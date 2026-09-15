/**
 * Pure, JSX-free inline-markdown tokenizer for the Help-page renderer. Kept separate from markdown.tsx so
 * it can run under plain `node --test` (no JSX transform needed) and be unit tested without a DOM.
 *
 * This never parses or passes through raw HTML — there is no HTML-tag recognition anywhere in this file.
 * Anything that isn't one of the four recognized inline forms (bold/italic/code/link) becomes a plain
 * `text` token, rendered later as JSX text children — which React escapes automatically. That, plus never
 * using `dangerouslySetInnerHTML`, is what keeps arbitrary text (including literal `<script>`-looking
 * content) inert: it is displayed, never executed.
 */

export type InlineToken =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'bold' | 'italic' | 'code'; readonly value: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string };

/**
 * Only these URL schemes (plus scheme-relative/relative paths and in-page anchors) are allowed as a real
 * `href`. This blocks `javascript:`, `data:`, `vbscript:`, and similar script-executing schemes from ever
 * reaching an `<a>` tag, even though today's content is static and developer-authored, not user-supplied —
 * defense in depth for a renderer that could later be pointed at less-trusted content.
 */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.length === 0) return false;
  if (/^(https?:|mailto:)/i.test(trimmed)) return true;
  if (/^(\/|\.\/|\.\.\/|#)/.test(trimmed)) return true;
  return false;
}

export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  // Bold is checked before italic in the alternation so `**x**` isn't consumed as `*` + text + `*`.
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) tokens.push({ kind: 'text', value: text.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ kind: 'bold', value: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: 'italic', value: m[2] });
    else if (m[3] !== undefined) tokens.push({ kind: 'code', value: m[3] });
    else if (m[4] !== undefined) {
      const href = m[5] ?? '';
      if (isSafeHref(href)) tokens.push({ kind: 'link', text: m[4], href });
      // An unsafe scheme (e.g. `javascript:`) is downgraded to plain text — never rendered as a real link.
      else tokens.push({ kind: 'text', value: m[4] });
    }
    last = re.lastIndex;
  }
  if (last < text.length) tokens.push({ kind: 'text', value: text.slice(last) });
  return tokens;
}
