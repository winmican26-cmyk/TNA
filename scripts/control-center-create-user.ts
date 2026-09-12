/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Real operator user-provisioning tool — there
 * is no self-service signup (foundation-review section 66), and until now creating a client user required
 * calling `ControlCenterSessionStore.createUser()` directly from a test/script rather than any real
 * operator-facing tool. This is that tool: connects to the SAME real SQLite database the running BFF uses
 * (`TNA_CONTROL_CENTER_DB_PATH`) and creates one real user row — never a separate, divergent store.
 *
 * Usage: node dist/scripts/control-center-create-user.js <tenant_id> <username> <password> <role>
 */
import { ControlCenterSessionStore } from '../apps/tna-control-center/src/session-store.js';
import { CLIENT_ROLES, type ClientRole } from '../apps/tna-control-center/src/schema.js';

const [tenantId, username, password, role] = process.argv.slice(2);
if (!tenantId || !username || !password || !role) {
  process.stderr.write('Usage: control-center-create-user <tenant_id> <username> <password> <role>\n');
  process.stderr.write(`role must be one of: ${CLIENT_ROLES.join(', ')}\n`);
  process.exit(1);
}
if (!(CLIENT_ROLES as readonly string[]).includes(role)) {
  process.stderr.write(`Invalid role "${role}" — must be one of: ${CLIENT_ROLES.join(', ')}\n`);
  process.exit(1);
}
const dbPath = process.env.TNA_CONTROL_CENTER_DB_PATH ?? 'data/control-center.sqlite';
const sessions = new ControlCenterSessionStore(dbPath);
try {
  const user = sessions.createUser(tenantId, username, password, role as ClientRole);
  process.stdout.write(`Created user ${user.username} (${user.role}) for tenant ${user.tenant_id}\n`);
} finally {
  sessions.close();
}
