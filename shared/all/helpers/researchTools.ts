import { z } from 'zod';

import type { ResearchProgressSource } from '../domains/socket';

// The research tools Ask's models call (.specs/search.md "Research mode"),
// defined once: Factiii's cloud Ask offers them to Claude
// (apps/server/src/utilities/research/tools.ts), and a runner serves the
// ones that read a vault to its own models, as an MCP server for Claude and
// Codex (apps/runner/src/vault/askMcp.ts) and as function tools for Ollama
// (askEngines.ts). Each tool's name, what the model is told, its input as a
// zod schema (the JSON schema the models read is made from it), and how a
// call and its result read in Ask's work line ("Worked for … · N steps").
//
// Where a tool runs is its corpus: `web` and `skills` need Factiii, so only
// the cloud has them; `files` reads the asker's own vault, and every one of
// them runs on a runner too, over the runner's own database.

const query = z.object({ query: z.string().describe('Search terms') });

const TOOLS = {
  search_wikipedia: {
    corpus: 'web',
    description:
      'Search Wikipedia for articles matching a query. Returns titles, URLs, and short excerpts.',
    input: query
  },
  read_wikipedia_article: {
    corpus: 'web',
    description:
      'Read the full text of a Wikipedia article by its URL (from search_wikipedia results).',
    input: z.object({ url: z.string().describe('Wikipedia article URL') })
  },
  search_openalex: {
    corpus: 'web',
    description:
      'Search OpenAlex for peer-reviewed papers and preprints matching a query. Returns titles, canonical URLs, authors, venue, year, citation counts, and retraction/preprint flags. Use for any scientific, medical, or academic claim.',
    input: query
  },
  read_openalex_work: {
    corpus: 'web',
    description:
      'Read the full record (metadata + abstract) of a scholarly work by its openalex.org URL (from search_openalex results) or a doi.org URL.',
    input: z.object({
      url: z.string().describe('openalex.org/W… or doi.org/10.… URL')
    })
  },
  search_edgar: {
    corpus: 'web',
    description:
      'Search SEC EDGAR filings. A company name or ticker returns that company’s recent filings (10-K, 10-Q, 8-K, S-1, insider trades); any other query runs full-text search across filing documents. Returns company, form type, dates, and document URLs. Use for claims about a company’s financials, disclosures, material events, or insider activity.',
    input: z.object({
      query: z.string().describe('Company name, ticker, or search terms')
    })
  },
  read_edgar_filing: {
    corpus: 'web',
    description:
      'Read an SEC filing by its sec.gov Archives URL (from search_edgar results): filing metadata plus the head of the document text.',
    input: z.object({
      url: z.string().describe('sec.gov/Archives/edgar/… URL')
    })
  },
  search_bluesky: {
    corpus: 'web',
    description:
      'Search recent Bluesky posts matching a query. Returns post text, author, and URL.',
    input: query
  },
  search_youtube: {
    corpus: 'web',
    description:
      'Search YouTube videos matching a query. Returns titles, URLs, and channel/description.',
    input: query
  },
  // The "my files" source. Same shape as the web tools, but every result
  // comes from the caller's own files: the user is the corpus, so whose
  // files they are is bound by whoever runs the tool, never passed by the
  // model.
  search_my_files: {
    corpus: 'files',
    description:
      "Search inside the user's own synced files. Matches the file NAME as " +
      'well as the text, and returns the page, file name and sync date. Set ' +
      'exact=true to match wording literally (names, codes, dates, file ' +
      'extensions). This searches content — to ask what files exist at all, ' +
      'use list_my_files. A hit with no uploadId is a research note you saved ' +
      'earlier, not a file: its text is all there is, and read_my_file cannot ' +
      'open it. A hit with photo=true was matched on what a photo shows, not ' +
      'on text — it is a guess until you open it with read_my_file and look.',
    input: z.object({
      query: z.string().describe('What to look for'),
      exact: z.boolean().optional().describe('Match the words literally')
    })
  },
  list_my_files: {
    corpus: 'files',
    description:
      'List the files the user has synced, newest first, with type and the ' +
      'date each was synced. Use this for any question ABOUT the collection ' +
      '— which files exist, what formats, what was added recently. Searching ' +
      'inside documents cannot answer those.',
    input: z.object({})
  },
  search_my_tags: {
    corpus: 'files',
    description:
      "Find the user's own files AND their own profile posts by the factiii " +
      'they were tagged with, such as Medical or Research. Tags describe what ' +
      'something is ABOUT, so this finds documents that never contain the ' +
      'word. Call list_my_tags first if you do not know which tags exist. A ' +
      'result with an uploadId is a file you can read_my_file; one without is ' +
      'a post, and its snippet is all there is.',
    input: z.object({ factiii: z.string().describe('The factiii name') })
  },
  list_my_tags: {
    corpus: 'files',
    description:
      "Every factiii on the user's own files and profile posts, with how many " +
      'carry each. Use this to see what they have before searching.',
    input: z.object({})
  },
  list_my_ontology: {
    corpus: 'files',
    description:
      'The rules this user files their documents by: each root factiii, what ' +
      'it is for in their own words, what hangs under it, and how many of ' +
      'their files it has caught. Different from list_my_tags, which reports ' +
      'only tags already applied — a rule with zero files is still how they ' +
      'have chosen to organise things, and is often the right vocabulary to ' +
      'search or answer in. Call it when the question is about how their ' +
      'files are organised, or when you need their words for a subject. ' +
      "Pass query to narrow to one subject: it matches a rule's name, its " +
      'wording, and the names beneath it, so "invoice" finds Finance. The ' +
      'reply carries total and nextCursor — pass nextCursor back to continue.',
    input: z.object({
      query: z
        .string()
        .optional()
        .describe('Narrow to rules about this subject'),
      cursor: z
        .number()
        .optional()
        .describe('nextCursor from a previous reply'),
      limit: z.number().optional().describe('How many to return (max 100)')
    })
  },
  save_research: {
    corpus: 'files',
    description:
      "Keep an answer in the user's own files, when what you have put " +
      'together is worth them having later — a finding they will want again, ' +
      'a summary drawn across several documents, something they asked you to ' +
      'remember. Their own rules are applied to it, so it becomes findable ' +
      'the way their documents are. Do NOT save a restatement of one file ' +
      'they already hold, an answer of a line or two, or anything they can ' +
      'read off a document directly. Save once per answer, after you have ' +
      'finished reasoning, and tell them you have in your reply.',
    input: z.object({
      title: z
        .string()
        .describe('What this is, as they would look for it later'),
      body: z
        .string()
        .describe(
          'What to keep, as simple HTML — the same formatting you answer in'
        )
    })
  },
  read_my_file: {
    corpus: 'files',
    description:
      'Read one whole file, given an uploadId from search_my_files. Do this ' +
      'before answering anything specific about a document. A photo comes ' +
      'back as the image itself: look at it and read what is in it.',
    input: z.object({
      uploadId: z.string().describe('uploadId from search_my_files')
    })
  },
  // Skills (.specs/skills.md): approved instructions for a kind of task,
  // kept on Factiii.
  find_skills: {
    corpus: 'skills',
    description:
      'Search the approved skills: instructions written for a kind of task ' +
      '(how to review a lease, how to compare two studies…). Returns each ' +
      "skill's uuid and its title, which says what it is for. Look here when " +
      'the request is a recognisable kind of task; leave the query empty to ' +
      'see the most used.',
    input: z.object({
      query: z
        .string()
        .optional()
        .describe('Words from the task, or empty for the most used')
    })
  },
  use_skill: {
    corpus: 'skills',
    description:
      "Load a skill's full instructions by uuid, and follow them for the rest " +
      'of this conversation. Loading one records that this answer used it.',
    input: z.object({ uuid: z.string().describe('uuid from find_skills') })
  }
} as const satisfies Record<
  string,
  {
    corpus: 'web' | 'files' | 'skills';
    description: string;
    input: z.ZodObject;
  }
