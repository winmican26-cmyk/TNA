import { Link, useParams } from 'react-router-dom';
import { Markdown } from '../lib/markdown.js';
import { HELP_CATEGORIES, HELP_DOC_TEMPLATE, findHelpEntry } from '../help/registry.js';

function HelpIndex() {
  return (
    <div>
      <h1>Help</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Where Can TNA Be Applied? Each page below is an architectural deployment example — how the Gate / Sentinel / Ledger / VAD
        control model could be applied to a given platform or industry. These are illustrative mappings onto publicly understood
        classes of agentic execution, not claims about any named company's actual internal systems.
      </p>
      {HELP_CATEGORIES.map(category => (
        <div key={category.slug} className="panel">
          <h3 style={{ marginTop: 0 }}>{category.title}</h3>
          {category.entries.map(entry => (
            <div key={entry.slug} style={{ padding: '4px 0' }}>
              {entry.status === 'available'
                ? <Link to={`/help/${entry.slug}`}>{entry.title} →</Link>
                : <span className="muted">{entry.title} (not yet written)</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function HelpDoc({ slug }: { readonly slug: string }) {
  const found = findHelpEntry(slug);
  if (!found) return <div><p className="error-text">Unknown help page.</p><Link to="/help">← Back to Help</Link></div>;
  const { entry } = found;
  return (
    <div>
      <Link to="/help">← Back to Help</Link>
      {entry.status === 'available' ? (
        <Markdown content={entry.content} />
      ) : (
        <>
          <h1>{entry.title}</h1>
          <p className="muted">This deployment example has not been written yet.</p>
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Planned structure</h3>
            <p className="muted">Once written, this page will follow the same shape as the other platform/domain examples:</p>
            <ol>{HELP_DOC_TEMPLATE.map(item => <li key={item}>{item}</li>)}</ol>
          </div>
        </>
      )}
    </div>
  );
}

export default function Help() {
  const { slug } = useParams<{ slug?: string }>();
  return slug ? <HelpDoc slug={slug} /> : <HelpIndex />;
}
