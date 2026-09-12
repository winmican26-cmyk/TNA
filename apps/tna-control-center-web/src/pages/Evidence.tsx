import { useState } from 'react';
import { api, ApiError, type LedgerEvent, type StreamVerificationResult, type FullVerificationResult } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Evidence Explorer. Every row is a real
 * `LedgerEvent` from `apps/tna-ledger`'s own hash-chained store — this page never renders the Ledger's
 * internal storage details (no raw SQLite rows, no file paths, no bearer tokens), only the real
 * event/stream identifiers and hashes the Ledger itself already returns over its public API. Pagination is
 * bounded (a fixed page size, `nextCursor`-driven) — never an unbounded "load everything" query.
 */

type IntegrityDisplay = 'VERIFIED' | 'UNVERIFIED' | 'CORRUPT' | 'UNAVAILABLE' | 'UNKNOWN';
function IntegrityBadge({ status }: { readonly status: IntegrityDisplay }) {
  const cls = status === 'VERIFIED' ? 'status-VERIFIED' : status === 'CORRUPT' ? 'status-CORRUPT' : status === 'UNAVAILABLE' ? 'status-UNAVAILABLE' : status === 'UNVERIFIED' ? 'status-DEGRADED' : 'status-UNKNOWN';
  return <span className={`status-badge ${cls}`}>{status}</span>;
}

const PAGE_SIZE = 25;

export default function Evidence() {
  const [correlationId, setCorrelationId] = useState('');
  const [streamId, setStreamId] = useState('');
  const [eventType, setEventType] = useState('');
  const [items, setItems] = useState<readonly LedgerEvent[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [streamChecks, setStreamChecks] = useState<Record<string, StreamVerificationResult | 'UNAVAILABLE' | 'LOADING'>>({});
  const [wholeLedger, setWholeLedger] = useState<FullVerificationResult | 'UNAVAILABLE' | 'LOADING' | null>(null);

  const search = (useCursor?: string) => {
    setLoading(true);
    setError(null);
    api.evidenceSearch({
      correlationId: correlationId || undefined, streamId: streamId || undefined, eventType: eventType || undefined,
      limit: PAGE_SIZE, cursor: useCursor,
    }).then(page => { setItems(page.items); setNextCursor(page.nextCursor); setCursor(useCursor); })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Search failed'))
      .finally(() => setLoading(false));
  };

  const verifyStream = (id: string) => {
    setStreamChecks(prev => ({ ...prev, [id]: 'LOADING' }));
    api.evidenceStreamVerify(id)
      .then(result => setStreamChecks(prev => ({ ...prev, [id]: result })))
      .catch(() => setStreamChecks(prev => ({ ...prev, [id]: 'UNAVAILABLE' })));
  };
  const streamIntegrityDisplay = (id: string): IntegrityDisplay => {
    const check = streamChecks[id];
    if (!check) return 'UNKNOWN';
    if (check === 'LOADING') return 'UNKNOWN';
    if (check === 'UNAVAILABLE') return 'UNAVAILABLE';
    return check.valid ? 'VERIFIED' : 'CORRUPT';
  };

  const runVerifyAll = () => {
    setWholeLedger('LOADING');
    api.evidenceVerifyAll().then(setWholeLedger).catch(() => setWholeLedger('UNAVAILABLE'));
  };

  const uniqueStreamIds = items ? [...new Set(items.map(e => e.stream_id))] : [];

  return (
    <div>
      <h1>Evidence Explorer</h1>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Ledger integrity (whole tenant)</h3>
        <p className="muted" style={{ fontSize: 12 }}>
          The <code>valid</code> field below is a BFF-computed projection of the real Ledger's own
          <code> invalidStreams === 0</code> count — a direct read of authoritative Ledger output, never an
          independently fabricated status.
        </p>
        <button onClick={runVerifyAll} disabled={wholeLedger === 'LOADING'}>{wholeLedger === 'LOADING' ? 'Verifying…' : 'Verify whole ledger'}</button>
        {wholeLedger && wholeLedger !== 'LOADING' && (
          <p style={{ marginTop: 8 }}>
            {wholeLedger === 'UNAVAILABLE'
              ? <IntegrityBadge status="UNAVAILABLE" />
              : <>
                <IntegrityBadge status={wholeLedger.valid ? 'VERIFIED' : 'CORRUPT'} />{' '}
                <span className="muted">{wholeLedger.validStreams} valid / {wholeLedger.invalidStreams} invalid streams, {wholeLedger.eventsChecked} events checked</span>
              </>}
          </p>
        )}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Search</h3>
        <div className="grid">
          <label>Correlation ID<input type="text" value={correlationId} onChange={e => setCorrelationId(e.target.value)} /></label>
          <label>Stream ID<input type="text" value={streamId} onChange={e => setStreamId(e.target.value)} /></label>
          <label>Event type<input type="text" value={eventType} onChange={e => setEventType(e.target.value)} /></label>
        </div>
        <button style={{ marginTop: 10 }} onClick={() => search(undefined)} disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {items && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Stream</th><th>Seq</th><th>Event ID</th><th>Type</th><th>Causation</th><th>Source</th><th>Occurred</th><th>Stream integrity</th></tr></thead>
            <tbody>
              {items.length === 0
                ? <tr><td colSpan={8} className="muted" style={{ padding: 16 }}>No matching Ledger events.</td></tr>
                : items.map(e => (
                  <tr key={e.event_id}>
                    <td>{e.stream_id}</td>
                    <td>{e.sequence}</td>
                    <td className="muted">{e.event_id}</td>
                    <td>{e.event_type}</td>
                    <td className="muted">{e.causation_id ?? '—'}</td>
                    <td className="muted">{e.source_component}</td>
                    <td className="muted">{e.occurred_at ?? e.received_at}</td>
                    <td>
                      <IntegrityBadge status={streamIntegrityDisplay(e.stream_id)} />{' '}
                      <button className="secondary" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => verifyStream(e.stream_id)}>check</button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <div style={{ padding: 10 }}>
            <button className="secondary" disabled={!nextCursor || loading} onClick={() => nextCursor && search(nextCursor)}>Next page</button>
            {cursor && <button className="secondary" style={{ marginLeft: 8 }} onClick={() => search(undefined)}>Reset to first page</button>}
          </div>
        </div>
      )}
      {uniqueStreamIds.length === 0 && items && <p className="muted">Use "check" next to any row to run a real hash-chain verification for that stream.</p>}
    </div>
  );
}
