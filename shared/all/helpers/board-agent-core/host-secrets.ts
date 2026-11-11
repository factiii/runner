import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

import type {
  BackupImportPick,
  SecretFileEnvKey,
  SecretsBackupImportPlan
} from '../../domains/electron';
import { maskedSecret } from '../../domains/secretsBackup';
import { missingPartMessage } from '../runnerMissingPart';
import {
  type EnvFile,
  envFileKeys,
  parseEnvFile,
  serializeEnvFile,
  setEnvFileKey,
  unsetEnvFileKey
} from '../envFile';
import { hostEnv } from './host-env';
import { throttledPasswordCheck } from './password-throttle';
import type { SecretMeta } from './secret-descriptions';

const execFileAsync = promisify(execFile);

// All subprocess lookups use a login-shell-fresh PATH (see host-env.ts):
// sops/age installed after runner start work without a restart.

// Runner secrets store, the AI-safe contract the retired laptop vault used (see
// .specs/runner-secrets-store.md): AI-safe by tool shape. NO function here ever returns or
// prints a secret VALUE - key names and set-status only; values move
// write-only into the sops file and file-to-file into child process envs.
// Root of trust: one age key per board (space), encrypted under that board's
// password (scrypt + aes-256-gcm), decrypted in memory per call and never
// written to disk. The one cache is the unlock window (secrets-window.ts): a
// password holder can keep the unwrapped key in the runner's memory, for jobs,
// until it expires, is locked, or the runner restarts (unwrapIdentity).
// The key lives beside the store it opens, in `<space>/secrets/`, so a board's
// password opens that board's secrets and nothing else (spaceKeyDir).

const IDENTITY_FILE = 'age-identity.enc';
const RECIPIENT_FILE = 'age-recipient.txt';
const ENV_FILE = 'secrets.enc.env';

const SCRYPT_N = 1 << 15;

type IdentityBox = {
  salt: string;
  iv: string;
  tag: string;
  data: string;
  /** A copy of the runner-wide key this board adopted (adoptRunnerKey). It
   *  is replaced by a key of the board's own the first time the password
   *  opens it (identityFor). */
  adopted?: true;
};

async function binaryAvailable(bin: string): Promise<boolean> {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    await execFileAsync(finder, [bin], { env: await hostEnv() });
    return true;
  } catch {
    return false;
  }
}

async function assertBinaries(): Promise<void> {
  for (const bin of ['sops', 'age-keygen']) {
    if (!(await binaryAvailable(bin))) {
      throw new Error(
        missingPartMessage('secrets', `The secrets store needs ${bin === 'sops' ? 'sops' : 'age'} on the runner.`)
      );
    }
  }
}

function deriveKey(password: string, salt: Buffer): Buffer {
  // N=2^15 (r=8) needs exactly 32MiB, which is Node's default scrypt maxmem
  // and the limit check is exclusive - raise the ceiling, keep the hardness.
  return crypto.scryptSync(password, salt, 32, {
    N: SCRYPT_N,
    maxmem: 64 * 1024 * 1024
  });
}

// ── Per-board identity (one age key per space, password-encrypted at rest) ──

/** Where a space keeps its wrapped key and recipient: in its own secrets/
 *  folder (0700, ensureSecretsDir), beside the store that key opens. Every
 *  `configDir` below is one of these. */
export function spaceKeyDir(spaceDir: string): string {
  return path.join(spaceDir, 'secrets');
}

/** A fresh age keypair. */
async function generateKeypair(): Promise<{
  identity: string;
  recipient: string;
}> {
  const { stdout } = await execFileAsync('age-keygen', [], {
    env: await hostEnv()
  });
  const identity = stdout
    .split('\n')
    .find((l) => l.startsWith('AGE-SECRET-KEY-'));
  const recipient = stdout
    .split('\n')
    .find((l) => l.includes('public key:'))
    ?.split('public key:')[1]
    ?.trim();
  if (!identity || !recipient) {
    throw new Error('age-keygen returned no usable keypair.');
  }
  return { identity, recipient };
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false
  );
}

/**
 * Give a space its own copy of the runner-wide key it was using, once.
 *
 * Until 0.23 one key and one password guarded every board on a runner, in
 * `<runner>/age-identity.enc`. A board that already stores secrets keeps
 * opening them with that same password after the update: it gets a copy of
 * the wrapped key and the recipient. A board with nothing stored gets
 * nothing, and sets up its own password like a new store. From here each
 * board's copy changes on its own (changeSpacePassword re-keys it), so the
 * shared password stops opening a board once that board changes it.
 *
 * Idempotent: a space that has its own key is left alone, and so is one the
 * runner has no key for. The recipient is written first and the identity
 * last, by rename, because the identity is what makes the store "set up".
 */
export async function adoptRunnerKey(
  runnerDir: string,
  spaceDir: string
): Promise<boolean> {
  const keyDir = spaceKeyDir(spaceDir);
  if (await exists(path.join(keyDir, IDENTITY_FILE))) return false;
  if (!(await exists(path.join(runnerDir, IDENTITY_FILE)))) return false;
  const hasStore =
    (await exists(envPath(spaceDir))) ||
    (await storedSecretFiles(spaceDir)).length > 0 ||
    (await parkedInboxItems(spaceDir)).length > 0;
  if (!hasStore) return false;
  await ensureSecretsDir(spaceDir);
  await fs.writeFile(
    path.join(keyDir, RECIPIENT_FILE),
    await fs.readFile(path.join(runnerDir, RECIPIENT_FILE), 'utf-8'),
    { mode: 0o600 }
  );
  await writeIdentityBox(keyDir, {
    ...(await readIdentityBox(runnerDir)),
    adopted: true
  });
  return true;
}

export async function secretsInitialized(configDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(configDir, IDENTITY_FILE));
    return true;
  } catch {
    return false;
  }
}

/** First-time setup: generate the age keypair and store the identity
 *  encrypted under the owner's password. Idempotent-refusing: never
 *  overwrites an existing identity. */
