import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), sections 51-54. Cookie and CSRF helpers for
 * the Control Center's browser session boundary. The session cookie is HttpOnly (never readable by page
 * JavaScript, defeating XSS-driven session theft of the cookie itself) and `SameSite=Lax`; a SEPARATE,
 * non-HttpOnly CSRF cookie carries the session's own real `csrf_token` (bound server-side to that exact
 * session row, not a bare independently-generated value) so the browser's own same-origin JavaScript can
 * read it and echo it back as a request header — the standard double-submit pattern, strengthened here by
 * binding the token to the session record rather than trusting the cookie pair alone.
 */

export const SESSION_COOKIE = 'tna_cc_session';
export const CSRF_COOKIE = 'tna_cc_csrf';

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function setSessionCookies(res: ServerResponse, sessionId: string, csrfToken: string, secure: boolean, maxAgeSeconds: number): void {
  const base = (name: string, value: string, httpOnly: boolean): string => {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `Max-Age=${maxAgeSeconds}`, 'SameSite=Lax'];
    if (httpOnly) parts.push('HttpOnly');
    if (secure) parts.push('Secure');
    return parts.join('; ');
  };
  res.setHeader('Set-Cookie', [base(SESSION_COOKIE, sessionId, true), base(CSRF_COOKIE, csrfToken, false)]);
}
export function clearSessionCookies(res: ServerResponse, secure: boolean): void {
  const base = (name: string, httpOnly: boolean): string => {
    const parts = [`${name}=`, 'Path=/', 'Max-Age=0', 'SameSite=Lax'];
    if (httpOnly) parts.push('HttpOnly');
    if (secure) parts.push('Secure');
    return parts.join('; ');
  };
  res.setHeader('Set-Cookie', [base(SESSION_COOKIE, true), base(CSRF_COOKIE, false)]);
}

/** Every mutating (non-GET/HEAD) request against a cookie-authenticated session must present the
 * session's OWN real csrf_token as a header — a cross-site attacker's page can trigger a cookie-carrying
 * request but cannot read the CSRF cookie's value cross-origin, so it can never produce a matching header. */
export function verifyCsrf(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers['x-csrf-token'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
