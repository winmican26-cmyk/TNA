/**
 * TNA Deployment Academy v0.1 — Level 4 Lab: The Packaged Path (TNA-64).
 *
 * Objective: prove that the real, PACKAGED client gateway binary — not a library call, not a demo
 * script — actually drives a governed action through Gate, Sentinel, a real MCP process, and Ledger.
 *
 * This lab deliberately reuses the accepted Volume 10 packaged-execution closure's own smoke test
 * (`npm run smoke:client-integration:v01`) rather than re-deriving the same proof by hand: that command
 * already spawns the real compiled `tna-client-gateway` binary and asserts on real Gate/Sentinel/MCP/
 * Ledger evidence, printing exactly `GATE ALLOW`, `SENTINEL CONTINUE`, `MCP INVOKED`,
 * `LEDGER EVIDENCE FOUND` as it verifies each one. Re-running it here is the honest way to teach this
 * lesson: the same real evidence a production operator would rely on, not a simplified restatement.
 */
import { spawnSync } from 'node:child_process';
import { execPath } from 'node:process';
import { resolve } from 'node:path';
import type { LabResult, LabStep } from './blocked-action.js';

const SMOKE_SCRIPT = resolve('dist', 'scripts', 'smoke-client-integration-v01.js');
const REQUIRED_LINES = ['GATE ALLOW', 'SENTINEL CONTINUE', 'MCP INVOKED', 'LEDGER EVIDENCE FOUND', 'ACTION COMPLETED'];

export async function runLab(): Promise<LabResult> {
  const steps: LabStep[] = [];
  const result = spawnSync(execPath, [SMOKE_SCRIPT], { encoding: 'utf8' });
  // spawnSync blocks until the whole smoke-test process (pid noted for
  // tests/academy/process-cleanup.test.ts) exits — including its own accepted Volume 10 `finally` block,
  // which already SIGKILLs the packaged gateway it spawns and waits before returning — so by this line
  // both the direct child and its gateway grandchild are already gone.
  steps.push({ description: `The real packaged client-gateway smoke test (pid ${result.pid}) exits 0`, passed: result.status === 0 });
  for (const line of REQUIRED_LINES) {
    steps.push({ description: `Real evidence line printed: "${line}"`, passed: result.stdout.includes(line) });
  }
  return { lab_id: 'lab-15-packaged-path', passed: steps.every(s => s.passed) && steps.length > 0, steps };
}
