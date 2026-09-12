/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). Section 117-118: `ClientDeploymentHandoff
 * v1` — a non-secret summary of what was actually configured, hashed so a later dispute about "what was
 * handed over" can be settled against a durable record rather than memory.
 */
import { createHash } from 'node:crypto';
import type { GoLiveAssessment } from './go-live.js';

export interface ClientDeploymentHandoff {
  readonly version: '1.0';
  readonly generated_at: string;
  readonly deployment_id: string;
  readonly component_versions: Readonly<Record<string, string>>;
  readonly tenant_id: string;
  readonly enabled_tools: readonly { readonly tool_id: string; readonly external_tool_name: string; readonly risk_class: string | null }[];
  readonly policy_bindings_count: number;
  readonly known_limitations: readonly string[];
  readonly bypass_assessment: string;
  readonly backup_status: string;
  readonly health_status: string;
  readonly go_live_assessment: GoLiveAssessment;
  readonly handoff_hash: string;
}

export function buildHandoff(input: Omit<ClientDeploymentHandoff, 'version' | 'generated_at' | 'handoff_hash'>): ClientDeploymentHandoff {
  const generatedAt = new Date().toISOString();
  const withoutHash = { version: '1.0' as const, generated_at: generatedAt, ...input };
  const handoff_hash = createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex');
  return { ...withoutHash, handoff_hash };
}
