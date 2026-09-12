/**
 * TNA Recursive Improvement Governance v0.1 demo fixture (section 107-108). A deliberately tiny,
 * deterministic, read-only routing "agent" — the improvement demo's Generation 0 baseline. It has no
 * real tools, no network access, no filesystem writes, and no code execution capability of its own; it
 * only classifies an input string into a category by keyword.
 */
export function route(input) {
  const text = input.toLowerCase();
  if (text.includes('billing')) return 'billing';
  if (text.includes('bug')) return 'support';
  return 'general';
}
