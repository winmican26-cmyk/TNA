import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { LedgerStore, Ledger } from '../../../packages/ledger-core/src/index.js';
import { createLedgerServer } from './server.js';

// Resolve from this compiled module, never from an arbitrary caller's working directory.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const data = resolve(root, 'data');
const tenantId = process.env.TNA_LEDGER_TENANT ?? 'tenant_demo';
const writerGateToken = process.env.TNA_LEDGER_WRITER_GATE_TOKEN ?? '';
const writerVadToken = process.env.TNA_LEDGER_WRITER_VAD_TOKEN ?? '';
const readerToken = process.env.TNA_LEDGER_READER_TOKEN ?? '';
const adminToken = process.env.TNA_LEDGER_ADMIN_TOKEN ?? '';
const port = Number(process.env.PORT ?? 4417);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

mkdirSync(data, { recursive: true });
const store = new LedgerStore(resolve(data, 'tna-ledger.sqlite'));
const ledger = new Ledger(store);
const server = createLedgerServer(ledger, { writerGateToken, writerVadToken, readerToken, adminToken }, tenantId);
server.listen(port, '127.0.0.1', () => process.stdout.write(`TNA Ledger listening on http://127.0.0.1:${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  server.close(() => { store.close(); process.exit(0); });
  server.closeIdleConnections();
});
