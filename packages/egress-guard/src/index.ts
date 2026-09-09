import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type EgressBlockReason = 'NETWORK_DISABLED' | 'UNSUPPORTED_PROTOCOL' | 'INVALID_URL' | 'USERINFO_FORBIDDEN' | 'INVALID_HOST' | 'PORT_FORBIDDEN' | 'LOCALHOST_FORBIDDEN' | 'PRIVATE_ADDRESS' | 'UNKNOWN_DESTINATION' | 'DENIED_HOST' | 'HOST_NOT_ALLOWED' | 'DNS_FAILURE' | 'REDIRECT_LIMIT' | 'REDIRECT_LOCATION_INVALID';
export type EgressPolicy = { readonly mode: 'none' | 'required'; readonly allowHosts: readonly string[]; readonly denyHosts?: readonly string[]; readonly approvedPorts?: readonly number[]; readonly credentialHeaders?: readonly string[] };
export type EgressDecision = { readonly allowed: boolean; readonly reason: EgressBlockReason | 'ALLOWED'; readonly destination: string; readonly hostname?: string; readonly detail?: string };
export type CanonicalDestination = { readonly url: URL; readonly hostname: string; readonly protocol: 'http:' | 'https:'; readonly port: number };

export class EgressError extends Error {
  constructor(public readonly decision: EgressDecision) { super(`Egress blocked: ${decision.reason}${decision.detail ? ` (${decision.detail})` : ''}`); this.name = 'EgressError'; }
}

type Address = { readonly address: string; readonly family: number };
type Lookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<readonly Address[]>;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
const protocols = new Set(['http:', 'https:']);
const defaultPorts = new Set([80, 443]);
const forwardedHeaders = new Set(['accept', 'accept-language', 'cache-control', 'content-type', 'range']);
const sensitiveHeaders = new Set(['authorization', 'cookie', 'proxy-authorization']);

function ipv4Value(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null;
  const values = parts.map(Number);
  if (values.some(value => value > 255)) return null;
  return (((values[0]! * 256 + values[1]!) * 256 + values[2]!) * 256 + values[3]!);
}

function ipv4Private(address: string): boolean {
  const value = ipv4Value(address);
  if (value === null) return false;
  const inRange = (start: number, end: number) => value >= start && value <= end;
  return inRange(0x00000000, 0x00ffffff) || inRange(0x0a000000, 0x0affffff) || inRange(0x64400000, 0x647fffff) || inRange(0x7f000000, 0x7fffffff) || inRange(0xa9fe0000, 0xa9feffff) || inRange(0xac100000, 0xac1fffff) || inRange(0xc0000000, 0xc00000ff) || inRange(0xc6120000, 0xc61200ff) || inRange(0xc6336400, 0xc63364ff) || inRange(0xc0a80000, 0xc0a8ffff) || inRange(0xcb007100, 0xcb0071ff);
}

function ipv6Words(address: string): number[] | null {
  if (address.includes('%')) return null;
  const pieces = address.split('::');
  if (pieces.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const values: number[] = [];
    for (const item of part.split(':')) {
      if (item.includes('.')) { const value = ipv4Value(item); if (value === null) return null; values.push(value >>> 16, value & 0xffff); }
      else if (/^[0-9a-fA-F]{1,4}$/.test(item)) values.push(Number.parseInt(item, 16));
      else return null;
    }
    return values;
  };
  const left = parse(pieces[0]!); const right = parse(pieces[1] ?? '');
  if (!left || !right || (pieces.length === 1 && left.length !== 8) || (pieces.length === 2 && left.length + right.length >= 8)) return null;
  return pieces.length === 2 ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right] : left;
}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return ipv4Private(address);
  if (isIP(address) !== 6) return false;
  const words = ipv6Words(address);
  if (!words) return true;
  const mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;
  if (mapped) return ipv4Private(`${words[6]! >>> 8}.${words[6]! & 255}.${words[7]! >>> 8}.${words[7]! & 255}`);
  return words[0] === 0 || (words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xffc0) === 0xfe80;
}

function normalizedHost(host: string): string {
  const withoutBrackets = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (!withoutBrackets || withoutBrackets.includes('%') || Array.from(withoutBrackets).some(character => character.charCodeAt(0) > 0x7f)) throw new Error('invalid host');
  return withoutBrackets.toLowerCase().replace(/\.+$/, '');
}
function policyHost(host: string): string { if (host.startsWith('*.')) { const suffix = normalizedHost(host.slice(2)); if (!suffix || isIP(suffix) !== 0) throw new Error('invalid wildcard'); return `*.${suffix}`; } return normalizedHost(host); }

