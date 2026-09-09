import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { equalToken, type Principal } from '../../../packages/agent-identity/src/index.js';
import { BrokerError, type ExecutionBroker } from '../../../packages/execution-broker/src/index.js';
import { Gate, HttpError } from './gate.js';

export type Credentials = { adminToken: string; approvers: { token: string; role: string }[] };
function validateCredentials(config: Credentials): void {
  const tokens = [config.adminToken, ...config.approvers.map(a => a.token)];
  if (tokens.some(t => t.length < 32) || new Set(tokens).size !== tokens.length) throw new Error('Credentials must be distinct and at least 32 characters');
  if (config.approvers.some(a => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(a.role))) throw new Error('Invalid approver role');
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 65536) throw new HttpError(413, 'Request too large');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}
function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function decisionIdInput(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !('decisionId' in input) || typeof input.decisionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.decisionId)) throw new HttpError(400, 'Schema validation failed');
  return input.decisionId;
}
export function createGateServer(gate: Gate, credentials: Credentials, broker?: ExecutionBroker) {
  validateCredentials(credentials);
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    void (async () => {
      let principal: Principal | null = null;
      try {
        const authorization = req.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Bearer credential required');
        const token = authorization.slice(7);
        if (equalToken(token, credentials.adminToken)) principal = { kind: 'admin', role: 'administrator' };
        else {
          const approver = credentials.approvers.find(a => equalToken(token, a.token));
          principal = approver ? { kind: 'approver', role: approver.role } : gate.authenticateAgent(token);
        }
        if (!principal) throw new HttpError(401, 'Invalid credential');
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.search) throw new HttpError(400, 'Query parameters are not supported');
        const path = url.pathname;
        if (req.method === 'POST') {
          const input = await body(req);
          if (path === '/v1/agents/register') return send(res, 201, gate.register(principal, input));
          if (path === '/v1/envelopes') return send(res, 201, gate.setEnvelope(principal, input));
          if (path === '/v1/authorize') return send(res, 200, gate.authorize(principal, input));
          if (path === '/v1/approvals') return send(res, 201, gate.approve(principal, input));
          if (path === '/v1/revoke') return send(res, 200, gate.revoke(principal, input));
          if (path === '/v1/capabilities') {
            if (!broker) throw new HttpError(503, 'Execution broker unavailable');
            return send(res, 201, broker.issue(principal, decisionIdInput(input)));
          }
          if (path === '/v1/capabilities/redeem') {
            if (!broker) throw new HttpError(503, 'Execution broker unavailable');
            return send(res, 200, await broker.redeem(principal, input as never));
          }
        }
        if (req.method === 'GET') {
          const envelope = /^\/v1\/envelopes\/([a-zA-Z0-9._-]+)$/.exec(path);
          if (envelope?.[1]) return send(res, 200, gate.getEnvelope(principal, envelope[1]));
          const decision = /^\/v1\/decisions\/([a-zA-Z0-9._-]+)$/.exec(path);
          if (decision?.[1]) return send(res, 200, gate.decision(principal, decision[1]));
          const activity = /^\/v1\/agents\/([a-zA-Z0-9._-]+)\/activity$/.exec(path);
          if (activity?.[1]) return send(res, 200, gate.activity(principal, activity[1]));
          const execution = /^\/v1\/executions\/([a-zA-Z0-9._-]+)$/.exec(path);
          if (execution?.[1]) {
            if (!broker) throw new HttpError(503, 'Execution broker unavailable');
            return send(res, 200, broker.execution(principal, execution[1]));
          }
          const executions = /^\/v1\/agents\/([a-zA-Z0-9._-]+)\/executions$/.exec(path);
          if (executions?.[1]) {
            if (!broker) throw new HttpError(503, 'Execution broker unavailable');
            return send(res, 200, broker.executions(principal, executions[1]));
          }
        }
        throw new HttpError(404, 'Route not found');
      } catch (error) {
        const status = error instanceof HttpError || error instanceof BrokerError ? error.status : error instanceof ZodError ? 400 : 503;
        try { gate.audit('http.rejected', { status, principal, method: req.method, path: req.url?.split('?')[0]?.slice(0, 512) }); }
        catch { return send(res, 503, { error: 'Evidence storage unavailable' }); }
        send(res, status, { error: error instanceof HttpError || error instanceof BrokerError ? error.message : error instanceof ZodError ? 'Schema validation failed' : 'Service unavailable' });
      }
    })();
  });
  server.maxRequestsPerSocket = 100;
  return server;
}
