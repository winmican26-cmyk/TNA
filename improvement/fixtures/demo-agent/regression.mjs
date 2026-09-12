/**
 * TNA Recursive Improvement Governance v0.1 demo fixture — a tiny real regression check
 * `runPromotionEvaluation` spawns as a real process. Exits 0 only if the router still returns a string
 * for every input (a minimal sanity contract a candidate must not break).
 */
import { route } from './router.mjs';

const INPUTS = ['I have a billing question', 'found a bug', 'hello', 'refund please'];
let ok = true;
for (const input of INPUTS) { if (typeof route(input) !== 'string' || route(input).length === 0) ok = false; }
process.exitCode = ok ? 0 : 1;
