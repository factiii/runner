import type { SecretFileEnvKey } from '../domains/electron';
import { maskedSecret } from '../domains/secretsBackup';

// One key of an env file, changed in place (.specs/runner-secrets-store.md
// "One key of an env file"). A server env is stored on the runner as one file
// secret; this is the text half of editing it: parse the file to lines, change
// one, and write the rest back byte for byte. Pure: no file, no process, no
// crypto. The runner (host-secrets.ts) holds the decrypted text in memory
// around these calls, and the app uses only the two `...Problem` checks.
//
// Nothing here puts a value in an error message. A message names the key.

/** What a job, a shell and every dotenv reader accept as a variable name. */
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `KEY=rest`, with an optional `export` and blanks around the `=`. */
const ENTRY =
  /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)([^]*)$/;
const BLANK_OR_COMMENT = /^[ \t]*(?:#[^]*)?$/;
/** What may follow a closing quote: blanks, then an optional comment. */
const AFTER_QUOTE = /^[ \t]*(?:#.*)?$/;
/** Where an unquoted value stops: at a comment, or at trailing blanks. */
const UNQUOTED_END = /[ \t]+#|[ \t]*$/;
/** What a value written bare cannot be: a reader trims outer blanks, takes a
 *  first quote as the start of a quoted value, stops at a `#`
 *  (`node --env-file` at any `#`, the others at one after a blank), and
 *  docker compose expands a `$name`. */
const NOT_BARE = /^[\s'"`]|\s$|[#$]/;
/** `\n` or `\r` inside double quotes: a parser turns it into a line break. */
const ESCAPED_BREAK = /\\[nr]/;

type Quote = '' | "'" | '"' | '`';
const QUOTES: readonly Quote[] = ["'", '"', '`'];
/** The order a style is tried in when the line's own cannot hold the new
 *  value. Bare first: `docker run --env-file` (the deploy's migration step)
 *  reads quotes as part of the value. Then single quotes, which every other
 *  parser reads literally. */
const QUOTE_ORDER: readonly Quote[] = ['', "'", '"', '`'];

type PlainLine = { kind: 'plain'; raw: string; eol: string };
type EntryLine = {
  kind: 'entry';
  /** The line as it is in the file, without its line ending. For a value
   *  that runs over several lines, all of them. */
  raw: string;
  eol: string;
  name: string;
  /** Everything up to the value: `export `, the name, `=` and the blanks. */
  head: string;
  quote: Quote;
  /** The value as written, between the quotes when it has them. */
  value: string;
  /** Everything after the value: blanks and a comment. */
  rest: string;
  /** False for a value this module does not rewrite: one that runs over
   *  several lines, or that holds a line break as `\n` in double quotes. */
  editable: boolean;
};
type EnvLine = PlainLine | EntryLine;

/** An env file as its lines. `serializeEnvFile(parseEnvFile(text))` is `text`. */
export type EnvFile = { lines: EnvLine[] };

/** '' when `name` may be a key in an env file. */
export function envKeyNameProblem(name: string): string {
  return KEY_NAME.test(name)
    ? ''
    : 'Letters, digits and _ only, not starting with a digit.';
}

/** '' when `value` may be typed as one key's value. */
export function envValueProblem(value: string): string {
  return /[\n\r\0]/.test(value)
    ? 'A value typed here is one line. Replace the whole file to store a value with line breaks.'
    : '';
}

function splitLines(text: string): { raw: string; eol: string }[] {
  const lines: { raw: string; eol: string }[] = [];
  const breaks = /\r\n|\n/g;
  let start = 0;
  let found = breaks.exec(text);
  while (found) {
    lines.push({ raw: text.slice(start, found.index), eol: found[0] });
    start = breaks.lastIndex;
    found = breaks.exec(text);
  }
  if (start < text.length) lines.push({ raw: text.slice(start), eol: '' });
  return lines;
}

/** The index of the quote that closes a value, or -1. A quote after a
 *  backslash does not close it, which is the dotenv rule. */
function closingQuote(text: string, quote: Quote, from: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === '\\' && text[i + 1] === quote) i += 2;
    else if (text[i] === quote) return i;
    else i += 1;
  }
  return -1;
}

function unquotedEntry(
  line: { raw: string; eol: string },
  name: string,
  head: string,
  after: string
): EntryLine {
  const end = after.startsWith('#') ? 0 : after.search(UNQUOTED_END);
  const value = after.slice(0, end);
  const rest = after.slice(end);
  return {
    kind: 'entry',
    ...line,
    name,
    head,
    quote: '',
    value,
    rest,
    editable: !line.raw.includes('\r')
  };
}

/**
 * `text` as an env file, or null when it is not one: a line that is not blank,
 * a `#` comment or `KEY=value` (a `.pem`, a JSON key, anything binary).
 *
 * A quoted value may run over several lines; those lines are one entry, kept
 * whole and marked not editable.
 */
export function parseEnvFile(text: string): EnvFile | null {
  if (text.includes('\0')) return null;
  const physical = splitLines(text);
  const lines: EnvLine[] = [];
  for (let i = 0; i < physical.length; i += 1) {
    const line = physical[i]!;
    if (BLANK_OR_COMMENT.test(line.raw)) {
      lines.push({ kind: 'plain', ...line });
      continue;
    }
    const match = ENTRY.exec(line.raw);
    if (!match) return null;
    const name = match[2]!;
    const head = `${match[1]}${name}${match[3]}`;
    const after = match[4]!;
    const quote = QUOTES.find((q) => after.startsWith(q)) ?? '';
    if (quote === '') {
      lines.push(unquotedEntry(line, name, head, after));
      continue;
    }
    const close = closingQuote(after, quote, 1);
    if (close >= 0) {
      const rest = after.slice(close + 1);
      // Text after the closing quote that is not a comment: no parser reads
      // that as a quoted value, so it is taken as written.
      if (!AFTER_QUOTE.test(rest)) {
        lines.push(unquotedEntry(line, name, head, after));
        continue;
      }
      const value = after.slice(1, close);
      lines.push({
        kind: 'entry',
        ...line,
        name,
        head,
        quote,
        value,
        rest,
        editable:
          !value.includes('\r') && !(quote === '"' && ESCAPED_BREAK.test(value))
      });
      continue;
    }
    // The quote does not close on this line. It closes on a later one (a
    // value over several lines), or nowhere (the quote is part of the value).
    let last = -1;
    for (let j = i + 1; j < physical.length && last < 0; j += 1) {
      if (closingQuote(physical[j]!.raw, quote, 0) >= 0) last = j;
    }
    if (last < 0) {
      lines.push(unquotedEntry(line, name, head, after));
      continue;
    }
    const span = physical.slice(i, last + 1);
    lines.push({
      kind: 'entry',
      raw: span
        .map((l, at) => (at < span.length - 1 ? `${l.raw}${l.eol}` : l.raw))
        .join(''),
      eol: physical[last]!.eol,
      name,
      head,
      quote,
      value: '',
      rest: '',
      editable: false
    });
    i = last;
  }
  return { lines };
}

export function serializeEnvFile(file: EnvFile): string {
  return file.lines.map((l) => `${l.raw}${l.eol}`).join('');
}

function entriesOf(file: EnvFile, name: string): EntryLine[] {
  return file.lines.filter(
    (l): l is EntryLine => l.kind === 'entry' && l.name === name
  );
}

/**
 * The file's keys in file order, each once. A key written more than once has
 * the value of its last line, as a reader of the file sees it. `masked` is never the value: its last four
 * characters, or only dots (`maskedSecret`). A key that is not editable shows
 * only dots.
 */
export function envFileKeys(file: EnvFile): SecretFileEnvKey[] {
  const keys = new Map<string, SecretFileEnvKey>();
  for (const line of file.lines) {
    if (line.kind !== 'entry') continue;
    const editable = line.editable && (keys.get(line.name)?.editable ?? true);
    keys.set(line.name, {
      name: line.name,
      masked: maskedSecret(editable ? line.value : ''),
      editable
    });
  }
  return [...keys.values()];
}

function canWrite(value: string, quote: Quote): boolean {
  switch (quote) {
    case '':
      return !NOT_BARE.test(value);
    case '"':
      // Inside double quotes parsers disagree on `\` and `$`, and none reads
      // an escaped `"` back as typed.
      return !/["\\$]/.test(value);
    default:
      // Literal in every parser, but a last `\` would escape the closing
      // quote for dotenv.
      return !value.includes(quote) && !value.endsWith('\\');
  }
}

/**
 * `value` as it is written after `KEY=`: in the line's own style when that
 * can hold it, otherwise bare, and in quotes only when bare cannot hold it.
 * No escape is written: parsers do not agree on any. Exported for its test.
 */
export function encodeEnvValue(value: string, preferred: Quote = ''): string {
  const quote = [preferred, ...QUOTE_ORDER].find((q) => canWrite(value, q));
  if (quote === undefined) {
    throw new Error(
      'No env quoting keeps this value as typed: it mixes quote characters. Replace the whole file to store it.'
    );
  }
  return `${quote}${value}${quote}`;
}

function assertEditable(name: string, entries: EntryLine[]): void {
  if (entries.some((e) => !e.editable)) {
    throw new Error(
      `${name} holds a value with line breaks. Replace the whole file to change it.`
    );
  }
}

/** One written `KEY=value` line as the entry a later read of it gives. */
function entryFromLine(raw: string, eol: string): EnvLine {
  const line = parseEnvFile(raw)?.lines[0];
  if (!line) throw new Error('That line could not be written as an env line.');
  return { ...line, eol };
}

/** The line ending new lines get: the one the file's last ended line has. */
function fileEol(file: EnvFile): string {
  for (let i = file.lines.length - 1; i >= 0; i -= 1) {
    if (file.lines[i]!.eol !== '') return file.lines[i]!.eol;
  }
  return '\n';
}

/**
 * Set one key. An existing key keeps its line: position, `export`, its
 * quotes when the new value fits them, and a trailing comment. A key written
 * more than once has its LAST line changed, the one a reader uses. A new key
 * is appended as the last line.
 */
export function setEnvFileKey(
  file: EnvFile,
  name: string,
  value: string
): { file: EnvFile; occurrences: number } {
  const problem = envKeyNameProblem(name) || envValueProblem(value);
  if (problem) throw new Error(problem);
  const entries = entriesOf(file, name);
  assertEditable(name, entries);
  const target = entries[entries.length - 1];
  if (target) {
    const written = encodeEnvValue(value, target.quote);
    // A comment that touched the old value must not join the new one.
    const gap = /^[ \t]|^$/.test(target.rest) ? '' : ' ';
    const next = entryFromLine(
      `${target.head}${written}${gap}${target.rest}`,
      target.eol
    );
    return {
      file: { lines: file.lines.map((l) => (l === target ? next : l)) },
      occurrences: entries.length
    };
  }
  const lines = [...file.lines];
  const last = lines[lines.length - 1];
  // The new line ends as the file ended: a file with no final line break
  // still has none, and its old last line gains the one it now needs.
  const eol = last ? last.eol : '\n';
  if (last && last.eol === '') {
    lines[lines.length - 1] = { ...last, eol: fileEol(file) };
  }
  lines.push(entryFromLine(`${name}=${encodeEnvValue(value)}`, eol));
  return { file: { lines }, occurrences: 1 };
}

/**
 * Remove one key: every line that sets it, because removing only the last
 * would leave the key set to an older value. Nothing else moves.
 */
export function unsetEnvFileKey(
  file: EnvFile,
  name: string
): { file: EnvFile; removed: number } {
  const problem = envKeyNameProblem(name);
  if (problem) throw new Error(problem);
  const entries = entriesOf(file, name);
  if (entries.length === 0) throw new Error(`${name} is not in this file.`);
  assertEditable(name, entries);
  const lines = file.lines.filter(
    (l) => !(l.kind === 'entry' && l.name === name)
  );
  if (lines.length === 0) {
    throw new Error(
      `${name} is the only line in this file. Remove the file instead.`
    );
  }
  return { file: { lines }, removed: entries.length };
}
