import type { OllamaLibraryModel } from '@shared/all/domains/electron';
import { ollamaTagKey } from '@shared/all/helpers/oakboxBackend';

import {
  OLLAMA_ORIGIN,
  type ParsedOllamaTag,
  parseOllamaSearch,
  parseOllamaTags,
  searchUrl,
  tagsUrl
} from './ollamaLibrary';

// ollama.com read from the runner (Oakbox > Account > Backend's search). The
// runner asks ollama.com itself, never Factiii's server, so Runner mode stays
// independent of Factiii. Pages are kept a few minutes: typing a query asks
// again on every pause, and opening a model then pulling one of its tags
// reads the same page twice.

const TIMEOUT_MS = 10_000;
/** A tags page is about 230 KB; a page far past that is not one. */
const MAX_BYTES = 3_000_000;
const CACHE_MS = 5 * 60_000;
const CACHE_ENTRIES = 64;

export const UNREACHABLE = 'Could not reach ollama.com.';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type OllamaLibrary = {
  search(query: string): Promise<OllamaLibraryModel[]>;
  tags(name: string): Promise<ParsedOllamaTag[]>;
  /** One tag's facts for a pull, from its model's page; null when unknown or
   *  ollama.com cannot be read. */
  lookup(tag: string): Promise<ParsedOllamaTag | null>;
};

/** The page's text, or null for a 404. Throws `UNREACHABLE` on any other
 *  failure, a slow answer or a page over the cap. */
async function fetchPage(fetchImpl: FetchLike, url: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'text/html' }
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (res.status === 404) return null;
  // A redirect off ollama.com is not a page of it.
  if (!res.ok || (res.url && !res.url.startsWith(`${OLLAMA_ORIGIN}/`))) {
    throw new Error(UNREACHABLE);
  }
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error(UNREACHABLE);
      }
      chunks.push(value);
    }
  } catch {
    throw new Error(UNREACHABLE);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createOllamaLibrary(
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  now: () => number = Date.now
): OllamaLibrary {
  const cache = new Map<string, { at: number; value: unknown }>();

  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value as T;
    const value = await load();
    cache.delete(key);
    cache.set(key, { at: now(), value });
    // A Map keeps insertion order, so the first key is the oldest.
    while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    return value;
  }

  const tags = (name: string) =>
    cached(`tags:${name}`, async () => {
      const html = await fetchPage(fetchImpl, tagsUrl(name));
      if (html === null) throw new Error(`ollama.com has no model named ${name}.`);
      return parseOllamaTags(html);
    });

  return {
    search: (query) =>
      cached(`search:${query.toLowerCase()}`, async () => {
        const html = await fetchPage(fetchImpl, searchUrl(query));
        return html === null ? [] : parseOllamaSearch(html);
      }),
    tags,
    lookup: async (tag) => {
      const key = ollamaTagKey(tag);
      const name = key.slice(0, key.indexOf(':'));
      const list = await tags(name).catch(() => null);
      return list?.find((t) => [t.tag, ...t.aliases].map(ollamaTagKey).includes(key)) ?? null;
    }
  };
}
