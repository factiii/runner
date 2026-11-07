// How a scratchpad file becomes something on screen.
//
// The extension is the whole contract: an agent that writes `chart.png` gets an
// image and one that writes `notes.md` gets prose, with no manifest to keep in
// step and nothing to parse before the panel knows what it is holding. Both
// ends import this, so the runner's listing and the panel's renderer can never
// disagree about what a name means.

import type { ScratchpadKind } from '../domains/electron';

/** Inlined over the data channel at 14KB a frame, so this is the point past
 *  which a read costs more than the panel can justify. Bigger files still get
 *  listed - the panel offers the host path instead of the bytes. */
export const SCRATCHPAD_MAX_BYTES = 12_000_000;

/** A scratchpad is a display surface, not a folder. Past this the listing is
 *  truncated (newest kept) rather than paged. */
export const SCRATCHPAD_MAX_ITEMS = 200;

/** Bytes per range in a download. Base64 inflates by 4/3 and the transport
 *  frames at 14KB, so this is ~50 frames a round trip: big enough that the
 *  per-request overhead disappears, small enough to report progress against. */
export const SCRATCHPAD_CHUNK_BYTES = 512 * 1024;

/** A download still has to fit in the tab that asked for it, since the parts
 *  are held in memory until the Blob is assembled. Past this the panel says no
 *  rather than killing the page. */
export const SCRATCHPAD_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** The ranges a download walks, in order. Its own function so the arithmetic
 *  is testable without a runner: an off-by-one here is a corrupt file, and a
 *  corrupt file is the kind of bug nobody notices until they open it.
 *
 *  A zero-byte file yields no ranges - there is nothing to ask for, and the
 *  caller writes an empty Blob. */
export function scratchpadChunkRanges(
  size: number,
  chunk = SCRATCHPAD_CHUNK_BYTES
): { offset: number; length: number }[] {
  if (!Number.isFinite(size) || size <= 0) return [];
  const ranges: { offset: number; length: number }[] = [];
  for (let offset = 0; offset < size; offset += chunk) {
    ranges.push({ offset, length: Math.min(chunk, size - offset) });
  }
  return ranges;
}

/** Extension → renderer. Anything unlisted reads as text, which is the honest
 *  default: a file the panel cannot place is still worth showing. */
const KIND_BY_EXT: Record<string, ScratchpadKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  svg: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  aac: 'audio',
  flac: 'audio',
  pdf: 'pdf',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  url: 'link'
};

/** What a browser needs to play or draw the bytes. Only kinds the panel hands
 *  to an element need one; everything else is decoded as text. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pdf: 'application/pdf'
};

/** Lowercased, no dot. '' when the name has no extension, or ends in one.
 *  Private: `kind` and `mimeType` below are the whole public surface, and a
 *  third answer to "what is this file" is a third thing to keep in step. */
function scratchpadExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function scratchpadKind(name: string): ScratchpadKind {
  return KIND_BY_EXT[scratchpadExt(name)] ?? 'text';
}

/** Kinds a client reads as characters rather than bytes. Coupled to
 *  `scratchpadKind` above, so it lives beside it rather than in each client's
 *  renderer, where the two copies had already started to differ. */
export function isTextualScratchpadKind(kind: ScratchpadKind): boolean {
  return (
    kind === 'html' || kind === 'markdown' || kind === 'text' || kind === 'link'
  );
}

export function scratchpadMimeType(name: string): string {
  return MIME_BY_EXT[scratchpadExt(name)] ?? 'application/octet-stream';
}

/**
 * A name the runner will act on. The scratchpad is flat and agent-written, so
 * every read and delete runs this first: no separators, no traversal, no
 * leading dot (which would hide the file from the listing that named it), and
 * nothing a shell would treat as anything but a word.
 */
export function isSafeScratchpadName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.startsWith('.')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name);
}

/**
 * The URL a `.url` file points at, or '' when it holds none.
 *
 * Both spellings are accepted: a bare URL on its own line, and Windows'
 * `[InternetShortcut]` / `URL=` INI, which is what most tools write when asked
 * for a link file.
 */
export function parseScratchpadLink(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('[') || line.startsWith('#')) continue;
    const value = /^url\s*=/i.test(line) ? line.replace(/^url\s*=/i, '') : line;
    const url = value.trim();
    if (/^https?:\/\/\S+$/i.test(url)) return url;
  }
  return '';
}

/** A size a person reads at a glance, for the panel's item subtitles. */
export function formatScratchpadSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What Copy puts on the clipboard for a textual item: a link's URL, otherwise
 * the file exactly as written, less the newline editors end a file with. Pasted
 * into a terminal, that newline would run the command before it can be read.
 */
export function scratchpadCopyText(kind: ScratchpadKind, text: string): string {
  if (kind === 'link') return parseScratchpadLink(text);
  return text.replace(/^﻿/, '').replace(/(\r?\n)+$/, '');
}

type MarkdownSegment =
  | { type: 'prose'; text: string }
  | { type: 'code'; text: string; lang: string };

/** A fence opening a code block: ``` or ~~~, three or more, then a language. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;

/**
 * A markdown file cut into prose and fenced code blocks, so each block can
 * carry its own Copy and one note can hand over several commands. A fence left
 * open runs to the end of the file, as markdown renders it.
 */
export function markdownSegments(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let prose: string[] = [];
  let code: { fence: string; lang: string; lines: string[] } | null = null;

  const flushProse = () => {
    const joined = prose.join('\n');
    if (joined.trim()) segments.push({ type: 'prose', text: joined });
    prose = [];
  };

  // CRLF as LF: a block keeping its \r would run on paste into a terminal.
  for (const line of text.split(/\r\n?|\n/)) {
    if (code) {
      const close = line.trim();
      if (
        close.length >= code.fence.length &&
        close === code.fence[0]!.repeat(close.length)
      ) {
        segments.push({ type: 'code', text: code.lines.join('\n'), lang: code.lang });
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    const open = FENCE_RE.exec(line);
    if (open) {
      flushProse();
      code = { fence: open[1]!, lang: open[2] ?? '', lines: [] };
      continue;
    }
    prose.push(line);
  }
  if (code) {
    segments.push({ type: 'code', text: code.lines.join('\n'), lang: code.lang });
  }
  flushProse();
  return segments;
}
