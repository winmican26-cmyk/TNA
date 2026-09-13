import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ControlCenterError, CLIENT_ROLES, type ClientRole, type ControlCenterUser, type ControlCenterSession } from './schema.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Real SQLite-backed human user + session
 * store for the Control Center's own browser-facing login boundary — nothing before this volume had a
 * human-login concept anywhere in TNA (every prior backend app authenticates a SERVICE identity via a
 * static bearer token). This is the "smallest secure additive browser session boundary" the kickoff brief
 * calls for (section 51): passwords are hashed with `scrypt` (Node's own built-in, no new dependency), a
 * session is an opaque random id looked up server-side (never a self-asserting signed token), and CSRF
 * tokens are bound to the session row itself, never a bare cookie value trusted alone.
 */

interface UserRow { user_id: string; tenant_id: string; username: string; password_hash: string; role: string; created_at: string; disabled: number }
function rowToUser(row: UserRow): ControlCenterUser {
  return { user_id: row.user_id, tenant_id: row.tenant_id, username: row.username, role: row.role as ClientRole, created_at: row.created_at, disabled: row.disabled === 1 };
}
interface SessionRow { session_id: string; user_id: string; tenant_id: string; role: string; csrf_token: string; created_at: string; expires_at: string }
function rowToSession(row: SessionRow): ControlCenterSession {
  return { session_id: row.session_id, user_id: row.user_id, tenant_id: row.tenant_id, role: row.role as ClientRole, csrf_token: row.csrf_token, created_at: row.created_at, expires_at: row.expires_at };
}

const SCRYPT_KEYLEN = 64;
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}
function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const SESSION_TTL_MS = 8 * 3600_000; // 8 hours — a real, bounded, server-enforced expiry (section 17).

/**
 * Signup / password-reset tokens. Design decision (supersedes the earlier "no self-service signup" note):
 * this project has no email-sending capability anywhere and none is added here — inventing one would mean
 * either fabricating delivery that never actually happens, or taking on a real external service dependency
 * with credentials nobody has provided. Instead, both flows are ADMIN-MEDIATED and OUT-OF-BAND, mirroring
 * the "credential shown once" pattern already established for service-identity issuance
 * (`packages/client-schema`'s `issueCredential`):
 *   - Signup: a `client-admin` names the exact username+role for a NEW account in their own tenant and
 *     receives a real, single-use, expiring token shown exactly once. The admin still decides WHO gets an
 *     account and WHAT role/tenant it has — self-service is limited to the invitee choosing their own
 *     password, never their own tenant or role.
 *   - Password reset: a `client-admin` names an EXISTING username in their own tenant and receives a real,
 *     single-use, expiring token, shown once, to deliver via their own channel.
 * A token is a bare `randomBytes(32)` hex string — the same entropy as a session id — so brute-forcing one
 * is infeasible regardless of rate limiting, and it is looked up by exact value (not hashed), matching this
 * store's own existing session-id convention (SQLite file access is already the real trust boundary here).
 */
const SIGNUP_TOKEN_TTL_MS = 7 * 24 * 3600_000; // 7 days — long enough to actually deliver out of band.
const RESET_TOKEN_TTL_MS = 3600_000; // 1 hour — shorter-lived, since a reset is a more sensitive action.
export type ControlCenterTokenKind = 'SIGNUP' | 'PASSWORD_RESET';
interface TokenRow { token: string; kind: ControlCenterTokenKind; tenant_id: string; username: string; role: string | null; created_at: string; expires_at: string; used_at: string | null }

