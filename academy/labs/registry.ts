/**
 * TNA Deployment Academy v0.1. The complete, closed set of 15 hands-on labs (section 40, 58-59: real
 * TNA state, deterministic verification, never student self-report).
 */
import { runLab as blockedAction } from './blocked-action.js';
import { runLab as heldAction } from './held-action.js';
import { runLab as sentinelTermination } from './sentinel-termination.js';
import { runLab as vadRejection } from './vad-rejection.js';
import { runLab as ledgerReconstruction } from './ledger-reconstruction.js';
import { runLab as ledgerCorruption } from './ledger-corruption.js';
import { runLab as mcpDiscovery } from './mcp-discovery.js';
import { runLab as schemaDrift } from './schema-drift.js';
import { runLab as clientBypass } from './client-bypass.js';
import { runLab as tenantIsolation } from './tenant-isolation.js';
import { runLab as backupRestore } from './backup-restore.js';
import { runLab as outboxFailure } from './outbox-failure.js';
import { runLab as incidentTriage } from './incident-triage.js';
import { runLab as clientOffboarding } from './client-offboarding.js';
import { runLab as packagedPath } from './packaged-path.js';
import type { LabResult } from './blocked-action.js';

export const LAB_IDS = [
  'lab-01-blocked-action', 'lab-02-held-action', 'lab-03-sentinel-termination', 'lab-04-vad-rejection',
  'lab-05-ledger-reconstruction', 'lab-06-ledger-corruption', 'lab-07-mcp-discovery', 'lab-08-schema-drift',
  'lab-09-client-bypass', 'lab-10-tenant-isolation', 'lab-11-backup-restore', 'lab-12-outbox-failure',
  'lab-13-incident-triage', 'lab-14-client-offboarding', 'lab-15-packaged-path',
] as const;
export type LabId = typeof LAB_IDS[number];

export interface LabMeta { readonly id: LabId; readonly title: string; readonly level: 1 | 2 | 3 | 4; readonly destructive: boolean }

export const LAB_META: readonly LabMeta[] = [
  { id: 'lab-01-blocked-action', title: 'Blocked Action', level: 1, destructive: false },
  { id: 'lab-02-held-action', title: 'Held Action', level: 1, destructive: false },
  { id: 'lab-03-sentinel-termination', title: 'Sentinel Termination', level: 4, destructive: false },
  { id: 'lab-04-vad-rejection', title: 'VAD Rejection', level: 1, destructive: false },
  { id: 'lab-05-ledger-reconstruction', title: 'Ledger Reconstruction', level: 4, destructive: false },
  { id: 'lab-06-ledger-corruption', title: 'Ledger Corruption', level: 4, destructive: true },
  { id: 'lab-07-mcp-discovery', title: 'MCP Tool Discovery', level: 2, destructive: false },
  { id: 'lab-08-schema-drift', title: 'MCP Schema Drift', level: 2, destructive: false },
  { id: 'lab-09-client-bypass', title: 'Client Bypass', level: 2, destructive: false },
  { id: 'lab-10-tenant-isolation', title: 'Tenant Isolation', level: 2, destructive: false },
  { id: 'lab-11-backup-restore', title: 'Backup & Restore', level: 3, destructive: true },
  { id: 'lab-12-outbox-failure', title: 'Outbox Failure', level: 3, destructive: false },
  { id: 'lab-13-incident-triage', title: 'Incident Triage', level: 2, destructive: false },
  { id: 'lab-14-client-offboarding', title: 'Client Offboarding', level: 2, destructive: false },
  { id: 'lab-15-packaged-path', title: 'Packaged Path', level: 4, destructive: false },
];

const RUNNERS: Readonly<Record<LabId, () => Promise<LabResult>>> = {
  'lab-01-blocked-action': blockedAction,
  'lab-02-held-action': heldAction,
  'lab-03-sentinel-termination': sentinelTermination,
  'lab-04-vad-rejection': vadRejection,
  'lab-05-ledger-reconstruction': ledgerReconstruction,
  'lab-06-ledger-corruption': ledgerCorruption,
  'lab-07-mcp-discovery': mcpDiscovery,
  'lab-08-schema-drift': schemaDrift,
  'lab-09-client-bypass': clientBypass,
  'lab-10-tenant-isolation': tenantIsolation,
  'lab-11-backup-restore': backupRestore,
  'lab-12-outbox-failure': outboxFailure,
  'lab-13-incident-triage': incidentTriage,
  'lab-14-client-offboarding': clientOffboarding,
  'lab-15-packaged-path': packagedPath,
};

export function isLabId(value: string): value is LabId {
  return (LAB_IDS as readonly string[]).includes(value);
}

export function labMeta(id: LabId): LabMeta {
  return LAB_META.find(m => m.id === id)!;
}

export async function runLabById(id: LabId): Promise<LabResult> {
  return RUNNERS[id]();
}
