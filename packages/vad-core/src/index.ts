import { createHash } from 'node:crypto';

export type RiskLevel = 'low' | 'medium' | 'high';
export type SuccessValidationMode = 'deterministic';

export interface SuccessCriterion {
  id: string;
  description: string;
  validation: SuccessValidationMode;
}

export interface AtomSpec {
  version: '1.0';
  atom: {
    id: string;
    title: string;
  };
  goal: string;
  success_criteria: SuccessCriterion[];
  risk: {
    level: RiskLevel;
  };
  resources: {
    read: string[];
    write: string[];
    create: string[];
  };
  constraints: {
    forbidden: string[];
  };
  limits: {
    max_attempts: number;
    max_runtime_seconds: number;
    max_cost_usd: number;
  };
}

const allowedRootKeys = new Set(['version', 'atom', 'goal', 'success_criteria', 'risk', 'resources', 'constraints', 'limits']);
const allowedAtomKeys = new Set(['id', 'title']);
const allowedRiskKeys = new Set(['level']);
const allowedResourceKeys = new Set(['read', 'write', 'create']);
const allowedConstraintKeys = new Set(['forbidden']);
const allowedLimitKeys = new Set(['max_attempts', 'max_runtime_seconds', 'max_cost_usd']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertStrictKeys(actual: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(actual).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`Unknown field in ${label}: ${unknown}`);
  }
}

export function finalizeAtomSpec(input: unknown): AtomSpec {
  if (!isPlainObject(input)) throw new Error('Atom spec must be an object');
  assertStrictKeys(input, allowedRootKeys, 'atom specification');

  const version = input.version;
  if (version !== '1.0') throw new Error('Unsupported atom spec version');

  const atom = input.atom;
  if (!isPlainObject(atom)) throw new Error('Atom identity is required');
  assertStrictKeys(atom, allowedAtomKeys, 'atom identity');
  const atomId = typeof atom.id === 'string' && atom.id.trim().length > 0 ? atom.id : null;
  const title = typeof atom.title === 'string' && atom.title.trim().length > 0 ? atom.title : null;
  if (!atomId || !title) throw new Error('Malformed atom identity');

  const goal = typeof input.goal === 'string' && input.goal.trim().length > 0 ? input.goal : null;
  if (!goal) throw new Error('Primary goal is required');

  const criteria = Array.isArray(input.success_criteria) ? input.success_criteria : null;
  if (!criteria || criteria.length === 0) throw new Error('Success criteria are required');
  for (const criterion of criteria) {
    if (!isPlainObject(criterion)) throw new Error('Each criterion must be an object');
    const criterionKeys = new Set(['id', 'description', 'validation']);
    assertStrictKeys(criterion, criterionKeys, 'success criterion');
    if (typeof criterion.id !== 'string' || criterion.id.trim().length === 0) throw new Error('Criterion id is required');
    if (typeof criterion.description !== 'string' || criterion.description.trim().length === 0) throw new Error('Criterion description is required');
    if (criterion.validation !== 'deterministic') throw new Error('Only deterministic criteria are supported');
  }

  const risk = isPlainObject(input.risk) ? input.risk : null;
  if (!risk) throw new Error('Risk level is required');
  assertStrictKeys(risk, allowedRiskKeys, 'risk');
  if (!['low', 'medium', 'high'].includes(String(risk.level))) throw new Error('Invalid risk level');

  const resources = isPlainObject(input.resources) ? input.resources : null;
  if (!resources) throw new Error('Resource manifest is required');
  assertStrictKeys(resources, allowedResourceKeys, 'resources');
  const read = Array.isArray(resources.read) ? resources.read : null;
  const write = Array.isArray(resources.write) ? resources.write : null;
  const create = Array.isArray(resources.create) ? resources.create : null;
  if (!read || !write || !create) throw new Error('Resource arrays are required');
  if (!read.every((entry) => typeof entry === 'string') || !write.every((entry) => typeof entry === 'string') || !create.every((entry) => typeof entry === 'string')) {
    throw new Error('Resource paths must be strings');
  }

  const constraints = isPlainObject(input.constraints) ? input.constraints : null;
  if (!constraints) throw new Error('Constraints are required');
  assertStrictKeys(constraints, allowedConstraintKeys, 'constraints');
  if (!Array.isArray(constraints.forbidden) || !constraints.forbidden.every((entry) => typeof entry === 'string')) {
    throw new Error('Forbidden constraints must be strings');
  }

  const limits = isPlainObject(input.limits) ? input.limits : null;
  if (!limits) throw new Error('Limits are required');
  assertStrictKeys(limits, allowedLimitKeys, 'limits');
  const maxAttempts = Number(limits.max_attempts);
  const maxRuntimeSeconds = Number(limits.max_runtime_seconds);
  const maxCostUsd = Number(limits.max_cost_usd);
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new Error('max_attempts must be a positive integer');
  if (!Number.isFinite(maxRuntimeSeconds) || maxRuntimeSeconds <= 0) throw new Error('max_runtime_seconds must be positive');
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error('max_cost_usd must be positive');

  return {
    version: '1.0',
    atom: { id: atomId, title },
    goal,
    success_criteria: criteria.map((criterion) => ({
      id: String(criterion.id),
      description: String(criterion.description),
      validation: 'deterministic',
    })),
    risk: { level: String(risk.level) as RiskLevel },
    resources: {
      read: read as string[],
      write: write as string[],
      create: create as string[],
    },
    constraints: {
      forbidden: constraints.forbidden as string[],
    },
    limits: {
      max_attempts: Number(limits.max_attempts),
      max_runtime_seconds: Number(limits.max_runtime_seconds),
      max_cost_usd: Number(limits.max_cost_usd),
    },
  };
}

