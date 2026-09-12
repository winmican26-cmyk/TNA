/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). Section 15-16: `tna action explain` —
 * deterministic, rules-based operator guidance derived ONLY from recorded state (`PlatformAction`'s own
 * `state`/`error_code`/`gate_decision`). No LLM is used for truth generation here (section 15); the
 * machine-readable code is always shown alongside the human explanation, never concealed (section 16).
 */

export interface ExplainInput {
  readonly state: string;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly gate_decision: { readonly decision: string; readonly reason: string } | null;
}

export interface Explanation {
  readonly code: string | null;
  readonly headline: string;
  readonly detail: string;
  readonly guidance: string;
}

const ERROR_CODE_EXPLANATIONS: Readonly<Record<string, { headline: string; detail: string; guidance: string }>> = {
  SENTINEL_TERMINATED: {
    headline: 'Sentinel terminated this action before or during execution.',
    detail: 'The runtime observation layer (Sentinel) detected behavior outside the bounds that made authorizing this action acceptable, and stopped it.',
    guidance: 'Review the Sentinel violation evidence for this session. If the containment is confirmed, no further action on this request is possible — resubmit as a new request if still needed.',
  },
  SENTINEL_HOLD: {
    headline: 'Sentinel held this action before execution.',
    detail: 'The connector was never invoked — Sentinel decided HOLD on the mandatory pre-action check.',
    guidance: 'This is a terminal INDETERMINATE outcome in v0.1; there is no resume path for a pre-action HOLD. Investigate why Sentinel held it before resubmitting.',
  },
  SENTINEL_UNAVAILABLE: {
    headline: 'A Sentinel session could not be created.',
    detail: 'The platform requires monitoring before capability redemption; it never falls back to unmonitored execution.',
    guidance: 'Check Sentinel readiness (`tna doctor`). This action never executed and is safe to resubmit once Sentinel is available.',
  },
  CAPABILITY_FAILURE: {
    headline: 'Capability issuance failed after Gate authorized this action.',
    detail: 'Gate ALLOWed the request, but the execution broker could not issue a capability for it.',
    guidance: 'Check the execution broker / capability signing key configuration (`tna doctor`).',
  },
  EXECUTION_FAILED: {
    headline: 'The connector reported a failure during execution.',
    detail: 'This includes an input-binding drift detected between authorization and execution (fail-closed) or a real connector-side error.',
    guidance: 'Inspect the connector/tool involved. No partial or ambiguous execution occurred — this is a clean failure, not INDETERMINATE.',
  },
  EVIDENCE_DEGRADED: {
    headline: 'The action executed, but evidence delivery is degraded.',
    detail: 'The external side effect may have already happened; the durable evidence obligation for it has not yet been confirmed delivered.',
    guidance: 'Do not treat this as a failed action and do not treat it as a clean success — check Ledger/outbox delivery status and retry delivery, never the external effect itself.',
  },
  VERIFICATION_REJECTED: {
    headline: 'VAD rejected the produced work.',
    detail: 'Execution completed, but independent verification found the result did not meet its acceptance criteria.',
    guidance: 'Review the VAD atom for this action. The underlying tool call happened — this is a verification failure, not an execution failure.',
  },
  VERIFICATION_ESCALATED: {
    headline: 'VAD verification could not reach a clean ACCEPT/REJECT and was escalated.',
    detail: 'This is an INDETERMINATE outcome pending human review of the verification evidence.',
    guidance: 'A human reviewer must examine the VAD atom and record a decision — this state does not resolve itself.',
  },
  COMPONENT_UNAVAILABLE: {
    headline: 'A required component for this action was unavailable.',
    detail: 'Most commonly: verification was required but no VAD component was configured — never silently skipped.',
    guidance: 'Check `tna doctor` for the specific missing component.',
  },
};

const GATE_BLOCK_EXPLANATIONS: readonly { readonly match: RegExp; readonly detail: string; readonly guidance: string }[] = [
  { match: /outside the stated objective/i, detail: 'No action binding in this agent\'s authority envelope matches the requested action.', guidance: 'Review the envelope\'s `action_bindings` — either the action was never intended to be permitted, or the envelope needs to be updated by an authorized operator.' },
  { match: /is not permitted/i, detail: 'The requested tool is not in this envelope\'s tool allow-list, or is explicitly denied.', guidance: 'Confirm the tool should be reachable by this agent; if so, an authorized operator must update the envelope.' },
  { match: /Undeclared resource or operation/i, detail: 'The requested resource path or operation (read/write) is outside what this envelope\'s `resources` section declares for this action binding.', guidance: 'Check the resource pattern actually bound to this tool — a resource outside the pattern is refused by design, not a bug.' },
  { match: /revoked/i, detail: 'The agent behind this request has been revoked.', guidance: 'No envelope change can fix this — a revoked agent must be re-registered as a new identity if it should regain access.' },
  { match: /expired/i, detail: 'The authority envelope for this agent has expired.', guidance: 'An authorized operator must issue a fresh envelope.' },
  { match: /limit exceeded/i, detail: 'A runtime, call-count, or retry limit configured in the envelope has been reached.', guidance: 'This is by design — raise the limit deliberately (an authorized operator decision) if the workload genuinely needs it.' },
];

