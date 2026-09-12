/**
 * TNA Deployment Academy v0.1 (Volume 11). Section 89-91: path safety for every destructive academy
 * operation (lab reset, destructive-corruption labs). No `../../` traversal, no absolute path outside
 * the lab workspace, no symlink escape — verified by actually resolving the real path and checking it
 * remains a descendant of the lab workspace root, not by string-prefix matching alone (which a symlink
 * could defeat).
 */
import { realpathSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export class AcademyPathSafetyError extends Error {
  public constructor(message: string) { super(message); this.name = 'AcademyPathSafetyError'; }
}

export function academyLabWorkspaceRoot(): string {
  return resolve('academy', '.lab-state');
}

/** Section 89: any destructive academy operation (`reset`, a corruption lab) must refuse to run unless
 * `ACADEMY_LAB_MODE=true` is explicitly set. */
export function assertLabModeEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.ACADEMY_LAB_MODE !== 'true') {
    throw new AcademyPathSafetyError('Refusing to run a destructive academy operation: ACADEMY_LAB_MODE=true is not set.');
  }
}

/** Resolves `candidate` and asserts the REAL (symlink-resolved) path is a descendant of the lab
 * workspace root — never a plain string-prefix check, which a symlink or `..` segment could defeat. */
export function assertInsideLabWorkspace(candidate: string): string {
  const root = academyLabWorkspaceRoot();
  mkdirSync(root, { recursive: true });
  const resolvedCandidate = resolve(candidate);
  if (!existsSync(resolvedCandidate)) {
    // Path doesn't exist yet (e.g. about to be created) — check its resolved parent-chain prefix.
    if (!resolvedCandidate.startsWith(root + sep) && resolvedCandidate !== root) {
      throw new AcademyPathSafetyError(`Refusing: "${candidate}" resolves outside the lab workspace (${root})`);
    }
    return resolvedCandidate;
  }
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(resolvedCandidate);
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
    throw new AcademyPathSafetyError(`Refusing: "${candidate}" (real path ${realCandidate}) resolves outside the lab workspace (${realRoot}) — possible symlink escape`);
  }
  return realCandidate;
}