function sortedEntries(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedEntries);
  if (isPlainObject(value)) {
    const final: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      final[key] = sortedEntries(value[key]);
    }
    return final;
  }
  return value;
}

export function canonicalizeSpec(spec: AtomSpec): string {
  return JSON.stringify(sortedEntries(spec));
}

export function computeSpecHash(spec: AtomSpec): string {
  return createHash('sha256').update(canonicalizeSpec(spec)).digest('hex');
}

export function matchesPattern(pattern: string, actual: string): boolean {
  if (pattern.endsWith('/**')) {
    const base = pattern.slice(0, -3);
    return actual === base || actual.startsWith(base + '/');
  }
  if (pattern.includes('*')) {
    const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return regex.test(actual);
  }
  return pattern === actual;
}

export function canonicalizePath(filePath: string): string {
  if (filePath.includes('\0')) throw new Error('Path contains null byte');
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) throw new Error('Absolute path not allowed in relative context');
  const segments = normalized.split('/');
  const result: string[] = [];
  for (const segment of segments) {
    if (segment === '..') throw new Error('Path traversal (..) not allowed');
    if (segment === '.' || segment === '') continue;
    result.push(segment);
  }
  if (result.length === 0) throw new Error('Empty path after canonicalization');
  return result.join('/');
}

export function isResourceViolation(spec: AtomSpec, actualFiles: string[]): boolean {
  const allowed = new Set<string>([...spec.resources.read, ...spec.resources.write, ...spec.resources.create]);
  for (const file of actualFiles) {
    let canonical: string;
    try {
      canonical = canonicalizePath(file);
    } catch {
      return true;
    }
    const matches = [...allowed].some((pattern) => matchesPattern(pattern, canonical));
    if (!matches) return true;
  }
  return false;
}

export function isOperationViolation(spec: AtomSpec, file: string, operation: 'read' | 'write' | 'create'): boolean {
  let canonical: string;
  try {
    canonical = canonicalizePath(file);
  } catch {
    return true;
  }
  const allowedPatterns = spec.resources[operation];
  return !allowedPatterns.some((pattern) => matchesPattern(pattern, canonical));
}

export function checkForbiddenDependencies(spec: AtomSpec, beforeDeps: string[], afterDeps: string[]): string[] {
  const before = new Set(beforeDeps);
  const newDeps = afterDeps.filter((dep) => !before.has(dep));
  const forbidden = spec.constraints.forbidden;
  const violations: string[] = [];
  for (const dep of newDeps) {
    if (forbidden.includes(dep) || forbidden.includes('new dependencies')) {
      violations.push(dep);
    }
  }
  return violations;
}
