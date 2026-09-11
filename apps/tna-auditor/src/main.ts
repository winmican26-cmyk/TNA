import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { LedgerStore, Ledger } from '../../../packages/ledger-core/src/index.js';
import { AuditorRuntime } from '../../../packages/auditor-engine/src/index.js';
import { LedgerEvidenceProvider } from '../../../packages/auditor-evidence/src/index.js';
import { createAuditorServer, type AuditorCredentials } from './server.js';

// Resolve from this compiled module, never from an arbitrary caller's working directory.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const data = resolve(root, 'data');
const tenantId = process.env.TNA_AUDITOR_TENANT ?? 'tenant_demo';
const env = (name: string): string => process.env[name] ?? '';
const credentials: AuditorCredentials = {
  readerToken: env('TNA_AUDITOR_READER_TOKEN'), runnerToken: env('TNA_AUDITOR_RUNNER_TOKEN'), adminToken: env('TNA_AUDITOR_ADMIN_TOKEN'),
};
const port = Number(process.env.PORT ?? 4617);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

mkdirSync(data, { recursive: true });
// Opens the same Ledger database the accepted tna-ledger app writes to (WAL mode supports multiple
// reader connections, including from a separate process) — Auditor never opens it for writing.
const ledgerStore = new LedgerStore(resolve(data, 'tna-ledger.sqlite'));
const ledger = new Ledger(ledgerStore);
const evidenceProvider = new LedgerEvidenceProvider(ledger, { readerId: 'ledger-reader-auditor' });
const runtime = new AuditorRuntime(resolve(data, 'tna-auditor.sqlite'), { evidenceProvider });

const server = createAuditorServer(runtime, credentials, tenantId);
server.listen(port, '127.0.0.1', () => process.stdout.write(`TNA Auditor listening on http://127.0.0.1:${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  server.close(() => { runtime.close(); ledgerStore.close(); process.exit(0); });
  server.closeIdleConnections();
});
