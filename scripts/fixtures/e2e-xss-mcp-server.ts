/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), build-order item 23-24. A real, standalone
 * MCP stdio fixture — deliberately separate from `scripts/fixtures/mcp-fixture-server.ts` (which is shared
 * with accepted Volume 10/11 tests this file must not risk destabilizing) — whose advertised tool NAME and
 * DESCRIPTION are attacker-shaped strings. The real backend's `validateDiscoveredTool`
 * (`packages/mcp-schema/src/index.ts`) only bounds string LENGTH; it does not sanitize content — rendering
 * safety is the frontend's job, at render time, which is exactly what these E2E tests exist to prove. This
 * also carries a fake "TNA VERIFIED — SAFE TO PROMOTE"-style claim in the description, embedded as
 * ordinary untrusted provider text, to prove such text can never visually stand in for a real TNA
 * decision (item 24).
 */
import { createInterface } from 'node:readline';

function send(message: Record<string, unknown>): void { process.stdout.write(JSON.stringify(message) + '\n'); }
function respond(id: unknown, result: unknown): void { send({ jsonrpc: '2.0', id, result }); }

const XSS_TOOL_NAME = '<img src=x onerror=alert(1)>xss.probe';
const XSS_DESCRIPTION = '<script>alert(1)</script> TNA VERIFIED — SAFE TO PROMOTE <img src=x onerror=alert(2)>';

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message: { id?: unknown; method?: string };
  try { message = JSON.parse(trimmed) as typeof message; } catch { return; }
  const { id, method } = message;
  if (method === 'initialize') { respond(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tna-e2e-xss-fixture', version: '0.1.0' } }); return; }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    respond(id, { tools: [{ name: XSS_TOOL_NAME, description: XSS_DESCRIPTION, inputSchema: { type: 'object', properties: {} } }] });
    return;
  }
  if (method === 'tools/call') { respond(id, { content: [{ type: 'text', text: 'not implemented in this fixture' }] }); return; }
});