export async function initSecrets(
  configDir: string,
  password: string
): Promise<{ success: boolean }> {
  await assertBinaries();
  if (password.length < 8) {
    throw new Error('Use a password of at least 8 characters.');
  }
  if (await secretsInitialized(configDir)) {
    throw new Error('The secrets store is already set up on this board.');
  }
  // A board's key dir is its secrets/ folder, which a board that has never
  // stored anything may not have yet.
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const { identity, recipient } = await generateKeypair();

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    deriveKey(password, salt),
    iv
  );
  const data = Buffer.concat([
    cipher.update(identity, 'utf-8'),
    cipher.final()
  ]);
  const box: IdentityBox = {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
  // Recipient first: the identity is what makes the store "set up", and a
  // crash between the two must not leave one that is set up but unwritable.
  await fs.writeFile(path.join(configDir, RECIPIENT_FILE), `${recipient}\n`, {
    mode: 0o600
  });
  await fs.writeFile(path.join(configDir, IDENTITY_FILE), JSON.stringify(box), {
    mode: 0o600
  });
  return { success: true };
}

/** Encrypt an identity under a password. Takes several newline-separated when
 *  a rotation needs both keys readable at once. */
function sealIdentity(identity: string, password: string): IdentityBox {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    deriveKey(password, salt),
    iv
  );
  const data = Buffer.concat([
    cipher.update(identity, 'utf-8'),
    cipher.final()
  ]);
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
}

/** Said when a password reaches a board that has no store yet. Raw, it was
 *  `ENOENT … age-identity.enc` (mac-mini-m6, 2026-10-25). */
export const NO_STORE_YET =
  'This board has no secrets store yet. Set a password for it, or import a backup into it.';

async function readIdentityBox(configDir: string): Promise<IdentityBox> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(configDir, IDENTITY_FILE), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(NO_STORE_YET);
    }
    throw err;
  }
  return JSON.parse(raw) as IdentityBox;
}

/** Atomic: a crash mid-write must never truncate the only copy of the key. */
async function writeIdentityBox(
  configDir: string,
  box: IdentityBox
): Promise<void> {
  const file = path.join(configDir, IDENTITY_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(box), { mode: 0o600 });
  await fs.rename(tmp, file);
}

function decryptIdentity(box: IdentityBox, password: string): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(password, Buffer.from(box.salt, 'base64')),
    Buffer.from(box.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(box.data, 'base64')),
      decipher.final()
    ]).toString('utf-8');
  } catch {
    throw new Error('Wrong password.');
  }
}

// ── One writer per store ─────────────────────────────────────────────
//
// Every write reads the recipient and (for the dotenv) the current values,
// then runs sops. A password change rewrites the recipient and re-encrypts
// everything in between, so a write that overlapped it could land encrypted
// to the retired key, or put back values read before it: lost for good once
// the old key is dropped. So every write to a space's store, and the re-key
// itself, queue on one chain per space.

const storeLocks = new Map<string, Promise<unknown>>();

async function withStoreLock<T>(
  spaceDir: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = path.resolve(spaceDir);
  const prev = storeLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  storeLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (storeLocks.get(key) === tail) storeLocks.delete(key);
  }
}

/** The secrets inbox's parked updates (secrets-inbox.ts): age armor encrypted
 *  to this board's recipient, waiting for a password holder. */
function inboxDir(spaceDir: string): string {
  return path.join(spaceDir, 'secrets', 'inbox');
}

async function parkedInboxItems(spaceDir: string): Promise<string[]> {
  const names = await fs.readdir(inboxDir(spaceDir)).catch(() => []);
  return names
    .filter((n) => n.endsWith('.age'))
    .map((n) => path.join(inboxDir(spaceDir), n));
}

/** Re-encrypt parked inbox updates to `recipient`, reading them with
 *  `identity` (both keys during a re-key), so an update sent before a
 *  password change can still be approved after it. One that does not open
 *  with these keys is left as it is. The plaintext passes through memory
 *  only. */
async function reencryptInbox(
  spaceDir: string,
  identity: string,
  recipient: string
): Promise<void> {
  for (const file of await parkedInboxItems(spaceDir)) {
    let plain: Buffer;
    try {
      plain = await decryptToRunner(identity, file);
    } catch {
      continue;
    }
    try {
      const armor = await encryptToRecipient(recipient, plain);
      const staged = `${file}.${process.pid}.tmp`;
      await fs.writeFile(staged, armor, { mode: 0o600 });
      await fs.rename(staged, file);
    } finally {
      plain.fill(0);
    }
  }
}

/** Age armor of `data` for `recipient`. The plaintext goes to `age` on stdin. */
async function encryptToRecipient(
  recipient: string,
  data: Buffer
): Promise<Buffer> {
  const env = await hostEnv();
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('age', ['-a', '-r', recipient], {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`age could not encrypt it: ${err.trim()}`));
    });
    child.stdin.end(data);
  });
}

// ── Per-space sops dotenv (values write-only; list returns names only) ──

/** `<space>/secrets` and every folder in it, 0700: only the runner user may
 *  even list what is stored. mkdir applies a mode only when it creates, and
 *  the host may have created `secrets/` already with the default mode, so
 *  this chmods what exists too. Called before every write and at space start. */
export async function ensureSecretsDir(spaceDir: string): Promise<void> {
  const root = path.join(spaceDir, 'secrets');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await fs.chmod(path.join(root, entry.name), 0o700).catch(() => undefined);
    }
  }
}

function envPath(spaceDir: string): string {
  return path.join(spaceDir, 'secrets', ENV_FILE);
}

// Per-call decrypt: the password proves presence every single time.
async function identityFor(
  configDir: string,
  password: string
): Promise<string> {
  const box = await readIdentityBox(configDir);
  // Every password road ends here (or in rotatePassword), so the guess limit
  // lives here too (password-throttle.ts).
  const identity = await throttledPasswordCheck(configDir, () =>
    decryptIdentity(box, password)
  );
  if (!box.adopted) return identity;
  return ownKeyForAdopted(configDir, password);
}

/**
 * The first unlock of a board that adopted the runner-wide key: give it a key
 * of its own, under the same password, so no two boards share one even before
 * anyone changes a password. Under the store lock, and it reads the box
 * again there: a second unlock racing this one finds the board already
 * re-keyed and opens the new key instead.
 */
async function ownKeyForAdopted(
  keyDir: string,
  password: string
): Promise<string> {
  const spaceDir = path.dirname(keyDir);
  return withStoreLock(spaceDir, async () => {
    const box = await readIdentityBox(keyDir);
    const current = decryptIdentity(box, password);
    if (!box.adopted) return current;
    return rekeyLocked(spaceDir, current, password);
  });
}

