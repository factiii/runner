// Files between sessions (.specs/card-sessions.md "Across runners", "Files";
// card 6336db91): read_session and message_session can bring files from the
// target session back to the caller's $DROPS_DIR. Across runners every byte
// goes over the server's relay, the way a read does: `info` first (name,
// size, sha256, chunk count), then one chunk at a time, so no frame is over
// the socket's limit and no runner ever connects to another.
//
// The rules, here for both sides:
// - The target sends only a regular file inside the session's own roots (its
//   workspace, and its board's drops, scratchpad and builds), resolved through
//   every symlink first. Never one inside a forbidden folder (the Vault's:
//   the Vault never leaves its runner), never a Vault-sealed file, never a
//   `.env` file, never a text file that holds a secret (secretScan.ts).
// - One call brings at most `maxBytes` in all (SESSION_FILES_MAX_BYTES by
//   default), and the caller stops the moment a file sends more than it said.
// - The caller checks the whole against the sha256 the target gave, scans a
//   text file again (it does not take the far side's word for it), and only
//   then lands it, under a name no file there has (never overwriting).
// Access is the call's own: the same rules as read_session, here and on the
// target (session-hypervisor.ts).

import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  SESSION_FILE_CHUNK_BYTES,
  SESSION_FILES_PER_CALL,
  type SessionFileInfo,
  type SessionFileResult
} from '../../domains/sessionRelay';
import { findSecret } from '../secretScan';

/** What may be sent from one session: the host's part (the cap, the Vault)
 *  and the board's (the session's roots). */
export type FileSourceRules = {
  /** The session's folders, its workspace first: a relative path is read
   *  against that one. */
  roots: string[];
  /** Folders nothing is ever sent from, whatever links into them. */
  forbidden: string[];
  /** A file still sealed by the Vault: never sent. */
  isVaultFile?: (realPath: string) => boolean;
  maxBytes: number;
};

/** How much of a file is looked at to call it text. */
const TEXT_SNIFF_BYTES = 8_000;

const errText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Whether `child` is `parent` or inside it (both real paths). */
const inside = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const realOrNull = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/** No NUL byte near the start: what git calls text, too. */
export const looksLikeText = (head: Buffer): boolean => !head.includes(0);

const isEnvFile = (name: string) => /^\.env(\..*)?$/i.test(name);

/** What a description saw of a file: across runners a chunk is sent only
 *  while the file is still that one (its real path, size and change time),
 *  so no byte goes out that the secret scan did not read. */
export type SourceFileStamp = { real: string; bytes: number; mtimeMs: number };

