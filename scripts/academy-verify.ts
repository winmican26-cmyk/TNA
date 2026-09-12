/**
 * TNA Deployment Academy v0.1 — `npm run academy:verify -- <lab-id>`. Section 58, 59: deterministic,
 * real-state lab verification — never "student says complete". Exit 0 only if every step of the named
 * lab actually passed against real TNA state.
 */
import { LAB_IDS, isLabId, runLabById } from '../academy/labs/registry.js';

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id || !isLabId(id)) {
    process.stderr.write(`Usage: academy:verify -- <lab-id>\nKnown labs: ${LAB_IDS.join(', ')}\n`);
    process.exitCode = 2;
    return;
  }
  const result = await runLabById(id);
  process.stdout.write(`\n=== Academy Lab: ${result.lab_id} ===\n`);
  for (const step of result.steps) process.stdout.write(`${step.passed ? '✓' : '✗'} ${step.description}\n`);
  process.stdout.write(`\nResult: ${result.passed ? 'PASSED' : 'FAILED'}\n`);
  process.exitCode = result.passed ? 0 : 1;
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
