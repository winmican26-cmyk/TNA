import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), sections 10/14-17/62. `state` shown here is
 * always the value most recently returned by the real backend — a HELD action never optimistically
 * flips to approved in this component before `api.approveAction()`'s real response comes back and is
 * re-rendered (section 62-63: no optimistic security state).
 */
const ROLE_CAN_REVIEW = new Set(['client-reviewer', 'client-admin']);
// TNA-85: an unrecognized action state renders with neutral/UNKNOWN styling, never a state-name CSS class
// that could accidentally collide with a positive-looking style.
const KNOWN_ACTION_STATES = new Set(['RECEIVED', 'AUTHORIZING', 'BLOCKED', 'HELD', 'AUTHORIZED', 'CAPABILITY_ISSUED', 'MONITORING', 'EXECUTING', 'VERIFYING', 'COMPLETED', 'FAILED', 'TERMINATED', 'INDETERMINATE']);

export default function ActionDetail({ role, environment }: { readonly role: string; readonly environment: string }) {
  const { id } = useParams<{ id: string }>();
  const [action, setAction] = useState<Record<string, unknown> | null>(null);
  const [evidence, setEvidence] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'approve' | 'terminate' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    setError(null);
    api.action(id).then(setAction).catch(() => setError('Could not load this action from the backend.'));
    api.actionEvidence(id).then(setEvidence).catch(() => setEvidence(null));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <p className="error-text">{error}</p>;
  if (!action || !id) return <p className="muted">Loading action…</p>;

  const state = typeof action.state === 'string' ? action.state : 'UNKNOWN';
  const stateClass = KNOWN_ACTION_STATES.has(state) ? state : 'UNKNOWN';
  const canReview = ROLE_CAN_REVIEW.has(role);

  const runApprove = () => {
    setBusy(true);
    api.approveAction(id).then(() => { setConfirming(null); load(); }).catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Approval failed')).finally(() => setBusy(false));
  };
  const runTerminate = () => {
    if (reason.trim().length === 0) { setError('A reason is required to terminate an action.'); return; }
    setBusy(true);
    api.terminateAction(id, reason).then(() => { setConfirming(null); setReason(''); load(); }).catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Termination failed')).finally(() => setBusy(false));
  };

  return (
    <div>
      <h1>Action {id}</h1>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Overview</h3>
        <p>State: <span className={`status-badge status-${stateClass}`}>{state}</span></p>
        <p className="muted">Tool: {String(action.tool ?? '—')} · Agent: {String(action.agent_id ?? '—')} · Created: {String(action.created_at ?? '—')}</p>
      </div>

      {state === 'HELD' && canReview && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Approval required</h3>
          {confirming === 'approve' ? (
            <div>
              <p>Confirm approval of this action in <strong>{environment.toUpperCase()}</strong>? This cannot be undone.</p>
              <button onClick={runApprove} disabled={busy}>{busy ? 'Approving…' : 'Confirm approve'}</button>{' '}
              <button className="secondary" onClick={() => setConfirming(null)} disabled={busy}>Cancel</button>
            </div>
          ) : confirming === 'terminate' ? (
            <div>
              <label htmlFor="reason">Reason (required)</label>
              <input id="reason" type="text" value={reason} onChange={e => setReason(e.target.value)} />
              <div style={{ marginTop: 8 }}>
                <button onClick={runTerminate} disabled={busy}>{busy ? 'Terminating…' : 'Confirm terminate'}</button>{' '}
                <button className="secondary" onClick={() => setConfirming(null)} disabled={busy}>Cancel</button>
              </div>
            </div>
          ) : (
            <div>
              <button onClick={() => setConfirming('approve')}>Approve</button>{' '}
              <button className="secondary" onClick={() => setConfirming('terminate')}>Terminate</button>
            </div>
          )}
        </div>
      )}
      {state === 'HELD' && !canReview && (
        <div className="panel"><p className="muted">This action is awaiting approval. Your role ({role}) cannot approve or terminate it — a client-reviewer or client-admin is required.</p></div>
      )}

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Evidence</h3>
        {evidence ? <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>{JSON.stringify(evidence, null, 2)}</pre> : <p className="muted">No evidence available.</p>}
      </div>
    </div>
  );
}