/** Re-key one board while holding its store lock: a new key, the store and
 *  parked inbox updates re-encrypted to it, sealed under `password`. Both
 *  keys are sealed under `password` while the store is mixed, so an
 *  interruption leaves a store that password still opens in full. Returns
 *  the new identity, which must stay in memory. */
async function rekeyLocked(
  spaceDir: string,
  oldIdentity: string,
  password: string
): Promise<string> {
  await assertBinaries();
  const keyDir = spaceKeyDir(spaceDir);
  const { identity: newIdentity, recipient } = await generateKeypair();
  const both = `${oldIdentity}\n${newIdentity}`;
  await writeIdentityBox(keyDir, sealIdentity(both, password));
  await fs.writeFile(path.join(keyDir, RECIPIENT_FILE), `${recipient}\n`, {
    mode: 0o600
  });
  await reencryptStore(keyDir, spaceDir, both);
  // Updates parked before the re-key were sent to the old recipient.
  await reencryptInbox(spaceDir, both, recipient);
  await writeIdentityBox(keyDir, sealIdentity(newIdentity, password));
  return newIdentity;
}

// All values pass through runner memory only; sops re-encrypts file-to-file.
async function readEnv(
  spaceDir: string,
  identity: string
): Promise<Record<string, string>> {
  try {
    await fs.access(envPath(spaceDir));
  } catch {
    return {};
  }
  const { stdout } = await execFileAsync(
    'sops',
    [
      '-d',
      '--input-type',
      'dotenv',
      '--output-type',
      'dotenv',
      envPath(spaceDir)
    ],
    {
      env: { ...(await hostEnv()), SOPS_AGE_KEY: identity },
      maxBuffer: 4 * 1024 * 1024
    }
  );
  const values: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) {
      values[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return values;
}

/** A file written whole beside the one it replaces: `rename` puts it there. */
type Staged = { from: string; to: string };

async function writeEnv(
  configDir: string,
  spaceDir: string,
  identity: string,
  values: Record<string, string>
): Promise<void> {
  const staged = await stageEnv(configDir, spaceDir, identity, values);
  await fs.rename(staged.from, staged.to);
}

/** writeEnv up to the rename, for a caller that puts several files in place
 *  together (importBackupIntoStore). */
async function stageEnv(
  configDir: string,
  spaceDir: string,
  identity: string,
  values: Record<string, string>
): Promise<Staged> {
  const recipient = (
    await fs.readFile(path.join(configDir, RECIPIENT_FILE), 'utf-8')
  ).trim();
  await ensureSecretsDir(spaceDir);
  const plain = `${Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`;
  const tmp = envPath(spaceDir).replace(
    /\.enc\.env$/,
    `.${process.pid}.tmp.env`
  );
  await fs.writeFile(tmp, plain, { mode: 0o600 });
  try {
    const { stdout } = await execFileAsync(
      'sops',
      [
        '-e',
        '--age',
        recipient,
        '--input-type',
        'dotenv',
        '--output-type',
        'dotenv',
        tmp
      ],
      {
        env: { ...(await hostEnv()), SOPS_AGE_KEY: identity },
        maxBuffer: 4 * 1024 * 1024
      }
    );
    // Staged and renamed: a crash mid-write must not truncate the store,
    // which a password change now rewrites whole.
    const staged = `${envPath(spaceDir)}.${process.pid}.staged`;
    await fs.writeFile(staged, stdout, { mode: 0o600 });
    return { from: staged, to: envPath(spaceDir) };
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/**
 * The key names the store actually holds, WITHOUT the password.
 *
 * sops in dotenv mode encrypts values and leaves names in cleartext, so the
 * file itself answers "what is in here" - which is what lets `factiii-secrets
 * list` report the real contents of the store rather than the contract's
 * guess at it. Its own bookkeeping rows (`sops_version`, `sops_mac`, the
 * recipient list) are not stored keys and are dropped.
 */
export async function storedSecretKeys(spaceDir: string): Promise<string[]> {
  const raw = await fs.readFile(envPath(spaceDir), 'utf-8').catch(() => '');
  const keys: string[] = [];
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0 || line.startsWith('#')) continue;
    const key = line.slice(0, eq);
    if (key.startsWith('sops_')) continue;
    keys.push(key);
  }
  return keys;
}

/** Key NAMES only - the wire never carries a value. */
export async function listSecretKeys(
  configDir: string,
  spaceDir: string,
  password: string
): Promise<string[]> {
  const identity = await identityFor(configDir, password);
  return Object.keys(await readEnv(spaceDir, identity));
}

export async function setSecret(
  configDir: string,
  spaceDir: string,
  password: string,
  key: string,
  value: string
): Promise<{ success: boolean }> {
  await assertBinaries();
  if (!/^[A-Z][A-Z0-9_]*$/i.test(key)) {
    throw new Error('Key must be an env-style name (letters, digits, _).');
  }
  const identity = await identityFor(configDir, password);
  await withStoreLock(spaceDir, async () => {
    const values = await readEnv(spaceDir, identity);
    values[key] = value;
    await writeEnv(configDir, spaceDir, identity, values);
  });
  return { success: true };
}

export async function unsetSecret(
  configDir: string,
  spaceDir: string,
  password: string,
  key: string
): Promise<{ success: boolean }> {
  const identity = await identityFor(configDir, password);
  await withStoreLock(spaceDir, async () => {
    const values = await readEnv(spaceDir, identity);
    delete values[key];
    await writeEnv(configDir, spaceDir, identity, values);
  });
  // The description outlives nothing: a key removed and later re-added is a
  // different credential, and inheriting the old purpose would misdescribe it.
  await pruneSecretMeta(spaceDir);
  return { success: true };
}

/** Unwrap the age key with the password, for a caller that holds it for
 *  longer than one call: the unlock window (secrets-window.ts). Throws
 *  'Wrong password.' like every other entry point. The result must stay in
 *  memory and never be written anywhere. */
export async function unwrapIdentity(
  configDir: string,
  password: string
): Promise<string> {
  return identityFor(configDir, password);
}

/** The decrypted store for an identity already unwrapped (the window path).
 *  Same rules as secretsForInjection: never crosses the wire. */
export async function secretsForIdentity(
  spaceDir: string,
  identity: string
): Promise<Record<string, string>> {
  return readEnv(spaceDir, identity);
}

/** Set a key with an identity already unwrapped, for the inbox, which has
 *  proved the password once and writes more than one value. */
export async function setSecretWithIdentity(
  configDir: string,
  spaceDir: string,
  identity: string,
  key: string,
  value: string
): Promise<void> {
  await assertBinaries();
  if (!SECRET_NAME.test(key)) {
    throw new Error('Key must be an env-style name (letters, digits, _).');
  }
  await withStoreLock(spaceDir, async () => {
    const values = await readEnv(spaceDir, identity);
    values[key] = value;
    await writeEnv(configDir, spaceDir, identity, values);
  });
}

/** For the run executor ONLY: the decrypted env to inject into a declared
 *  command's process. Never crosses the wire; callers must redact all output
 *  against these values. The password arrives with the push itself - no
 *  session ever exists. */
export async function secretsForInjection(
  configDir: string,
  spaceDir: string,
  password: string
): Promise<Record<string, string>> {
  const identity = await identityFor(configDir, password);
  return readEnv(spaceDir, identity);
}

// ── Binary secrets (sops blobs, one file per secret) ─────────────────
//
// Keys, certificates and whole server .env files do not fit a dotenv line, and
// the flat key namespace would collide for the last of those. Each one is its
// own sops binary blob at `<space>/secrets/files/<NAME>.enc`, encrypted to the
// same runner recipient. A spawn that names one gets a 0600 temp file whose
// path is in `$NAME`, wiped after the spawn (secrets-run.ts). A listing
// returns the name, and for an env file its key names and masked tails
// (secretFileEnvKeys), never the bytes.

const FILES_DIR = 'files';
/** Env-style, because the name becomes the variable holding the file's path. */
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** sops reads a .sops.yaml from any parent directory and refuses to encrypt
 *  when its creation rules do not match. The recipient is always explicit
 *  here, so no config applies. */
const NO_SOPS_CONFIG = ['--config', '/dev/null'];

function filesDir(spaceDir: string): string {
  return path.join(spaceDir, 'secrets', FILES_DIR);
}

function blobPath(spaceDir: string, name: string): string {
  if (!SECRET_NAME.test(name)) {
    throw new Error(
      'A file secret needs an env-style name (letters, digits, _).'
    );
  }
  return path.join(filesDir(spaceDir), `${name}.enc`);
}

/** The file-secret NAMES this space holds, without the password. */
export async function storedSecretFiles(spaceDir: string): Promise<string[]> {
  const entries = await fs.readdir(filesDir(spaceDir)).catch(() => []);
  return entries
    .filter((f) => f.endsWith('.enc'))
    .map((f) => f.slice(0, -'.enc'.length))
    .filter((name) => SECRET_NAME.test(name))
    .sort();
}

/** Encrypt `data` into the blob for `name`, replacing any previous one. The
 *  plaintext touches disk only as a 0600 temp file for sops to read, as the
 *  dotenv store already does, and is removed in every outcome. */
export async function setSecretFileWithIdentity(
  configDir: string,
  spaceDir: string,
  identity: string,
  name: string,
  data: Buffer
): Promise<void> {
  await withStoreLock(spaceDir, () =>
    writeBlob(configDir, spaceDir, identity, name, data)
  );
}

/** setSecretFileWithIdentity without the store lock, for callers that hold
 *  it (setSecretFile, the re-key). */
async function writeBlob(
  configDir: string,
  spaceDir: string,
  identity: string,
  name: string,
  data: Buffer
): Promise<void> {
  await assertBinaries();
  const target = blobPath(spaceDir, name);
  const recipient = (
    await fs.readFile(path.join(configDir, RECIPIENT_FILE), 'utf-8')
  ).trim();
  await ensureSecretsDir(spaceDir);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(target), 0o700);
  const tmp = `${target}.${process.pid}.plain`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  try {
    const { stdout } = await execFileAsync(
      'sops',
      [
        ...NO_SOPS_CONFIG,
        '-e',
        '--age',
        recipient,
        '--input-type',
        'binary',
        '--output-type',
        'binary',
        tmp
      ],
      {
        env: { ...(await hostEnv()), SOPS_AGE_KEY: identity },
        maxBuffer: 64 * 1024 * 1024
      }
    );
    const staged = `${target}.${process.pid}.tmp`;
    await fs.writeFile(staged, stdout, { mode: 0o600 });
    await fs.rename(staged, target);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export async function setSecretFile(
  configDir: string,
  spaceDir: string,
  password: string,
  name: string,
  data: Buffer
): Promise<{ success: boolean }> {
  const identity = await identityFor(configDir, password);
  await withStoreLock(spaceDir, () =>
    writeBlob(configDir, spaceDir, identity, name, data)
  );
  return { success: true };
}

/** Remove a file secret. Takes the password like unsetSecret: deleting a
 *  deploy key is as consequential as replacing it. */
export async function unsetSecretFile(
  configDir: string,
  spaceDir: string,
  password: string,
  name: string
): Promise<{ success: boolean }> {
  await identityFor(configDir, password);
  await withStoreLock(spaceDir, () =>
    fs.rm(blobPath(spaceDir, name), { force: true })
  );
  return { success: true };
}

/** For the run executor ONLY: one blob's bytes. Never crosses the wire. */
export async function readSecretFileWithIdentity(
  spaceDir: string,
  identity: string,
  name: string
): Promise<Buffer> {
  const file = blobPath(spaceDir, name);
  try {
    await fs.access(file);
  } catch {
    throw new Error(`No file secret named ${name} is stored.`);
  }
  const { stdout } = await execFileAsync(
    'sops',
    [
      ...NO_SOPS_CONFIG,
      '-d',
      '--input-type',
      'binary',
      '--output-type',
      'binary',
      file
    ],
    {
      env: { ...(await hostEnv()), SOPS_AGE_KEY: identity },
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024
    }
  );
  return stdout;
}

// ── One key inside an env file secret (envFile.ts) ───────────────────
//
// A server env is one file secret, so changing one key used to mean sending
// the whole file again. Here the runner opens the blob, changes one line and
// re-encrypts it. The decrypted file is in this process's memory only: sops
// writes it to stdout on the way in and reads it from stdin on the way out, so
// no file ever holds it in the clear. What leaves this module is key names
// and masked tails (envFileKeys), never the file and never a value.

/** A stored file secret as an env file, or null when it is not one: bytes
 *  that are not UTF-8 text, or text that is not env lines (parseEnvFile). */
async function openEnvFile(
  spaceDir: string,
  identity: string,
  name: string
): Promise<EnvFile | null> {
  const data = await readSecretFileWithIdentity(spaceDir, identity, name);
  try {
    const text = data.toString('utf-8');
    // Bytes that do not decode cleanly would not come back the same.
    if (!Buffer.from(text, 'utf-8').equals(data)) return null;
    return parseEnvFile(text);
  } finally {
    data.fill(0);
  }
}

/** writeBlob for bytes that must not touch disk in the clear: sops reads
 *  them from stdin. The caller holds the store lock. On a failure only the
 *  exit code is reported, never what sops printed. */
async function writeBlobFromMemory(
  configDir: string,
  spaceDir: string,
  name: string,
  data: Buffer
): Promise<void> {
  const staged = await stageBlobFromMemory(configDir, spaceDir, name, data);
  await fs.rename(staged.from, staged.to);
}

/** writeBlobFromMemory up to the rename (importBackupIntoStore). */
async function stageBlobFromMemory(
  configDir: string,
  spaceDir: string,
  name: string,
  data: Buffer
): Promise<Staged> {
  const target = blobPath(spaceDir, name);
  const recipient = (
    await fs.readFile(path.join(configDir, RECIPIENT_FILE), 'utf-8')
  ).trim();
  // Encrypting needs the recipient only, so the identity is not passed.
  const env = await hostEnv();
  const encrypted = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      'sops',
      [
        ...NO_SOPS_CONFIG,
        '-e',
        '--age',
        recipient,
        '--input-type',
        'binary',
        '--output-type',
        'binary',
        '/dev/stdin'
      ],
      { env, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const out: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.on('error', reject);
    // sops exiting before it has read everything is reported by `close`.
    child.stdin.on('error', () => undefined);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`sops could not encrypt ${name} (exit ${code}).`));
    });
    child.stdin.end(data);
  });
  // Staged and renamed, as writeBlob does: a crash mid-write must not
  // truncate the only copy of a server env.
  const staged = `${target}.${process.pid}.tmp`;
  await fs.writeFile(staged, encrypted, { mode: 0o600 });
  return { from: staged, to: target };
}

