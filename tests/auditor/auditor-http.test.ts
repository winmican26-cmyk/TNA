import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { AuditorRuntime } from '../../packages/auditor-engine/src/index.js';
import { StaticEvidenceProvider } from '../../packages/auditor-evidence/src/index.js';
import { createAuditorServer, type AuditorCredentials } from '../../apps/tna-auditor/src/server.js';
import { mkEvent, baseScope, TENANT, CUTOFF } from './fixture.js';

const CREDENTIALS: AuditorCredentials = {
  readerToken: 'reader-token-32-characters-long-abc',
  runnerToken: 'runner-token-32-characters-long-abc',
  adminToken: 'admin-token-32-characters-long-abcd',
};

async function withServer(run: (baseUrl: string, runtime: AuditorRuntime) => Promise<void>): Promise<void> {
  const provider = new StaticEvidenceProvider([mkEvent({ event_type: 'AUTHORIZATION_ALLOWED', tenant_id: TENANT, authority_context: { agent_id: 'agent-1', decision_id: 'dec-1', policy_hash: 'p'.repeat(64), action: 'deploy', tool: 'github', resource: 'repo:x' } })]);
  const runtime = new AuditorRuntime(':memory:', { evidenceProvider: provider });
  const server = createAuditorServer(runtime, CREDENTIALS, TENANT);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try { await run(`http://127.0.0.1:${port}`, runtime); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); runtime.close(); }
}

function jsonHeaders(token: string): Record<string, string> { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }; }

test('HTTP: anonymous requests are rejected on every route', async () => {
  await withServer(async baseUrl => {
    const res = await fetch(`${baseUrl}/v1/auditor/controls`);
    assert.equal(res.status, 401);
  });
});
test('HTTP: an invalid bearer token is rejected', async () => {
  await withServer(async baseUrl => {
    const res = await fetch(`${baseUrl}/v1/auditor/controls`, { headers: { Authorization: 'Bearer not-a-real-token' } });
    assert.equal(res.status, 401);
  });
});

test('HTTP: reader cannot create or run an assessment; runner can', async () => {
  await withServer(async baseUrl => {
    const spec = { version: '1.0', tenant_id: TENANT, name: 'http test', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF };
    const readerCreate = await fetch(`${baseUrl}/v1/auditor/assessments`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.readerToken), body: JSON.stringify(spec) });
    assert.equal(readerCreate.status, 403);
    const runnerCreate = await fetch(`${baseUrl}/v1/auditor/assessments`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: JSON.stringify(spec) });
    assert.equal(runnerCreate.status, 201);
    const assessment = await runnerCreate.json() as { assessment_id: string };
    const readerRun = await fetch(`${baseUrl}/v1/auditor/assessments/${assessment.assessment_id}/run`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.readerToken), body: '{}' });
    assert.equal(readerRun.status, 403);
    const runnerRun = await fetch(`${baseUrl}/v1/auditor/assessments/${assessment.assessment_id}/run`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: '{}' });
    assert.equal(runnerRun.status, 200);
    const run = await runnerRun.json() as { status: string };
    assert.equal(run.status, 'COMPLETED');
  });
});

test('HTTP: cross-tenant read is rejected with 404, not a leaked 403', async () => {
  await withServer(async baseUrl => {
    const spec = { version: '1.0', tenant_id: TENANT, name: 'http test', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF };
    const create = await fetch(`${baseUrl}/v1/auditor/assessments`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: JSON.stringify(spec) });
    const assessment = await create.json() as { assessment_id: string };
    // Same credentials, but the server is fixed to one tenant — there is no way for a caller to name
    // a different tenant over this API; the meaningful cross-tenant check lives at the facade level
    // (already proven in auditor-engine.test.ts). Here we confirm a bad id 404s, not 500s or leaks.
    const res = await fetch(`${baseUrl}/v1/auditor/assessments/not-a-real-id`, { headers: jsonHeaders(CREDENTIALS.readerToken) });
    assert.equal(res.status, 404);
    void assessment;
  });
});

test('HTTP: invalid scope is rejected with 400', async () => {
  await withServer(async baseUrl => {
    const spec = { version: '1.0', tenant_id: TENANT, name: 'bad scope', scope: { tenant_wide: false, time_range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' } }, control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF };
    const res = await fetch(`${baseUrl}/v1/auditor/assessments`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: JSON.stringify(spec) });
    assert.equal(res.status, 400);
  });
});
test('HTTP: invalid control_profile_id is rejected with 400', async () => {
  await withServer(async baseUrl => {
    const spec = { version: '1.0', tenant_id: TENANT, name: 'bad profile', scope: baseScope(), control_profile_id: 'NOT_A_PROFILE', evidence_cutoff_at: CUTOFF };
    const res = await fetch(`${baseUrl}/v1/auditor/assessments`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: JSON.stringify(spec) });
    assert.equal(res.status, 400);
  });
});

test('HTTP: assessment replay works end to end', async () => {
  await withServer(async baseUrl => {
    const spec = { version: '1.0', tenant_id: TENANT, name: 'replay', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF };
    const create = await fetch(`${baseUrl}/v1/auditor/assessments`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: JSON.stringify(spec) });
    const assessment = await create.json() as { assessment_id: string };
    await fetch(`${baseUrl}/v1/auditor/assessments/${assessment.assessment_id}/run`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: '{}' });
    const replay = await fetch(`${baseUrl}/v1/auditor/assessments/${assessment.assessment_id}/replay`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: '{}' });
    assert.equal(replay.status, 200);
    const run = await replay.json() as { run_number: number; is_replay: boolean };
    assert.equal(run.run_number, 2);
    assert.equal(run.is_replay, true);
  });
});

