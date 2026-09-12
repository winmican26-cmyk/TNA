import { useEffect, useState, useCallback } from 'react';
import { api, type Incident } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Incidents page. Every row is a real,
 * freshly-computed signal from the backend (see `apps/tna-control-center/src/incidents.ts`) — severity is
 * a deterministic backend mapping, never decided here in React. Acknowledging an incident records a real,
 * persisted (tenant, signature) row via the real BFF route; it never marks the underlying condition
 * resolved locally — the same real condition, if still true on the backend, keeps reappearing after
 * acknowledgment, exactly as the backend reports it.
 */
const SEVERITY_CLASS: Record<string, string> = { CRITICAL: 'status-UNAVAILABLE', HIGH: 'status-UNAVAILABLE', MEDIUM: 'status-DEGRADED', LOW: 'status-UNKNOWN' };
const CAN_ACKNOWLEDGE = new Set(['client-auditor', 'client-admin']);

export default function Incidents({ role }: { readonly role: string }) {
  const [items, setItems] = useState<readonly Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.incidents().then(page => setItems(page.items)).catch(() => setError('Could not load incidents from the backend.'));
  }, []);
  useEffect(load, [load]);

  const acknowledge = (signature: string) => {
    setBusy(signature);
    api.acknowledgeIncident(signature).then(load).catch(() => setError('Acknowledgment failed.')).finally(() => setBusy(null));
  };

  if (error) return <p className="error-text">{error}</p>;
  if (!items) return <p className="muted">Loading incidents…</p>;

  return (
    <div>
      <h1>Incidents</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Computed live from real backend signals (component health, Ledger integrity, schema drift, connection reachability, action state)
        — there is no separate incident record store, so nothing here can be stale or fabricated independently of those real sources.
      </p>
      {items.length === 0 && <p className="muted">No incidents — every checked real signal is currently healthy.</p>}
      {items.length > 0 && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Severity</th><th>Type</th><th>Summary</th><th>Acknowledged</th><th></th></tr></thead>
            <tbody>
              {items.map(i => (
                <tr key={i.signature}>
                  <td><span className={`status-badge ${SEVERITY_CLASS[i.severity]}`}>{i.severity}</span></td>
                  <td className="muted">{i.type}</td>
                  <td>{i.summary}</td>
                  <td className="muted">{i.acknowledgment ? `${i.acknowledgment.acknowledged_by} @ ${i.acknowledgment.acknowledged_at}` : '—'}</td>
                  <td>
                    {CAN_ACKNOWLEDGE.has(role) && !i.acknowledgment && (
                      <button className="secondary" disabled={busy === i.signature} onClick={() => acknowledge(i.signature)}>
                        {busy === i.signature ? 'Acknowledging…' : 'Acknowledge'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