/**
 * The keys inside an env file secret: names and masked tails, or null for a
 * file that is not an env file. Takes the password like every read of the
 * store's contents: a file secret is one encrypted blob, so even its key
 * names are unreadable without the key.
 */
export async function secretFileEnvKeys(
  configDir: string,
  spaceDir: string,
  password: string,
  name: string
): Promise<SecretFileEnvKey[] | null> {
  const identity = await identityFor(configDir, password);
  const file = await withStoreLock(spaceDir, () =>
    openEnvFile(spaceDir, identity, name)
  );
  return file ? envFileKeys(file) : null;
}

/** Open the env file `name`, apply `change`, and store the result, all under
 *  the store lock so no other write lands between the read and the write.
 *  Returns the keys the file holds afterwards. */
async function rewriteEnvFile(
  configDir: string,
  spaceDir: string,
  password: string,
  name: string,
  maxBytes: number,
  change: (file: EnvFile) => EnvFile
): Promise<SecretFileEnvKey[]> {
  await assertBinaries();
  const identity = await identityFor(configDir, password);
  return withStoreLock(spaceDir, async () => {
    const file = await openEnvFile(spaceDir, identity, name);
    if (!file) {
      throw new Error(
        `${name} is not an env file. Replace the whole file to change it.`
      );
    }
    const next = change(file);
    const data = Buffer.from(serializeEnvFile(next), 'utf-8');
    try {
      if (data.length > maxBytes) {
        throw new Error(`${name} would be larger than a file secret may be.`);
      }
      await writeBlobFromMemory(configDir, spaceDir, name, data);
    } finally {
      data.fill(0);
    }
    return envFileKeys(next);
  });
}

