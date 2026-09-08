import { DatabaseSync } from 'node:sqlite';
import { hash } from '../../authority-envelope/src/index.js';

/** Single-process durable state. All authorization mutations and audit events commit atomically. */
export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS evidence (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL);`);
    try { this.verifyEvidence(); } catch (error) { this.db.close(); throw error; }
  }
  get<T>(kind: string, id: string): T | null {
    const row = this.db.prepare('SELECT body FROM state WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(String(row.body)) as T : null;
  }
  list<T>(kind: string): T[] {
    return this.db.prepare('SELECT body FROM state WHERE kind=? ORDER BY id').all(kind).map(row => JSON.parse(String(row.body)) as T);
  }
  put(kind: string, id: string, value: unknown): void {
    this.db.prepare('INSERT INTO state(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind, id, JSON.stringify(value));
  }
  append(event: unknown): void {
    const last = this.db.prepare('SELECT hash FROM evidence ORDER BY seq DESC LIMIT 1').get();
    const previous = last ? String(last.hash) : 'GENESIS';
    const body = JSON.stringify(event);
    this.db.prepare('INSERT INTO evidence(body,previous,hash) VALUES(?,?,?)').run(body, previous, hash({ previous, body }));
  }
  events(): unknown[] { return this.db.prepare('SELECT body FROM evidence ORDER BY seq').all().map(row => JSON.parse(String(row.body)) as unknown); }
  verifyEvidence(): void {
    let previous = 'GENESIS';
    for (const row of this.db.prepare('SELECT body,previous,hash FROM evidence ORDER BY seq').all()) {
      if (row.previous !== previous || row.hash !== hash({ previous, body: String(row.body) })) throw new Error('Evidence integrity check failed');
      previous = String(row.hash);
    }
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
