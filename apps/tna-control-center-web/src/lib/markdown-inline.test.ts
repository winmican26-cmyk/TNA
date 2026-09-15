import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeInline, isSafeHref } from './markdown-inline.ts';

/**
 * Focused coverage for the Help-page inline renderer's parsing/escaping behavior. Runs under plain
 * `node --test` (Node 24's built-in TypeScript type-stripping) — no test framework added as a dependency.
 */

test('bold', () => {
  assert.deepEqual(tokenizeInline('a **bold** word'), [
    { kind: 'text', value: 'a ' },
    { kind: 'bold', value: 'bold' },
    { kind: 'text', value: ' word' },
  ]);
});

test('italic', () => {
  assert.deepEqual(tokenizeInline('a *italic* word'), [
    { kind: 'text', value: 'a ' },
    { kind: 'italic', value: 'italic' },
    { kind: 'text', value: ' word' },
  ]);
});

test('bold is not consumed as italic-plus-text-plus-italic', () => {
  assert.deepEqual(tokenizeInline('**bold**'), [{ kind: 'bold', value: 'bold' }]);
});

test('code', () => {
  assert.deepEqual(tokenizeInline('run `ls -la` now'), [
    { kind: 'text', value: 'run ' },
    { kind: 'code', value: 'ls -la' },
    { kind: 'text', value: ' now' },
  ]);
});

test('safe link renders as a real link token', () => {
  assert.deepEqual(tokenizeInline('[docs](https://example.com/x)'), [
    { kind: 'link', text: 'docs', href: 'https://example.com/x' },
  ]);
});

test('mixed bold, italic, code and link in one line', () => {
  const tokens = tokenizeInline('**A** and *B* and `C` and [D](https://x.test)');
  assert.deepEqual(tokens, [
    { kind: 'bold', value: 'A' },
    { kind: 'text', value: ' and ' },
    { kind: 'italic', value: 'B' },
    { kind: 'text', value: ' and ' },
    { kind: 'code', value: 'C' },
    { kind: 'text', value: ' and ' },
    { kind: 'link', text: 'D', href: 'https://x.test' },
  ]);
});

test('javascript: scheme link is downgraded to plain text, never a link token', () => {
  // The unbalanced `)` inside `alert(1)` ends the link's URL capture early (a pre-existing regex
  // limitation, not a safety issue) — what matters for security is asserted below: no `link` token is ever
  // produced for a javascript: scheme, regardless of exactly how the trailing text is split.
  const tokens = tokenizeInline('[click me](javascript:alert(1))');
  assert.ok(tokens.every(t => t.kind !== 'link'), 'must never produce a link token for a javascript: scheme');
  assert.equal(tokens.map(t => (t.kind === 'text' ? t.value : '')).join(''), 'click me)');
});

test('data: scheme link is downgraded to plain text', () => {
  const tokens = tokenizeInline('[x](data:text/html,<script>alert(1)</script>)');
  assert.ok(tokens.every(t => t.kind !== 'link'));
});

test('isSafeHref allows http(s)/mailto/relative/anchor, rejects script-executing schemes', () => {
  assert.equal(isSafeHref('https://example.com'), true);
  assert.equal(isSafeHref('http://example.com'), true);
  assert.equal(isSafeHref('mailto:a@example.com'), true);
  assert.equal(isSafeHref('/help/openai'), true);
  assert.equal(isSafeHref('./doc.md'), true);
  assert.equal(isSafeHref('#section'), true);
  assert.equal(isSafeHref('javascript:alert(1)'), false);
  assert.equal(isSafeHref('data:text/html,x'), false);
  assert.equal(isSafeHref('vbscript:msgbox(1)'), false);
  assert.equal(isSafeHref(''), false);
});

test('raw HTML in plain text is captured as an inert text token, never specially parsed', () => {
  const input = 'before <script>alert(1)</script> after';
  const tokens = tokenizeInline(input);
  // No HTML recognition exists in the tokenizer at all — the whole line is one literal text token.
  assert.deepEqual(tokens, [{ kind: 'text', value: input }]);
  // Rendered as JSX text children (see markdown.tsx), React escapes this automatically — it is displayed
  // as visible text, never parsed as markup or executed. This module never calls dangerouslySetInnerHTML.
});

test('raw HTML mixed with real markdown does not bypass escaping of the HTML part', () => {
  const tokens = tokenizeInline('**bold** <img src=x onerror=alert(1)> *end*');
  assert.deepEqual(tokens, [
    { kind: 'bold', value: 'bold' },
    { kind: 'text', value: ' <img src=x onerror=alert(1)> ' },
    { kind: 'italic', value: 'end' },
  ]);
});

test('an HTML-looking string inside code stays a code token, not executable markup', () => {
  assert.deepEqual(tokenizeInline('`<script>x</script>`'), [
    { kind: 'code', value: '<script>x</script>' },
  ]);
});