/** Set one key inside an env file secret, in place (setEnvFileKey). */
export async function setSecretFileEnvKey(
  configDir: string,
  spaceDir: string,
  password: string,
  target: { name: string; key: string; value: string; maxBytes: number }
): Promise<{ occurrences: number; keys: SecretFileEnvKey[] }> {
  let occurrences = 0;
  const keys = await rewriteEnvFile(
    configDir,
    spaceDir,
    password,
    target.name,
    target.maxBytes,
    (file) => {
      const result = setEnvFileKey(file, target.key, target.value);
      occurrences = result.occurrences;
      return result.file;
    }
  );
  return { occurrences, keys };
}

/** Remove one key from an env file secret (unsetEnvFileKey). */
export async function unsetSecretFileEnvKey(
  configDir: string,
  spaceDir: string,
  password: string,
  target: { name: string; key: string; maxBytes: number }
): Promise<{ removed: number; keys: SecretFileEnvKey[] }> {
  let removed = 0;
  const keys = await rewriteEnvFile(
    configDir,
    spaceDir,
    password,
    target.name,
    target.maxBytes,
    (file) => {
      const result = unsetEnvFileKey(file, target.key);
      removed = result.removed;
      return result.file;
    }
  );
  return { removed, keys };
}

/**
 * Open age armor sent to this runner's recipient (the secrets inbox). The
 * identity goes to `age` on stdin, so the unwrapped key is never written to a
 * file even for the length of one call.
 */
export async function decryptToRunner(
  identity: string,
  armoredFile: string
): Promise<Buffer> {
  const env = await hostEnv();
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('age', ['-d', '-i', '-', armoredFile], {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      // age's stderr names the failure (no identity matched, bad armor) and
      // never the plaintext, which only ever goes to stdout.
      else reject(new Error(`age could not decrypt it: ${err.trim()}`));
    });
    child.stdin.end(`${identity}\n`);
  });
}

/** This runner's public age recipient, which the laptop CLI encrypts to. */
export async function runnerRecipient(configDir: string): Promise<string> {
  return (
    await fs.readFile(path.join(configDir, RECIPIENT_FILE), 'utf-8')
  ).trim();
}

