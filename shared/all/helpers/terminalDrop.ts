// A file dropped or pasted onto a board terminal (`terminalDropFile`).
//
// The name comes from the client and becomes a file on the runner, and the
// path is then typed into a shell. Every rule that makes that safe is a pure
// function here, so the client and the runner share one answer and each rule
// can be tested without a runner.

import { TERMINAL_DROP_MAX_BYTES } from '../domains/electron';

/** A file name is capped at 255 bytes on every filesystem a runner uses. This
 *  leaves room for the suffix `uniqueDropName` adds. */
const MAX_NAME_BYTES = 200;
/** Past this a "last dot" is punctuation in the name, not an extension. */
const MAX_EXT_CHARS = 16;
const FALLBACK_NAME = 'file';
const BYTES_PER_MB = 1_000_000;
/** Base64 carries 3 bytes in every 4 characters. */
const BASE64_GROUP_CHARS = 4;
const BASE64_GROUP_BYTES = 3;
/** The first suffix tried when a name is taken: `report-2.pdf`. */
const FIRST_DUPLICATE = 2;

const DROP_ID_RE = /^[a-z0-9-]{8,64}$/;
/** Characters a POSIX shell reads literally, so a path made only of them is
 *  typed as it is (which is every image path the runner has ever returned). */
const SHELL_PLAIN_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A runner that predates an action answers every call to it with this
 *  (engine.ts `dispatch`). */
const UNKNOWN_ACTION = 'Unknown board-agent action';

export const DROP_NEEDS_RUNNER_UPDATE =
  'Update the runner to attach files other than images.';

/** Whether `err` is a runner saying it does not know the action. */
export function isUnknownActionError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(UNKNOWN_ACTION);
}

// C0 and C1 controls and DEL (a newline typed into a terminal is Enter), the
// Unicode line separators, and the bidi controls that let a name display with
// a different extension than it has.
function isUnsafeCodePoint(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

function utf8Bytes(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) bytes += utf8Bytes(ch.codePointAt(0) ?? 0);
  return bytes;
}

/** Cut `text` to at most `maxBytes` of UTF-8, never through a character. */
function clampBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    bytes += utf8Bytes(ch.codePointAt(0) ?? 0);
    if (bytes > maxBytes) break;
    out += ch;
  }
  return out;
}

/** `report.pdf` -> ['report', '.pdf']. A leading dot is part of the name
 *  (`.env` has no extension), and so is a "dot something" too long to be one. */
function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || name.length - dot - 1 > MAX_EXT_CHARS) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

/**
 * The client's file name as a single safe path segment. It keeps the name and
 * extension the user gave, minus what could leave the drops dir or act on a
 * terminal:
 * - only the last path segment survives (`../../etc/passwd` -> `passwd`), for
 *   both `/` and `\`;
 * - control and bidi characters are removed;
 * - a leading dot stays (`.env` is a file people drop), but a name that is
 *   only dots (`.`, `..`) is not a name;
 * - trailing dots and spaces go;
 * - the result is at most MAX_NAME_BYTES of UTF-8, cut from the stem so the
 *   extension survives.
 * Anything left empty becomes `file`.
 */
export function safeDropName(raw: unknown): string {
  if (typeof raw !== 'string') return FALLBACK_NAME;
  const segment = raw.split(/[/\\]/).pop() ?? '';
  let clean = '';
  for (const ch of segment) {
    if (!isUnsafeCodePoint(ch.codePointAt(0) ?? 0)) clean += ch;
  }
  clean = clean.trim().replace(/[. ]+$/, '');
  if (!clean) return FALLBACK_NAME;
  const [stem, ext] = splitExtension(clean);
  // A cut can leave a space or a dot at the end of the stem again.
  const cutStem = clampBytes(stem, MAX_NAME_BYTES - utf8Length(ext)).replace(
    /[. ]+$/,
    ''
  );
  return `${cutStem || FALLBACK_NAME}${ext}`;
}

// macOS and Windows filesystems fold case and Unicode form, so two names that
// differ only there are the same file on disk.
const nameKey = (name: string) => name.normalize('NFC').toLowerCase();

/**
 * `name`, or the first of `name-2.ext`, `name-3.ext`... that `taken` (the
 * drops dir's listing) does not hold. `name` must already be a `safeDropName`.
 */
export function uniqueDropName(name: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const entry of taken) used.add(nameKey(entry));
  if (!used.has(nameKey(name))) return name;
  const [stem, ext] = splitExtension(name);
  // `used` is finite, so one of size + 1 candidates is free.
  for (let n = FIRST_DUPLICATE; n <= used.size + FIRST_DUPLICATE; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(nameKey(candidate))) return candidate;
  }
  return `${stem}-${used.size + FIRST_DUPLICATE + 1}${ext}`;
}

/** The dropId as a file-name part, or null when it is not one. Refused, not
 *  cleaned: a cleaned id could collide with another upload's. */
export function safeDropId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.toLowerCase();
  return DROP_ID_RE.test(id) ? id : null;
}

/** Why a file of `size` bytes cannot be attached, or null when it can. The
 *  client shows this before uploading; the runner throws it. */
export function dropSizeRefusal(name: string, size: unknown): string | null {
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    return `${name} has no valid size.`;
  }
  if (size === 0) return `${name} is empty.`;
  if (size > TERMINAL_DROP_MAX_BYTES) {
    return `${name} is larger than ${TERMINAL_DROP_MAX_BYTES / BYTES_PER_MB} MB.`;
  }
  return null;
}

export function dropFolderRefusal(name: string): string {
  return `${name} is a folder. Folders cannot be attached.`;
}

/** Decoded size of a base64 chunk, ignoring line breaks. */
export function base64Bytes(b64: string): number {
  const text = b64.replace(/[\r\n]/g, '');
  const padding = text.length - text.replace(/=+$/, '').length;
  return Math.max(
    0,
    Math.floor((text.length * BASE64_GROUP_BYTES) / BASE64_GROUP_CHARS) -
      padding
  );
}

/**
 * Why the upload must stop once `onDisk` bytes of a file declared as
 * `declared` are written, or null. More than declared is refused at any
 * point; on the `last` chunk the two must match, so a truncated upload never
 * becomes a path in a terminal.
 */
export function dropProgressRefusal(opts: {
  declared: number;
  onDisk: number;
  last: boolean;
}): string | null {
  if (!Number.isFinite(opts.onDisk) || opts.onDisk > opts.declared) {
    return 'The upload is larger than its declared size.';
  }
  if (opts.last && opts.onDisk !== opts.declared) {
    return 'The upload is incomplete.';
  }
  return null;
}

/**
 * A path as one argument to a POSIX shell (every runner terminal is bash
 * under tmux). A path of plain characters is returned as it is; anything else
 * is single-quoted, the one quoting where nothing is special, with each
 * quote inside closed, escaped and reopened.
 */
export function shellQuotePath(path: string): string {
  if (SHELL_PLAIN_RE.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
