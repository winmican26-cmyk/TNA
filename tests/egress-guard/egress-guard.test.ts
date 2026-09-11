import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EgressError, EgressGuard, canonicalizeDestination, isPrivateAddress, type EgressPolicy } from '../../packages/egress-guard/src/index.js';

const policy = (overrides: Partial<EgressPolicy> = {}): EgressPolicy => ({ mode: 'required', allowHosts: ['api.example.com'], approvedPorts: [80, 443], ...overrides });
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (status: number, location?: string) => new Response(null, { status, headers: location ? { location } : {} });

test('canonicalizes case and trailing dots while preserving exact host matching', async () => { const canonical = canonicalizeDestination('HTTPS://API.EXAMPLE.COM./path'); assert.equal(canonical.hostname, 'api.example.com'); assert.equal((await new EgressGuard(policy(), { lookup: publicLookup }).evaluate('https://api.example.com/')).allowed, true); assert.equal((await new EgressGuard(policy(), { lookup: publicLookup }).evaluate('https://api.example.com.evil/')).reason, 'HOST_NOT_ALLOWED'); });
test('deny precedence supports exact and wildcard denies', async () => { const guard = new EgressGuard(policy({ allowHosts: ['api.example.com', 'sub.example.com'], denyHosts: ['api.example.com', '*.example.com'] }), { lookup: publicLookup }); assert.equal((await guard.evaluate('https://api.example.com')).reason, 'DENIED_HOST'); assert.equal((await guard.evaluate('https://sub.example.com')).reason, 'DENIED_HOST'); });
test('rejects userinfo, unsupported protocols, malformed URLs, and ports', async () => { const guard = new EgressGuard(policy(), { lookup: publicLookup }); for (const [url, reason] of [['ftp://api.example.com', 'UNSUPPORTED_PROTOCOL'], ['https://user:pass@api.example.com', 'USERINFO_FORBIDDEN'], ['https://api.example.com:8443', 'PORT_FORBIDDEN'], ['https://%65xample.com', 'INVALID_HOST'], ['not a url', 'INVALID_URL']] as const) assert.equal((await guard.evaluate(url)).reason, reason); });
test('blocks localhost, private IPv4, IPv6, mapped IPv6, and metadata addresses', async () => { const guard = new EgressGuard(policy({ allowHosts: ['localhost', '127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '::ffff:808:808'] })); for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '169.254.169.254', '[::1]', '[::ffff:127.0.0.1]']) assert.equal((await guard.evaluate(`https://${host}`)).reason, host === 'localhost' ? 'LOCALHOST_FORBIDDEN' : 'PRIVATE_ADDRESS'); assert.equal((await guard.evaluate('https://[::ffff:8.8.8.8]')).reason, 'ALLOWED'); assert.equal(isPrivateAddress('192.168.1.1'), true); assert.equal(isPrivateAddress('8.8.8.8'), false); assert.equal(isPrivateAddress('fd00::1'), true); assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true); assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true); assert.equal(isPrivateAddress('::ffff:169.254.169.254'), true); });
test('blocks benchmark (198.18/15), multicast IPv4 (224/4), and multicast IPv6 (ff00::/8)', async () => {
	assert.equal(isPrivateAddress('198.19.0.1'), true, '198.19.0.1 is in 198.18.0.0/15 benchmark range');
	assert.equal(isPrivateAddress('224.0.0.1'), true, '224.0.0.1 is in 224.0.0.0/4 multicast range');
	assert.equal(isPrivateAddress('ff02::1'), true, 'ff02::1 is in ff00::/8 IPv6 multicast range');
	assert.equal(isPrivateAddress('198.17.255.255'), false, '198.17.255.255 is outside the benchmark range');
	assert.equal(isPrivateAddress('223.255.255.255'), false, '223.255.255.255 is outside the multicast range');
	const guard = new EgressGuard(policy({ allowHosts: ['198.19.0.1', '224.0.0.1', 'ff02::1'] }));
	assert.equal((await guard.evaluate('https://198.19.0.1')).reason, 'PRIVATE_ADDRESS');
	assert.equal((await guard.evaluate('https://224.0.0.1')).reason, 'PRIVATE_ADDRESS');
	assert.equal((await guard.evaluate('https://[ff02::1]')).reason, 'PRIVATE_ADDRESS');
});
test('blocks unknown hosts and DNS answers in private ranges', async () => { const unknown = new EgressGuard(policy(), { lookup: async () => { throw new Error('NXDOMAIN'); } }); assert.equal((await unknown.evaluate('https://api.example.com')).reason, 'UNKNOWN_DESTINATION'); const privateDns = new EgressGuard(policy(), { lookup: async () => [{ address: '169.254.169.254', family: 4 }] }); assert.equal((await privateDns.evaluate('https://api.example.com')).reason, 'PRIVATE_ADDRESS'); });
test('no-network mode rejects without invoking DNS or fetch', async () => { let calls = 0; const guard = new EgressGuard(policy({ mode: 'none' }), { lookup: async () => { calls++; return []; }, fetch: async () => { calls++; return response(200); } }); assert.equal((await guard.evaluate('https://api.example.com')).reason, 'NETWORK_DISABLED'); await assert.rejects(() => guard.request('https://api.example.com'), (error: unknown) => error instanceof EgressError && error.decision.reason === 'NETWORK_DISABLED'); assert.equal(calls, 0); });
test('revalidates every redirect and never follows loopback or unauthorized destinations', async () => { const calls: string[] = []; const guard = new EgressGuard(policy(), { lookup: publicLookup, fetch: async input => { calls.push(String(input)); return response(302, 'http://127.0.0.1/'); } }); await assert.rejects(() => guard.request('https://api.example.com/start'), (error: unknown) => error instanceof EgressError && error.decision.reason === 'PRIVATE_ADDRESS'); assert.deepEqual(calls, ['https://api.example.com/start']); const unauthorized = new EgressGuard(policy(), { lookup: publicLookup, fetch: async () => response(302, 'https://other.example.com/') }); await assert.rejects(() => unauthorized.request('https://api.example.com/start'), (error: unknown) => error instanceof EgressError && error.decision.reason === 'HOST_NOT_ALLOWED'); });
test('strips credentials across origins and revalidates the allowed redirect', async t => {
	let redirectedHeaders: Record<string, string> | undefined;
	let destinationPort = 0;
	const source = createServer((_request, reply) => { reply.writeHead(302, { location: `http://allowed.example:${destinationPort}/target` }); reply.end(); });
	const destination = createServer((request, reply) => { redirectedHeaders = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(',') : value ?? ''])); reply.end('ok'); });
	source.listen(0, '127.0.0.1'); destination.listen(0, '127.0.0.1');
	await Promise.all([once(source, 'listening'), once(destination, 'listening')]);
	t.after(async () => { source.close(); destination.close(); await Promise.all([once(source, 'close'), once(destination, 'close')]); });
	const sourcePort = (source.address() as { port: number }).port;
	destinationPort = (destination.address() as { port: number }).port;
	const lookups: string[] = [];
	const guard = new EgressGuard(policy({ allowHosts: ['source.example', 'allowed.example'], approvedPorts: [sourcePort, destinationPort], credentialHeaders: ['x-api-key'] }), {
		lookup: async hostname => { lookups.push(hostname); return publicLookup(); },
		fetch: async (input, init) => { const url = new URL(String(input)); const port = url.hostname === 'source.example' ? sourcePort : destinationPort; return fetch(`http://127.0.0.1:${port}${url.pathname}`, init); },
	});
	const result = await guard.request(`http://source.example:${sourcePort}/start`, { headers: { Accept: 'text/plain', Authorization: 'Bearer secret', Cookie: 'session=secret', 'Proxy-Authorization': 'Basic secret', 'X-Api-Key': 'api-secret', 'X-Trace': 'trace' } });
	assert.equal(result.status, 200);
	assert.deepEqual(lookups, ['source.example', 'allowed.example']);
	assert.ok(redirectedHeaders);
	assert.equal(redirectedHeaders.authorization, undefined);
	assert.equal(redirectedHeaders.cookie, undefined);
	assert.equal(redirectedHeaders['proxy-authorization'], undefined);
	assert.equal(redirectedHeaders['x-api-key'], undefined);
	assert.equal(redirectedHeaders['x-trace'], undefined);
	assert.equal(redirectedHeaders.accept, 'text/plain');
});