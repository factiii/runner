import {
  type CardAIConfig,
  type ConfigProvider,
  hostTarget,
  isSignedIn
} from '@shared/all/helpers/board-agent-core';
import fs from 'fs';
import path from 'path';

import { CONFIG_DIR, spaceDirPath } from './paths';
import {
  isVaultSealedFile,
  readSecureBuffer,
  readSecureJson,
  writeSecureJson
} from './secureFile';
import {
  isSecureStoreError,
  retireVault,
  type SecureStoreStatus,
  storeStatus
} from './secureStore';

// One encrypted file per board, in that board's own `.creds`: github.json
// (settings + token). A board's credentials are its own, so a leaked token is
// one board's and removing a board is one directory. `provider` rides in
// github.json rather than earning a file of its own. (A second file,
// onedrive.json, held the runner OneDrive index's connection; that feature
// was removed, and removeOneDriveConnections deletes what it left.)
//
// It is sealed under the machine keychain key and nothing else, so the
// runner reads them the moment it starts - it can clone, deploy and show who
// is connected without anyone typing anything. Files an older runner sealed
// under the password-lockable vault are converted the first time the vault is
// open, and the vault is then retired (convertVaultSealedFiles).
//
// `.creds` rather than the space root: the root is the deploy contract's tree
// (workspace/backups/builds/bin), and credentials have no place in a directory
// a skill or a terminal might list, encrypted or not.
function credsDir(spaceSlug: string): string {
  return path.join(spaceDirPath(spaceSlug), '.creds');
}

function githubPath(spaceSlug: string): string {
  return path.join(credsDir(spaceSlug), 'github.json');
}

/** The runner OneDrive index's connection file (removed feature). Only
 *  removeOneDriveConnections reads this path, to delete it. */
function legacyOneDrivePath(spaceSlug: string): string {
  return path.join(credsDir(spaceSlug), 'onedrive.json');
}

/** Superseded stores, read once by migrateToSpaceFolders and then removed. */
const RUNNER_CONFIG_PATH = path.join(CONFIG_DIR, 'runner-config.json');

// Encrypted at rest under the machine keychain key. No plaintext path: a host
// that can't encrypt throws.
function writeJson(filePath: string, value: unknown): void {
  // A vault-sealed file is read first: that converts it when the vault is
  // open, and throws `locked` when it is not - a locked file is the only copy
  // of the token in it, and a save built on the empty defaults a locked read
  // degrades to must not replace it.
  if (isVaultSealedFile(filePath)) readSecureBuffer(filePath);
  writeSecureJson(filePath, value);
}

function fillDefaults(config: Partial<CardAIConfig>): CardAIConfig {
  return {
    repoUrl: config.repoUrl || '',
    mainBranch: config.mainBranch || 'main',
    gitName: config.gitName || '',
    gitEmail: config.gitEmail || '',
    githubToken: config.githubToken || '',
    provider: config.provider || 'claude'
  };
}

/** Every directory under the config root. The runner keeps host-level trees of
 *  its own in here beside the spaces — the rendered plugin, tmux's plugin and
 *  save dirs — so callers filter for what they mean. */
