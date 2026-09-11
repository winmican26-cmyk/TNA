import { readerPrincipal, runnerPrincipal, adminPrincipal, type AuditorPrincipal } from '../../../packages/auditor-engine/src/index.js';

/**
 * Fixed service identities (sections 50-52). A governed agent is never issued one of these — only
 * trusted platform/operator identities hold reader/runner/admin authority. An agent may *request*
 * an assessment through whatever policy layer sits in front of this app, but it is never handed the
 * runner credential directly, and it is never authoritative over control results, risk score, or
 * assessment outcome (section 51) — those are always computed by AuditorRuntime itself.
 */
export function reader(tenantId: string): AuditorPrincipal { return readerPrincipal('auditor-reader', tenantId); }
export function runner(tenantId: string): AuditorPrincipal { return runnerPrincipal('auditor-runner', tenantId); }
export function admin(tenantId: string): AuditorPrincipal { return adminPrincipal('auditor-admin', tenantId); }
