import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONFIG_DIR } from '../paths';

import { PROCEDURES, type Api } from './api';

// `factiii-runner secret set KEY` — the value goes laptop -> age -> server ->
// runner inbox as ciphertext only. It never lands in argv, on disk, or in the
// terminal: it is read from stdin into a Buffer, piped into `age` over stdin,
// and the Buffer is zeroed after.

/** Env keys and file-blob names share one rule, UPPER_SNAKE_CASE. Must match
 *  RUNNER_SECRET_KEY_REGEX in shared/all/validators/runnerJobs.ts (not
 *  imported, so the runner bundle does not pull in zod for one regex). */
const SECRET_KEY = /^[A-Z][A-Z0-9_]*$/;
const MAX_KEY_LENGTH = 128;
/** A native age X25519 recipient (bech32, lowercase). Anything else is
 *  refused, which also keeps a hostile value from reading as an age flag. */
const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

/** The server takes at most 1 MB of armor; age armor is ~1.36x the value. */
const MAX_VALUE_BYTES = 720 * 1024;

export type SpawnLike = typeof spawn;

export type SecretIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Silent terminal prompt (no echo). */
  promptSilent: (label: string) => Promise<string>;
  spawnImpl?: SpawnLike;
  /** Where recipient pins live. Defaults to ~/.factiii-runner. */
  pinDir?: string;
};

function validateKey(key: string): void {
  if (!SECRET_KEY.test(key) || key.length > MAX_KEY_LENGTH) {
    throw new Error(
      `"${key}" is not a valid name. Use UPPER_SNAKE_CASE (A-Z, 0-9, _), e.g. EXPO_TOKEN or DESKTOP_CERT_P12.`
    );
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_VALUE_BYTES) {
      for (const p of parts) p.fill(0);
      buf.fill(0);
      throw new Error('The value is larger than 720 KB.');
    }
    parts.push(buf);
  }
  const all = Buffer.concat(parts);
  for (const p of parts) p.fill(0);
  return all;
}

/** Read the value from stdin only. A terminal on stdin is refused unless
 *  `--from-tty`, which prompts without echo (env values only). */
export async function readSecretValue(
  kind: 'env' | 'file',
  fromTty: boolean,
  io: Pick<SecretIo, 'stdin' | 'promptSilent'>
): Promise<Buffer> {
  let value: Buffer;
  if (io.stdin.isTTY) {
    if (!fromTty) {
      throw new Error(
        'Refusing to read a secret from the terminal. Pipe it in ' +
          '(factiii-runner secret set KEY < file), or pass --from-tty to type it without echo.'
      );
    }
    if (kind === 'file') {
      throw new Error('--from-tty is for env values. Pipe a file blob in on stdin.');
    }
    value = Buffer.from(await io.promptSilent('Value (no echo): '), 'utf-8');
  } else {
    value = await readAll(io.stdin);
    // `echo VALUE |` and editors add one trailing newline; an env value never
    // wants it. A file blob keeps its exact bytes.
    if (kind === 'env' && value.length && value[value.length - 1] === 0x0a) {
      const end = value.length >= 2 && value[value.length - 2] === 0x0d ? 2 : 1;
      const trimmed = Buffer.from(value.subarray(0, value.length - end));
      value.fill(0);
      value = trimmed;
    }
  }
  if (!value.length) throw new Error('The value is empty.');
  return value;
}

/** Encrypt with `age -r <recipient> -a`, the value on stdin, armor on stdout. */
export function ageEncrypt(
  recipient: string,
  value: Buffer,
  spawnImpl: SpawnLike = spawn
): Promise<string> {
  if (!AGE_RECIPIENT.test(recipient)) {
    return Promise.reject(new Error('The runner returned an invalid age recipient.'));
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl('age', ['-r', recipient, '-a'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => errOut.push(c));
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT'
          ? new Error('The "age" command was not found. Install it: brew install age')
          : err
      );
    });
    child.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`age failed (${code}): ${Buffer.concat(errOut).toString().trim()}`));
        return;
      }
      const armor = Buffer.concat(out).toString('utf-8');
      if (!armor.startsWith('-----BEGIN AGE ENCRYPTED FILE-----')) {
        reject(new Error('age returned no armored ciphertext.'));
        return;
      }
      resolve(armor);
    });
    child.stdin?.on('error', () => {
      // A failed spawn closes stdin early; the 'error'/'close' handlers report it.
    });
    child.stdin?.end(value);
  });
}

// ── Recipient pin (trust on first use) ──
//
// The recipient comes from the server. A compromised server could hand out its
// own recipient and read the next value. So the first recipient seen for a
// server + space is pinned, and a change is refused until the user confirms it
// out of band (Runner Settings shows the runner's recipient).

function pinFile(pinDir: string): string {
  return path.join(pinDir, 'cli-recipients.json');
}

