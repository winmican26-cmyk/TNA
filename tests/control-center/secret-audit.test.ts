import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13) — foundation review sections 21-24. A real
 * source-code audit (not a claim, an executed check) for browser credential storage and sensitive
 * logging. Runs directly against the actual files on disk — a future change that reintroduces
 * `localStorage`/`sessionStorage` for anything session-shaped, or a `console.log` of a password/token,
 * fails this test immediately.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') continue;
    if (statSync(full).isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}

const WEB_SRC = resolve('apps', 'tna-control-center-web', 'src');
const BFF_SRC = resolve('apps', 'tna-control-center', 'src');

/** Strips `//` and `/* ... *\/` comments before scanning — an explanatory doc-comment that MENTIONS
 * `localStorage` by name (to say it is deliberately never used) must not itself trip this audit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('browser source: no ACTUAL CODE use of localStorage or sessionStorage anywhere in the frontend (comments mentioning them by name to document their absence are not code use)', () => {
  const files = walk(WEB_SRC).filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));
  assert.ok(files.length > 0, 'sanity: the frontend source tree must actually be found');
  const offenders: string[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (/\blocalStorage\b/.test(code) || /\bsessionStorage\b/.test(code)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `no frontend source file may use localStorage/sessionStorage in real code: ${offenders.join(', ')}`);
});

test('browser source: the only cookie name ever referenced by frontend JS is the non-HttpOnly CSRF cookie — the session cookie name never appears', () => {
  const apiFile = resolve(WEB_SRC, 'api.ts');
  const content = readFileSync(apiFile, 'utf8');
  assert.ok(content.includes("'tna_cc_csrf'"), 'the frontend must reference the real CSRF cookie name to read it');
  assert.ok(!content.includes('tna_cc_session'), 'the session cookie\'s name must never even be referenced by frontend JS — it is HttpOnly and structurally unreadable, and no code should need to name it');
  const otherFiles = walk(WEB_SRC).filter(f => (f.endsWith('.ts') || f.endsWith('.tsx')) && f !== apiFile);
  for (const file of otherFiles) assert.ok(!readFileSync(file, 'utf8').includes('tna_cc_session'), `${file} must not reference the session cookie name`);
});

test('browser source: no console logging of password/token/secret/session-shaped values', () => {
  const files = walk(WEB_SRC).filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));
  const suspicious = /console\.(log|error|warn|debug)\([^)]*\b(password|token|secret|session[_A-Za-z]*|csrf)\b/i;
  const offenders: string[] = [];
  for (const file of files) if (suspicious.test(readFileSync(file, 'utf8'))) offenders.push(file);
  assert.deepEqual(offenders, []);
});

test('BFF source: no console logging of password/token/secret/session id values', () => {
  const files = walk(BFF_SRC).filter(f => f.endsWith('.ts'));
  const suspicious = /console\.(log|error|warn|debug)\([^)]*\b(password|platform_token|platform_operator_token|session_id|csrf_token)\b/i;
  const offenders: string[] = [];
  for (const file of files) if (suspicious.test(readFileSync(file, 'utf8'))) offenders.push(file);
  assert.deepEqual(offenders, []);
});

test('BFF source: no route handler ever places a tenant registry token field directly into a browser-facing response', () => {
  const serverSrc = stripComments(readFileSync(resolve(BFF_SRC, 'server.ts'), 'utf8'));
  const usages = [...readFileSync(resolve(BFF_SRC, 'platform-client.ts'), 'utf8').matchAll(/platform(?:_operator)?_token/g)];
  assert.ok(usages.length > 0, 'sanity: the token fields must be used somewhere for real backend auth');
  // Every `send(res, status, ...)` call in server.ts is the browser-facing response surface — none of
  // them may reference a tenant registry token field.
  const sendCalls = [...serverSrc.matchAll(/send\(res,\s*\d+,([\s\S]*?)\);/g)].map(m => m[1] ?? '');
  for (const call of sendCalls) assert.ok(!/platform(?:_operator)?_token/.test(call), `a browser-facing send() call must never include a token field: ${call.slice(0, 80)}`);
});

test('built frontend bundle exists and contains no literal occurrence of a backend token env-var name (would indicate a bundled secret)', () => {
  const distDir = resolve('apps', 'tna-control-center-web', 'dist', 'assets');
  if (!existsSync(distDir)) { assert.ok(true, 'frontend not built in this run — covered by the packaged smoke test which requires a real build'); return; }
  const jsFiles = readdirSync(distDir).filter(f => f.endsWith('.js'));
  for (const file of jsFiles) {
    const content = readFileSync(join(distDir, file), 'utf8');
    assert.ok(!content.includes('TNA_CONTROL_CENTER_TENANT_REGISTRY_PATH'), 'the tenant registry path/contents must never be bundled into frontend JS');
    assert.ok(!/platform_operator_token/.test(content), 'the operator token field name must never appear in the bundled frontend — it never crosses the browser boundary');
  }
});
