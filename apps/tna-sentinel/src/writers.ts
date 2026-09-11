import { observerPrincipal, readerPrincipal, controllerPrincipal, adminPrincipal, type SentinelPrincipal } from '../../../packages/sentinel-runtime/src/index.js';

/**
 * Fixed service identities (sections 11-12, 79-80). A governed agent is never issued one of these —
 * only trusted platform components hold observer/controller/admin identity, and each observer is
 * bound to the specific observation types it is allowed to submit.
 */
export function gateSource(tenantId: string): SentinelPrincipal { return observerPrincipal('sentinel-observer-gate', tenantId, ['TNA_GATE']); }
export function executionBrokerSource(tenantId: string): SentinelPrincipal { return observerPrincipal('sentinel-observer-broker', tenantId, ['EXECUTION_BROKER']); }
export function isolationRunnerSource(tenantId: string): SentinelPrincipal { return observerPrincipal('sentinel-observer-isolation', tenantId, ['ISOLATION_RUNNER']); }
export function egressGuardSource(tenantId: string): SentinelPrincipal { return observerPrincipal('sentinel-observer-egress', tenantId, ['EGRESS_GUARD']); }
export function secretBrokerSource(tenantId: string): SentinelPrincipal { return observerPrincipal('sentinel-observer-secret-broker', tenantId, ['SECRET_BROKER']); }
export function toolAdapterSource(tenantId: string): SentinelPrincipal { return observerPrincipal('sentinel-observer-tool-adapter', tenantId, ['TOOL_ADAPTER']); }
export function vadRuntimeSource(tenantId: string): SentinelPrincipal { return observerPrincipal('sentinel-observer-vad', tenantId, ['VAD_RUNTIME']); }
export function systemSource(tenantId: string): SentinelPrincipal { return observerPrincipal('sentinel-observer-system', tenantId, ['SYSTEM']); }
export function reader(tenantId: string): SentinelPrincipal { return readerPrincipal('sentinel-reader', tenantId); }
export function controller(tenantId: string): SentinelPrincipal { return controllerPrincipal('sentinel-controller', tenantId); }
export function admin(tenantId: string): SentinelPrincipal { return adminPrincipal('sentinel-admin', tenantId); }
