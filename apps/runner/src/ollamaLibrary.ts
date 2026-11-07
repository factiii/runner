import type { OllamaLibraryModel } from '@shared/all/domains/electron';
import { OLLAMA_NAME_PATTERN, OLLAMA_TAG_PATTERN } from '@shared/all/validators';

// ollama.com's search and tags pages, read as the HTML they are (Oakbox >
// Account > Backend, .specs/runner-vault-ask.md "Oakbox's backend: setup, sign-ins, models"). Ollama has no
// public search API, so this reads the markup its own site renders. Pure:
// the fetch and the cache are ollamaLibraryFetch.ts. When the site changes,
// the parse finds nothing rather than something wrong, and the tests'
// saved pages (test-fixtures/ollama-*.html) show what it was written for.

export const OLLAMA_ORIGIN = 'https://ollama.com';

/** One tag as the tags page lists it, before any fit. */
export type ParsedOllamaTag = {
  tag: string;
  aliases: string[];
  sizeGb: number | null;
  context: string | null;
  input: string | null;
  cloud: boolean;
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

/** Exported for the tests. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const textOf = (html: string) =>
  decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** `/library/qwen3` → `qwen3`; `/someone/model` → `someone/model`. */
const nameFromPath = (path: string) => path.replace(/^\/(?:library\/)?/, '');

export const searchUrl = (query: string): string =>
  query ? `${OLLAMA_ORIGIN}/search?${new URLSearchParams({ q: query })}` : `${OLLAMA_ORIGIN}/search`;

/** A model's tags page. `name` has passed `ollamaNameSchema`. */
export function tagsUrl(name: string): string {
  const parts = name.split('/').map(encodeURIComponent);
  return `${OLLAMA_ORIGIN}/${parts.length === 1 ? `library/${parts[0]}` : parts.join('/')}/tags`;
}

/** The chips in one result whose class has `colour`, as their text. */
function chips(html: string, colour: string): string[] {
  const out: string[] = [];
  const re = /<span[^>]*class="([^"]*)"[^>]*>([^<]*)<\/span>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]!.split(/\s+/).includes(colour)) {
      const text = textOf(m[2]!);
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

/** Each result on a search page: its name, description, capability chips
 *  (indigo), parameter sizes (blue), whether it is a cloud model (cyan) and
 *  its downloads. */
export function parseOllamaSearch(html: string): OllamaLibraryModel[] {
  const models: OllamaLibraryModel[] = [];
  const re = /<a href="(\/[^"]+)" class="group flex items-start[^"]*">([\s\S]*?)<\/a>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const name = nameFromPath(decodeEntities(m[1]!));
    if (!OLLAMA_NAME_PATTERN.test(name) || models.some((x) => x.name === name)) continue;
    const body = m[2]!;
    const description = /<p[^>]*\btitle="([^"]*)"/.exec(body)?.[1];
    const downloads = /title="([\d,]+) downloads?"/.exec(body)?.[1];
    models.push({
      name,
      description: description ? decodeEntities(description).trim() : '',
      capabilities: chips(body, 'bg-indigo-50'),
      sizes: chips(body, 'bg-[#ddf4ff]'),
      cloud: chips(body, 'bg-cyan-50').includes('cloud'),
      downloads: downloads ? Number(downloads.replace(/,/g, '')) : null
    });
  }
  return models;
}

const UNIT_GB: Record<string, number> = { KB: 1 / 1e6, MB: 1 / 1e3, GB: 1, TB: 1e3 };

/** "5.2GB" → 5.2, "523MB" → 0.523; null for "High Usage" and the like.
 *  Exported for the tests. */
export function sizeToGb(text: string): number | null {
  const m = /^([\d.]+)\s*(KB|MB|GB|TB)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.round(n * UNIT_GB[m[2]!.toUpperCase()]! * 1000) / 1000 : null;
}

/** A tag that runs on Ollama's cloud: `name:cloud`, `name:480b-cloud`. */
export const isCloudTag = (tag: string): boolean =>
  /(?:^|[:-])cloud$/i.test(tag.slice(tag.indexOf(':') + 1));

/** "500a1f067a9f • 5.2GB • 40K context window • Text input": the digest,
 *  the size, the context and the input, as a tag's line reads. */
const TAG_FACTS =
  /\b([0-9a-f]{12})\s*•\s*([^•]+?)\s*•\s*(?:([^•]+?)\s+context window\s*•\s*)?(?:([^•]+?)\s+input\b)?/i;

/** `qwen3:latest` is no better a name than `qwen3:8b` for the same file. */
const rank = (tag: string) => (tag.endsWith(':latest') ? 1000 : 0) + tag.length;

/**
 * Each tag on a tags page, with its size, context and input. Tags that are
 * the same file (the same digest: `qwen3:latest`, `qwen3:8b`,
 * `qwen3:8b-q4_K_M`) are one row under the shortest name, with the others as
 * aliases; quantizations are other files, so each keeps its row.
 */
export function parseOllamaTags(html: string): ParsedOllamaTag[] {
  type Row = ParsedOllamaTag & { digest: string | null };
  const rows: Row[] = [];
  // The phone layout's link carries all of a tag's facts in one place.
  const re = /<a href="(\/[^"]+)" class="md:hidden[^"]*">([\s\S]*?)<\/a>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const tag = nameFromPath(decodeEntities(m[1]!));
    if (!tag.includes(':') || !OLLAMA_TAG_PATTERN.test(tag)) continue;
    const text = textOf(m[2]!);
    const facts = TAG_FACTS.exec(text);
    const sizeGb = facts ? sizeToGb(facts[2]!) : null;
    const row: Row = {
      tag,
      aliases: [],
      sizeGb,
      context: facts?.[3]?.trim() ?? null,
      input: facts?.[4]?.trim() ?? null,
      cloud: isCloudTag(tag) || (facts !== null && sizeGb === null),
      digest: facts?.[1] ?? null
    };
    const same = row.digest ? rows.find((r) => r.digest === row.digest) : rows.find((r) => r.tag === tag);
    if (!same) {
      rows.push(row);
      continue;
    }
    if (same.tag === tag || same.aliases.includes(tag)) continue;
    // Keep the better name in front.
    if (rank(tag) < rank(same.tag)) {
      same.aliases.push(same.tag);
      same.tag = tag;
    } else {
      same.aliases.push(tag);
    }
  }
  return rows.map(({ digest: _digest, ...row }) => ({
    ...row,
    aliases: [...row.aliases].sort((a, b) => a.length - b.length)
  }));
}