/** MCP error codes (mirrors `packages/mcp-schema`'s `McpErrorCode` union) surfaced through Ledger
 * evidence/action metadata where applicable — kept here rather than imported so this module has no
 * dependency on the client-integration packages (the platform action alone may not carry an MCP error
 * code directly; this table is consulted when `error_message` contains one of these tokens). */
const MCP_ERROR_EXPLANATIONS: Readonly<Record<string, { headline: string; detail: string; guidance: string }>> = {
  MCP_SERVER_UNAVAILABLE: { headline: 'The MCP server could not be reached.', detail: 'The gateway could not start or connect to the registered MCP server process.', guidance: 'Verify the server\'s executable/args are still correct and the process can actually start; check `tna mcp inspect`.' },
  MCP_SCHEMA_DRIFT: { headline: 'The MCP tool schema changed after policy approval.', detail: 'The tool was disabled because previous authorization assumptions no longer match the current tool contract.', guidance: 'Rediscover, review, and re-enable the tool.' },
  MCP_TOOL_DISABLED: { headline: 'The governed tool is disabled.', detail: 'No execution is permitted for a disabled tool regardless of Gate authorization.', guidance: 'Review why it was disabled (schema drift, manual disable, offboarding) before re-enabling.' },
  MCP_TIMEOUT: { headline: 'The MCP server did not respond within the bounded timeout.', detail: 'The gateway killed the process rather than waiting indefinitely.', guidance: 'Check the MCP server\'s own health/logs; consider whether the timeout is appropriate for this tool\'s real latency.' },
  MCP_PROTOCOL_ERROR: { headline: 'The MCP server returned a malformed or error response.', detail: 'The response did not conform to the expected MCP protocol shape, or the tool call itself returned isError:true.', guidance: 'Inspect the MCP server\'s own logs for the underlying cause.' },
  MCP_RESULT_TOO_LARGE: { headline: 'The MCP tool result exceeded the configured size bound.', detail: 'A result this large is rejected rather than accepted unbounded.', guidance: 'This is a resource-exhaustion guard, not a transient failure — the tool\'s output shape likely needs to change.' },
  MCP_INDETERMINATE: { headline: 'The MCP server crashed mid-call.', detail: 'Whether the external side effect actually happened is unknown — this is never silently upgraded to success or downgraded to failure.', guidance: 'Treat as INDETERMINATE: verify externally whether the effect occurred before resubmitting.' },
};

export function explain(action: ExplainInput): Explanation {
  if (action.error_code && ERROR_CODE_EXPLANATIONS[action.error_code]) {
    const found = ERROR_CODE_EXPLANATIONS[action.error_code]!;
    return { code: action.error_code, headline: found.headline, detail: found.detail, guidance: found.guidance };
  }
  if (action.error_message) {
    for (const [code, found] of Object.entries(MCP_ERROR_EXPLANATIONS)) {
      if (action.error_message.includes(code)) return { code, headline: found.headline, detail: found.detail, guidance: found.guidance };
    }
  }
  if (action.gate_decision?.decision === 'BLOCK') {
    const reason = action.gate_decision.reason;
    for (const rule of GATE_BLOCK_EXPLANATIONS) {
      if (rule.match.test(reason)) return { code: 'GATE_BLOCK', headline: `Gate blocked this action: ${reason}`, detail: rule.detail, guidance: rule.guidance };
    }
    return { code: 'GATE_BLOCK', headline: `Gate blocked this action: ${reason}`, detail: 'Gate\'s policy engine refused this request against the agent\'s current authority envelope.', guidance: 'Review the envelope and the exact request that was blocked.' };
  }
  if (action.state === 'COMPLETED') {
    return { code: null, headline: 'This action completed successfully.', detail: 'Gate ALLOWed it, execution succeeded, and (if required) verification accepted the result.', guidance: 'No action needed.' };
  }
  if (action.state === 'HELD') {
    return { code: null, headline: 'This action is held pending approval.', detail: 'Gate\'s policy requires an approval for this action before it may proceed.', guidance: 'An authorized operator must approve or reject it (`tna hold approve` / `tna hold reject`).' };
  }
  return {
    code: action.error_code, headline: `This action is in state ${action.state}.`,
    detail: action.error_message ?? 'No further recorded detail is available for this state.',
    guidance: 'Inspect the full action record (`tna action show`) and its reconstruction (`tna action reconstruct`) for more context.',
  };
}
