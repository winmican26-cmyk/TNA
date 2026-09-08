import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Store } from '../../../packages/evidence-core/src/index.js';
import { Gate } from './gate.js';
import { createGateServer } from './server.js';

// Resolve from this compiled module, never from an arbitrary caller's working directory.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const data = resolve(root, 'data');
const adminToken = process.env.TNA_ADMIN_TOKEN ?? '';
const releaseToken = process.env.TNA_RELEASE_TOKEN ?? '';
const securityToken = process.env.TNA_SECURITY_TOKEN ?? '';
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
mkdirSync(data, { recursive: true });
const store = new Store(resolve(data, 'tna.sqlite'));
const server = createGateServer(new Gate(store), { adminToken, approvers: [
  { token: releaseToken, role: 'human-release-manager' }, { token: securityToken, role: 'security' },
] });
server.listen(port, '127.0.0.1', () => process.stdout.write(`TNA Gate listening on http://127.0.0.1:${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  server.close(() => { store.close(); process.exit(0); });
  server.closeIdleConnections();
});