// ── Rotation ─────────────────────────────────────────────────────────

/**
 * Change the password guarding the age key. The key itself is untouched, so
 * the recipient and every space's `secrets.enc.env` stay exactly as they are —
 * one small file is rewritten and no value is ever re-encrypted.
 */
export async function rotatePassword(
  configDir: string,
  currentPassword: string,
  nextPassword: string
): Promise<{ success: boolean }> {
  if (nextPassword.length < 8) {
    throw new Error('Use a password of at least 8 characters.');
  }
  // Throws 'Wrong password.' before anything is written, and counts toward
  // the guess limit like every other password check.
  const box = await readIdentityBox(configDir);
  const identity = await throttledPasswordCheck(configDir, () =>
    decryptIdentity(box, currentPassword)
  );
  await writeIdentityBox(configDir, sealIdentity(identity, nextPassword));
  return { success: true };
}

/**
 * Replace the age key itself, re-encrypting every space's store to the new
 * recipient. The password is unchanged — it guards the new key exactly as it
 * guarded the old one.
 *
 * Heavier than a password rotation by nature: every value has to be decrypted
 * and re-encrypted, so it is O(spaces) subprocess work rather than one file.
 *
 * Crash-safe by keeping BOTH keys readable while the stores are mixed: sops
 * accepts newline-separated identities in SOPS_AGE_KEY, so the box holds
 * `old\nnew` for the duration and narrows to the new key only once every space
 * has been re-encrypted. Interrupt it at any point and the surviving state can
 * still decrypt everything — the worst case is a runner holding one key more
 * than it needs, which a re-run clears.
 *
 * `spaceDirs` is passed in rather than discovered: this module never assumes
 * the runner's on-disk layout.
 */
export async function rotateKey(
  configDir: string,
  password: string,
  spaceDirs: string[]
): Promise<{ success: boolean; spaces: number }> {
  await assertBinaries();
  const oldIdentity = decryptIdentity(
    await readIdentityBox(configDir),
    password
  );

  const { identity: newIdentity, recipient: newRecipient } =
    await generateKeypair();

  // Both keys, then the new recipient: from here a store may be on either key
  // and everything still reads.
  const both = `${oldIdentity}\n${newIdentity}`;
  await writeIdentityBox(configDir, sealIdentity(both, password));
  await fs.writeFile(
    path.join(configDir, RECIPIENT_FILE),
    `${newRecipient}\n`,
    { mode: 0o600 }
  );

  let spaces = 0;
  for (const spaceDir of spaceDirs) {
    if (await reencryptStore(configDir, spaceDir, both)) spaces += 1;
  }

  await writeIdentityBox(configDir, sealIdentity(newIdentity, password));
  return { success: true, spaces };
}

/** Re-encrypt one space's store (dotenv and file blobs) to the recipient now
 *  in `configDir`, reading it with `identity`. True when it had a dotenv
 *  store. */
async function reencryptStore(
  configDir: string,
  spaceDir: string,
  identity: string
): Promise<boolean> {
  // File blobs are encrypted to the recipient too, so they move with the
  // store; left behind they would be readable only by the key being retired.
  for (const name of await storedSecretFiles(spaceDir)) {
    const data = await readSecretFileWithIdentity(spaceDir, identity, name);
    await writeBlob(configDir, spaceDir, identity, name, data);
    data.fill(0);
  }
  if (!(await exists(envPath(spaceDir)))) return false;
  const values = await readEnv(spaceDir, identity);
  await writeEnv(configDir, spaceDir, identity, values);
  return true;
}

/**
 * Change one board's password, and its key with it.
 *
 * A new password alone would leave the key unchanged, and every board that
 * adopted the runner's old key (adoptRunnerKey) holds a copy of it under the
 * old shared password. So this generates a new key for the board,
 * re-encrypts its store to it, and seals it under the new password: after
 * this the old password opens nothing here, whichever board's copy it is
 * typed into.
 *
 * Crash-safe as rotateKey is: both keys are sealed under the NEW password
 * while the store is mixed, so an interrupted change leaves a store the new
 * password still opens in full.
 */
export async function changeSpacePassword(
  spaceDir: string,
  currentPassword: string,
  nextPassword: string
): Promise<{ success: boolean }> {
  if (nextPassword.length < 8) {
    throw new Error('Use a password of at least 8 characters.');
  }
  await assertBinaries();
  const keyDir = spaceKeyDir(spaceDir);
  return withStoreLock(spaceDir, async () => {
    // Throws 'Wrong password.' before anything is written, and counts toward
    // this board's guess limit like every other password check.
    const box = await readIdentityBox(keyDir);
    const oldIdentity = await throttledPasswordCheck(keyDir, () =>
      decryptIdentity(box, currentPassword)
    );
    await rekeyLocked(spaceDir, oldIdentity, nextPassword);
    return { success: true };
  });
}

// ── What each key is FOR (plaintext sidecar, no password) ──
//
// sops dotenv mode already leaves key NAMES in cleartext, which is what lets
// `factiii-secrets list` answer "what is in here" without unlocking anything.
// A description of a credential is not the credential, so it lives beside the
// names under the same rule: `secrets.meta.json`, plaintext, no password on
// either side. Nothing in this block can read or write a VALUE.
//
// Why a sidecar rather than the deploy contract: required-variables.json only
// describes keys a merged deploy skill DECLARES. Keys that arrive any other
// way - the one-time vault import, `factiii-runner secret set`, a value typed into the Secrets panel -
// have nowhere to carry a purpose, and those are most of the store on a repo
// with no deploy skill yet. The contract still wins as a default; an entry
// here is the owner's own edit and overrides it (see space-core.ts).

const META_FILE = 'secrets.meta.json';

type MetaFile = { v: 1; keys: Record<string, SecretMeta> };

function metaPath(spaceDir: string): string {
  return path.join(spaceDir, 'secrets', META_FILE);
}

export function normalizeMeta(raw: unknown): SecretMeta {
  const row = (raw ?? {}) as Partial<Record<keyof SecretMeta, unknown>>;
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  // No field is defaulted here, `category` included: an entry that says
  // nothing about a field must stay silent so the deploy contract's value
  // still shows through. Substituting 'general' would shadow it (space-core.ts
  // merges field by field, and a present value wins).
  return {
    title: text(row.title),
    description: text(row.description),
    category: text(row.category),
    source: text(row.source)
  };
}

