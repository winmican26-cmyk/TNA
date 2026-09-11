/**
 * Real local MCP-fixture server (section 81, 94) — a standalone, dependency-free Node script speaking
 * the actual minimal MCP stdio wire protocol (newline-delimited JSON-RPC 2.0: `initialize`,
 * `notifications/initialized`, `tools/list`, `tools/call`). Deliberately knows nothing about TNA —
 * this stands in for "a client's real external MCP server," exercised by `packages/mcp-gateway`'s tests
 * and the client-integration demo exactly the way a genuine third-party server would be.
 *
 * Behavior is controlled entirely by the `MCP_FIXTURE_MODE` environment variable so one script can play
 * every real-world failure mode the review requires:
 *   normal            - two tools (crm.lookup_customer read, crm.update_customer write), correct protocol
 *   schema-v2         - same tools, crm.lookup_customer's input schema has drifted (added required field)
 *   malformed         - tools/list responds with a non-JSON line
 *   hang              - tools/call never responds (process stays alive, silent)
 *   crash-on-call     - tools/call is accepted, then the process exits before responding
 *   crash-immediately - the process exits right after start, before ever reading a message
 *   oversized-result  - tools/call responds with a result far larger than MAX_MCP_RESULT_BYTES
 *   echo-env          - tools/list advertises one tool, "env.echo", whose call returns the child
 *                       process's own `process.env[args.name]` — used to prove environment isolation:
 *                       a real child process, actually queried for what it can see of its own
 *                       environment, not an assertion about what the parent intended to pass.
 */
import { createInterface } from 'node:readline';

const mode = process.env.MCP_FIXTURE_MODE ?? 'normal';

if (mode === 'crash-immediately') process.exit(1);

function send(message: Record<string, unknown>): void { process.stdout.write(JSON.stringify(message) + '\n'); }
function respond(id: unknown, result: unknown): void { send({ jsonrpc: '2.0', id, result }); }

const schemaV1 = { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] };
const schemaV2 = { type: 'object', properties: { customer_id: { type: 'string' }, tenant_scope: { type: 'string' } }, required: ['customer_id', 'tenant_scope'] };
const updateSchema = { type: 'object', properties: { customer_id: { type: 'string' }, fields: { type: 'object' } }, required: ['customer_id', 'fields'] };

const envEchoSchema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

function tools(): unknown[] {
  if (mode === 'echo-env') return [{ name: 'env.echo', description: 'Echoes one of this process\'s own environment variables', inputSchema: envEchoSchema }];
  return [
    { name: 'crm.lookup_customer', description: 'Read-only customer lookup by id', inputSchema: mode === 'schema-v2' ? schemaV2 : schemaV1 },
    { name: 'crm.update_customer', description: 'Write customer fields (high-risk)', inputSchema: updateSchema },
  ];
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try { message = JSON.parse(trimmed) as typeof message; } catch { return; }
  const { id, method, params } = message;
  if (method === 'initialize') {
    respond(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tna-fixture-mcp-server', version: '0.1.0' } });
    return;
  }
  if (method === 'notifications/initialized') return; // no response expected
  if (method === 'tools/list') {
    if (mode === 'malformed') { process.stdout.write('this is not valid json-rpc\n'); return; }
    respond(id, { tools: tools() });
    return;
  }
  if (method === 'tools/call') {
    if (mode === 'hang') return; // never respond
    if (mode === 'crash-on-call') { process.exitCode = 1; process.exit(1); }
    const name = params?.name;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    if (mode === 'oversized-result') {
      respond(id, { content: [{ type: 'text', text: 'x'.repeat(500_000) }], isError: false });
      return;
    }
    if (name === 'env.echo') {
      const key = typeof args.name === 'string' ? args.name : '';
      respond(id, { content: [{ type: 'text', text: JSON.stringify({ name: key, value: process.env[key] ?? null }) }], isError: false });
      return;
    }
    if (name === 'crm.lookup_customer') {
      respond(id, { content: [{ type: 'text', text: JSON.stringify({ customer_id: args.customer_id, name: 'Ada Lovelace', tier: 'gold' }) }], isError: false });
      return;
    }
    if (name === 'crm.update_customer') {
      respond(id, { content: [{ type: 'text', text: JSON.stringify({ customer_id: args.customer_id, updated: true }) }], isError: false });
      return;
    }
    respond(id, { content: [{ type: 'text', text: `unknown tool: ${String(name)}` }], isError: true });
    return;
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
