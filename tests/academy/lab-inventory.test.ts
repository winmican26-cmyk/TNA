import assert from 'node:assert/strict';
import test from 'node:test';
import { LAB_IDS, LAB_META } from '../../academy/labs/registry.js';

/**
 * TNA Deployment Academy v0.1. Section 12, 40: the final academy must include exactly the required
 * lab-01 through lab-15 inventory — asserted explicitly here, not merely inferred from other tests'
 * generic iteration over whatever LAB_IDS happens to contain.
 */

const REQUIRED_TITLES: Readonly<Record<number, string>> = {
  1: 'Blocked Action', 2: 'Held Action', 3: 'Sentinel Termination', 4: 'VAD Rejection',
  5: 'Ledger Reconstruction', 6: 'Ledger Corruption', 7: 'MCP Tool Discovery', 8: 'MCP Schema Drift',
  9: 'Client Bypass', 10: 'Tenant Isolation', 11: 'Backup & Restore', 12: 'Outbox Failure',
  13: 'Incident Triage', 14: 'Client Offboarding', 15: 'Packaged Path',
};

test('exactly 15 labs are registered — no accidental missing or extra lab', () => {
  assert.equal(LAB_IDS.length, 15);
  assert.equal(LAB_META.length, 15);
});

for (let n = 1; n <= 15; n += 1) {
  const padded = String(n).padStart(2, '0');
  test(`lab-${padded} exists in the registry with its required title ("${REQUIRED_TITLES[n]}")`, () => {
    const found = LAB_META.find(l => l.id.startsWith(`lab-${padded}-`));
    assert.ok(found, `no registered lab starts with "lab-${padded}-"`);
    assert.equal(found!.title, REQUIRED_TITLES[n]);
  });
}

test('every lab id is unique', () => {
  const seen = new Set<string>();
  for (const id of LAB_IDS) { assert.ok(!seen.has(id), `duplicate lab id: ${id}`); seen.add(id); }
});

test('every lab declares a valid level 1-4', () => {
  for (const meta of LAB_META) assert.ok([1, 2, 3, 4].includes(meta.level), `${meta.id} has invalid level ${meta.level}`);
});

test('every level has at least one lab', () => {
  for (const level of [1, 2, 3, 4] as const) {
    assert.ok(LAB_META.some(l => l.level === level), `level ${level} has no labs`);
  }
});

test('destructive labs are explicitly flagged (Ledger Corruption, Backup & Restore)', () => {
  const destructiveTitles = LAB_META.filter(l => l.destructive).map(l => l.title).sort();
  assert.deepEqual(destructiveTitles, ['Backup & Restore', 'Ledger Corruption']);
});
