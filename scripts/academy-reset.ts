/**
 * TNA Deployment Academy v0.1 — `npm run academy:reset`. Section 42-43: resets ONLY the academy's own
 * lab-state workspace (`academy/.lab-state/`), never real deployment data. Section 89: requires
 * `ACADEMY_LAB_MODE=true` explicitly and validates the target path stays inside the lab workspace before
 * deleting anything.
 */
import { rmSync, mkdirSync } from 'node:fs';
import { assertLabModeEnabled, assertInsideLabWorkspace, academyLabWorkspaceRoot, AcademyPathSafetyError } from '../academy/lib/lab-paths.js';

function main(): void {
  try {
    assertLabModeEnabled();
    const root = academyLabWorkspaceRoot();
    const verified = assertInsideLabWorkspace(root);
    rmSync(verified, { recursive: true, force: true });
    mkdirSync(verified, { recursive: true });
    process.stdout.write(`Academy lab workspace reset: ${verified}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof AcademyPathSafetyError ? error.message : (error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
}

main();
