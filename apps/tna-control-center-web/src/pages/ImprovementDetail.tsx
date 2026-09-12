import { useEffect, useState, useCallback, type ReactElement } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, ApiError, type ImprovementGeneration, type ImprovementEvidence, type LineageResult } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Recursive-improvement generation detail — the
 * flagship page. Every fact rendered here traces to a real field returned by `apps/tna-improvement-governor`
 * (Volume 12): the raw generation row, the Ledger-reconstructed evaluation/capability/authority signals, and
 * the real 9-control security assessment. Two sections the illustrative kickoff mockup implied
 * ("Objective" text, a numeric "Benchmark" score/holdout result) are NOT retrievable from the governor's real
 * HTTP API today — this component says so explicitly rather than inventing placeholder values for them.
 * Mutations (approve/promote/rollback) never optimistically update local state: every one submits to the
 * real BFF route, waits for its real response, and then RE-FETCHES this generation's authoritative state.
 */
const CAN_MUTATE = new Set(['client-admin']);

function Bool({ value }: { readonly value: boolean | undefined }) {
  if (value === undefined) return <span className="status-badge status-UNKNOWN">NOT RECORDED</span>;
  return value ? <span className="status-badge status-AVAILABLE">YES</span> : <span className="status-badge status-UNAVAILABLE">NO</span>;
}
const CONTROL_CLASS: Record<string, string> = { PASS: 'status-AVAILABLE', FAIL: 'status-UNAVAILABLE', INSUFFICIENT_EVIDENCE: 'status-UNKNOWN' };

function LineageTree({ lineage, currentId }: { readonly lineage: LineageResult; readonly currentId: string }) {
  const byParent = new Map<string | null, typeof lineage.nodes>();
  for (const node of lineage.nodes) {
    const key = node.parentGenerationId;
    byParent.set(key, [...(byParent.get(key) ?? []), node]);
  }
  const STATE_CLASS: Record<string, string> = { PROMOTED: 'status-AVAILABLE', REJECTED: 'status-UNAVAILABLE', ROLLED_BACK: 'status-DEGRADED', INDETERMINATE: 'status-UNKNOWN' };
  function renderNode(id: string, depth: number): ReactElement {
    const node = lineage.nodes.find(n => n.generationId === id);
    const children = byParent.get(id) ?? [];
    return (
      <div key={id} style={{ marginLeft: depth * 20, borderLeft: depth > 0 ? '1px solid var(--border)' : undefined, paddingLeft: depth > 0 ? 10 : 0, marginTop: 4 }}>
        <Link to={`/improvements/${encodeURIComponent(id)}`} style={{ fontWeight: id === currentId ? 700 : 400 }}>{id}</Link>{' '}
        <span className={`status-badge ${STATE_CLASS[node?.finalState ?? ''] ?? 'status-UNKNOWN'}`}>{node?.finalState ?? 'UNKNOWN'}</span>
        {children.map(c => renderNode(c.generationId, depth + 1))}
      </div>
    );
  }
  return <div>{lineage.roots.map(id => renderNode(id, 0))}</div>;
}

