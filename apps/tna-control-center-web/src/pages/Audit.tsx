import { useEffect, useState, useCallback } from 'react';
import { api, type AssessmentRecord, type ControlResult, type AuditFinding } from '../api.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13). Audit / Assurance page. Every assessment,
 * control result, and finding is the real `apps/tna-auditor` record — `INSUFFICIENT_EVIDENCE` is a
 * distinct, non-green real outcome/result value and is never remapped to a success color here (the
 * permanent rule this page exists to honor: an auditor's inability to find evidence is not the same as a
 * passing control, and must never be presented as one).
 */

const OUTCOME_CLASS: Record<string, string> = {
  PASS: 'status-AVAILABLE', PASS_WITH_FINDINGS: 'status-DEGRADED', FAIL: 'status-UNAVAILABLE',
  INSUFFICIENT_EVIDENCE: 'status-UNKNOWN', ERROR: 'status-UNAVAILABLE',
};
const RESULT_CLASS: Record<string, string> = {
  PASS: 'status-AVAILABLE', PARTIAL: 'status-DEGRADED', FAIL: 'status-UNAVAILABLE',
  NOT_APPLICABLE: 'status-UNKNOWN', INSUFFICIENT_EVIDENCE: 'status-UNKNOWN', ERROR: 'status-UNAVAILABLE',
};
function OutcomeBadge({ outcome }: { readonly outcome: string | null }) {
  if (!outcome) return <span className="status-badge status-UNKNOWN">PENDING</span>;
  return <span className={`status-badge ${OUTCOME_CLASS[outcome] ?? 'status-UNKNOWN'}`}>{outcome}</span>;
}
function ResultBadge({ status }: { readonly status: string }) {
  return <span className={`status-badge ${RESULT_CLASS[status] ?? 'status-UNKNOWN'}`}>{status}</span>;
}

function AssessmentDetail({ id }: { readonly id: string }) {
  const [results, setResults] = useState<readonly ControlResult[] | null>(null);
  const [findings, setFindings] = useState<readonly AuditFinding[] | null>(null);
  useEffect(() => {
    api.assessmentResults(id).then(p => setResults(p.items)).catch(() => setResults([]));
    api.assessmentFindings(id).then(p => setFindings(p.items)).catch(() => setFindings([]));
  }, [id]);

  return (
    <div style={{ marginTop: 8 }}>
      <h4 style={{ marginBottom: 4 }}>Control results</h4>
      {!results ? <p className="muted">Loading…</p> : (
        <table>
          <thead><tr><th>Control</th><th>Result</th><th>Evaluated</th><th>Reason codes</th></tr></thead>
          <tbody>
            {results.length === 0 ? <tr><td colSpan={4} className="muted">No control results.</td></tr> : results.map(r => (
              <tr key={r.control_id}>
                <td>{r.control_id}</td><td><ResultBadge status={r.status} /></td>
                <td className="muted">{r.evaluated_at}</td><td className="muted">{r.reason_codes.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4 style={{ marginBottom: 4, marginTop: 12 }}>Findings</h4>
      {!findings ? <p className="muted">Loading…</p> : findings.length === 0 ? <p className="muted">No findings.</p> : (
        <table>
          <thead><tr><th>Title</th><th>Severity</th><th>Control</th><th>Status</th></tr></thead>
          <tbody>
            {findings.map(f => (
              <tr key={f.finding_id}><td>{f.title}</td><td>{f.severity}</td><td className="muted">{f.control_id}</td><td className="muted">{f.status}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Audit() {
  const [assessments, setAssessments] = useState<readonly AssessmentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    api.assessments().then(page => setAssessments(page.items)).catch(() => setError('Could not load assessments from the backend.'));
  }, []);
  useEffect(load, [load]);

  return (
    <div>
      <h1>Audit / Assurance</h1>
      <div className="panel" style={{ background: '#241a06', borderColor: 'var(--warn)' }}>
        <p style={{ margin: 0 }}>
          TNA Auditor evaluates configured controls against available evidence. It does not certify legal, regulatory, contractual, or industry compliance.
        </p>
      </div>

      {error && <p className="error-text">{error}</p>}
      {!assessments && !error && <p className="muted">Loading assessments…</p>}
      {assessments && assessments.length === 0 && <p className="muted">No assessments recorded for this tenant.</p>}
      {assessments && assessments.map(a => (
        <div className="panel" key={a.assessment_id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>{a.name}</strong>
              <div className="muted" style={{ fontSize: 12 }}>{a.control_profile_id} · created {a.created_at} · run #{a.latest_run_number}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div><span className="status-badge status-INDETERMINATE">{a.status}</span></div>
              <div style={{ marginTop: 4 }}><OutcomeBadge outcome={a.outcome} /></div>
            </div>
          </div>
          <button className="secondary" style={{ marginTop: 10 }} onClick={() => setExpanded(expanded === a.assessment_id ? null : a.assessment_id)}>
            {expanded === a.assessment_id ? 'Hide details' : 'Show control results & findings'}
          </button>
          {expanded === a.assessment_id && <AssessmentDetail id={a.assessment_id} />}
        </div>
      ))}
    </div>
  );
}