function readPins(pinDir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(pinFile(pinDir), 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function checkRecipientPin(
  pinKey: string,
  recipient: string,
  acceptNew: boolean,
  pinDir: string,
  /** Keys a pin was stored under before: `<server>/<space>` from before calls
   *  named their runner, and `<server>/<slug>/<runner>` from before pins
   *  were by space id (with the slugs the board had). Read in order when
   *  `pinKey` has no pin yet, so the first call under the new key is still
   *  checked against the old pin. */
  legacyKeys: string | string[] = [],
  /** What the error calls the board and runner. */
  label: string = pinKey
): 'pinned-now' | 'match' | 'replaced' {
  const pins = readPins(pinDir);
  const older = (Array.isArray(legacyKeys) ? legacyKeys : [legacyKeys]).find((k) =>
    Object.hasOwn(pins, k)
  );
  const known = pins[pinKey] ?? (older ? pins[older] : undefined);
  if (known === recipient) {
    // Carried over to the new key, so the old ones stop mattering.
    if (!Object.hasOwn(pins, pinKey)) writePin(pinDir, pins, pinKey, recipient);
    return 'match';
  }
  if (known && !acceptNew) {
    throw new Error(
      `The runner recipient for ${label} changed.\n  was: ${known}\n  now: ${recipient}\n` +
        "It changes when the board's secrets password is changed, which also replaces the board's key. If that happened, run again with --accept-new-recipient. If not, ask the board owner before sending the value."
    );
  }
  writePin(pinDir, pins, pinKey, recipient);
  return known ? 'replaced' : 'pinned-now';
}

function writePin(
  pinDir: string,
  pins: Record<string, string>,
  pinKey: string,
  recipient: string
): void {
  pins[pinKey] = recipient;
  fs.mkdirSync(pinDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(pinFile(pinDir), `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Where a runner's recipient is pinned, and where it was pinned before. By
 * space id when the server says it (a server older than that does not): the
 * slug follows the space's name, so a pin by slug was lost on every rename,
 * and the next call trusted whatever recipient came back.
 */
export function recipientPinKeys(args: {
  serverHost: string;
  spaceSlug: string;
  runnerId: number;
  spaceId?: number;
  /** Slugs the board had before, when this machine's runner knows them. */
  formerSlugs?: string[];
}): { pinKey: string; legacyKeys: string[] } {
  const { serverHost, runnerId } = args;
  const slugs = [args.spaceSlug, ...(args.formerSlugs ?? [])];
  const bySlug = slugs.map((slug) => `${serverHost}/${slug}/${runnerId}`);
  const bySpace = slugs.map((slug) => `${serverHost}/${slug}`);
  if (!args.spaceId) {
    return { pinKey: bySlug[0], legacyKeys: [...bySlug.slice(1), ...bySpace] };
  }
  return { pinKey: `${serverHost}/space-${args.spaceId}/${runnerId}`, legacyKeys: [...bySlug, ...bySpace] };
}

export async function setSecret(
  api: Api,
  args: {
    serverHost: string;
    spaceSlug: string;
    runnerId: number;
    key: string;
    kind: 'env' | 'file';
    fromTty: boolean;
    acceptNewRecipient: boolean;
    /** How to name the board to the person (its space name), when known. */
    spaceLabel?: string;
    /** Slugs the board had before, so a pin made under one is still read. */
    formerSlugs?: string[];
  },
  io: SecretIo
): Promise<number> {
  validateKey(args.key);
  const value = await readSecretValue(args.kind, args.fromTty, io);
  try {
    const { recipient, spaceId } = await api.query<{ recipient: string; spaceId?: number }>(
      PROCEDURES.recipient,
      { spaceSlug: args.spaceSlug, runnerId: args.runnerId }
    );
    // One pin per runner: two runners on one board hold different keys. And
    // per board, not per slug: a rename keeps the pin.
    const { pinKey, legacyKeys } = recipientPinKeys({
      serverHost: args.serverHost,
      spaceSlug: args.spaceSlug,
      runnerId: args.runnerId,
      spaceId: Number.isInteger(spaceId) ? spaceId : undefined,
      formerSlugs: args.formerSlugs
    });
    const where = args.spaceLabel ?? args.spaceSlug;
    const pin = checkRecipientPin(
      pinKey,
      recipient,
      args.acceptNewRecipient,
      io.pinDir ?? CONFIG_DIR,
      legacyKeys,
      `runner ${args.runnerId} on ${where}`
    );
    if (pin === 'pinned-now') io.err(`Pinned the runner recipient for ${where}: ${recipient}\n`);
    const ciphertext = await ageEncrypt(recipient, value, io.spawnImpl);
    await api.mutation(PROCEDURES.submitSecret, {
      spaceSlug: args.spaceSlug,
      runnerId: args.runnerId,
      key: args.key,
      kind: args.kind,
      ciphertext
    });
  } finally {
    value.fill(0);
  }
  io.out('submitted; waiting for an approver\n');
  return 0;
}
