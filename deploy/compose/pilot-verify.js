// TNA Pilot Deployment v0.1 — operator verification script (see
// docs/deployment/pilot-deployment-verification-v0.1.md, item 1). Exercises the real, running pilot
// stack through its one public endpoint exactly as a browser would — no mocking, no interception.
// Never embeds a real credential: the pilot admin username/password are read from the environment,
// created ahead of time with `scripts/control-center-create-user.ts` (or the Onboarding page) and never
// committed anywhere.
//
// Usage: TNA_PILOT_ADMIN_USER=... TNA_PILOT_ADMIN_PASSWORD=... node pilot-verify.js [base_url]
const base = process.argv[2] ?? 'https://localhost';
const username = process.env.TNA_PILOT_ADMIN_USER;
const password = process.env.TNA_PILOT_ADMIN_PASSWORD;
if (!username || !password) {
  console.error('set TNA_PILOT_ADMIN_USER and TNA_PILOT_ADMIN_PASSWORD (a real pilot admin account you created yourself)');
  process.exit(1);
}
// Local-only verification runs against Caddy's `localhost` internal-CA certificate (see the Caddyfile's
// own header comment) — never disable TLS verification against a real pilot hostname.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = base.includes('localhost') ? '0' : '1';

async function main() {
  const loginRes = await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const cookies = (loginRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]);
  const cookie = cookies.join('; ');
  console.log('login status', loginRes.status);
  console.log('cookie flags:', (loginRes.headers.getSetCookie?.() ?? []).map(c => c.split(';').slice(1).map(s => s.trim()).join('|')));
  if (loginRes.status !== 200) { console.error('login failed, aborting'); process.exit(1); }

  const dash = await fetch(`${base}/api/dashboard`, { headers: { Cookie: cookie } });
  console.log('dashboard status', dash.status, JSON.stringify(await dash.json()));

  const org = await fetch(`${base}/api/organization`, { headers: { Cookie: cookie } });
  console.log('organization (client gateway) status', org.status, (await org.text()).slice(0, 200));

  const readiness = await fetch(`${base}/api/readiness`, { headers: { Cookie: cookie } });
  console.log('readiness (client gateway) status', readiness.status);

  const ev = await fetch(`${base}/api/evidence/search`, { headers: { Cookie: cookie } });
  console.log('evidence (expected 503 — Ledger/Auditor are documented as not deployable in v0.1, see the security checklist) status', ev.status, await ev.text());

  const audit = await fetch(`${base}/api/audit/assessments`, { headers: { Cookie: cookie } });
  console.log('audit (expected 503, same reason) status', audit.status, await audit.text());

  const hostile = await fetch(`${base}/api/session/me`, { headers: { Origin: 'https://evil.example.com' } });
  console.log('hostile-origin CORS check — Access-Control-Allow-Origin header present:', hostile.headers.has('access-control-allow-origin'));

  const csrf = await fetch(`${base}/api/actions/nonexistent/approve`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  console.log('missing-CSRF-token rejection status (expect 403)', csrf.status);
}
main().catch(e => { console.error(e); process.exit(1); });