export default function ImprovementDetail({ role, environment }: { readonly role: string; readonly environment: string }) {
  const { id } = useParams<{ id: string }>();
  const [generation, setGeneration] = useState<ImprovementGeneration | null>(null);
  const [evidence, setEvidence] = useState<ImprovementEvidence | null>(null);
  const [lineage, setLineage] = useState<LineageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<'approve-promote' | 'approve-rollback' | 'promote' | 'rollback' | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState('');
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    setError(null);
    api.improvement(id).then(setGeneration).catch(() => setError('Could not load this generation from the backend.'));
    api.improvementEvidence(id).then(setEvidence).catch(() => setEvidence(null));
    api.improvementLineage(id).then(setLineage).catch(() => setLineage(null));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <p className="error-text">{error}</p>;
  if (!generation || !id) return <p className="muted">Loading generation…</p>;
  const canMutate = CAN_MUTATE.has(role);
  const evaluated = evidence?.reconstruction.evaluated ?? null;

  const runApprovePromote = () => {
    setBusy(true);
    api.approveImprovement(id, 'promote').then(res => { setPendingApprovalId(res.approval.approvalId); setConfirming('promote'); }).catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Approval failed')).finally(() => setBusy(false));
  };
  const runPromote = () => {
    setBusy(true);
    api.promoteImprovement(id, pendingApprovalId ?? undefined).then(() => { setConfirming(null); setPendingApprovalId(null); load(); }).catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Promotion failed')).finally(() => setBusy(false));
  };
  const runApproveRollback = () => {
    setBusy(true);
    api.approveImprovement(id, 'rollback').then(res => { setPendingApprovalId(res.approval.approvalId); setConfirming('rollback'); }).catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Approval failed')).finally(() => setBusy(false));
  };
  const runRollback = () => {
    if (rollbackTarget.trim().length === 0) { setError('A target generation ID is required to roll back.'); return; }
    setBusy(true);
    api.rollbackImprovement(id, rollbackTarget.trim(), pendingApprovalId ?? undefined).then(() => { setConfirming(null); setPendingApprovalId(null); setRollbackTarget(''); load(); }).catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Rollback failed')).finally(() => setBusy(false));
  };

  return (
    <div>
      <h1>Generation {generation.generation_id}</h1>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Overview</h3>
        <table>
          <tbody>
            <tr><td className="muted">Status</td><td><span className="status-badge status-INDETERMINATE">{generation.status}</span></td></tr>
            <tr><td className="muted">Improvement class</td><td>{generation.improvement_class}</td></tr>
            <tr><td className="muted">Candidate version</td><td>{generation.candidate_version}</td></tr>
            <tr><td className="muted">Parent</td><td>{generation.parent_generation_id ? <Link to={`/improvements/${encodeURIComponent(generation.parent_generation_id)}`}>{generation.parent_generation_id}</Link> : '(root generation)'}</td></tr>
            <tr><td className="muted">Created</td><td className="muted">{generation.created_at} by {generation.created_by}</td></tr>
            <tr><td className="muted">Objective</td><td className="muted">Not exposed by the governor's HTTP API — only the spec hash below is retrievable.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Mutation</h3>
        <table>
          <tbody>
            <tr><td className="muted">Spec hash</td><td><code>{generation.spec_hash}</code></td></tr>
            <tr><td className="muted">Source hash (before)</td><td><code>{generation.source_hash_before}</code></td></tr>
            <tr><td className="muted">Source hash (after)</td><td><code>{generation.source_hash_after ?? '— (not yet built)'}</code></td></tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Competence, Authority, Capability, Control Plane</h3>
        <p className="muted" style={{ fontSize: 12 }}>
          These are kept visually separate deliberately — a successor can become better without automatically becoming more powerful, and
          this system never collapses that distinction into one combined "score".
        </p>
        <div className="grid">
          <div className="metric">
            <div className="label">Competence (evaluation decision)</div>
            <div className="value" style={{ fontSize: 16 }}>{evaluated?.decision ?? '— (not yet evaluated)'}</div>
            <div className="muted" style={{ fontSize: 11 }}>VAD verdict: {evaluated?.vad_final_state ?? '—'}. Numeric benchmark scores are not exposed by the governor's HTTP API.</div>
          </div>
          <div className="metric">
            <div className="label">Authority</div>
            <div className="value" style={{ fontSize: 16 }}>{evaluated?.authority_within_ceiling === undefined ? '—' : evaluated.authority_within_ceiling ? 'No change (within ceiling)' : 'EXPANDED (exceeded ceiling)'}</div>
          </div>
          <div className="metric">
            <div className="label">Capability</div>
            <div className="value" style={{ fontSize: 16 }}>{evidence?.reconstruction.capabilityDelta?.has_unexpected_gain === undefined ? '—' : evidence.reconstruction.capabilityDelta.has_unexpected_gain ? 'Unexpected gain detected' : 'No unexpected gain'}</div>
          </div>
          <div className="metric">
            <div className="label">Control plane</div>
            <div className="value" style={{ fontSize: 16 }}>{evaluated?.control_plane_changed === undefined ? '—' : evaluated.control_plane_changed ? 'Changed' : 'Unchanged'}</div>
          </div>
        </div>
        {evaluated?.reason && (
          <p style={{ marginBottom: 0, marginTop: 12 }}>
            Real evaluator reason: <em>{evaluated.reason}</em>
            {evaluated.decision === 'REJECT' && evaluated.authority_within_ceiling === false && (
              <><br /><span className="muted" style={{ fontSize: 12 }}>
                Evaluation short-circuits at the authority-ceiling check — a benchmark result, if any was computed, is not distinguishable
                from "not evaluated" once authority is exceeded. This candidate's promotion was REJECTED on authority grounds alone.
              </span></>
            )}
          </p>
        )}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Security controls (real, Ledger-reconstructed assessment)</h3>
        {!evidence ? <p className="muted">Loading…</p> : (
          <>
            <p>Overall: <span className={`status-badge ${CONTROL_CLASS[evidence.assessment.overall] ?? 'status-UNKNOWN'}`}>{evidence.assessment.overall}</span></p>
            <table>
              <thead><tr><th>Control</th><th>Status</th><th>Reason</th></tr></thead>
              <tbody>
                {evidence.assessment.controls.map(c => (
                  <tr key={c.control_id}><td>{c.control_id}</td><td><span className={`status-badge ${CONTROL_CLASS[c.status] ?? 'status-UNKNOWN'}`}>{c.status}</span></td><td className="muted">{c.reason}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Evaluation flags</h3>
        <table>
          <tbody>
            <tr><td className="muted">Proposed</td><td><Bool value={evidence?.reconstruction.proposed} /></td></tr>
            <tr><td className="muted">Authorized</td><td><Bool value={evidence?.reconstruction.authorized} /></td></tr>
            <tr><td className="muted">Built</td><td><Bool value={evidence?.reconstruction.built} /></td></tr>
            <tr><td className="muted">Evaluator changed</td><td><Bool value={evaluated?.evaluator_changed} /></td></tr>
            <tr><td className="muted">Test manifest tampered</td><td><Bool value={evaluated?.test_tampered} /></td></tr>
            <tr><td className="muted">Authority expansion request</td><td>{evidence?.reconstruction.authorityExpansion?.status ?? 'none recorded'}</td></tr>
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>"Holdout" evaluation is not a concept implemented by this backend — no holdout section is shown to avoid inventing one.</p>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Lineage</h3>
        {lineage ? <LineageTree lineage={lineage} currentId={id} /> : <p className="muted">Loading…</p>}
      </div>

      {canMutate && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Promotion / Rollback</h3>
          {confirming === 'promote' ? (
            <div>
              <p>A real approval was just granted by the trusted governor's approver role (never this client's own role — see the Volume 13 threat model). Confirm promotion in <strong>{environment.toUpperCase()}</strong>?</p>
              <button onClick={runPromote} disabled={busy}>{busy ? 'Promoting…' : 'Confirm promote'}</button>{' '}
              <button className="secondary" onClick={() => { setConfirming(null); setPendingApprovalId(null); }} disabled={busy}>Cancel</button>
            </div>
          ) : confirming === 'rollback' ? (
            <div>
              <label>Target generation ID (rollback destination)<input type="text" value={rollbackTarget} onChange={e => setRollbackTarget(e.target.value)} /></label>
              <div style={{ marginTop: 8 }}>
                <button onClick={runRollback} disabled={busy}>{busy ? 'Rolling back…' : 'Confirm rollback'}</button>{' '}
                <button className="secondary" onClick={() => { setConfirming(null); setPendingApprovalId(null); setRollbackTarget(''); }} disabled={busy}>Cancel</button>
              </div>
            </div>
          ) : (
            <div>
              <button onClick={runApprovePromote} disabled={busy}>Request approval to promote</button>{' '}
              <button className="secondary" onClick={runApproveRollback} disabled={busy}>Request approval to roll back</button>
            </div>
          )}
          <p className="muted" style={{ fontSize: 12, marginBottom: 0, marginTop: 8 }}>
            Every action here submits to the real governor and re-fetches its response — this page never marks a generation PROMOTED or
            ROLLED_BACK locally before the backend confirms it.
          </p>
        </div>
      )}
      {!canMutate && <p className="muted">Your role ({role}) cannot approve, promote, or roll back improvements — a client-admin is required.</p>}
    </div>
  );
}
