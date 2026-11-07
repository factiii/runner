// How a file is asked about its categories, shared by the two taggers: the
// server's (apps/server/src/helpers/vaultRootFactiiis.ts) and a runner's
// Categorize (apps/runner/src/vault/categorize.ts, .specs/runner-vault-ask.md
// "Categorize on the runner"). One list of rules, one way to say what each
// asks for, and one way to cut a long document, so a file is asked the same
// question wherever it is kept.

/** A category as a tagger asks about it: its rule is `description`. */
export type CategoryRule = {
  id: number;
  // Slugs are how a tagger names a specific root it treats specially (the
  // markdown → Research default); ids would break the moment a database is
  // seeded fresh.
  slug: string;
  name: string;
  description: string | null;
  requirements: string[];
};

// Requirements meaning "this tag carries a value".
const DATA_REQUIREMENTS = ['DATA_REQUIRED', 'INTEGER_REQUIRED'] as const;
// Adding one of these to a root is the whole change needed to make the pass
// start reading that field off the document.
const LOCATION_REQUIREMENTS = [
  'LOCATION_REQUIRED',
  'DEVICE_LOCATION',
  'APPROXIMATE_LOCATION'
] as const;
const TIME_REQUIREMENTS = ['TIME_REQUIRED'] as const;
// All four validate the same way: a URL in `data`. SOURCE_REQUIRED is absent on
// purpose — despite the name it checks `factiiiReferences` rows instead, so a
// URL in `data` would still leave the tag incomplete.
const SOURCE_REQUIREMENTS = [
  'HUMAN_SOURCE',
  'GOVERNMENT_SOURCE',
  'ENTERPRISE_SOURCE',
  'ANONYMOUS_SOURCE'
] as const;

const hasAny = (rule: CategoryRule, group: readonly string[]): boolean =>
  rule.requirements.some((r) => group.includes(r));

export const needsSource = (rule: CategoryRule): boolean =>
  hasAny(rule, SOURCE_REQUIREMENTS);
export const needsData = (rule: CategoryRule): boolean =>
  hasAny(rule, DATA_REQUIREMENTS) || needsSource(rule);
export const needsPlace = (rule: CategoryRule): boolean =>
  hasAny(rule, LOCATION_REQUIREMENTS);
export const needsTime = (rule: CategoryRule): boolean =>
  hasAny(rule, TIME_REQUIREMENTS);
// Validated as a number, so a word there is no better than nothing.
export const needsNumber = (rule: CategoryRule): boolean =>
  rule.requirements.includes('INTEGER_REQUIRED');

// Shown beside the root so its rule and its ask arrive together.
const asks = (rule: CategoryRule): string => {
  const value = (): string => {
    if (needsNumber(rule)) return 'a number in data';
    if (needsSource(rule)) return 'a source URL in data';
    return needsData(rule) ? 'a value in data' : '';
  };
  const parts = [
    value(),
    needsPlace(rule) ? 'a place with its region' : '',
    needsTime(rule) ? 'a date' : ''
  ].filter(Boolean);
  return parts.length > 0 ? ` (needs ${parts.join(', ')})` : '';
};

/** The list a tagging call carries: each category's id, name, what it needs
 *  and its rule, word for word. */
export const renderRules = (rules: CategoryRule[]): string =>
  rules
    .map((r) => {
      const rule = r.description?.trim() || '(no description — skip it)';
      return `[${r.id}] ${r.name}${asks(r)}\n    ${rule}`;
    })
    .join('\n');

/**
 * Cut text into pieces no larger than `budget`, preferring paragraph breaks so a
 * rule is not split mid-sentence. A paragraph longer than the budget on its own
 * is hard-sliced — better a clean cut than a piece that will not fit.
 *
 * Losing or duplicating text here is silent, and the only way to see it is to
 * assert the pieces still add up to what went in (the server's
 * splitForTagging.test.ts).
 */
export const splitForTagging = (text: string, budget: number): string[] => {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    for (let rest = paragraph; rest.length > 0; ) {
      const piece = rest.slice(0, budget);
      rest = rest.slice(budget);
      if (current && current.length + piece.length + 2 > budget) {
        chunks.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
};

// Markdown in a vault is notes-written-to-be-read-again far more often than it
// is anything else, so the Research root is the DEFAULT for a .md file rather
// than something the model has to think of. Coded in each tagger, not left to
// the root's description, because "the model usually notices" is how a whole
// file type ends up untagged.
export const RESEARCH_ROOT_SLUG = 'research';

/** Said once per Markdown file, with the first piece of the first round. */
export const MARKDOWN_RESEARCH_NOTE =
  'This is a Markdown file. Markdown here is notes written to be read again, so it counts as research by default. You do not need to tag Research for that to happen. Set `notResearch` true only if this particular document is clearly not research.';