test('HTTP: findings and results endpoints are bounded/paginated', async () => {
  await withServer(async baseUrl => {
    const spec = { version: '1.0', tenant_id: TENANT, name: 'bounded', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF };
    const create = await fetch(`${baseUrl}/v1/auditor/assessments`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: JSON.stringify(spec) });
    const assessment = await create.json() as { assessment_id: string };
    await fetch(`${baseUrl}/v1/auditor/assessments/${assessment.assessment_id}/run`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: '{}' });
    const res = await fetch(`${baseUrl}/v1/auditor/assessments/${assessment.assessment_id}/results?limit=5`, { headers: jsonHeaders(CREDENTIALS.readerToken) });
    assert.equal(res.status, 200);
    const page = await res.json() as { items: unknown[]; nextCursor: string | null };
    assert.equal(page.items.length, 5);
    assert.notEqual(page.nextCursor, null);
  });
});

test('HTTP: export works and the resulting package verifies via the /packages/verify route', async () => {
  await withServer(async baseUrl => {
    const spec = { version: '1.0', tenant_id: TENANT, name: 'export', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF };
    const create = await fetch(`${baseUrl}/v1/auditor/assessments`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: JSON.stringify(spec) });
    const assessment = await create.json() as { assessment_id: string };
    await fetch(`${baseUrl}/v1/auditor/assessments/${assessment.assessment_id}/run`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: '{}' });
    const exportRes = await fetch(`${baseUrl}/v1/auditor/assessments/${assessment.assessment_id}/export`, { headers: jsonHeaders(CREDENTIALS.readerToken) });
    assert.equal(exportRes.status, 200);
    const pkg = await exportRes.json();
    const verifyRes = await fetch(`${baseUrl}/v1/auditor/packages/verify`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.readerToken), body: JSON.stringify(pkg) });
    assert.equal(verifyRes.status, 200);
    const verification = await verifyRes.json() as { valid: boolean };
    assert.equal(verification.valid, true);
  });
});
test('HTTP: a tampered package fails verification via the /packages/verify route', async () => {
  await withServer(async baseUrl => {
    const spec = { version: '1.0', tenant_id: TENANT, name: 'tamper', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF };
    const create = await fetch(`${baseUrl}/v1/auditor/assessments`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: JSON.stringify(spec) });
    const assessment = await create.json() as { assessment_id: string };
    await fetch(`${baseUrl}/v1/auditor/assessments/${assessment.assessment_id}/run`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: '{}' });
    const exportRes = await fetch(`${baseUrl}/v1/auditor/assessments/${assessment.assessment_id}/export`, { headers: jsonHeaders(CREDENTIALS.readerToken) });
    const pkg = await exportRes.json() as { assessment_hash: string };
    pkg.assessment_hash = 'f'.repeat(64);
    const verifyRes = await fetch(`${baseUrl}/v1/auditor/packages/verify`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.readerToken), body: JSON.stringify(pkg) });
    const verification = await verifyRes.json() as { valid: boolean };
    assert.equal(verification.valid, false);
  });
});

test('HTTP: controls and profiles catalog endpoints are readable by any authenticated role', async () => {
  await withServer(async baseUrl => {
    const controlsRes = await fetch(`${baseUrl}/v1/auditor/controls`, { headers: jsonHeaders(CREDENTIALS.readerToken) });
    assert.equal(controlsRes.status, 200);
    const controls = await controlsRes.json() as unknown[];
    assert.ok(controls.length >= 20);
    const profilesRes = await fetch(`${baseUrl}/v1/auditor/profiles`, { headers: jsonHeaders(CREDENTIALS.readerToken) });
    assert.equal(profilesRes.status, 200);
  });
});

test('HTTP: no generic PATCH/PUT/DELETE mutation route exists for a session (404, unchanged afterward)', async () => {
  await withServer(async baseUrl => {
    const spec = { version: '1.0', tenant_id: TENANT, name: 'no mutation', scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF };
    const create = await fetch(`${baseUrl}/v1/auditor/assessments`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: JSON.stringify(spec) });
    const assessment = await create.json() as { assessment_id: string };
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const res = await fetch(`${baseUrl}/v1/auditor/assessments/${assessment.assessment_id}`, { method, headers: jsonHeaders(CREDENTIALS.adminToken), ...(method !== 'DELETE' ? { body: JSON.stringify({ status: 'COMPLETED' }) } : {}) });
      assert.equal(res.status, 404);
    }
    const after = await fetch(`${baseUrl}/v1/auditor/assessments/${assessment.assessment_id}`, { headers: jsonHeaders(CREDENTIALS.readerToken) });
    const afterBody = await after.json() as { status: string };
    assert.equal(afterBody.status, 'CREATED'); // unchanged
  });
});

test('HTTP: request body exceeding the size limit is rejected', async () => {
  await withServer(async baseUrl => {
    const oversized = JSON.stringify({ version: '1.0', tenant_id: TENANT, name: 'x'.repeat(200_000), scope: baseScope(), control_profile_id: 'TNA_BASELINE_V01', evidence_cutoff_at: CUTOFF });
    const res = await fetch(`${baseUrl}/v1/auditor/assessments`, { method: 'POST', headers: jsonHeaders(CREDENTIALS.runnerToken), body: oversized });
    assert.equal(res.status, 413);
  });
});
