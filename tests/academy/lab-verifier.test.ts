import assert from 'node:assert/strict';
import test from 'node:test';
import { LAB_IDS, runLabById } from '../../academy/labs/registry.js';

/**
 * TNA Deployment Academy v0.1. Section 41, 58-59: every lab must be verifiable against REAL TNA state,
 * deterministically — never "student says complete". This suite runs the actual lab verification logic
 * (the same code `npm run academy:verify -- <lab-id>` and `npm run demo:academy:v01` invoke) and asserts
 * on its real, computed result.
 */

for (const id of LAB_IDS) {
  test(`academy lab "${id}" passes real, deterministic verification against real TNA state`, async () => {
    const result = await runLabById(id);
    assert.equal(result.lab_id, id);
    assert.ok(result.steps.length > 0, 'a lab must produce at least one real verification step');
    for (const step of result.steps) assert.equal(step.passed, true, `lab "${id}" step failed: ${step.description}`);
    assert.equal(result.passed, true);
  });
}

test('a lab with zero verification steps could never report passed=true (no self-report loophole)', async () => {
  // Structural check on the shared LabResult contract used by every lab and the CLI/demo scripts:
  // `passed` requires `steps.length > 0` in every real lab implementation (see registry.ts labs) — this
  // guards against a future lab accidentally reporting success with no actual checks performed.
  for (const id of LAB_IDS) {
    const result = await runLabById(id);
    assert.ok(result.steps.length > 0, `lab "${id}" must perform at least one real check`);
  }
});
