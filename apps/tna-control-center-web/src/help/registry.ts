// Content lives under the repo's real docs tree (`docs/help/where-can-tna-be-applied/`), not inside this
// app's src — the app is a reader of that library, not its owner. Vite's dev-server file allow-list already
// covers the whole npm-workspace root (this repo's lockfile lives there), so a relative import out of `src`
// works in both `vite dev` and `vite build`. Filenames mirror the numbered hierarchy defined by that
// directory's own README.md — keep the two in sync when adding a doc.
import openai from '../../../../docs/help/where-can-tna-be-applied/01-frontier-ai-openai.md?raw';
import anthropicClaude from '../../../../docs/help/where-can-tna-be-applied/02-frontier-ai-anthropic-claude.md?raw';
import xaiGrok from '../../../../docs/help/where-can-tna-be-applied/03-frontier-ai-xai-grok.md?raw';
import googleGemini from '../../../../docs/help/where-can-tna-be-applied/04-frontier-ai-google-gemini.md?raw';
import otherAgentPlatforms from '../../../../docs/help/where-can-tna-be-applied/05-frontier-ai-other-agent-platforms.md?raw';
import financialServices from '../../../../docs/help/where-can-tna-be-applied/06-financial-services.md?raw';
import healthcare from '../../../../docs/help/where-can-tna-be-applied/07-healthcare.md?raw';
import government from '../../../../docs/help/where-can-tna-be-applied/08-government.md?raw';
import criticalInfrastructure from '../../../../docs/help/where-can-tna-be-applied/09-critical-infrastructure.md?raw';
import softwareEngineering from '../../../../docs/help/where-can-tna-be-applied/10-software-engineering.md?raw';
import enterpriseAutomation from '../../../../docs/help/where-can-tna-be-applied/11-enterprise-automation.md?raw';

/**
 * TNA Client Control Center & Assurance UI, Help section: a library of architectural deployment examples
 * ("where could TNA be applied?"), organized by category. Each entry is either `available` (real, written
 * content, rendered below) or `planned` (named in the index so the shape of the library is visible, but
 * with no fabricated content — consistent with this app's rule of never rendering something as real that
 * isn't). Every `available` doc here is explicitly an illustrative architecture mapping, not a claim about
 * any named company's actual internal systems — see each doc's own Purpose note.
 */
export type HelpDoc = { readonly slug: string; readonly title: string; readonly content: string };
export type HelpEntry = { readonly slug: string; readonly title: string } & ({ readonly status: 'available'; readonly content: string } | { readonly status: 'planned' });
export type HelpCategory = { readonly slug: string; readonly title: string; readonly entries: readonly HelpEntry[] };

export const HELP_CATEGORIES: readonly HelpCategory[] = [
  {
    slug: 'frontier-ai-labs',
    title: 'Frontier AI Labs',
    entries: [
      { slug: 'openai', title: 'OpenAI', status: 'available', content: openai },
      { slug: 'anthropic-claude', title: 'Anthropic / Claude', status: 'available', content: anthropicClaude },
      { slug: 'xai-grok', title: 'xAI / Grok', status: 'available', content: xaiGrok },
      { slug: 'google-gemini', title: 'Google / Gemini', status: 'available', content: googleGemini },
      { slug: 'other-agent-platforms', title: 'Other Agent Platforms', status: 'available', content: otherAgentPlatforms },
    ],
  },
  { slug: 'financial-services', title: 'Financial Services', entries: [{ slug: 'financial-services', title: 'Financial Services', status: 'available', content: financialServices }] },
  { slug: 'healthcare', title: 'Healthcare', entries: [{ slug: 'healthcare', title: 'Healthcare', status: 'available', content: healthcare }] },
  { slug: 'government', title: 'Government', entries: [{ slug: 'government', title: 'Government', status: 'available', content: government }] },
  { slug: 'critical-infrastructure', title: 'Critical Infrastructure', entries: [{ slug: 'critical-infrastructure', title: 'Critical Infrastructure', status: 'available', content: criticalInfrastructure }] },
  { slug: 'software-engineering', title: 'Software Engineering', entries: [{ slug: 'software-engineering', title: 'Software Engineering', status: 'available', content: softwareEngineering }] },
  { slug: 'enterprise-automation', title: 'Enterprise Automation', entries: [{ slug: 'enterprise-automation', title: 'Enterprise Automation', status: 'available', content: enterpriseAutomation }] },
];

export function findHelpEntry(slug: string): { readonly category: HelpCategory; readonly entry: HelpEntry } | null {
  for (const category of HELP_CATEGORIES) {
    const entry = category.entries.find(e => e.slug === slug);
    if (entry) return { category, entry };
  }
  return null;
}

/** The reusable 12-part shape every platform/domain doc in this library follows once written. */
export const HELP_DOC_TEMPLATE: readonly string[] = [
  "What the platform's agents can do",
  'Where consequential execution occurs',
  'Where Gate should sit',
  'How Sentinel should observe execution',
  'What belongs in Ledger',
  'Where VAD applies',
  'How MCP/tool access should be mediated',
  'How recursive/self-modifying behavior should be governed',
  'Recommended pilot workload',
  'Enterprise-scale changes required',
  'Known limitations',
  'Example governed action flow',
];
