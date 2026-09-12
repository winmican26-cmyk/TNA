/**
 * TNA Operator Readiness & Deployment Academy v0.1 (Volume 11). Re-exports for the operator CLI —
 * mirrors `apps/tna-platform/src/index.ts` / `apps/tna-client-gateway/src/index.ts`.
 */
export { loadOperatorProfile, resolveCredential, OperatorConfigError, type OperatorProfile } from './config.js';
export { OPERATOR_ROLES, roleAtLeast, assertRoleAllows, resolveCommandKey, OperatorAuthError, type OperatorRole } from './roles.js';
export { PlatformClient, ClientGatewayClient, OperatorHttpError } from './http-client.js';
export { ok, fail, printResult, exitCodeFor, type OperatorCommandResult } from './output.js';
export { runDoctor, type DoctorReport, type DiagnosticCheck, type DiagnosticStatus } from './doctor.js';
export { collectIncidentPackage, type IncidentPackage, type IncidentPackageManifest } from './incident.js';
export { explain, type Explanation } from './explain.js';
export { assessGoLive, GO_LIVE_STATEMENT, type GoLiveAssessment, type GoLiveInput, type GoLiveStatus } from './go-live.js';
export { buildHandoff, type ClientDeploymentHandoff } from './handoff.js';
export { OperatorAuditLog, type OperatorAuditEntry } from './audit-log.js';
export { AcademyProgressStore, ACADEMY_PROGRESS_STATUSES, type AcademyProgressEntry, type AcademyAttemptRecord, type AcademyProgressStatus } from './academy/progress-store.js';
export { assessLevel, KNOWLEDGE_PASSING_SCORE, type AcademyAssessment, type KnowledgeAnswer } from './academy/assessment.js';
export { redactDeep, REDACTED } from './redact.js';
