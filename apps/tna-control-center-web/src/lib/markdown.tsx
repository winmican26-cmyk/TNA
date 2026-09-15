import type { ReactNode } from 'react';
import { tokenizeInline } from './markdown-inline.js';

/**
 * Minimal, dependency-free renderer for the small markdown subset used by Help docs: headings (#/##/###),
 * blockquotes (>), fenced code blocks (```), tables (| a | b |), unordered/ordered lists, horizontal rules
 * (---), and inline **bold** / *italic* / `code` / [text](url). No npm package added for this — the subset
 * is small and fixed, and this project otherwise depends on nothing beyond react/react-dom/react-router-dom.
 *
 * Inline parsing/escaping lives in the plain (non-JSX) `markdown-inline.ts` so it can be unit tested with
 * `node --test` directly — see `markdown-inline.test.ts`. This function only maps its tokens to JSX; it
 * never uses `dangerouslySetInnerHTML`, so any text that isn't one of the four recognized inline forms is
 * rendered as ordinary JSX text children, which React escapes automatically rather than executing.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  let i = 0;
  return tokenizeInline(text).map(token => {
    const key = `${keyPrefix}-${i++}`;
    switch (token.kind) {
      case 'bold': return <strong key={key}>{token.value}</strong>;
      case 'italic': return <em key={key}>{token.value}</em>;
      case 'code': return <code key={key}>{token.value}</code>;
      case 'link': return <a key={key} href={token.href} target="_blank" rel="noreferrer">{token.text}</a>;
      case 'text': return token.value;
    }
  });
}

const isTableSeparator = (line: string) => /^\|?[\s:|-]+\|?$/.test(line) && line.includes('-');
const splitRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

export function Markdown({ content }: { readonly content: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const at = (idx: number) => lines[idx] ?? '';
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = at(i);

    if (line.trim().length === 0) { i++; continue; }

    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !at(i).startsWith('```')) { code.push(at(i)); i++; }
      i++;
      blocks.push(<pre key={key++}><code>{code.join('\n')}</code></pre>);
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? '').length;
      const text = renderInline(heading[2] ?? '', `h${key}`);
      blocks.push(level === 1 ? <h1 key={key++}>{text}</h1> : level === 2 ? <h2 key={key++}>{text}</h2> : <h3 key={key++}>{text}</h3>);
      i++;
      continue;
    }

    if (/^-{3,}$/.test(line.trim())) { blocks.push(<hr key={key++} />); i++; continue; }

    if (line.startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && (at(i).startsWith('>') || at(i).trim().length === 0)) {
        if (at(i).trim().length === 0) { if (quoted.length === 0 || quoted[quoted.length - 1] !== '') break; }
        quoted.push(at(i).replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={key++}>
          {quoted.filter(l => l.length > 0).map((l, idx) => <p key={idx}>{renderInline(l, `bq${key}-${idx}`)}</p>)}
        </blockquote>,
      );
      continue;
    }

    if (line.trim().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && at(i).trim().startsWith('|')) {
        if (!isTableSeparator(at(i).trim())) rows.push(splitRow(at(i)));
        i++;
      }
      const [header, ...body] = rows;
      blocks.push(
        <table key={key++}>
          {header && <thead><tr>{header.map((c, idx) => <th key={idx}>{renderInline(c, `th${key}-${idx}`)}</th>)}</tr></thead>}
          <tbody>{body.map((r, ridx) => <tr key={ridx}>{r.map((c, cidx) => <td key={cidx}>{renderInline(c, `td${key}-${ridx}-${cidx}`)}</td>)}</tr>)}</tbody>
        </table>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(at(i))) { items.push(at(i).replace(/^[-*]\s+/, '')); i++; }
      blocks.push(<ul key={key++}>{items.map((it, idx) => <li key={idx}>{renderInline(it, `ul${key}-${idx}`)}</li>)}</ul>);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(at(i))) { items.push(at(i).replace(/^\d+\.\s+/, '')); i++; }
      blocks.push(<ol key={key++}>{items.map((it, idx) => <li key={idx}>{renderInline(it, `ol${key}-${idx}`)}</li>)}</ol>);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && at(i).trim().length > 0 && !/^(#{1,3})\s|^```|^>|^\||^[-*]\s|^\d+\.\s|^-{3,}$/.test(at(i))) {
      para.push(at(i));
      i++;
    }
    blocks.push(<p key={key++}>{renderInline(para.join(' '), `p${key}`)}</p>);
  }

  return <div className="help-doc">{blocks}</div>;
}