function configDirNames(): string[] {
  try {
    return fs
      .readdirSync(CONFIG_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Slugs with a provisioned space tree, read off the directory names.
 *  `safeSlug` only rewrites characters outside [A-Za-z0-9_.-], so a real slug
 *  round-trips through its directory name.
 *
 *  `bin/` is the test rather than a denylist of the runner's own directories:
 *  `ensureSpaceWorkspace` mkdirs it for every space, and nothing else here has
 *  one. A denylist goes stale as soon as another host-level tree lands, and one
 *  did — `ensureTmuxResurrect` adds `tmux-plugins/`, which a name filter reads
 *  as a board and hands the default board's github token. */
function provisionedSpaceSlugs(): string[] {
  return configDirNames().filter((name) =>
    fs.existsSync(path.join(CONFIG_DIR, name, 'bin'))
  );
}

/** Shape of the superseded runner-config.json. `default` was a template every
 *  board inherited; `boards[slug]` held either a full config (briefly) or only
 *  the fields that differed from the default. */
interface LegacyStore {
  boards?: Record<string, Partial<CardAIConfig>>;
  defaultSlug?: string;
  default?: Partial<CardAIConfig>;
}

/** One-time: move every board's settings into its own folder, then delete the
 *  stores they came from.
 *
 *  Two shapes feed in: runner-config.json (a shared `default` plus per-board
 *  overrides) and the older per-board `space-<slug>.json`. The default merges field-by-field
 *  with `||` because that is how it resolved when read — an empty override
 *  inherited rather than cleared. A board that inherited wholesale has no entry
 *  of its own, so its directory is the only record that it exists.
 *
 *  Deletion is last and best-effort: a surviving source is migrated again next
 *  start, which is harmless; deleting one before its replacement lands is not. */
let migrated = false;

function migrateToSpaceFolders(): void {
  if (migrated) return;
  migrated = true;
  // First and apart: it reads nothing, so a locked store cannot hold it up.
  removeOneDriveConnections();
  try {
    migrateOnce();
  } catch {
    // A legacy store still locked in the vault, or no keychain: nothing moved,
    // and the sources are untouched. Retry on the next read, which is what
    // happens after an unlock.
    migrated = false;
  }
}

/** The runner OneDrive index was removed, and nothing reads its connections
 *  now: delete them, so no OneDrive refresh token outlives the feature. Each
 *  board's `.creds/onedrive.json`, and the older `space-<slug>.onedrive.json`
 *  in the config root. Best-effort; whatever survives goes next start. */
function removeOneDriveConnections(): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(CONFIG_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  const files = entries.flatMap((entry) => {
    if (entry.isDirectory()) return [legacyOneDrivePath(entry.name)];
    const rootFile =
      entry.name.startsWith('space-') && entry.name.endsWith('.onedrive.json');
    return rootFile ? [path.join(CONFIG_DIR, entry.name)] : [];
  });
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Gone next start.
    }
  }
}

/** Tells an ABSENT legacy store apart from an UNREADABLE one — `readSecureJson`
 *  answers null for both, and the delete pass below turns on the difference.
 *  Unreadable means a rotated keychain entry or a config dir carried from
 *  another machine, so the file is the only copy of the token in it; deleting
 *  it as if it were empty is unrecoverable. (A LOCKED vault throws instead, and
 *  the caller's retry covers that.) */
function readLegacy<T>(filePath: string): { readable: boolean; value: T | null } {
  if (!fs.existsSync(filePath)) return { readable: true, value: null };
  const value = readSecureJson<T>(filePath);
  return { readable: value !== null, value };
}

function migrateOnce(): void {
  const legacy = readLegacy<LegacyStore>(RUNNER_CONFIG_PATH);
  if (!legacy.readable) {
    // Undecryptable rather than missing. Every board would look unconfigured,
    // every write would be skipped, and the delete pass would then destroy the
    // one file holding them. Bail so nothing is removed; a retry after the key
    // is restored migrates for real.
    throw new Error(
      `Cannot read ${RUNNER_CONFIG_PATH} — leaving the legacy stores in place.`
    );
  }
  const store = legacy.value ?? {};
  const base = store.default ?? {};
  const boards = store.boards ?? {};

  // Older still: one file per board in the config root. Only the ones actually
  // read are eligible for deletion.
  const strays: Record<string, Partial<CardAIConfig>> = {};
  const consumed: string[] = [];
  let strayFiles: string[] = [];
  try {
    strayFiles = fs
      .readdirSync(CONFIG_DIR)
      .filter((f) => f.startsWith('space-') && f.endsWith('.json'))
      .filter((f) => !f.endsWith('.onedrive.json'));
  } catch {
    strayFiles = [];
  }
  for (const name of strayFiles) {
    const slug = name.slice('space-'.length, -'.json'.length);
    const parsed = readLegacy<Partial<CardAIConfig>>(
      path.join(CONFIG_DIR, name)
    );
    if (!parsed.readable) continue;
    if (parsed.value) strays[slug] = parsed.value;
    consumed.push(name);
  }

  const slugs = new Set([
    ...Object.keys(boards),
    ...Object.keys(strays),
    ...(store.defaultSlug ? [store.defaultSlug] : []),
    ...provisionedSpaceSlugs()
  ]);

  for (const slug of slugs) {
    // Already moved: never overwrite the live file with an older copy.
    if (fs.existsSync(githubPath(slug))) continue;
    const over = boards[slug] ?? strays[slug] ?? {};
    // A directory left by a workspace, with no settings anywhere to inherit,
    // is not a configured board — writing defaults here would make it one.
    if (!Object.keys(over).length && !Object.keys(base).length) continue;
    const merged = fillDefaults({
      repoUrl: over.repoUrl || base.repoUrl,
      mainBranch: over.mainBranch || base.mainBranch,
      gitName: over.gitName || base.gitName,
      gitEmail: over.gitEmail || base.gitEmail,
      githubToken: over.githubToken || base.githubToken,
      provider: over.provider || base.provider
    });
    fs.mkdirSync(credsDir(slug), { recursive: true });
    writeJson(githubPath(slug), merged);
  }

  // Copies are in place; drop the originals so no token outlives its board.
  // `consumed`, not the listings: a file that could not be decrypted was never
  // migrated, and it is the only copy of what is in it.
  for (const name of [...consumed, 'runner-config.json']) {
    try {
      fs.rmSync(path.join(CONFIG_DIR, name), { force: true });
    } catch {
      // Still readable next start; migration is idempotent.
    }
  }
}

// A plaintext config from a runner that predates encryption still holds a live
// githubToken, and the migration has to be able to read it. Rewrite in place,
// don't delete.
let sweptStrays = false;

// Only files WE own, by name, so another tool's JSON can't be clobbered.
// Non-recursive: the provider CLIs own their subdirectories.
const OUR_ROOT_FILES = /^(config|runner-config|space-.*)\.json(\.bak-\d+)?$/;

function encryptStrayPlaintextConfigs(): void {
  if (sweptStrays) return;
  sweptStrays = true;
  let names: string[] = [];
  try {
    names = fs.readdirSync(CONFIG_DIR).filter((f) => OUR_ROOT_FILES.test(f));
  } catch {
    return;
  }
  for (const name of names) {
    const filePath = path.join(CONFIG_DIR, name);
    let value: unknown;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      // Already encrypted, or not JSON we wrote - leave it alone.
      if (!raw.startsWith('{')) continue;
      value = JSON.parse(raw);
    } catch {
      // Unreadable or unparseable: not ours to rewrite. On to the next.
      continue;
    }
    try {
      // The keychain envelope, which is also what readBootJson expects of
      // config.json: this sweep used to seal it under the vault, where the
      // pairing reader could not open it.
      writeSecureJson(filePath, value);
    } catch (err) {
      // No keychain, or the disk refused. The plaintext file is untouched;
      // say so once rather than on every read.
      console.error(
        `[secure] Could not encrypt ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }
  }
}

// ── Files an older runner sealed under the vault ──

// Nothing writes the vault envelope any more, so once a scan comes back empty
// it stays empty for the life of the process.
let vaultFilesGone = false;

/** Every file still in the vault (v2) envelope, in every place an older
 *  runner wrote one: the per-board connection files, and in the config root
 *  the superseded stores, the pairing config the old sweep could mis-seal, and
 *  their `.bak-N` copies. The vault is retired when this is empty, so it errs
 *  towards listing: an unreadable file, or a root that cannot be listed,
 *  counts. */
function vaultSealedFiles(): string[] {
  if (vaultFilesGone) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(CONFIG_DIR, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
    else return [CONFIG_DIR];
  }
  const files = entries
    .flatMap((entry) => {
      if (entry.isDirectory()) {
        return [githubPath(entry.name)];
      }
      return OUR_ROOT_FILES.test(entry.name)
        ? [path.join(CONFIG_DIR, entry.name)]
        : [];
    })
    .filter(isVaultSealedFile);
  if (!files.length) vaultFilesGone = true;
  return files;
}

/**
 * Rewrite every vault-sealed file, in every board, under the keychain key -
 * and once none is left, retire the vault, taking the connection password
 * with it. Run at start and right after an unlock, so one unlock is the last
 * one a runner ever needs; a runner whose vault holds nothing (password or
 * not) loses it at start without being asked for anything.
 *
 * `left` is what is still vault-sealed afterwards: everything while the vault
 * is locked, otherwise only a file that could not be decrypted or rewritten.
 * Such a file is never deleted or overwritten, and it keeps the vault.
 */
export function convertVaultSealedFiles(): {
  converted: number;
  left: string[];
  retired: boolean;
} {
  const before = vaultSealedFiles();
  if (before.length) {
    // Folds the superseded root stores into the boards first (a read converts
    // them on the way), so the loop below only meets what is left.
    migrateToSpaceFolders();
    for (const filePath of before) {
      try {
        readSecureBuffer(filePath);
      } catch {
        // Locked or no keychain, and so the same for every other file.
        break;
      }
    }
  }
  const left = before.length ? vaultSealedFiles() : [];
  return {
    converted: before.length - left.length,
    left,
    retired: left.length === 0 && retireVault()
  };
}

/**
 * The storage state the UI and the console get. On top of the keychain's own
 * state it reports the one thing a connection password can still block: files
 * an older runner sealed under the vault, while the vault is locked. Only
 * then is `passwordSupported` true, which is what makes a client - old or new
 * - show its unlock box; no client is ever offered a password to set.
 */
export function credentialStoreStatus(): SecureStoreStatus {
  const status = storeStatus();
  if (!status.ready || status.unlocked) return status;
  const locked = vaultSealedFiles().length;
  if (!locked) return status;
  return {
    ...status,
    passwordSupported: true,
    ready: false,
    problem: `${locked} saved connection ${
      locked === 1 ? 'file is' : 'files are'
    } still locked behind this runner’s old connection password, from before an update. Enter the password once: ${
      locked === 1 ? 'it stays' : 'they stay'
    } readable for good and the password is removed.`,
    fix: 'Enter the password in Runner Settings → Secrets, restart the runner in a terminal and type it there, or run "factiii-runner password".'
  };
}

/** One board's settings, straight from its folder. */
function readBoard(spaceSlug: string): Partial<CardAIConfig> {
  encryptStrayPlaintextConfigs();
  migrateToSpaceFolders();
  return readSecureJson<Partial<CardAIConfig>>(githubPath(spaceSlug)) ?? {};
}

// Which private connections this host has - the fact only, never the token.
// Kinds are open strings; see RunnerConnectionKind in shared.
export async function getConfiguredConnections(): Promise<string[]> {
  const kinds = new Set<string>();
  for (const slug of listConfiguredSlugs()) {
    if (kinds.has('git')) break;
    try {
      if (readBoard(slug).githubToken) kinds.add('git');
    } catch {
      // This board's file can't be read (no keychain, or still locked in the
      // vault): don't guess at it, and don't let it hide the other boards.
      // The UI reads the real reason from the secure-store status.
    }
  }
  // The CLI owns its sign-in, host-wide, so this is one question not one
  // per board.
  if (await isSignedIn(hostTarget(CONFIG_DIR), 'claude')) kinds.add('claude');
  return [...kinds];
}

/** Every space this runner has config for. The daemon reattaches each one's
 *  persistent workspace at startup to resume interrupted work. */
export function listConfiguredSlugs(): string[] {
  try {
    migrateToSpaceFolders();
    // Its settings file makes a board configured. A bare directory left by a
    // workspace is not. The full directory list, not the provisioned one: a
    // board saved but never opened has settings and no tree yet, and the
    // daemon still has to reattach it.
    return configDirNames().filter((slug) => fs.existsSync(githubPath(slug)));
  } catch {
    return [];
  }
}

export const localConfigProvider: ConfigProvider = {
  readConfig(spaceSlug: string): CardAIConfig {
    try {
      return fillDefaults(readBoard(spaceSlug));
    } catch (err) {
      // A runner that cannot read this file must still render its settings
      // panel, since that is where the fix is. Reads degrade to empty and
      // configProblem says why; a write over a locked file still throws.
      if (!isSecureStoreError(err)) throw err;
      return fillDefaults({});
    }
  },

  configProblem(spaceSlug: string): string | null {
    try {
      readBoard(spaceSlug);
      // Read without an error and still vault-sealed: the vault is open and
      // this file will not decrypt. It reads as empty, so name it.
      return isVaultSealedFile(githubPath(spaceSlug))
        ? `This board’s saved GitHub connection cannot be decrypted and was left in place (${githubPath(spaceSlug)}). Connect GitHub again to replace it.`
        : null;
    } catch (err) {
      if (!isSecureStoreError(err)) throw err;
      return err.fix ? `${err.message} ${err.fix}` : err.message;
    }
  },

  // The whole config, every time: a cleared field has to persist as cleared,
  // which is what makes disconnect stick.
  writeConfig(spaceSlug: string, config: CardAIConfig): void {
    // A save can be the first thing a process does, and this file must not
    // become the only copy before the old stores are folded in.
    migrateToSpaceFolders();
    fs.mkdirSync(credsDir(spaceSlug), { recursive: true });
    writeJson(githubPath(spaceSlug), config);
  },

  // No unencrypted mode exists any more, so this is true whenever the store
  // works at all; secureStore() carries the detail.
  tokensEncrypted(): boolean {
    return credentialStoreStatus().ready;
  },

  secureStore(): SecureStoreStatus {
    return credentialStoreStatus();
  },

  // Per-space environment root (workspace/backups/builds/secrets) - the
  // layout every deploy skill is written against. See .specs/deploy.md.
  spaceDir(spaceSlug: string): string {
    const dir = spaceDirPath(spaceSlug);
    for (const sub of [
      'workspace',
      'backups',
      'builds',
      'secrets',
      'claude',
      'codex',
      'scratchpad'
    ]) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
    // The secrets store: only the runner user may even list it. mkdir applies
    // a mode only on create, so an existing 0755 dir is tightened too.
    fs.chmodSync(path.join(dir, 'secrets'), 0o700);
    return dir;
  }
};
