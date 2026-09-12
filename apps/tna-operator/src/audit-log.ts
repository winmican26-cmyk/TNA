/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). Section 73: every consequential CLI
 * action must be evidenced — actor, operation, target, tenant, reason, before/after, correlation,
 * timestamp. This is a real, durable, local SQLite store distinct from (and additive to) the evidence
 * each accepted subsystem already records for its own domain — it captures the *operator's own act of
 * running a command*, which no subsystem's own evidence model represents (Ledger records what an agent
 * did; this records what an operator told the CLI to do, including commands whose target subsystem
 * refused them).
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface OperatorAuditEntry {
  readonly entry_id: string;
  readonly timestamp: string;
  readonly actor: string;
  readonly role: string;
  readonly operation: string;
  readonly target: string | null;
  readonly tenant_id: string | null;
  readonly reason: string | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly correlation_id: string | null;
  readonly outcome: 'OK' | 'DENIED' | 'FAILED';
}

export class OperatorAuditLog {
  private readonly db: DatabaseSync;
  public constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000;
      CREATE TABLE IF NOT EXISTS operator_audit (
        entry_id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL,
        operation TEXT NOT NULL, target TEXT, tenant_id TEXT, reason TEXT, before_json TEXT, after_json TEXT,
        correlation_id TEXT, outcome TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operator_audit_tenant ON operator_audit(tenant_id, timestamp);`);
  }
  public record(input: Omit<OperatorAuditEntry, 'entry_id' | 'timestamp'>): OperatorAuditEntry {
    const entry: OperatorAuditEntry = { entry_id: `oaud_${randomUUID()}`, timestamp: new Date().toISOString(), ...input };
    this.db.prepare(`INSERT INTO operator_audit VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      entry.entry_id, entry.timestamp, entry.actor, entry.role, entry.operation, entry.target, entry.tenant_id,
      entry.reason, entry.before, entry.after, entry.correlation_id, entry.outcome,
    );
    return entry;
  }
  public listForTenant(tenantId: string, limit = 200): readonly OperatorAuditEntry[] {
    return (this.db.prepare('SELECT * FROM operator_audit WHERE tenant_id = ? ORDER BY timestamp DESC LIMIT ?').all(tenantId, limit) as unknown as Record<string, unknown>[])
      .map(rowToEntry);
  }
  public recent(limit = 200): readonly OperatorAuditEntry[] {
    return (this.db.prepare('SELECT * FROM operator_audit ORDER BY timestamp DESC LIMIT ?').all(limit) as unknown as Record<string, unknown>[])
      .map(rowToEntry);
  }
  public close(): void { this.db.close(); }
}

function rowToEntry(row: Record<string, unknown>): OperatorAuditEntry {
  return {
    entry_id: row.entry_id as string, timestamp: row.timestamp as string, actor: row.actor as string, role: row.role as string,
    operation: row.operation as string, target: row.target as string | null, tenant_id: row.tenant_id as string | null,
    reason: row.reason as string | null, before: row.before_json as string | null, after: row.after_json as string | null,
    correlation_id: row.correlation_id as string | null, outcome: row.outcome as OperatorAuditEntry['outcome'],
  };
}
