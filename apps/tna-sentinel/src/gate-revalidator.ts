import { Gate } from '../../tna-gate-api/src/gate.js';
import { type Principal } from '../../../packages/agent-identity/src/index.js';
import { type AuthorityRevalidator, type AuthorityStatus, type SentinelSession } from '../../../packages/sentinel-runtime/src/index.js';

/**
 * Live authority-revalidation adapter over the accepted TNA Gate (sections 59-61, 99). Uses only
 * Gate's existing public surface (`isAgentRevoked`, `getEnvelope`) — no Gate behavior is modified or
 * reimplemented. `principal` must be a Gate admin/reader identity Sentinel is trusted to hold; it is
 * never derived from or exposed to a governed agent.
 *
 * Section 61 (fail-closed): any failure to reach a definite VALID/EXPIRED/REVOKED/POLICY_CHANGED
 * conclusion — including "no envelope on file" — resolves to UNKNOWN, never VALID.
 */
export class GateAuthorityRevalidator implements AuthorityRevalidator {
  public constructor(private readonly gate: Gate, private readonly principal: Principal) {}

  public validate(session: SentinelSession): AuthorityStatus {
    try {
      if (this.gate.isAgentRevoked(session.agent_id)) return { status: 'REVOKED', revokedScope: 'agent' };
      const envelope = this.gate.getEnvelope(this.principal, session.agent_id) as { hash: string };
      if (envelope.hash !== session.policy_snapshot_hash) return { status: 'POLICY_CHANGED', currentPolicyHash: envelope.hash };
      return { status: 'VALID', currentPolicyHash: envelope.hash };
    } catch {
      return { status: 'UNKNOWN', detail: 'Gate authority state could not be established' };
    }
  }
}