/** The real path `requested` names on the target, or the refusal. */
export function resolveSourceFile(
  rules: FileSourceRules,
  requested: string
): SourceFileStamp | { error: string } {
  const roots = rules.roots
    .map(realOrNull)
    .filter((r): r is string => r !== null);
  if (roots.length === 0) {
    return { error: 'This session has no folder to send files from.' };
  }
  const named = path.isAbsolute(requested)
    ? requested
    : path.join(roots[0]!, requested);
  const real = realOrNull(named);
  if (!real) return { error: `No file ${requested} there.` };
  // Checked on the real path, so a link into the Vault is the Vault.
  const forbidden = rules.forbidden
    .map((f) => realOrNull(f) ?? path.resolve(f))
    .some((f) => inside(f, real));
  if (forbidden || rules.isVaultFile?.(real)) {
    return {
      error: `${requested} is in the Vault, and the Vault never leaves its runner.`
    };
  }
  if (!roots.some((root) => inside(root, real))) {
    return {
      error: `${requested} is outside the session's folders (its workspace, and the board's drops, scratchpad and builds).`
    };
  }
  if (isEnvFile(path.basename(real))) {
    return {
      error: `${requested} is an env file: sessions never pass secrets to each other.`
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch (err) {
    return { error: `${requested} cannot be read: ${errText(err)}` };
  }
  if (!stat.isFile()) return { error: `${requested} is not a file.` };
  if (stat.size > rules.maxBytes) {
    return {
      error: `${requested} is ${stat.size} bytes, over the ${rules.maxBytes} a call may bring.`
    };
  }
  return { real, bytes: stat.size, mtimeMs: stat.mtimeMs };
}

/** What a text file's secret scan finds, or null (binary files are not
 *  scanned: the scan reads text). */
function secretIn(data: Buffer): string | null {
  if (!looksLikeText(data.subarray(0, TEXT_SNIFF_BYTES))) return null;
  return findSecret(data.toString('utf-8'));
}

/** The target's side: describe a file before sending it, with the stamp
 *  its chunks must still match (taken before the read, so a change during
 *  it shows too). Throws the refusal. */
export function describeSourceFileStamped(
  rules: FileSourceRules,
  requested: string,
  chunkBytes = SESSION_FILE_CHUNK_BYTES
): { info: SessionFileInfo; stamp: SourceFileStamp } {
  const found = resolveSourceFile(rules, requested);
  if ('error' in found) throw new Error(found.error);
  const data = fs.readFileSync(found.real);
  const secret = secretIn(data);
  if (secret) {
    throw new Error(
      `Not sent: ${requested} holds what looks like ${secret}. Sessions never pass secrets to each other.`
    );
  }
  return {
    info: {
      name: path.basename(found.real),
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      chunks: Math.max(1, Math.ceil(data.length / chunkBytes))
    },
    stamp: found
  };
}

/** The target's side: describe a file before sending it. Throws the
 *  refusal. */
export function describeSourceFile(
  rules: FileSourceRules,
  requested: string,
  chunkBytes = SESSION_FILE_CHUNK_BYTES
): SessionFileInfo {
  return describeSourceFileStamped(rules, requested, chunkBytes).info;
}

/** The target's side: one chunk, base64. The path is checked again, as on
 *  every call, and with `stamp` the file must still be the one described.
 *  Throws the refusal. */
export function readSourceChunk(
  rules: FileSourceRules,
  requested: string,
  index: number,
  chunkBytes = SESSION_FILE_CHUNK_BYTES,
  stamp?: SourceFileStamp
): string {
  const found = resolveSourceFile(rules, requested);
  if ('error' in found) throw new Error(found.error);
  if (
    stamp &&
    (found.real !== stamp.real ||
      found.bytes !== stamp.bytes ||
      found.mtimeMs !== stamp.mtimeMs)
  ) {
    throw new Error(
      `${requested} changed since it was described: ask for it again.`
    );
  }
  const fd = fs.openSync(found.real, 'r');
  try {
    const buf = Buffer.alloc(chunkBytes);
    const read = fs.readSync(fd, buf, 0, chunkBytes, index * chunkBytes);
    return buf.subarray(0, read).toString('base64');
  } finally {
    fs.closeSync(fd);
  }
}

/** A name that is safe to land: the basename, nothing hidden, no odd
 *  characters. */
export function landingName(name: string): string {
  const base = path
    .basename(name)
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^[.\s]+/, '')
    .slice(0, 120);
  return base || 'file';
}

/** Moves `tmp` to `dir` under `name`, or `name (2)`, `name (3)`…: never over
 *  a file that is there. A hard link fails when the name is taken, so two
 *  landings at once cannot pick the same one. */
export function landUnique(tmp: string, dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'file';
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    try {
      fs.linkSync(tmp, candidate);
      fs.rmSync(tmp, { force: true });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/** The far side, as the caller reaches it: the relay, or this runner's own
 *  board for a session here. Each throws its refusal. */
export type FileSource = {
  info(requested: string): Promise<SessionFileInfo>;
  chunk(requested: string, index: number): Promise<string>;
};

/** What a call's `files` argument names, or the refusal. */
export function filesArg(value: unknown): string[] | string {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== 'string' || !v.trim())
  ) {
    return 'files must be a list of paths on the session (relative to its workspace).';
  }
  if (value.length > SESSION_FILES_PER_CALL) {
    return `At most ${SESSION_FILES_PER_CALL} files a call.`;
  }
  return value.map((v: string) => v.trim());
}

/** The caller's side: bring each file into `dropsDir`, in order, within
 *  `maxBytes` in all. One file's refusal does not stop the next. */
export async function fetchFiles(
  source: FileSource,
  requested: string[],
  opts: { dropsDir: string; maxBytes: number }
): Promise<SessionFileResult[]> {
  const results: SessionFileResult[] = [];
  let budget = opts.maxBytes;
  for (const want of requested) {
    try {
      const info = await source.info(want);
      if (info.bytes > budget) {
        results.push({
          requested: want,
          error: `${info.bytes} bytes is over what is left of this call's ${opts.maxBytes}.`
        });
        continue;
      }
      const landed = await fetchOne(source, want, info, opts.dropsDir);
      budget -= info.bytes;
      results.push({ requested: want, ...landed });
    } catch (err) {
      results.push({ requested: want, error: errText(err) });
    }
  }
  return results;
}

async function fetchOne(
  source: FileSource,
  want: string,
  info: SessionFileInfo,
  dropsDir: string
): Promise<{ path: string; bytes: number; sha256: string }> {
  fs.mkdirSync(dropsDir, { recursive: true });
  const tmp = path.join(
    dropsDir,
    `.incoming-${randomBytes(6).toString('hex')}`
  );
  // The far side's word on its own file, checked before a byte is asked for.
  if (
    !Number.isInteger(info.bytes) ||
    info.bytes < 0 ||
    info.chunks !== Math.max(1, Math.ceil(info.bytes / SESSION_FILE_CHUNK_BYTES)) ||
    !/^[0-9a-f]{64}$/.test(info.sha256)
  ) {
    throw new Error(`Refused: ${want} was described in a way this runner does not accept.`);
  }
  const hash = createHash('sha256');
  const parts: Buffer[] = [];
  let received = 0;
  try {
    for (let i = 0; i < info.chunks; i++) {
      const piece = Buffer.from(await source.chunk(want, i), 'base64');
      received += piece.length;
      // More than it said: stop now, never past the cap it was let in under.
      if (received > info.bytes) {
        throw new Error(
          `Refused: ${want} sent more than the ${info.bytes} bytes it said.`
        );
      }
      hash.update(piece);
      parts.push(piece);
    }
    const sha256 = hash.digest('hex');
    if (received !== info.bytes || sha256 !== info.sha256) {
      throw new Error(
        `Refused: ${want} did not arrive whole (its sha256 does not match). It may have changed while it was sent: try again.`
      );
    }
    const data = Buffer.concat(parts);
    const secret = secretIn(data);
    if (secret) {
      throw new Error(
        `Refused: ${want} holds what looks like ${secret}. Sessions never pass secrets to each other.`
      );
    }
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    const landed = landUnique(tmp, dropsDir, landingName(info.name));
    return { path: landed, bytes: received, sha256 };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** A board's own files as a FileSource, for a session on this runner. */
export function localFileSource(rules: FileSourceRules): FileSource {
  return {
    info: async (requested) => describeSourceFile(rules, requested),
    chunk: async (requested, index) =>
      readSourceChunk(rules, requested, index)
  };
}