/** Every described key. A missing or unreadable sidecar is "nothing described
 *  yet", never an error: the store works without it and the panel must still
 *  render. */
export async function readSecretMeta(
  spaceDir: string
): Promise<Record<string, SecretMeta>> {
  const raw = await fs.readFile(metaPath(spaceDir), 'utf-8').catch(() => '');
  if (!raw) return {};
  let parsed: Partial<MetaFile>;
  try {
    parsed = JSON.parse(raw) as Partial<MetaFile>;
  } catch {
    return {};
  }
  const keys = parsed.keys;
  if (!keys || typeof keys !== 'object') return {};
  const out: Record<string, SecretMeta> = {};
  for (const [key, row] of Object.entries(keys)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = normalizeMeta(row);
  }
  return out;
}

async function writeSecretMeta(
  spaceDir: string,
  keys: Record<string, SecretMeta>
): Promise<void> {
  const file = metaPath(spaceDir);
  await ensureSecretsDir(spaceDir);
  const body: MetaFile = { v: 1, keys };
  // Atomic: the sidecar is small and rewritten whole, and a truncated one
  // would read as "nothing described" and quietly lose every description.
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, {
    mode: 0o600
  });
  await fs.rename(tmp, file);
}

/**
 * Describe one key. Fields left undefined keep what they had, so the panel can
 * save a title without clearing a description.
 *
 * Deliberately password-free: this writes no secret material, and taking the
 * password would mean an scrypt derivation and a sops decrypt to store a
 * sentence. The wire it arrives on is already the owner's.
 */
export async function setSecretMeta(
  spaceDir: string,
  key: string,
  patch: Partial<SecretMeta>
): Promise<{ success: boolean }> {
  if (!/^[A-Z][A-Z0-9_]*$/i.test(key)) {
    throw new Error('Key must be an env-style name (letters, digits, _).');
  }
  const all = await readSecretMeta(spaceDir);
  const next = normalizeMeta({ ...(all[key] ?? {}), ...patch });
  // An entry with nothing left to say is noise in the file and in `list`.
  if (!next.title && !next.description && !next.source) {
    delete all[key];
  } else {
    all[key] = next;
  }
  await writeSecretMeta(spaceDir, all);
  return { success: true };
}

/** Drop descriptions for keys the store no longer holds. Called after an
 *  unset, so a re-added key never inherits the old one's purpose. */
async function pruneSecretMeta(spaceDir: string): Promise<void> {
  const all = await readSecretMeta(spaceDir);
  const stored = new Set(await storedSecretKeys(spaceDir));
  let changed = false;
  for (const key of Object.keys(all)) {
    if (!stored.has(key)) {
      delete all[key];
      changed = true;
    }
  }
  if (changed) await writeSecretMeta(spaceDir, all);
}

// ── Offline backup (secrets-backup.ts) ────────────────────────────────
//
// A backup holds the board's secrets themselves: the keys, their
// descriptions and the file secrets, read out of the store here and sealed
// under a passphrase there. Nothing of the store's own files is in it, and
// not the board's key. The inbox is left out: its items are updates still
// waiting for approval, not the store.

/** A board's secrets in the clear, in this process's memory only. Whoever
 *  holds one zeroes each file's `data` when done (secrets-backup.ts). */
export type BackupContents = {
  values: Record<string, string>;
  meta: Record<string, SecretMeta>;
  files: { name: string; data: Buffer }[];
};

/** Everything the board's store holds, for a holder of the board password.
 *  Read under the store lock, so a write cannot land between two reads. */
export async function readStoreForBackup(
  spaceDir: string,
  password: string
): Promise<BackupContents> {
  const configDir = spaceKeyDir(spaceDir);
  if (!(await exists(path.join(configDir, IDENTITY_FILE)))) {
    throw new Error(
      'This board has no secrets of its own yet, so there is nothing to back up.'
    );
  }
  // The guess limit, and the first-unlock re-key of an adopted board, both
  // live on this road. It takes the store lock itself, so it runs first.
  const identity = await unwrapIdentity(configDir, password);
  await assertBinaries();
  return withStoreLock(spaceDir, async () => {
    const contents: BackupContents = {
      values: await readEnv(spaceDir, identity),
      meta: await readSecretMeta(spaceDir),
      files: []
    };
    for (const name of await storedSecretFiles(spaceDir)) {
      contents.files.push({
        name,
        data: await readSecretFileWithIdentity(spaceDir, identity, name)
      });
    }
    return contents;
  });
}

/** Whether the board's secrets folder holds anything of a store: a key, a
 *  recipient, the key store, descriptions or a file secret. A restore goes
 *  only into a board where this is false: one over a live store would lose
 *  every secret written since the backup was taken. */
export async function boardHoldsSecrets(spaceDir: string): Promise<boolean> {
  const root = path.join(spaceDir, 'secrets');
  for (const file of [IDENTITY_FILE, RECIPIENT_FILE, ENV_FILE, META_FILE]) {
    if (await exists(path.join(root, file))) return true;
  }
  const blobs = await fs.readdir(filesDir(spaceDir)).catch(() => []);
  return blobs.some((name) => name.endsWith('.enc'));
}

// ── Import from a backup into a board (secrets-backup.ts) ─────────────
//
// The owner picks secrets of an opened backup and the runner writes them into
// THIS board's store, encrypted to the board's key. What leaves this module
// is names, masked tails and sizes.

type ImportPlanRows = Pick<SecretsBackupImportPlan, 'secrets' | 'files'>;

/** The backup's secrets beside the board's own of the same names. Reads the
 *  board under the store lock, and writes nothing. `identity` is null for a
 *  board with no store yet, which has nothing to compare with. */