>;

export type ResearchToolName = keyof typeof TOOLS;
type ResearchToolInput<N extends ResearchToolName> = z.infer<
  (typeof TOOLS)[N]['input']
>;
type Corpus = (typeof TOOLS)[ResearchToolName]['corpus'];

const NAMES = Object.keys(TOOLS) as ResearchToolName[];

/** The tools of one corpus, in the order the cloud offers them. */
export const researchToolNames = (corpus: Corpus): ResearchToolName[] =>
  NAMES.filter((name) => TOOLS[name].corpus === corpus);

export const isResearchTool = (name: string): name is ResearchToolName =>
  Object.prototype.hasOwnProperty.call(TOOLS, name);

/** A tool as the models read it: Anthropic's `input_schema` shape, which
 *  MCP's `inputSchema` and Ollama's `parameters` take as it is. Only the
 *  schema's own keys: no `$schema`, no `additionalProperties`. */
export type ResearchToolDef = {
  name: ResearchToolName;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export function researchToolDefs(names: ResearchToolName[]): ResearchToolDef[] {
  return names.map((name) => {
    const { properties, required } = z.toJSONSchema(TOOLS[name].input) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return {
      name,
      description: TOOLS[name].description,
      input_schema: {
        type: 'object',
        properties: properties ?? {},
        ...(required?.length ? { required } : {})
      }
    };
  });
}

/** A model's input for `name`, read against the tool's schema; the error is
 *  what the model is told. */
export function parseToolInput<N extends ResearchToolName>(
  name: N,
  input: unknown
): { ok: true; input: ResearchToolInput<N> } | { ok: false; error: string } {
  const parsed = TOOLS[name].input.safeParse(input ?? {});
  if (parsed.success) {
    return { ok: true, input: parsed.data as ResearchToolInput<N> };
  }
  return {
    ok: false,
    error: `Bad input for ${name}: ${parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`)
      .join('; ')}`
  };
}

const asString = (input: unknown, key: string): string => {
  if (input && typeof input === 'object' && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return '';
};

// Friendly live-progress label + source icon for a tool call, shown in the UI.
export function describeToolCall(
  name: string,
  input: unknown
): { source: ResearchProgressSource; label: string } {
  const q = asString(input, 'query');
  const quoted = q ? ` for “${q}”` : '';
  switch (name) {
    case 'search_wikipedia':
      return { source: 'wikipedia', label: `Searching Wikipedia${quoted}` };
    case 'read_wikipedia_article':
      return { source: 'wikipedia', label: 'Reading a Wikipedia article' };
    case 'search_openalex':
      return {
        source: 'openalex',
        label: `Searching scientific literature${quoted}`
      };
    case 'read_openalex_work':
      return { source: 'openalex', label: 'Reading a research paper' };
    case 'search_edgar':
      return { source: 'edgar', label: `Searching SEC filings${quoted}` };
    case 'read_edgar_filing':
      return { source: 'edgar', label: 'Reading an SEC filing' };
    case 'search_bluesky':
      return { source: 'bluesky', label: `Searching Bluesky${quoted}` };
    case 'search_youtube':
      return { source: 'youtube', label: `Searching YouTube${quoted}` };
    // "Your files", not "OneDrive": Oakbox asks the same tools, and its files
    // come from uploads as often as from a sync. Each of these is followed by
    // a step saying what it found (describeToolResult).
    case 'search_my_files':
      return { source: 'onedrive', label: `Searching your files${quoted}` };
    case 'list_my_files':
      return { source: 'onedrive', label: 'Listing your files' };
    case 'search_my_tags': {
      const tag = asString(input, 'factiii');
      return {
        source: 'onedrive',
        label: tag ? `Looking for files tagged “${tag}”` : 'Checking your tags'
      };
    }
    case 'list_my_tags':
      return { source: 'onedrive', label: 'Checking your tags' };
    case 'list_my_ontology':
      return { source: 'onedrive', label: 'Checking your categories' };
    case 'read_my_file':
      return { source: 'onedrive', label: 'Opening a file' };
    case 'save_research':
      return { source: 'onedrive', label: 'Saving this to your files' };
    case 'find_skills':
      return { source: 'skill', label: `Looking for a skill${quoted}` };
    case 'use_skill':
      return { source: 'skill', label: 'Reading a skill' };
    default:
      return { source: 'web', label: 'Researching' };
  }
}

// What a file tool actually did, said once it has done it — which files a search
// turned up, which file was read — as a step of its own after the "Searching…"
// one that went out before the call. The label before a call can only repeat
// the model's input; the useful part is what came back.
//
// Pure, over the tool's own JSON output, so it cannot fail a turn: anything it
// does not recognise, or cannot parse, gets null and no extra step is sent.

// How many file names a step spells out before it says "+N more".
const NAMED = 2;

const quote = (s: string) => `“${s}”`;

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

// Names, deduplicated in order: a search returns pages, so one document can
// be several hits.
const uniqueNames = (rows: unknown[], key: string): string[] => {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = (row as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) seen.add(value.trim());
  }
  return [...seen];
};

const listNames = (names: string[]): string => {
  const shown = names.slice(0, NAMED).join(', ');
  const rest = names.length - NAMED;
  return rest > 0 ? `${shown} +${rest} more` : shown;
};

const parse = (out: string): unknown => {
  try {
    return JSON.parse(out) as unknown;
  } catch {
    // A tool that failed answers in prose ("Tool failed: …").
    return undefined;
  }
};

const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;

export function describeToolResult(
  name: string,
  input: unknown,
  out: string
): string | null {
  const data = parse(out);
  if (data === undefined) return null;
  const query = field(input, 'query');
  const q = typeof query === 'string' && query ? query : '';

  switch (name) {
    case 'find_skills': {
      if (!Array.isArray(data)) return null;
      const names = uniqueNames(data, 'title');
      return names.length > 0
        ? `Found ${plural(names.length, 'skill', 'skills')}: ${listNames(names.map(quote))}`
        : 'No skill fits';
    }
    case 'search_my_files': {
      if (!Array.isArray(data)) return null;
      const names = uniqueNames(data, 'name');
      if (names.length === 0) {
        return q ? `No file mentions ${quote(q)}` : 'No matching files';
      }
      return q
        ? `Found ${quote(q)} in ${listNames(names)}`
        : `Found ${listNames(names)}`;
    }
    case 'search_my_tags': {
      if (!Array.isArray(data)) return null;
      const tag = field(input, 'factiii');
      const label = typeof tag === 'string' && tag ? quote(tag) : 'that tag';
      const names = uniqueNames(data, 'title');
      if (data.length === 0) return `Nothing is tagged ${label}`;
      return names.length > 0
        ? `Tagged ${label}: ${listNames(names)}`
        : `${plural(data.length, 'file', 'files')} tagged ${label}`;
    }
    case 'list_my_files':
      return Array.isArray(data)
        ? `Looked through ${plural(data.length, 'file', 'files')}`
        : null;
    case 'list_my_tags':
      return Array.isArray(data)
        ? `Checked ${plural(data.length, 'tag', 'tags')}`
        : null;
    case 'list_my_ontology': {
      const total = field(data, 'total');
      return typeof total === 'number'
        ? `Checked ${plural(total, 'category', 'categories')}`
        : null;
    }
    case 'read_my_file': {
      if (field(data, 'error')) return 'Could not open that file';
      const fileName = field(data, 'name');
      const named =
        typeof fileName === 'string' && fileName ? fileName : 'a file';
      // A photo was looked at, not read: it went to the model as an image.
      if (field(data, 'photo') === true) return `Looked at ${named}`;
      return field(data, 'truncated') === true
        ? `Read the start of ${named}`
        : `Read ${named}`;
    }
    case 'save_research': {
      const title = field(data, 'title');
      return typeof title === 'string' && title
        ? `Saved ${quote(title)} to your files`
        : null;
    }
    default:
      return null;
  }
}

/** One root of the user's ontology as list_my_ontology answers it. */
type OntologyEntry = {
  name: string;
  /** The rule that decides when this applies — authored, not generated. */
  rule: string | null;
  /** How many of this user's own vault files carry it. */
  files: number;
  /** Names of the factiiis hanging under this one, if any. */
  under: string[];
};

/** One page of roots, plus what it takes to ask for the next. */
export type OntologyPage = {
  entries: OntologyEntry[];
  /** How many roots matched, before paging. */
  total: number;
  /** Pass back as `cursor` for the next page; null when this is the last. */
  nextCursor: number | null;
};

const ONTOLOGY_PAGE = 20;

/**
 * list_my_ontology's page over a loaded tree, the cloud's and a runner's
 * alike. `query` matches a root's name, its rule, or the name of anything
 * under it — "invoice" should find Finance, because that is where an invoice
 * gets filed — so matching runs over the walked tree, not in SQL. `filesOf`
 * counts the page's roots only, since the rest is not returned.
 */
export async function ontologyPage(
  roots: { id: number; name: string; description: string | null }[],
  under: (rootId: number) => string[],
  filesOf: (rootIds: number[]) => Promise<Map<number, number>>,
  opts?: { query?: string; cursor?: number; limit?: number }
): Promise<OntologyPage> {
  const needle = opts?.query?.trim().toLowerCase();
  const matched = needle
    ? roots.filter(
        (r) =>
          r.name.toLowerCase().includes(needle) ||
          (r.description ?? '').toLowerCase().includes(needle) ||
          under(r.id).some((c) => c.toLowerCase().includes(needle))
      )
    : roots;

  const cursor = Math.max(0, opts?.cursor ?? 0);
  const limit = Math.min(Math.max(1, opts?.limit ?? ONTOLOGY_PAGE), 100);
  const page = matched.slice(cursor, cursor + limit);
  const files = await filesOf(page.map((r) => r.id));

  return {
    entries: page.map((root) => ({
      name: root.name,
      rule: root.description,
      files: files.get(root.id) ?? 0,
      under: under(root.id)
    })),
    total: matched.length,
    nextCursor: cursor + limit < matched.length ? cursor + limit : null
  };
}
