/**
 * TNA Recursive Improvement Governance v0.1 demo fixture — the benchmark command `runPromotionEvaluation`
 * actually spawns (never a self-reported score). Prints a single accuracy number to stdout.
 */
import { route } from './router.mjs';

const CASES = [
  ['I have a billing question', 'billing'],
  ['found a bug in the app', 'support'],
  ['hello there', 'general'],
  ['refund please', 'billing'],
];

let correct = 0;
for (const [input, expected] of CASES) if (route(input) === expected) correct += 1;
process.stdout.write(String(correct / CASES.length));