export async function compareBackupWithStore(
  backup: BackupContents,
  spaceDir: string,
  identity: string | null
): Promise<ImportPlanRows> {
  return withStoreLock(spaceDir, async () => {
    const current = new Map(
      Object.entries(identity ? await readEnv(spaceDir, identity) : {})
    );
    const stored = new Set(identity ? await storedSecretFiles(spaceDir) : []);
    const plan: ImportPlanRows = { secrets: [], files: [] };
    for (const name of Object.keys(backup.values).sort()) {
      const value = backup.values[name]!;
      const mine = current.get(name);
      plan.secrets.push({
        name,
        masked: maskedSecret(value),
        current:
          mine === undefined
            ? null
            : { masked: maskedSecret(mine), same: mine === value }
      });
    }
    for (const { name, data } of backup.files) {
      let mine: Buffer | null = null;
      if (identity && stored.has(name)) {
        mine = await readSecretFileWithIdentity(spaceDir, identity, name);
      }
      plan.files.push({
        name,
        size: data.length,
        current: mine && { size: mine.length, same: mine.equals(data) }
      });
      mine?.fill(0);
    }
    return plan;
  });
}

/** The picks as the runner will act on them, or a refusal. Nothing the page
 *  sent is trusted: a name must be env-style, named once, and in the backup. */
function checkedPicks(
  picks: unknown,
  inBackup: Set<string>,
  what: 'key' | 'file'
): BackupImportPick[] {
  if (!Array.isArray(picks)) throw new Error('Pick what to import.');
  const seen = new Set<string>();
  return picks.map((raw: unknown) => {
    const pick = (raw ?? {}) as Partial<BackupImportPick>;
    const { name, conflict } = pick;
    if (typeof name !== 'string' || !SECRET_NAME.test(name)) {
      throw new Error(`A ${what} to import has no env-style name.`);
    }
    if (seen.has(name)) throw new Error(`${name} is picked twice.`);
    seen.add(name);
    if (!inBackup.has(name)) {
      throw new Error(`This backup holds no ${what} named ${name}.`);
    }
    if (conflict !== undefined && conflict !== 'keep' && conflict !== 'take') {
      throw new Error(`${name} needs a choice: keep the board's, or take the backup's.`);
    }
    return { name, conflict };
  });
}

/** Whether a pick is written. A name the board holds with another value is
 *  never overwritten without the owner's choice. */
function writesPick(
  pick: BackupImportPick,
  current: 'absent' | 'same' | 'differs'
): boolean {
  if (current === 'absent') return true;
  if (current === 'same') return false;
  if (pick.conflict === undefined) {
    throw new Error(
      `This board already has ${pick.name}. Choose: keep the board's, or take the backup's.`
    );
  }
  return pick.conflict === 'take';
}

/**
 * Write the picked secrets of a backup into a board's store, re-encrypted to
 * the board's key. Every pick is checked again here, against the store as it
 * is under the lock; what the plan said is not trusted.
 *
 * Nothing is put in place until every new file is encrypted and staged, so a
 * refusal or a sops failure writes nothing. The staged files then go in by
 * one rename each. A crash between two renames leaves the earlier ones
 * imported and the later ones as they were; each file is whole either way.
 */
export async function importBackupIntoStore(
  backup: BackupContents,
  spaceDir: string,
  /** Opens the board's store, or creates it. Called once every pick is known
   *  to be in the backup, so a refused pick leaves no new store behind. */
  targetKey: () => Promise<string>,
  picked: { secrets: unknown; files: unknown }
): Promise<{ secrets: string[]; files: string[] }> {
  const configDir = spaceKeyDir(spaceDir);
  const values = new Map(Object.entries(backup.values));
  const blobs = new Map(backup.files.map((f) => [f.name, f.data]));
  const keyPicks = checkedPicks(picked.secrets, new Set(values.keys()), 'key');
  const filePicks = checkedPicks(picked.files, new Set(blobs.keys()), 'file');
  if (keyPicks.length + filePicks.length === 0) {
    throw new Error('Pick what to import.');
  }
  const identity = await targetKey();
  return withStoreLock(spaceDir, async () => {
    const current = new Map(Object.entries(await readEnv(spaceDir, identity)));
    const writtenKeys = keyPicks.filter((pick) => {
      const mine = current.get(pick.name);
      if (mine === undefined) return writesPick(pick, 'absent');
      return writesPick(
        pick,
        mine === values.get(pick.name) ? 'same' : 'differs'
      );
    });
    const stored = new Set(await storedSecretFiles(spaceDir));
    const writtenFiles: BackupImportPick[] = [];
    for (const pick of filePicks) {
      let state: 'absent' | 'same' | 'differs' = 'absent';
      if (stored.has(pick.name)) {
        const mine = await readSecretFileWithIdentity(
          spaceDir,
          identity,
          pick.name
        );
        state = mine.equals(blobs.get(pick.name)!) ? 'same' : 'differs';
        mine.fill(0);
      }
      if (writesPick(pick, state)) writtenFiles.push(pick);
    }

    const staged: Staged[] = [];
    try {
      if (writtenKeys.length > 0) {
        for (const { name } of writtenKeys) current.set(name, values.get(name)!);
        staged.push(
          await stageEnv(
            configDir,
            spaceDir,
            identity,
            Object.fromEntries(current)
          )
        );
      }
      if (writtenFiles.length > 0) {
        await ensureSecretsDir(spaceDir);
        await fs.mkdir(filesDir(spaceDir), { recursive: true, mode: 0o700 });
        await fs.chmod(filesDir(spaceDir), 0o700);
      }
      for (const { name } of writtenFiles) {
        staged.push(
          await stageBlobFromMemory(configDir, spaceDir, name, blobs.get(name)!)
        );
      }
      for (const file of staged) await fs.rename(file.from, file.to);
    } finally {
      // A staged file that was renamed is no longer there to remove.
      for (const file of staged) await fs.rm(file.from, { force: true });
    }

    const written = writtenKeys.map((pick) => pick.name);
    // A key arrives with what the backup said it is for, unless the board
    // already says. The secrets are in place by now, so a description that
    // cannot be written does not fail the import.
    await copySecretMeta(spaceDir, backup.meta, written).catch(() => undefined);
    return { secrets: written, files: writtenFiles.map((pick) => pick.name) };
  });
}

async function copySecretMeta(
  spaceDir: string,
  from: Record<string, SecretMeta>,
  keys: string[]
): Promise<void> {
  const all = await readSecretMeta(spaceDir);
  const added = keys.filter(
    (key) => Object.hasOwn(from, key) && !Object.hasOwn(all, key)
  );
  if (added.length === 0) return;
  for (const key of added) all[key] = from[key]!;
  await writeSecretMeta(spaceDir, all);
}
