import { randomBytes } from 'node:crypto';
import { Store } from '../dist/packages/evidence-core/src/index.js';
import { CapabilityCodec } from '../dist/packages/capability-core/src/index.js';
import { ExecutionBroker, ToolRegistry } from '../dist/packages/execution-broker/src/index.js';
import { ToolInputRegistry, demoToolInputMetadata } from '../dist/packages/tool-inputs/src/index.js';
import { Gate } from '../dist/apps/tna-gate-api/src/gate.js';
import { envelope, NOW } from '../dist/tests/fixture.js';
import { isPrivateAddress } from '../dist/packages/egress-guard/src/index.js';

const result = {};
const input = { release: 'release-1', environment: 'demo-production' };
const inputs = new ToolInputRegistry(); inputs.register(demoToolInputMetadata);
const input_hash = inputs.parseAndHash('demo.deploy.execute', input).input_hash;
const agent = { kind: 'agent', agentId: 'deployment-agent-17' };
const admin = { kind: 'admin', role: 'administrator' };
const request = { agentId: agent.agentId, action: 'production.deploy', tool: 'demo.deploy.execute', resource: 'release-1', estimatedCostUsd: 0, input, input_hash };
const redeem = token => ({ token, tool: request.tool, resource: request.resource, operation: 'write', input, input_hash });
const definition = handler => ({ name: request.tool, action: request.action, resourceType: 'infrastructure', allowedOperations: ['write'], networkRequired: false, credentialsRequired: [], handler });

// Real Gate policy/approval state, fake clock, in-process no-op protected handler.
{
  let now = NOW;
  const store = new Store(':memory:');
  const gate = new Gate(store, () => now);
  const policy = envelope();
  policy.tools.allow.push(request.tool);
  const binding = policy.action_bindings.find(b => b.action === request.action);
  binding.tool = request.tool; binding.destination_required = false;
  policy.resources.infrastructure.write = [request.resource];
  policy.limits.max_runtime_seconds = 1;
  gate.register(admin, { id: agent.agentId, name: 'Audit agent' }); gate.setEnvelope(admin, policy);
  const approval = gate.approve({ kind: 'approver', role: 'human-release-manager' }, { request, expiresAt: new Date(now + 1000).toISOString() });
  const decision = gate.authorize(agent, { ...request, approvalId: approval.approvalId });
  let calls = 0; const registry = new ToolRegistry(); registry.register(definition(() => { calls++; return { ok: true }; }));
  const broker = new ExecutionBroker(store, new CapabilityCodec(randomBytes(32), { clock: () => now }), registry, { isAgentRevoked: id => gate.isAgentRevoked(id), isPolicyCurrent: d => gate.isPolicyCurrent(d), isDecisionCurrent: d => gate.isPolicyCurrent(d) });
  const issued = broker.issue(agent, decision.decisionId);
  now += 2000;
  result.expiredApprovalAndRuntime = { state: (await broker.redeem(agent, redeem(issued.token))).state, handlerCalls: calls, millisecondsAfterAuthorization: 2000, approvalAndRuntimeLimitMs: 1000 };
  store.close();
}
function stubSetup(handler, options = {}, credentialsRequired = []) {
  const store = new Store(':memory:'); const registry = new ToolRegistry();
  registry.register({ ...definition(handler), credentialsRequired });
  const decision = { decisionId: 'audit-decision', agentId: agent.agentId, decision: 'ALLOW', reason: 'audit fixture', severity: 'info', policyVersion: '1.0', policyHash: 'fixture-policy', requiresEvidence: true, timestamp: new Date().toISOString(), request, approvalReference: null };
  store.put('decision', decision.decisionId, decision);
  const broker = new ExecutionBroker(store, new CapabilityCodec(randomBytes(32)), registry, options);
  return { store, broker, issued: broker.issue(agent, decision.decisionId) };
}
{
  let revoked = false, calls = 0;
  const fixture = stubSetup(() => { calls++; return { ok: true }; }, { isAgentRevoked: () => revoked, isPolicyCurrent: () => true, secretBroker: { lease: async () => { revoked = true; return []; } } }, ['deployment']);
  result.revokedDuringLease = { state: (await fixture.broker.redeem(agent, redeem(fixture.issued.token))).state, revoked, handlerCalls: calls };
  fixture.store.close();
}
{
  let calls = 0;
  const fixture = stubSetup(() => { calls++; return { ok: true }; });
  const append = fixture.store.append.bind(fixture.store);
  fixture.store.append = event => { if (event.state === 'SUCCEEDED') throw new Error('Transient evidence failure'); return append(event); };
  try { await fixture.broker.redeem(agent, redeem(fixture.issued.token)); } catch (error) { result.successEvidenceFailureError = error.message; }
  result.successEvidenceFailure = { handlerCalls: calls, recordedState: fixture.broker.execution(agent, fixture.issued.payload.execution_id).state };
  fixture.store.close();
}
result.addressClassification = Object.fromEntries(['198.19.0.1', '224.0.0.1', 'ff02::1'].map(address => [address, isPrivateAddress(address)]));
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
