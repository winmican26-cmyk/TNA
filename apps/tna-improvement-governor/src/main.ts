/**
 * TNA Recursive Improvement Governance v0.1 (Volume 12), section I-J: the real production composition
 * root. Every mandatory dependency (ImprovementStore, Gate, Ledger, Sentinel) is constructed here,
 * before `server.listen` is ever reached — a construction failure in any one of them throws and crashes
 * the process (a non-zero exit, same as any other fatal startup failure in this project), never a
 * silent fallback to a reduced/unmonitored mode. There is no `IMPROVEMENT_MODE=local-only` escape hatch
 * anywhere in this file.
 */
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Gate } from '../../tna-gate-api/src/gate.js';
import { Store } from '../../../packages/evidence-core/src/index.js';
import { LedgerStore, Ledger } from '../../../packages/ledger-core/src/index.js';
import { SentinelRuntime } from '../../../packages/sentinel-runtime/src/index.js';
import { ImprovementStore } from '../../../packages/improvement-store/src/index.js';
import { loadImprovementGovernorConfig } from './config.js';
import { createImprovementGovernorServer } from './server.js';

const startedAt = Date.now();
const config = loadImprovementGovernorConfig();

for (const path of [config.dbPath, config.gatePath, config.ledgerPath, config.sentinelPath]) {
  mkdirSync(resolve(dirname(path)), { recursive: true, mode: 0o700 });
}

// Fail closed (section J): each of these is a required, real dependency. A thrown error here propagates
// out of this module and crashes the process before `server.listen` is reached.
const store = new ImprovementStore(config.dbPath);
const gateStore = new Store(config.gatePath);
const gate = new Gate(gateStore);
const ledgerStore = new LedgerStore(config.ledgerPath);
const ledger = new Ledger(ledgerStore);
const sentinel = new SentinelRuntime(config.sentinelPath);

console.log('[tna-improvement-governor] Real Gate/Ledger/Sentinel/ImprovementStore wired — no reduced-mode fallback exists');

const server = createImprovementGovernorServer({
  store, gate, ledger, ledgerStore, sentinel, tenantId: config.tenantId, governorAgentId: config.governorAgentId,
  approverRole: config.approverRole, adminToken: config.adminToken, startedAt,
});

server.listen(config.port, config.host, () => {
  console.log(`[tna-improvement-governor] TNA Improvement Governor listening on http://${config.host}:${config.port}`);
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[tna-improvement-governor] Graceful shutdown initiated (${signal})`);
  server.close(() => {
    store.close();
    gateStore.close();
    ledgerStore.close();
    sentinel.close();
    console.log('[tna-improvement-governor] Graceful shutdown complete');
    process.exitCode = 0;
  });
  server.closeIdleConnections();
});
