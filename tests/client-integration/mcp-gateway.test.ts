import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { McpStdioClient, isPidAlive } from '../../packages/mcp-gateway/src/index.js';
import { McpError } from '../../packages/mcp-schema/src/index.js';

/**
 * Section 94: real local MCP process/fixture, actual protocol — not a fake interface call. Every test
 * here spawns `scripts/fixtures/mcp-fixture-server.ts` (compiled) as a genuine child process and speaks
 * real newline-delimited JSON-RPC 2.0 to it.
 */
const fixture = fileURLToPath(new URL('../../scripts/fixtures/mcp-fixture-server.js', import.meta.url));

function client(mode: string, timeouts?: ConstructorParameters<typeof McpStdioClient>[0]['timeouts']): McpStdioClient {
  return new McpStdioClient({
    executable: process.execPath, args: [fixture], envAllowlist: [],
    extraEnv: { MCP_FIXTURE_MODE: mode }, ...(timeouts ? { timeouts } : {}),
  });
}

test('real MCP handshake: connect, list tools, call a tool, shut down cleanly', async () => {
  const c = client('normal');
  await c.connect();
  const pid = c.pid;
  assert.ok(pid && isPidAlive(pid));

  const tools = await c.listTools();
  assert.equal(tools.length, 2);
  assert.ok(tools.some(t => t.name === 'crm.lookup_customer'));
  assert.ok(tools.some(t => t.name === 'crm.update_customer'));

  const result = await c.callTool('crm.lookup_customer', { customer_id: 'cust_1' });
  assert.equal(result.is_error, false);
  assert.ok(result.bytes > 0);

  await c.shutdown();
  assert.equal(isPidAlive(pid!), false, 'the child process must actually be gone after shutdown');
});

test('MCP_SERVER_UNAVAILABLE: a process that exits immediately never completes handshake', async () => {
  const c = client('crash-immediately');
  await assert.rejects(() => c.connect(), (error: unknown) => {
    assert.ok(error instanceof McpError);
    assert.ok(error.code === 'MCP_SERVER_UNAVAILABLE' || error.code === 'MCP_INITIALIZATION_FAILED');
    return true;
  });
});

test('MCP_PROTOCOL_ERROR: a malformed (non-JSON) response is never treated as success', async () => {
  const c = client('malformed');
  await c.connect();
  await assert.rejects(() => c.listTools(), (error: unknown) => { assert.ok(error instanceof McpError); assert.equal(error.code, 'MCP_PROTOCOL_ERROR'); return true; });
  await c.shutdown();
});

test('MCP_TIMEOUT: a hanging server is bounded, never awaited indefinitely, and its process is still terminated', async () => {
  const c = client('hang', { callMs: 300, shutdownMs: 500 });
  await c.connect();
  const pid = c.pid;
  await assert.rejects(() => c.callTool('crm.lookup_customer', { customer_id: 'x' }), (error: unknown) => { assert.ok(error instanceof McpError); assert.equal(error.code, 'MCP_TIMEOUT'); return true; });
  await c.shutdown();
  assert.equal(isPidAlive(pid!), false);
});

test('MCP_INDETERMINATE: the server exiting mid-call is never reported as a fabricated success (TNA-48)', async () => {
  const c = client('crash-on-call');
  await c.connect();
  await assert.rejects(() => c.callTool('crm.update_customer', { customer_id: 'x', fields: {} }), (error: unknown) => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'MCP_INDETERMINATE');
    return true;
  });
  await c.shutdown();
});

test('schema drift is visible in discovery: normal vs schema-v2 produce different schema shapes for the same tool name', async () => {
  const c1 = client('normal');
  await c1.connect();
  const before = await c1.listTools();
  await c1.shutdown();

  const c2 = client('schema-v2');
  await c2.connect();
  const after = await c2.listTools();
  await c2.shutdown();

  const beforeSchema = before.find(t => t.name === 'crm.lookup_customer')?.input_schema;
  const afterSchema = after.find(t => t.name === 'crm.lookup_customer')?.input_schema;
  assert.notDeepEqual(beforeSchema, afterSchema, 'the fixture must genuinely advertise a different schema in schema-v2 mode');
});

test('MCP_RESULT_TOO_LARGE: an oversized real MCP result is rejected, never silently truncated or accepted', async () => {
  const c = client('oversized-result');
  await c.connect();
  await assert.rejects(() => c.callTool('crm.lookup_customer', { customer_id: 'x' }), (error: unknown) => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, 'MCP_RESULT_TOO_LARGE');
    return true;
  });
  await c.shutdown();
});

interface EnvEchoContent { readonly type: string; readonly text: string }
function parseEnvEcho(content: unknown): { name: string; value: string | null } {
  const first = (content as readonly EnvEchoContent[])[0];
  if (!first) throw new Error('env.echo returned no content');
  return JSON.parse(first.text) as { name: string; value: string | null };
}

test('environment isolation: a real spawned MCP child process cannot see an unallowlisted secret from the gateway\'s own environment', async () => {
  const secretName = 'TNA_TEST_SECRET_NOT_ALLOWLISTED';
  process.env[secretName] = 'super-secret-value-must-not-leak';
  try {
    const c = new McpStdioClient({
      executable: process.execPath, args: [fixture], envAllowlist: ['PATH'], // deliberately does not allowlist secretName
      extraEnv: { MCP_FIXTURE_MODE: 'echo-env' },
    });
    await c.connect();
    const result = await c.callTool('env.echo', { name: secretName });
    const rawContent = JSON.stringify(result.content);
    assert.ok(!rawContent.includes('super-secret-value-must-not-leak'), 'an unallowlisted environment variable must never reach the child process, in any encoding');
    const echoed = parseEnvEcho(result.content);
    assert.equal(echoed.value, null, 'the child process must genuinely not see the variable at all (process.env[name] === undefined inside the child), not merely be told not to report it');
    await c.shutdown();
  } finally { delete process.env[secretName]; }
});

test('environment isolation: an explicitly allowlisted variable does reach the real child process', async () => {
  const allowedName = 'TNA_TEST_ALLOWED_VAR';
  process.env[allowedName] = 'this-value-should-be-visible';
  try {
    const c = new McpStdioClient({
      executable: process.execPath, args: [fixture], envAllowlist: ['PATH', allowedName],
      extraEnv: { MCP_FIXTURE_MODE: 'echo-env' },
    });
    await c.connect();
    const result = await c.callTool('env.echo', { name: allowedName });
    const echoed = parseEnvEcho(result.content);
    assert.equal(echoed.value, 'this-value-should-be-visible', 'an explicitly allowlisted variable must actually reach the child process — isolation must not be overbroad either');
    await c.shutdown();
  } finally { delete process.env[allowedName]; }
});

test('process leak check: repeated connect/shutdown cycles leave no orphan child processes', async () => {
  const pids: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const c = client('normal');
    await c.connect();
    pids.push(c.pid!);
    await c.listTools();
    await c.shutdown();
  }
  for (const pid of pids) assert.equal(isPidAlive(pid), false, `pid ${pid} must not remain alive after shutdown`);
});