export class ControlCenterSessionStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;

  /** `clock` is injectable — foundation-review section 6: expiry must be provable with a deterministic
   * clock, never only "wait for real wall-clock time to pass" in a test. Defaults to the real `Date.now`
   * for every production/non-test caller; every prior TNA store (`PlatformStore`, `SentinelRuntime`, etc.)
   * follows this same injectable-clock convention. */
  public constructor(dbPath: string, options: { readonly clock?: () => number } = {}) {
    this.db = new DatabaseSync(dbPath);
    this.clock = options.clock ?? (() => Date.now());
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS control_center_users (
        user_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, username TEXT NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL, created_at TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS control_center_users_username ON control_center_users(username);
      CREATE TABLE IF NOT EXISTS control_center_sessions (
        session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, role TEXT NOT NULL,
        csrf_token TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS control_center_incident_acknowledgments (
        tenant_id TEXT NOT NULL, signature TEXT NOT NULL, acknowledged_by TEXT NOT NULL, acknowledged_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, signature));
      CREATE TABLE IF NOT EXISTS control_center_tokens (
        token TEXT PRIMARY KEY, kind TEXT NOT NULL, tenant_id TEXT NOT NULL, username TEXT NOT NULL, role TEXT,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
    `);
  }

  private now(): string { return new Date(this.clock()).toISOString(); }

/** Real, direct user provisioning by a trusted operator/CLI process that already knows the password (e.g.
   * `scripts/control-center-create-user.ts`). The BROWSER-facing path for a `client-admin` to provision a
   * teammate is the invite flow below (`createSignupInvite`/`redeemSignupInvite`), which never requires the
   * admin to know or transmit the new user's password at all. */
  public createUser(tenantId: string, username: string, password: string, role: ClientRole): ControlCenterUser {
    if (!(CLIENT_ROLES as readonly string[]).includes(role)) throw new ControlCenterError('INVALID_INPUT', `role must be one of: ${CLIENT_ROLES.join(', ')}`);
    if (password.length < 12) throw new ControlCenterError('INVALID_INPUT', 'password must be at least 12 characters');
    const userId = `ccu_${randomUUID()}`;
    const passwordHash = hashPassword(password);
    try {
      this.db.prepare('INSERT INTO control_center_users VALUES (?,?,?,?,?,?,0)').run(userId, tenantId, username, passwordHash, role, this.now());
    } catch {
      throw new ControlCenterError('CONFLICT', `username ${username} is already taken`);
    }
    return this.getUserById(userId);
  }
  public getUserById(userId: string): ControlCenterUser {
    const row = this.db.prepare('SELECT * FROM control_center_users WHERE user_id=?').get(userId) as unknown as UserRow | undefined;
    if (!row) throw new ControlCenterError('NOT_FOUND', `No user ${userId}`);
    return rowToUser(row);
  }
  /** Section 27: a suspended/offboarded client's users must stop authenticating. Real, not a placeholder
   * — `authenticate()` checks this same column on every login attempt. */
  public setDisabled(userId: string, disabled: boolean): void {
    const changed = this.db.prepare('UPDATE control_center_users SET disabled=? WHERE user_id=?').run(disabled ? 1 : 0, userId);
    if (changed.changes !== 1) throw new ControlCenterError('NOT_FOUND', `No user ${userId}`);
  }

  /** For the "reset password" admin UI: real users of the admin's OWN tenant only — a route handler must
   * always pass `session.tenant_id` here, never a caller-supplied tenant. */
  public listUsers(tenantId: string): readonly ControlCenterUser[] {
    const rows = this.db.prepare('SELECT * FROM control_center_users WHERE tenant_id=? ORDER BY created_at').all(tenantId) as unknown as UserRow[];
    return rows.map(rowToUser);
  }
  private findUserByUsernameInTenant(tenantId: string, username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM control_center_users WHERE tenant_id=? AND username=?').get(tenantId, username) as unknown as UserRow | undefined;
  }

  /** A `client-admin` names the exact username+role for a brand-new account in their OWN tenant (the
   * caller must pass `session.tenant_id`, never a client-supplied one). Real, single-use, expiring token —
   * returned once; there is no way to retrieve it again after this call, matching `issueCredential()`'s own
   * shown-once discipline. Throws if the username is already taken (checked now, and re-checked atomically
   * at redemption in case of a race). */
  public createSignupInvite(tenantId: string, username: string, role: ClientRole): { readonly token: string; readonly expires_at: string } {
    if (!(CLIENT_ROLES as readonly string[]).includes(role)) throw new ControlCenterError('INVALID_INPUT', `role must be one of: ${CLIENT_ROLES.join(', ')}`);
    // `username` carries a GLOBAL unique index (not per-tenant) — checked here up front for a fast, clear
    // error; `createUser()` at redemption time is the real, race-safe enforcement (its own INSERT relies on
    // that same unique index and throws CONFLICT on a collision regardless of what this check saw).
    if (this.db.prepare('SELECT 1 FROM control_center_users WHERE username=?').get(username)) {
      throw new ControlCenterError('CONFLICT', `username ${username} is already taken`);
    }
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(this.clock() + SIGNUP_TOKEN_TTL_MS).toISOString();
    this.db.prepare('INSERT INTO control_center_tokens VALUES (?,?,?,?,?,?,?,NULL)').run(token, 'SIGNUP', tenantId, username, role, this.now(), expiresAt);
    return { token, expires_at: expiresAt };
  }

  /** A `client-admin` names an EXISTING username in their OWN tenant. Real, single-use, expiring token,
   * returned once. Deliberately does not confirm or deny whether a username exists via a different
   * response shape beyond the real `NOT_FOUND` — this is an authenticated admin action, not a public
   * "forgot password" form, so username enumeration by an anonymous attacker is not this route's threat
   * model; the admin already knows their own team's usernames. */
  public createPasswordResetToken(tenantId: string, username: string): { readonly token: string; readonly expires_at: string } {
    const user = this.findUserByUsernameInTenant(tenantId, username);
    if (!user) throw new ControlCenterError('NOT_FOUND', `No user ${username} in this tenant`);
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(this.clock() + RESET_TOKEN_TTL_MS).toISOString();
    this.db.prepare('INSERT INTO control_center_tokens VALUES (?,?,?,?,NULL,?,?,NULL)').run(token, 'PASSWORD_RESET', tenantId, username, this.now(), expiresAt);
    return { token, expires_at: expiresAt };
  }

  private consumeToken(token: string, kind: ControlCenterTokenKind): TokenRow {
    const row = this.db.prepare('SELECT * FROM control_center_tokens WHERE token=?').get(token) as unknown as TokenRow | undefined;
    if (!row || row.kind !== kind) throw new ControlCenterError('INVALID_INPUT', 'This link is invalid.');
    if (row.used_at !== null) throw new ControlCenterError('INVALID_INPUT', 'This link has already been used.');
    if (Date.parse(row.expires_at) <= this.clock()) throw new ControlCenterError('INVALID_INPUT', 'This link has expired.');
    // Marked used BEFORE the caller acts on it, and only one row can ever match `used_at IS NULL` for a
    // given token — a concurrent double-redemption race is closed by this UPDATE's own atomicity (SQLite
    // serializes writes), not merely by application-level checking above.
    const changed = this.db.prepare('UPDATE control_center_tokens SET used_at=? WHERE token=? AND used_at IS NULL').run(this.now(), token);
    if (changed.changes !== 1) throw new ControlCenterError('INVALID_INPUT', 'This link has already been used.');
    return row;
  }

  /** Redeems a real, admin-issued signup invite: the invitee chooses only their password — tenant and role
   * were fixed by the admin at invite time and cannot be influenced here. */
  public redeemSignupInvite(token: string, password: string): ControlCenterUser {
    const row = this.consumeToken(token, 'SIGNUP');
    return this.createUser(row.tenant_id, row.username, password, row.role as ClientRole);
  }

  /** Redeems a real, admin-issued password-reset token. Real server-side session invalidation: every
   * existing session for this user is destroyed — a credential change must not leave old sessions (issued
   * under the OLD password) still valid. This is a narrow, event-triggered action distinct from the
   * deliberately-declined general "log out all other sessions" feature (foundation-review section 4): it
   * fires only as a consequence of the credential itself changing, not as a standalone capability. */
  public redeemPasswordReset(token: string, newPassword: string): void {
    const row = this.consumeToken(token, 'PASSWORD_RESET');
    if (newPassword.length < 12) throw new ControlCenterError('INVALID_INPUT', 'password must be at least 12 characters');
    const user = this.findUserByUsernameInTenant(row.tenant_id, row.username);
    if (!user) throw new ControlCenterError('NOT_FOUND', 'This account no longer exists.');
    const passwordHash = hashPassword(newPassword);
    this.db.prepare('UPDATE control_center_users SET password_hash=? WHERE user_id=?').run(passwordHash, user.user_id);
    this.db.prepare('DELETE FROM control_center_sessions WHERE user_id=?').run(user.user_id);
  }

  /** Real credential verification — never a stub, never a hardcoded ALLOW. Returns `null` on any failure
   * (unknown username, disabled account, wrong password) rather than distinguishing the reason, so a
   * caller cannot enumerate valid usernames from the login endpoint's response shape. */
  public authenticate(username: string, password: string): ControlCenterUser | null {
    const row = this.db.prepare('SELECT * FROM control_center_users WHERE username=?').get(username) as unknown as UserRow | undefined;
    if (!row || row.disabled === 1) return null;
    if (!verifyPassword(password, row.password_hash)) return null;
    return rowToUser(row);
  }

  /** Section 4/foundation-review: mints a BRAND-NEW, freshly-random session id on every call — there is
   * no parameter here through which a caller (or, transitively, an attacker who supplied a pre-login
   * cookie) could ever influence what the resulting session id is. This is the structural reason session
   * fixation cannot occur: the authenticated session id is never anything but a fresh
   * `randomBytes(32)` value minted at the moment of successful authentication. Documented multi-session
   * semantics (foundation-review section 4): a user may hold multiple concurrent, independent sessions
   * (e.g. two browsers/devices) — a new login does NOT invalidate a user's other existing sessions. Each
   * session is independently random, independently expiring, and independently revocable
   * (`destroySession` takes the specific session id, never "all sessions for this user"). This is a
   * deliberate product decision for a multi-device client console, not an oversight — see
   * `docs/control-center/control-center-foundation-review-v0.1.md`. */
  public createSession(user: ControlCenterUser): ControlCenterSession {
    const sessionId = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    const createdAt = this.now();
    const expiresAt = new Date(this.clock() + SESSION_TTL_MS).toISOString();
    this.db.prepare('INSERT INTO control_center_sessions VALUES (?,?,?,?,?,?,?)').run(sessionId, user.user_id, user.tenant_id, user.role, csrfToken, createdAt, expiresAt);
    return this.getSession(sessionId)!;
  }

  /** Returns `null` for a missing OR expired session — the caller never has to separately check
   * `expires_at`, and there is no code path that treats an expired session as valid "just this once".
   * Expiry is evaluated against THIS store's own clock (real wall-clock time in production, injectable in
   * tests) — never trusted from the browser's cookie `Max-Age`, which is only ever hygiene, not authority. */
  public getSession(sessionId: string): ControlCenterSession | null {
    const row = this.db.prepare('SELECT * FROM control_center_sessions WHERE session_id=?').get(sessionId) as unknown as SessionRow | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= this.clock()) { this.destroySession(sessionId); return null; }
    return rowToSession(row);
  }
  /** Real server-side deletion of the session row — this is what makes logout authoritative rather than
   * "the browser agreed to forget its cookie." A captured/replayed cookie for a destroyed session id can
   * never authenticate again: `getSession` finds no row and returns `null`. */
  public destroySession(sessionId: string): void {
    this.db.prepare('DELETE FROM control_center_sessions WHERE session_id=?').run(sessionId);
  }

  /** Section on Incidents (build-order item 15-16): this records ONLY that a real human, at a real time,
   * acknowledged a specific real incident signature — never a claim about the underlying condition itself
   * (which remains freshly recomputed from real backend state on every `/api/incidents` request, and is
   * never marked "resolved" by an acknowledgment). No accepted backend volume has an Incident store to
   * persist this against; this table is the Control Center's own, narrowly-scoped, honestly-labeled
   * record of human interaction with the assurance view, not manufactured backend evidence. */
  public acknowledgeIncident(tenantId: string, signature: string, acknowledgedBy: string): void {
    this.db.prepare('INSERT OR REPLACE INTO control_center_incident_acknowledgments VALUES (?,?,?,?)').run(tenantId, signature, acknowledgedBy, this.now());
  }
  public getIncidentAcknowledgments(tenantId: string): ReadonlyMap<string, { readonly acknowledged_by: string; readonly acknowledged_at: string }> {
    const rows = this.db.prepare('SELECT signature, acknowledged_by, acknowledged_at FROM control_center_incident_acknowledgments WHERE tenant_id=?').all(tenantId) as unknown as { signature: string; acknowledged_by: string; acknowledged_at: string }[];
    return new Map(rows.map(r => [r.signature, { acknowledged_by: r.acknowledged_by, acknowledged_at: r.acknowledged_at }]));
  }

  public close(): void { this.db.close(); }
}