export function canonicalizeDestination(input: string | URL): CanonicalDestination {
  const schemeEnd = typeof input === 'string' ? input.indexOf('://') : -1;
  const authorityEnd = typeof input === 'string' && schemeEnd >= 0 ? input.slice(schemeEnd + 3).search(/[/?#]/) : -1;
  if (typeof input === 'string' && schemeEnd >= 0 && input.slice(schemeEnd + 3, authorityEnd < 0 ? input.length : schemeEnd + 3 + authorityEnd).includes('%')) throw new EgressError({ allowed: false, reason: 'INVALID_HOST', destination: input, detail: 'encoded authority is forbidden' });
  let url: URL;
  try { url = new URL(input); } catch { throw new EgressError({ allowed: false, reason: 'INVALID_URL', destination: String(input) }); }
  if (!protocols.has(url.protocol)) throw new EgressError({ allowed: false, reason: 'UNSUPPORTED_PROTOCOL', destination: url.href });
  if (url.username || url.password) throw new EgressError({ allowed: false, reason: 'USERINFO_FORBIDDEN', destination: url.href });
  let hostname: string;
  try { hostname = normalizedHost(url.hostname); } catch { throw new EgressError({ allowed: false, reason: 'INVALID_HOST', destination: url.href }); }
  if (!hostname || hostname.endsWith('.')) throw new EgressError({ allowed: false, reason: 'INVALID_HOST', destination: url.href });
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new EgressError({ allowed: false, reason: 'PORT_FORBIDDEN', destination: url.href });
  return { url, hostname, protocol: url.protocol as 'http:' | 'https:', port };
}

export class EgressGuard {
  private readonly allowHosts: ReadonlySet<string>;
  private readonly denyHosts: readonly string[];
  private readonly lookup: Lookup;
  private readonly fetchImpl: FetchLike;
  private readonly maxRedirects: number;
  private readonly credentialHeaders: ReadonlySet<string>;
  constructor(private readonly policy: EgressPolicy, options: { lookup?: Lookup; fetch?: FetchLike; maxRedirects?: number } = {}) {
    this.allowHosts = new Set(policy.allowHosts.map(policyHost)); this.denyHosts = (policy.denyHosts ?? []).map(policyHost); this.lookup = options.lookup ?? (dnsLookup as unknown as Lookup); this.fetchImpl = options.fetch ?? fetch; this.maxRedirects = options.maxRedirects ?? 5;
    this.credentialHeaders = new Set((policy.credentialHeaders ?? []).map(header => header.toLowerCase()));
  }
  async evaluate(destination: string | URL): Promise<EgressDecision> {
    const text = String(destination);
    if (this.policy.mode === 'none') return { allowed: false, reason: 'NETWORK_DISABLED', destination: text };
    let canonical: CanonicalDestination;
    try { canonical = canonicalizeDestination(destination); } catch (error) { return error instanceof EgressError ? error.decision : { allowed: false, reason: 'INVALID_URL', destination: text }; }
    if (canonical.hostname === 'localhost' || canonical.hostname.endsWith('.localhost')) return { allowed: false, reason: 'LOCALHOST_FORBIDDEN', destination: canonical.url.href, hostname: canonical.hostname };
    if (isPrivateAddress(canonical.hostname)) return { allowed: false, reason: 'PRIVATE_ADDRESS', destination: canonical.url.href, hostname: canonical.hostname };
    const portAllowed = this.policy.approvedPorts ? this.policy.approvedPorts.includes(canonical.port) : defaultPorts.has(canonical.port);
    if (!portAllowed) return { allowed: false, reason: 'PORT_FORBIDDEN', destination: canonical.url.href, hostname: canonical.hostname };
    if (this.denyHosts.some(host => host === canonical.hostname || (host.startsWith('*.') && canonical.hostname.endsWith(`.${host.slice(2)}`)))) return { allowed: false, reason: 'DENIED_HOST', destination: canonical.url.href, hostname: canonical.hostname };
    if (!this.allowHosts.has(canonical.hostname)) return { allowed: false, reason: 'HOST_NOT_ALLOWED', destination: canonical.url.href, hostname: canonical.hostname };
    if (isIP(canonical.hostname)) return { allowed: true, reason: 'ALLOWED', destination: canonical.url.href, hostname: canonical.hostname };
    let addresses: readonly Address[];
    try { addresses = await this.lookup(canonical.hostname, { all: true, verbatim: true }); } catch { return { allowed: false, reason: 'UNKNOWN_DESTINATION', destination: canonical.url.href, hostname: canonical.hostname, detail: 'DNS lookup failed' }; }
    if (!addresses.length) return { allowed: false, reason: 'UNKNOWN_DESTINATION', destination: canonical.url.href, hostname: canonical.hostname };
    if (addresses.some(address => isPrivateAddress(address.address))) return { allowed: false, reason: 'PRIVATE_ADDRESS', destination: canonical.url.href, hostname: canonical.hostname, detail: 'DNS resolved to a private address' };
    return { allowed: true, reason: 'ALLOWED', destination: canonical.url.href, hostname: canonical.hostname };
  }
  /** DNS is checked before each request, but can change afterward; this is not kernel egress isolation. */
  async request(input: string | URL, init?: RequestInit): Promise<Response> {
    let current = input;
    let requestInit = init;
    for (let redirects = 0; ; redirects++) {
      const decision = await this.evaluate(current); if (!decision.allowed) throw new EgressError(decision);
      const response = await this.fetchImpl(decision.destination, { ...requestInit, redirect: 'manual' });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      if (!location) throw new EgressError({ allowed: false, reason: 'REDIRECT_LOCATION_INVALID', destination: decision.destination, detail: 'redirect has no Location header' });
      if (redirects >= this.maxRedirects) throw new EgressError({ allowed: false, reason: 'REDIRECT_LIMIT', destination: decision.destination });
      let next: URL;
      try { next = new URL(location, decision.destination); } catch { throw new EgressError({ allowed: false, reason: 'REDIRECT_LOCATION_INVALID', destination: decision.destination }); }
      if (new URL(decision.destination).origin !== next.origin) {
        const headers = new Headers(requestInit?.headers);
        for (const name of [...headers.keys()]) if (!forwardedHeaders.has(name) || sensitiveHeaders.has(name) || this.credentialHeaders.has(name)) headers.delete(name);
        requestInit = { ...requestInit, headers };
      }
      current = next;
    }
  }
}