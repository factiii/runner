// How a post's body is split into PostContent rows (.specs/posts.md → "Content
// rows"). A row is what one search vector can hold: the embedder truncates at
// 256 tokens (services/embedder/convert_text.py), ~4 chars a token, with
// headroom. Rows are disjoint, so joining them with '' rebuilds the body.

export const MAX_CONTENT_CHARS = 900;

// Blank line between pages: it keeps the sentence/paragraph split working across
// the seam instead of welding one page's last sentence to the next page's first.
const PAGE_SEPARATOR = '\n\n';

type ContentRow = {
  text: string;
  // 1-based source page for a row cut from a document; null for prose.
  page: number | null;
};

// Where a cut leaves nothing open. Row 1 renders on its own until the reader
// loads more, so a row must not end inside a mark, a code span or fence, a
// `[text](url)` link, or a write-time tag. Same grammar as the renderer
// (.specs/posts.md → "Formatting"). A list marker is not a mark, and a row
// must not end right after one; a backslash escapes the next character.
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;

function cleanCuts(window: string): boolean[] {
  const clean: boolean[] = new Array<boolean>(window.length + 1).fill(false);
  let fence = false;
  let code = false;
  let bold = false;
  let italic = false;
  let underscore = false;
  let strike = false;
  let link: 'text' | 'url' | null = null;
  let tag = false;
  let lineStart = true;
  clean[0] = true;
  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    const pair = window.slice(i, i + 2);
    const fenceHere = lineStart && window.startsWith('```', i);
    const marker =
      lineStart && !fence ? LIST_MARKER.exec(window.slice(i)) : null;
    let bareMarker = false;
    if (marker) {
      i += marker[0].length - 1;
      bareMarker = true;
    } else if (fenceHere) {
      fence = !fence;
      i += 2;
    } else if (fence) {
      // Nothing inside a fence is markup.
    } else if (c === '`') {
      code = !code;
    } else if (code) {
      // Nor inside an inline code span.
    } else if (c === '\\') {
      i += 1;
    } else if (tag) {
      if (c === '>') tag = false;
    } else if (c === '<') {
      tag = true;
    } else if (link === 'url') {
      if (c === ')') link = null;
    } else if (link === 'text' && pair === '](') {
      link = 'url';
      i += 1;
    } else if (c === '[') {
      link = 'text';
    } else if (pair === '**') {
      bold = !bold;
      i += 1;
    } else if (pair === '~~') {
      strike = !strike;
      i += 1;
    } else if (c === '*') {
      italic = !italic;
    } else if (c === '_') {
      // Word boundary outside, as the renderer requires: snake_case opens nothing.
      const prev = i === 0 ? '' : window[i - 1];
      const next = window[i + 1] ?? '';
      if (!underscore && !/[\w_]/.test(prev) && /\S/.test(next))
        underscore = true;
      else if (underscore && !/[\w_]/.test(next)) underscore = false;
    }
    lineStart = window[i] === '\n';
    clean[i + 1] =
      !bareMarker &&
      !fence &&
      !code &&
      !bold &&
      !italic &&
      !underscore &&
      !strike &&
      !link &&
      !tag;
  }
  return clean;
}

// Latest clean sentence end, else newline, else whitespace, else the latest
// clean position, else a hard cut. Only a span longer than a row is ever cut
// open. `window` is already capped to MAX_CONTENT_CHARS by the caller.
function findSplit(window: string): number {
  const minSplit = Math.floor(MAX_CONTENT_CHARS * 0.5);
  const clean = cleanCuts(window);
  let fallback = -1;
  for (const pattern of [/[.!?]\s/g, /\n/g, /\s/g]) {
    let best = -1;
    for (const match of window.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (end <= minSplit) continue;
      if (clean[end]) best = Math.max(best, end);
      else fallback = Math.max(fallback, end);
    }
    if (best > 0) return best;
  }
  // A clean cut mid-word beats an open mark.
  for (let at = MAX_CONTENT_CHARS; at > minSplit; at--) {
    if (clean[at] && !isHighSurrogate(window, at)) return at;
  }
  if (fallback > 0) return fallback;
  return isHighSurrogate(window, MAX_CONTENT_CHARS)
    ? MAX_CONTENT_CHARS - 1
    : MAX_CONTENT_CHARS;
}

// An emoji is two UTF-16 units; a lone surrogate becomes U+FFFD in Postgres.
function isHighSurrogate(window: string, at: number): boolean {
  const last = window.charCodeAt(at - 1);
  return last >= 0xd800 && last <= 0xdbff;
}

/** Split text into consecutive slices of at most MAX_CONTENT_CHARS. `''` → `[]`. */
export function splitContent(text: string): string[] {
  const slices: string[] = [];
  let cursor = 0;
  while (text.length - cursor > MAX_CONTENT_CHARS) {
    // Copy only the window we search, not the whole tail — a single 2MB .txt
    // would otherwise re-copy the remainder on every one of its 2,000 splits.
    const at = findSplit(text.slice(cursor, cursor + MAX_CONTENT_CHARS));
    slices.push(text.slice(cursor, cursor + at));
    cursor += at;
  }
  if (cursor < text.length) slices.push(text.slice(cursor));
  return slices;
}

/** Pages → rows. Pages are trimmed, empty ones skipped, and the separator leads
 *  the next page's first row (trailing, it could be a whitespace-only row with
 *  a vector of its own). `joinRows(chunkPages(pages))` is the stored body. */
export function chunkPages(pages: { text: string }[]): ContentRow[] {
  const trimmed = pages
    .map((p, i) => ({ text: p.text.trim(), page: i + 1 }))
    .filter((p) => p.text);
  return trimmed.flatMap((p, i) =>
    splitContent(i === 0 ? p.text : PAGE_SEPARATOR + p.text).map((text) => ({
      text,
      page: p.page
    }))
  );
}

/** Rows back to the body. Rows are disjoint, so this is exact. */
export const joinRows = (rows: { text: string }[]): string =>
  rows.map((row) => row.text).join('');
