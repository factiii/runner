import fs from 'node:fs';
import path from 'node:path';

import type {
  BoardAgentAction,
  BoardAgentActionMap,
  RunnerAskChat,
  RunnerAskModels,
  RunnerStoreName,
  RunnerVaultFile,
  RunnerVaultHit,
  RunnerVaultIngest,
  RunnerVaultNote,
  RunnerVaultStatus
} from '@shared/all/domains/electron';
import type { VouchedScope } from '@shared/all/helpers/board-agent-core/runner-access';
import { RUNNER_NO_VAULT } from '@shared/all/helpers/oakboxRunnerSetup';
import { MOVE_NOT_YOURS } from '@shared/all/helpers/storeMove';
import {
  isVaultLocked,
  VAULT_LOCKED,
  payloadStore,
  vaultAskPollSchema,
  vaultAskSchema,
  vaultChatSchema,
  vaultFilesSchema,
  vaultEraseSchema,
  vaultKeyChangeStartSchema,
  vaultKeyConfirmSchema,
  vaultKeySettingsSchema,
  vaultUnlockSchema,
  vaultMoveSchema,
  RUNNER_DISK_FULL,
  RUNNER_VAULT_READ_CHUNK_BYTES,
  RUNNER_VAULT_WRITE_CHUNK_BYTES,
  vaultSearchSchema,
  vaultUploadStartSchema,
  vaultWriteSchema
} from '@shared/all/validators';

import { freeDiskGb } from '../localAiModel';
import { checkRoom } from '../machineHealth';

import { NO_RUNNER_STORAGE, VAULT_NEVER_SHARED, VAULT_REFUSAL, vaultRole } from '@shared/vault-core/access';
import { type AskEngines, VaultAsk } from './ask';
import type { StartJob } from '../activity/registry';
import { type CategorizeEngines, VaultCategorize } from './categorize';
import { lazyVaultDb, openVaultDb } from './db';
import type { Embedder } from './embedder';
import type { FindingsJobOutcome } from './findingsJob';
import type { FetchTagChanges } from './tagFeed';
import {
  engineInstalled,
  installRouterClient,
  routerClientInstalled,
  type StorePaths,
  storePaths,
  vaultPaths
} from './engine';
import { VaultIngest } from './ingest';
import { FsObjectStore, RUNNER_STORAGE_TICKET_SCHEME, ticketStore } from '@shared/vault-core/objectStore';
import { RUNNER_CLOUD_SEALING, RunnerCloudSeal, type RunnerKeyStore } from '@shared/vault-core/runnerCloudSeal';
import { defaultRunnerKeyStores, legacyRunnerKeyStores, moveKeychainKeyToFile } from './runnerCloudKey';
import { openSealedVaultDb } from '@shared/vault-core/sealedDb';
import { sealPaths } from '@shared/vault-core/sealMigration';
import { diskFreeBytes, NOT_HERE, RunnerVault, VAULT_ROUTER_UPDATING } from './service';
import { VAULT_SEALING, VaultKeys } from '@shared/vault-core/vaultKeys';
import { loadVaultClient, RunnerVaultRouter } from './vaultRouter';

// The Vault as the daemon holds it: one per runner, its database started on
// the first call and stopped after IDLE_MS. `isMember` answers at once from
// the last read of Runner Cloud's share table, because the daemon asks it
// while a link is being opened. Its embedder is the daemon's.
// Ask with the runner's own model (ask.ts) goes through the same Vault, and
// so do its saved chats (askChats.ts) and Categorize (categorize.ts).
//
// The shared vault router (vaultRouter.ts) needs a Prisma client in the engine
// folder. A Vault added before the router existed has PGlite only, so the
// client is put in beside it in the background, at start or on the first
// `vaultRpc`; until it is there `vaultRpc` says to try again, and the old
// actions answer as they always have.
//
// Two stores (.specs/runner-vault.md "Two stores"): the Vault, read by Local
// AI only, and Runner Cloud, which Claude and Codex may read. Each is its
// own RunnerVault on its own database process and files folder
// (engine.ts `storePaths`), the same code on other paths. An action goes to
// the store its payload names (`store`); when it names none, the owner's go
// to the Vault, so an app from before Runner Cloud keeps working, and a
// member's to Runner Cloud. With no store named, a list, a search, a status,
// Ask's chats and a lookup by id answer from every store the caller reaches,
// each row tagged with its store. A ticket goes back to the store that
// signed it. Runner Cloud is made by the first file added to it, or the
// first person let in: until then the runner has none, and nothing starts
// its database.
//
// The Vault is the owner's only (.specs/vault.md rule 2): who the owner lets
// in is kept in Runner Cloud's share table and reaches Runner Cloud only. A
// runner from before kept that list in the Vault's table; `moveVaultShares`
// copies it into Runner Cloud once, then empties the Vault's (a locked
// Vault's at its unlock, with nobody let in again from it).
//
// Encryption at rest (.specs/vault.md "Encryption and the Vault key"): once
// set up, the Vault's database runs in memory from an encrypted dump
// (vault-core's sealedDb.ts) and its files are sealed (objectStore.ts `sealKey`), both
// under the master key VaultKeys holds while unlocked (vaultKeys.ts). While
// locked every Vault action answers VAULT_LOCKED, and so does an owner's read
// with no store named, which would read the Vault too; Runner Cloud named
// alone answers as before.
//
// Runner Cloud is encrypted with the same code under a key the runner holds
// (vault-core's runnerCloudSeal.ts, kept where runnerCloudKey.ts says), so it
// is always open to the runner: no unlock. A
// Runner Cloud from before that is encrypted in place on the first start
// (`sealRunnerCloud`), written beside the plaintext and verified before the
// swap; until it is done Runner Cloud answers RUNNER_CLOUD_SEALING, and if
// it fails the plaintext is served as before and tried again next start.

const IDLE_MS = 10 * 60_000;

/** The Vault key's actions, answered locked or not, owner only. */
const KEY_ACTIONS: ReadonlySet<BoardAgentAction> = new Set<BoardAgentAction>([
  'vaultKeyStatus',
  'vaultKeySetupStart',
  'vaultKeySetup',
  'vaultUnlock',
  'vaultLock',
  'vaultKeySettings',
  'vaultKeyChangeStart',
  'vaultKeyChange',
  'vaultErase'
]);
const KEYS_OWNER_ONLY = 'Only the owner of this runner manages its Vault key.';

const ASK_ACTIONS: ReadonlySet<BoardAgentAction> = new Set<BoardAgentAction>([
  'vaultAskModels',
  'vaultAsk',
  'vaultAskPoll',
  'vaultAskCancel',
  'vaultChats',
  'vaultChat',
  'vaultChatDelete'
]);

const GIB = 1024 ** 3;
const STORES: readonly RunnerStoreName[] = ['vault', 'runner'];
/** Runner chats one list holds (askChats.ts `LISTED`). */
const CHATS_LISTED = 100;
/** What a chat of the other store answers (askChats.ts). */
const NO_CHAT = 'That chat is not on this runner.';
const NO_TURN = 'That answer is gone. Ask again.';

/** Why an upload of `sizeBytes` is refused, or null: one that would leave
 *  the disk under DISK_CRITICAL_GB (machineHealth.ts). The refusal leads with
 *  RUNNER_DISK_FULL, as the store's own check does (service.ts), so the app
 *  knows it (storeErrors.ts) and offers Keep it on Cloud; checkRoom's numbers
 *  follow. */
export function roomRefusal(freeGb: number, sizeBytes: number, name: string): string | null {
  const { refuse } = checkRoom(freeGb, sizeBytes / GIB, name);
  return refuse ? `${RUNNER_DISK_FULL} ${refuse}` : null;
}

/** An upload that would leave the store's disk under DISK_CRITICAL_GB is
 *  refused before a byte is written (roomRefusal). */
function assertRoom(objectsDir: string, payload: unknown): void {
  const file = vaultUploadStartSchema.safeParse(payload);
  // A bad payload is the Vault's own parse to answer.
  if (!file.success) return;
  const refuse = roomRefusal(freeDiskGb(objectsDir), file.data.size, file.data.name);
  if (refuse) throw new Error(refuse);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Newest first, the id breaking a tie: the order `vaultFiles` keeps. */
const newestFirst = (a: RunnerVaultFile, b: RunnerVaultFile) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/** Two stores' search answers as one: word matches first (distance 0), then
 *  meaning, a store's own order kept on a tie (mergeByDistance's rule). */
export function mergeSearches(
  answers: BoardAgentActionMap['vaultSearch']['result'][],
  limit: number
): BoardAgentActionMap['vaultSearch']['result'] {
  const hits: RunnerVaultHit[] = answers
    .flatMap((answer, source) => answer.hits.map((hit, index) => ({ hit, source, index })))
    .sort(
      (a, b) =>
        (a.hit.distance ?? 0) - (b.hit.distance ?? 0) || a.source - b.source || a.index - b.index
    )
    .slice(0, limit)
    .map(({ hit }) => hit);
  const modes = answers.map((answer) => answer.mode);
  let mode: BoardAgentActionMap['vaultSearch']['result']['mode'] = 'names';
  if (modes.includes('words')) mode = 'words';
  else if (modes.includes('meaning')) mode = 'meaning';
  return { hits, mode };
}

/** Two stores' pages as one page, newest first. */
export function mergePages(
  pages: BoardAgentActionMap['vaultFiles']['result'][],
  limit: number
): BoardAgentActionMap['vaultFiles']['result'] {
  const all = pages.flatMap((page) => page.files).sort(newestFirst);
  return {
    files: all.slice(0, limit),
    more: all.length > limit || pages.some((page) => page.more)
  };
}

export type DaemonVault = {
  handle(action: BoardAgentAction, payload: unknown, scope: VouchedScope): Promise<unknown>;
  isMember(userId: string): boolean;
  members(): string[];
  /** Read the share table once at start, where the Vault is added. */
  load(): Promise<void>;
  /** The ingest's counts, for the owner's Remote connections. Null when the
   *  runner has no Vault (unpaired, or the part is not added). */
  ingest(): Promise<RunnerVaultIngest | null>;
  /** Stop both stores' database processes (they start again on the next
   *  call); an unlocked Vault is flushed and locked. */
  close(): Promise<void>;
  /** The Vault's encryption (vaultKeys.ts). */
  keys: VaultKeys;
  /** One run of the scheduled Findings job (findingsJob.ts) over the
   *  owner's viewing data. Never unlocks the Vault: a locked one is
   *  skipped. */
  findings(): Promise<FindingsJobOutcome>;
};

export type DaemonVaultOptions = {
  /** For the tests: the idle lock, in ms. */
  lockIdleMs?: number;
  /** For the tests: a light scrypt (vaultKeys.ts `kdf`). */
  kdf?: { N: number; r: number; p: number };
  /** Where Runner Cloud's key is kept (runnerCloudKey.ts): a 0600 file. */
  runnerKeyStores?: RunnerKeyStore[];
  /** For the tests: where an older runner kept it (the Keychain on a Mac),
   *  read only until it is moved to the file. */
  legacyRunnerKeyStores?: RunnerKeyStore[];
  /** A device pushed viewing data that brought rows (the Findings job's
   *  cue, findingsJob.ts). */
  onEngagementPush?: () => void;
  /** One page of the server's public tag-changes feed (`autoTag.changes`),
   *  downloaded before each Findings run (tagFeed.ts). Asked signed out. */
  fetchTagChanges?: FetchTagChanges;
  /** Registers Ask turns and Categorize runs in the runner's Activity
   *  (activity/registry.ts), as Vault jobs. */
  startJob?: StartJob;
};

/** The store a call with none named goes to: the owner's Vault, a
 *  member's Runner Cloud (the Vault is never shared). */
const homeStore = (scope: VouchedScope): RunnerStoreName => (scope.role === 'owner' ? 'vault' : 'runner');

/** One store as the daemon holds it. */
type Slot = {
  name: RunnerStoreName;
  paths: StorePaths;
  vault: RunnerVault | null;
  asker: VaultAsk | null;
  /** Its database process, for `close`. */
  db: { close(): Promise<void> } | null;
  /** Its files, for dropping sealed uploads on lock. */
  store?: FsObjectStore;
};

export function createDaemonVault(
  runnerDir: string,
  ownerUserId: string | null,
  onMembers: (members: string[]) => void,
  embedder: Embedder,
  engines: AskEngines,
  categorizeEngines: CategorizeEngines,
  options: DaemonVaultOptions = {}
): DaemonVault {
  const paths = vaultPaths(runnerDir);
  // From a runner where the Vault kept who is let in: its cache of that list,
  // read once to move it to Runner Cloud (`moveVaultShares`), then removed.
  const membersCache = path.join(paths.root, 'members.json');
  // Written once that list was let into Runner Cloud. From then on Runner
  // Cloud alone says who is in: what the Vault's table still holds (a locked
  // Vault's, until its unlock) is only emptied, never let in again, or
  // someone the owner removed since would be back.
  const sharesMoved = path.join(paths.root, 'shares-moved');
  /** Who is let into Runner Cloud, as it last said. */
  let known = new Set<string>();
  let installing: Promise<void> | null = null;
  const slots: Record<RunnerStoreName, Slot> = {
    vault: { name: 'vault', paths: storePaths(runnerDir, 'vault'), vault: null, asker: null, db: null },
    runner: { name: 'runner', paths: storePaths(runnerDir, 'runner'), vault: null, asker: null, db: null }
  };

  /** The stores whose database is closing now: `get` opens neither again
   *  until it is closed. */
  const releasing = new Set<RunnerStoreName>();

  /** Let go of a store's database and everything that read it: flushed and
   *  closed (sealed), before a lock drops the Vault's key or a store is
   *  encrypted in place. The slot is emptied before the wait for the last
   *  dump, and the closed database never opens again (db.ts lazyVaultDb), so
   *  a call that arrives meanwhile cannot start a second decrypted copy that
   *  the dropped key would then leave in memory, its writes lost. */
  const releaseSlot = async (name: RunnerStoreName) => {
    const slot = slots[name];
    const { db, store } = slot;
    slot.db = null;
    slot.vault = null;
    slot.asker = null;
    slot.store = undefined;
    releasing.add(name);
    try {
      await db?.close();
      store?.dropUploads();
    } finally {
      releasing.delete(name);
    }
  };
  const releaseVault = () => releaseSlot('vault');

  const COUNTS_SQL =
    'SELECT (SELECT count(*) FROM "Upload")::text AS u, (SELECT count(*) FROM "Post")::text AS p, (SELECT count(*) FROM "SearchVector")::text AS v, (SELECT count(*) FROM "_vault_migrations")::text AS m';

  /** Dump a plaintext database, and check a sealed copy holds what it held
   *  (sealMigration.ts' verify step), for either store. */
  const plainSeal = (dataDir: string) => {
    let plainCounts = '';
    return {
      dumpPlain: async () => {
        if (!fs.existsSync(dataDir)) return null;
        const db = await openVaultDb({ dataDir, engineDir: paths.engine });
        try {
          plainCounts = JSON.stringify(await db.query(COUNTS_SQL));
          return await db.dump();
        } finally {
          await db.close();
        }
      },
      verifyDump: async (plain: Buffer) => {
        const db = await openVaultDb({ dataDir: 'memory://', engineDir: paths.engine, load: plain });
        try {
          const counts = JSON.stringify(await db.query(COUNTS_SQL));
          if (counts !== plainCounts) {
            throw new Error('The encrypted copy does not hold what the store holds. Nothing was changed.');
          }
        } finally {
          await db.close();
        }
      }
    };
  };

  const runnerKeyStores = options.runnerKeyStores ?? defaultRunnerKeyStores(runnerDir);
  const legacyKeyStores = options.legacyRunnerKeyStores ?? (options.runnerKeyStores ? [] : legacyRunnerKeyStores(runnerDir));
  const runnerSeal = new RunnerCloudSeal({
    root: path.dirname(slots.runner.paths.db),
    stores: runnerKeyStores,
    legacy: legacyKeyStores
  });
  runnerSeal.recover();
  // A key an older runner kept in the Keychain moves to the file, once (Jon,
  // 2026-11-11, q22). If it cannot, Runner Cloud still opens from the
  // Keychain and the move is tried again at the next start.
  const keyMove = moveKeychainKeyToFile(runnerSeal, runnerKeyStores, legacyKeyStores);
  if (typeof keyMove === 'object') console.log(`[runner-cloud] Could not move Runner Cloud's key out of the Keychain yet: ${keyMove.failed}`);

  const keys = new VaultKeys({
    root: paths.root,
    idleMs: options.lockIdleMs,
    kdf: options.kdf,
    onLock: releaseVault,
    onUnlock: () => {
      // A list of who is let in still in the Vault moves out, and the files
      // left waiting are read.
      void moveVaultShares()
        .then(() => get('vault').kickIngest())
        .catch((err: unknown) => console.error(`[vault] after unlock: ${message(err)}`));
    },
    seal: { before: releaseVault, ...plainSeal(paths.db) }
  });

  /** The key actions (vaultKeys.ts), the owner's alone. */
  const keyAction = async (action: BoardAgentAction, payload: unknown, scope: VouchedScope) => {
    if (scope.role !== 'owner') throw new Error(KEYS_OWNER_ONLY);
    switch (action) {
      case 'vaultKeyStatus':
        return keys.status();
      case 'vaultKeySetupStart':
      case 'vaultKeySetup': {
        // Refused before a key is shown that could not be used.
        if (!ownerUserId) throw new Error('This runner is not paired.');
        if (!engineInstalled(paths.engine)) throw new Error(RUNNER_NO_VAULT);
        return action === 'vaultKeySetupStart' ? keys.setupStart() : keys.setup(vaultKeyConfirmSchema.parse(payload));
      }
      case 'vaultUnlock':
        return keys.unlock(vaultUnlockSchema.parse(payload));
      case 'vaultLock':
        return keys.lock();
      case 'vaultKeySettings':
        return keys.settings(vaultKeySettingsSchema.parse(payload).lockIdleMinutes);
      case 'vaultKeyChangeStart':
        return keys.changeStart(vaultKeyChangeStartSchema.parse(payload ?? {}));
      case 'vaultKeyChange':
        return keys.change(vaultKeyConfirmSchema.parse(payload));
      // The key is lost: the Vault's data and key go, never Runner Cloud
      // (another folder, its own key), with the word typed.
      case 'vaultErase':
        vaultEraseSchema.parse(payload);
        return keys.erase();
      default:
        throw new Error(`Unknown key action ${action}.`);
    }
  };

  /** Put the router's client into the engine folder, once at a time. */
  const installRouter = () => {
    installing ??= installRouterClient(paths.engine, (line) => console.log(`[vault] ${line}`))
      .catch((err: unknown) => {
        console.error(
          `[vault] The vault's query client did not install: ${err instanceof Error ? err.message : String(err)}`
        );
      })
      .finally(() => {
        installing = null;
      });
  };
  // From a checkout the client is the workspace's generated one.
  const fromSource = __filename.endsWith('.ts');

  /** Runner Cloud is there once a file was first added to it (or someone
   *  let in): its key file, or a plaintext database from before encryption.
   *  The Vault is there with the engine. */
  const exists = (name: RunnerStoreName): boolean =>
    engineInstalled(paths.engine) &&
    (name === 'vault' || runnerSeal.sealed() || fs.existsSync(slots.runner.paths.db));

  /** The stores a read with no `store` answers from: those the caller
   *  reaches (never the Vault for a member). */
  const present = (scope: VouchedScope): RunnerStoreName[] =>
    STORES.filter((name) => exists(name) && (name === 'runner' || scope.role === 'owner'));

  /** Runner Cloud from before encryption, encrypted in place once per
   *  process (a failure leaves the plaintext, served as before). */
  let runnerSealing: Promise<void> | null = null;
  let runnerSealTried = false;
  const sealRunnerCloud = (): Promise<void> => {
    if (runnerSealing) return runnerSealing;
    if (runnerSealTried || !runnerSeal.plain() || !engineInstalled(paths.engine)) return Promise.resolve();
    runnerSealTried = true;
    runnerSealing = (async () => {
      // Nothing reads the plaintext while it is copied.
      await releaseSlot('runner');
      await runnerSeal.seal(plainSeal(slots.runner.paths.db));
    })()
      .catch((err: unknown) => {
        console.error(`[runner-cloud] Runner Cloud stays unencrypted for now: ${message(err)}`);
      })
      .finally(() => {
        runnerSealing = null;
      });
    return runnerSealing;
  };

  const get = (name: RunnerStoreName = 'vault'): RunnerVault => {
    if (!ownerUserId) throw new Error('This runner is not paired.');
    if (!engineInstalled(paths.engine)) {
      // Neutral words, for any app: Oakbox reads them as a runner to set up
      // (isRunnerNoVault).
      throw new Error(RUNNER_NO_VAULT);
    }
    const slot = slots[name];
    // The sealed Vault is not served while locked or being encrypted.
    if (name === 'vault' && keys.busy()) throw new Error(VAULT_SEALING);
    if (name === 'runner' && runnerSealing) throw new Error(RUNNER_CLOUD_SEALING);
    if (name === 'runner' && runnerSeal.plain() && !runnerSealTried) {
      // From before encryption: encrypted first (load() does it at start).
      void sealRunnerCloud();
      throw new Error(RUNNER_CLOUD_SEALING);
    }
    // Closing now (a lock's last dump): not opened again beside it.
    if (releasing.has(name)) throw new Error(name === 'vault' ? VAULT_LOCKED : RUNNER_CLOUD_SEALING);
    // A new Runner Cloud is sealed from its first write.
    if (name === 'runner' && !runnerSeal.plain()) runnerSeal.create();
    const seal = name === 'vault' ? keys.sealed() : runnerSeal.sealed();
    const sealKey = name === 'vault' ? () => keys.key() : () => runnerSeal.key();
    if (seal) sealKey();
    // A call that reaches the Vault is its activity, for the idle lock (its
    // database calls are too, sealedDb's onActivity); Runner Cloud's calls,
    // and so every member's, never keep it unlocked.
    if (name === 'vault') keys.touch();
    if (!slot.vault) {
      const db = lazyVaultDb(
        seal
          ? () =>
              openSealedVaultDb({
                // vault-core's sealed database runs on this runner's PGlite child.
                open: (load) => openVaultDb({ dataDir: 'memory://', engineDir: paths.engine, load }),
                dumpPath: sealPaths(path.dirname(slot.paths.db)).dump,
                key: sealKey,
                ...(name === 'vault' ? { onActivity: () => keys.touch() } : { what: 'Runner Cloud' })
              })
          : () => openVaultDb({ dataDir: slot.paths.db, engineDir: paths.engine }),
        IDLE_MS,
        // A call still holding the store after it was let go (an Ask turn,
        // the ingest) is answered in the app's words.
        name === 'vault' ? () => new Error(keys.busy() ? VAULT_SEALING : VAULT_LOCKED) : undefined
      );
      slot.db = db;
      const store = new FsObjectStore(
        slot.paths.objects,
        Date.now,
        name === 'runner' ? RUNNER_STORAGE_TICKET_SCHEME : undefined,
        seal ? sealKey : undefined
      );
      slot.store = store;
      let router: RunnerVaultRouter | null = null;
      slot.vault = new RunnerVault(
        db,
        store,
        ownerUserId,
        (members) => {
          // Only Runner Cloud lets anyone in.
          if (name !== 'runner') return;
          known = new Set(members);
          onMembers(members);
        },
        new VaultIngest(db, store, embedder),
        embedder,
        new VaultCategorize(db, categorizeEngines, Date.now, options.startJob),
        () => {
          if (!fromSource && !routerClientInstalled(paths.engine)) {
            installRouter();
            throw new Error(VAULT_ROUTER_UPDATING);
          }
          router ??= new RunnerVaultRouter(db, store, embedder, () =>
            loadVaultClient(paths.engine)
          );
          return router;
        },
        // Who is let in is Runner Cloud's own to keep; the Vault lets
        // nobody in. A save is refused when the disk has no room for it, and
        // a recording's save shows in Activity.
        {
          storeName: name,
          freeBytes: () => diskFreeBytes(slot.paths.objects),
          startJob: options.startJob
        }
      );
    }
    return slot.vault;
  };

  /** A store an action named. Runner Cloud before its first file is
   *  refused in plain words, not made by a read; the Vault, to anyone but
   *  the owner, is refused as never shared. */
  const named = (name: RunnerStoreName, scope?: VouchedScope): RunnerVault => {
    if (name === 'vault' && scope && scope.role !== 'owner' && ownerUserId && engineInstalled(paths.engine)) {
      throw new Error(VAULT_NEVER_SHARED);
    }
    if (name === 'runner' && engineInstalled(paths.engine) && !exists('runner')) {
      throw new Error(NO_RUNNER_STORAGE);
    }
    return get(name);
  };

  const asker = (name: RunnerStoreName): VaultAsk => {
    const slot = slots[name];
    // Ask on the Vault (a poll of its turn too) reaches it, as `get` does.
    if (name === 'vault') keys.touch();
    slot.asker ??= new VaultAsk(
      name === 'vault' ? get('vault') : named('runner'),
      engines,
      Date.now,
      undefined,
      options.startJob
    );
    return slot.asker;
  };

  /** The one store a read with no `store` answers from, when there are not
   *  two: the one there is, else the Vault's own answer (RUNNER_NO_VAULT, or
   *  the owner's empty Vault), and to a member with no Runner Cloud to
   *  reach, the refusal. */
  const sole = (stores: RunnerStoreName[], scope: VouchedScope): RunnerVault => {
    if (stores.length === 1) return get(stores[0]);
    if (scope.role === 'owner' || !ownerUserId || !engineInstalled(paths.engine)) return get('vault');
    throw new Error(VAULT_REFUSAL);
  };

  /** Ask a lookup by id of each store in turn, until one has it. */
  const firstWith = async (
    action: BoardAgentAction,
    payload: unknown,
    scope: VouchedScope,
    missing: string
  ): Promise<unknown> => {
    const stores = present(scope);
    for (const [i, name] of stores.entries()) {
      try {
        return await get(name).handle(action, payload, scope);
      } catch (err) {
        if (message(err) !== missing || i === stores.length - 1) throw err;
      }
    }
    // No store at all: the Vault's own answer (RUNNER_NO_VAULT).
    return sole(stores, scope).handle(action, payload, scope);
  };

  const files = async (payload: unknown, scope: VouchedScope) => {
    const stores = present(scope);
    if (stores.length < 2) return sole(stores, scope).handle('vaultFiles', payload, scope);
    const input = vaultFilesSchema.parse(payload ?? {});
    // A page goes on from a row of one store: each store starts after its
    // time and id.
    let cursor = null;
    if (input.before) {
      for (const name of stores) cursor ??= await get(name).cursorOf(input.before);
      if (!cursor) return { files: [], more: false };
    }
    const { query, limit, factiiiId } = input;
    const pages = await Promise.all(
      stores.map((name) => get(name).listFor(scope, { query, limit, factiiiId }, cursor))
    );
    return mergePages(pages, input.limit ?? 50);
  };

  const search = async (payload: unknown, scope: VouchedScope) => {
    const stores = present(scope);
    if (stores.length < 2) return sole(stores, scope).handle('vaultSearch', payload, scope);
    const input = vaultSearchSchema.parse(payload);
    const answers = (await Promise.all(
      stores.map((name) => get(name).handle('vaultSearch', payload, scope))
    )) as BoardAgentActionMap['vaultSearch']['result'][];
    return mergeSearches(answers, input.limit ?? 50);
  };

  /** The Vault's status, with Runner Cloud's counts beside it, and who is
   *  let into Runner Cloud (`members`, the owner's to see). A member sees
   *  Runner Cloud's alone. */
  const status = async (scope: VouchedScope): Promise<RunnerVaultStatus> => {
    if (scope.role !== 'owner') return (await sole(present(scope), scope).handle('vaultStatus', {}, scope)) as RunnerVaultStatus;
    const vault = (await get('vault').handle('vaultStatus', {}, scope)) as RunnerVaultStatus;
    if (!exists('runner')) return { ...vault, members: [], runnerStorage: null };
    const runner = (await get('runner').handle('vaultStatus', {}, scope)) as RunnerVaultStatus;
    return { ...vault, members: runner.members, runnerStorage: { files: runner.files, bytes: runner.bytes } };
  };

  /**
   * Who is let in, out of the Vault (.specs/vault.md rule 2): a runner from
   * before kept the list in the Vault's share table, and cached it in
   * `parts/vault/members.json`. Both are copied into Runner Cloud's table
   * (made for it if need be) before either is removed, so an interrupted
   * move only runs again. The Vault's table is read and emptied only while
   * it is open; a locked Vault's waits for its unlock. Once the list moved
   * (`sharesMoved`), an unlock only empties the Vault's table: the cache
   * moved at start held the same ids, and the owner may have removed some
   * of them from Runner Cloud since.
   */
  const moveVaultShares = async (): Promise<void> => {
    if (!ownerUserId || !engineInstalled(paths.engine)) return;
    const vaultOpen = !keys.busy() && (!keys.sealed() || keys.state() === 'unlocked');
    const fromVault = vaultOpen ? await get('vault').shareRows() : [];
    const moved = fs.existsSync(sharesMoved);
    const ids = moved ? [] : [...new Set([...fromVault, ...readMembersCache(membersCache)])];
    if (ids.length > 0) {
      await get('runner').letIn(ids);
      fs.writeFileSync(sharesMoved, `${new Date().toISOString()}\n`);
      console.log(`[vault] ${ids.length} people let in moved from the Vault to Runner Cloud: the Vault is the owner's only.`);
    }
    if (fromVault.length > 0) await get('vault').clearShares();
    fs.rmSync(membersCache, { force: true });
  };

  /** Who is let into Runner Cloud, from its table, for links and the
   *  server. */
  const readMembers = async (): Promise<void> => {
    known = exists('runner') ? await get('runner').memberIds() : new Set();
    onMembers([...known]);
  };

  /** The store a follow-up's chat is kept in. */
  const chatStore = async (chatId: string, scope: VouchedScope): Promise<RunnerStoreName> => {
    for (const name of present(scope)) {
      try {
        await asker(name).handle('vaultChat', { chatId }, scope);
        return name;
      } catch (err) {
        if (message(err) !== NO_CHAT) throw err;
      }
    }
    throw new Error(NO_CHAT);
  };

  const ask = async (
    action: BoardAgentAction,
    payload: unknown,
    asked: RunnerStoreName | null,
    scope: VouchedScope
  ): Promise<unknown> => {
    // A member who names the Vault is refused before anything else.
    if (asked === 'vault') named('vault', scope);
    switch (action) {
      case 'vaultAskModels': {
        const models = (await asker(homeStore(scope)).handle(action, payload, scope)) as RunnerAskModels;
        return { ...models, runnerStorage: exists('runner') } satisfies RunnerAskModels;
      }
      case 'vaultAsk': {
        const { chatId } = vaultAskSchema.parse(payload);
        const target = asked ?? (chatId ? await chatStore(chatId, scope) : homeStore(scope));
        return asker(target).handle(action, payload, scope);
      }
      case 'vaultAskPoll':
      case 'vaultAskCancel': {
        const { askId } = vaultAskPollSchema.parse(payload);
        const holder = STORES.find((name) => slots[name].asker?.has(askId));
        if (!holder) throw new Error(NO_TURN);
        return asker(holder).handle(action, payload, scope);
      }
      case 'vaultChats': {
        const lists = await Promise.all(
          present(scope).map(async (name) => {
            const { chats } = (await asker(name).handle(action, payload, scope)) as {
              chats: RunnerAskChat[];
            };
            return chats.map((chat) => ({ ...chat, store: name }));
          })
        );
        const chats = lists
          .flat()
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
          .slice(0, CHATS_LISTED);
        return { chats } satisfies BoardAgentActionMap['vaultChats']['result'];
      }
      case 'vaultChat':
      case 'vaultChatDelete': {
        const name = asked ?? (await chatStore(vaultChatId(payload), scope));
        const answer = await asker(name).handle(action, payload, scope);
        if (action === 'vaultChatDelete') return answer;
        const { chat, messages } = answer as BoardAgentActionMap['vaultChat']['result'];
        return { chat: { ...chat, store: name }, messages };
      }
      default:
        return asker(asked ?? homeStore(scope)).handle(action, payload, scope);
    }
  };

  /**
   * Move to… (.specs/runner-vault.md "Two stores"): each of the owner's files
   * copied into the other store a range at a time, through the same actions
   * an app uses, then deleted where it was. Explicit, never automatic, and
   * the owner's alone, and only the owner's own files: a member's in Runner
   * Cloud is refused before it is copied (its delete is its adder's). A file
   * that fails stays where it was, and a copy whose original was not
   * deleted is taken back, so the file is never in both stores.
   */
  const move = async (payload: unknown, scope: VouchedScope) => {
    if (scope.role !== 'owner') throw new Error('Only the owner of this runner moves its files.');
    const { uploadIds, to } = vaultMoveSchema.parse(payload);
    const from: RunnerStoreName = to === 'vault' ? 'runner' : 'vault';
    const source = named(from);
    const target = get(to);
    const result: BoardAgentActionMap['vaultMove']['result'] = { moved: [], failed: [] };
    for (const uploadId of uploadIds) {
      try {
        const adder = await source.uploaderOf(uploadId);
        if (adder !== null && adder !== ownerUserId) throw new Error(MOVE_NOT_YOURS);
        const head = (await source.handle('vaultDownload', { uploadId }, scope)) as BoardAgentActionMap['vaultDownload']['result'];
        const bytes: Buffer[] = [];
        for (let offset = 0; offset < head.size; offset += RUNNER_VAULT_READ_CHUNK_BYTES) {
          const length = Math.min(RUNNER_VAULT_READ_CHUNK_BYTES, head.size - offset);
          const { content } = (await source.handle(
            'vaultRead',
            { ticket: head.ticket, offset, length },
            scope
          )) as BoardAgentActionMap['vaultRead']['result'];
          bytes.push(Buffer.from(content, 'base64'));
        }
        const whole = Buffer.concat(bytes);
        const { ticket } = (await target.handle(
          'vaultUploadStart',
          { name: head.name, size: whole.length, contentType: head.contentType },
          scope
        )) as BoardAgentActionMap['vaultUploadStart']['result'];
        let file: RunnerVaultFile | null = null;
        for (let offset = 0; offset === 0 || offset < whole.length; offset += RUNNER_VAULT_WRITE_CHUNK_BYTES) {
          const end = Math.min(whole.length, offset + RUNNER_VAULT_WRITE_CHUNK_BYTES);
          ({ file } = (await target.handle(
            'vaultWrite',
            {
              ticket,
              offset,
              content: whole.subarray(offset, end).toString('base64'),
              last: end === whole.length
            },
            scope
          )) as BoardAgentActionMap['vaultWrite']['result']);
          if (end === whole.length) break;
        }
        if (!file) throw new Error('The copy did not land.');
        const { deleted } = (await source.handle('vaultDelete', { uploadIds: [uploadId] }, scope)) as BoardAgentActionMap['vaultDelete']['result'];
        if (deleted !== 1) {
          const copy = file.id;
          await target.handle('vaultDelete', { uploadIds: [copy] }, scope).catch(() => undefined);
          throw new Error('The original could not be removed, so it stays where it was.');
        }
        result.moved.push({ from: uploadId, file });
      } catch (err) {
        result.failed.push({ uploadId, error: message(err) });
      }
    }
    return result;
  };

  /** The notes of both stores, newest first; one by id from whichever has
   *  it. */
  const notes = async (payload: unknown, scope: VouchedScope) => {
    const lists = await Promise.all(
      present(scope).map(
        async (name) =>
          ((await get(name).handle('vaultNotes', payload, scope)) as { notes: RunnerVaultNote[] })
            .notes
      )
    );
    return { notes: lists.flat().sort((a, b) => b.at.localeCompare(a.at)) };
  };

  return {
    handle: async (action, payload, scope) => {
      // Oakbox asks every runner it reaches. One with no Vault answers that
      // it has none, so the app leaves it out without a note; to someone it
      // never let in it is still the refusal.
      if (action === 'vaultSearch' && ownerUserId && !engineInstalled(paths.engine)) {
        if (!vaultRole(scope, known)) throw new Error(VAULT_REFUSAL);
        return { hits: [], mode: 'absent' } satisfies BoardAgentActionMap['vaultSearch']['result'];
      }
      if (KEY_ACTIONS.has(action)) return keyAction(action, payload, scope);
      const asked = payloadStore(payload);
      // The idle lock counts only the calls that reach the Vault (`get`).
      if (ASK_ACTIONS.has(action)) return ask(action, payload, asked, scope);
      switch (action) {
        // A ticket goes back to the store that signed it.
        case 'vaultWrite':
        case 'vaultRead':
          return get(ticketStore(vaultWriteTicket(payload))).handle(action, payload, scope);
        // Who is let in is runner-wide, kept in Runner Cloud (made for it if
        // need be); the Vault is never shared. The answer is the whole
        // status, as a status read gives it.
        case 'vaultShareSet': {
          // A member is refused by Runner Cloud itself (owner only), and
          // never makes it.
          if (scope.role !== 'owner') return named('runner', scope).handle(action, payload, scope);
          const runner = (await get('runner').handle(action, payload, scope)) as RunnerVaultStatus;
          // A locked Vault (or one being encrypted) does not read its own
          // counts, but the person is let in or out all the same: the answer
          // is then Runner Cloud's, and the app keeps the Vault's counts it
          // has (useRunnerVaultPart).
          return status(scope).catch((err: unknown) => {
            if (!isVaultLocked(message(err)) && message(err) !== VAULT_SEALING) throw err;
            return {
              ...runner,
              runnerStorage: { files: runner.files, bytes: runner.bytes }
            } satisfies RunnerVaultStatus;
          });
        }
        case 'vaultUploadStart': {
          const target = asked ?? homeStore(scope);
          // Only to someone let in: anyone else gets the store's own refusal.
          if (vaultRole(scope, known, target)) assertRoom(slots[target].paths.objects, payload);
          // The owner's first file added to Runner Cloud makes it; a
          // member's never does.
          const store = scope.role === 'owner' ? get(target) : named(target, scope);
          return store.handle(action, payload, scope);
        }
        case 'vaultFiles':
          if (asked === 'runner' && !exists('runner')) return { files: [], more: false };
          return asked ? named(asked, scope).handle(action, payload, scope) : files(payload, scope);
        case 'vaultSearch':
          if (asked === 'runner' && !exists('runner')) return { hits: [], mode: 'absent' };
          return asked ? named(asked, scope).handle(action, payload, scope) : search(payload, scope);
        case 'vaultStatus':
          return asked ? named(asked, scope).handle(action, payload, scope) : status(scope);
        case 'vaultDownload':
        case 'vaultFilePost':
          return asked
            ? named(asked, scope).handle(action, payload, scope)
            : firstWith(action, payload, scope, NOT_HERE);
        case 'vaultDelete': {
          if (asked) return named(asked, scope).handle(action, payload, scope);
          // Each store deletes what it holds of the ids.
          let deleted = 0;
          let kept = 0;
          for (const name of present(scope)) {
            const one = (await get(name).handle(action, payload, scope)) as {
              deleted: number;
              kept: number;
            };
            deleted += one.deleted;
            kept += one.kept;
          }
          return { deleted, kept } satisfies BoardAgentActionMap['vaultDelete']['result'];
        }
        case 'vaultNotes':
          return asked ? named(asked, scope).handle(action, payload, scope) : notes(payload, scope);
        case 'vaultNoteDelete': {
          if (asked) return named(asked, scope).handle(action, payload, scope);
          let deleted = false;
          for (const name of present(scope)) {
            const one = (await get(name).handle(action, payload, scope)) as { deleted: boolean };
            deleted ||= one.deleted;
          }
          return { deleted } satisfies BoardAgentActionMap['vaultNoteDelete']['result'];
        }
        case 'vaultMove':
          return move(payload, scope);
        // Viewing data lives in the Vault only, whatever the payload names:
        // Claude and Codex read Runner Cloud, and never this.
        case 'engagementPush': {
          const pushed = (await get('vault').handle(action, payload, scope)) as BoardAgentActionMap['engagementPush']['result'];
          if (pushed.accepted > 0) options.onEngagementPush?.();
          return pushed;
        }
        case 'engagementQuery':
          return get('vault').handle(action, payload, scope);
        // vaultRpc, Categorize: the store named, else the caller's own.
        default:
          return named(asked ?? homeStore(scope), scope).handle(action, payload, scope);
      }
    },
    isMember: (userId) => known.has(userId),
    members: () => [...known],
    load: async () => {
      if (!ownerUserId || !engineInstalled(paths.engine)) return;
      if (!fromSource && !routerClientInstalled(paths.engine)) installRouter();
      // A Runner Cloud from before encryption is encrypted first.
      await sealRunnerCloud();
      // Who is let in, out of the Vault if it still holds it, then from
      // Runner Cloud. A failed move leaves both as they were.
      await moveVaultShares().catch((err: unknown) =>
        console.error(`[vault] could not move who is let in to Runner Cloud: ${message(err)}`)
      );
      await readMembers();
      // Files left PENDING when the runner last stopped, in either store; a
      // locked Vault's wait for its unlock.
      if (exists('runner')) get('runner').kickIngest();
      if (keys.state() !== 'locked') get('vault').kickIngest();
    },
    ingest: async () => {
      if (!ownerUserId || !engineInstalled(paths.engine)) return null;
      if (keys.sealed() && keys.state() !== 'unlocked') return null;
      return get('vault').ingestCounts();
    },
    close: async () => {
      await keys.lock().catch((err: unknown) => console.error(`[vault] lock at close: ${message(err)}`));
      // Each slot emptied, so the next call starts its store afresh.
      await Promise.all(STORES.map(releaseSlot));
    },
    keys,
    findings: async () => {
      if (!ownerUserId || !engineInstalled(paths.engine)) return { state: 'absent' };
      if (keys.sealed() && keys.state() !== 'unlocked') return { state: 'locked' };
      if (keys.busy()) return { state: 'locked' };
      const store = get('vault');
      // Tags placed or taken off since the last run attach to the history
      // first. The server out of reach is not a failed run: the Findings use
      // what is held.
      if (options.fetchTagChanges) {
        await store
          .syncTagFeed(options.fetchTagChanges)
          .catch((err: unknown) => console.error(`[vault] tag feed: ${message(err)}`));
      }
      // The owner's own dimensions, with this machine's Ollama only.
      await store
        .runPrivateTags({
          models: async () => (await categorizeEngines.models()).ollama.map((m) => m.id),
          ask: (model, system, prompt, signal) => categorizeEngines.ask('ollama', model, system, prompt, signal)
        })
        .catch((err: unknown) => console.error(`[vault] private tags: ${message(err)}`));
      return store.runFindings();
    }
  };
}

/** Who was let in, as a Vault from before rule 2 cached it: ids only. */
function readMembersCache(file: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** A write's or read's ticket, for its store; a bad payload is the store's
 *  own parse to answer. */
function vaultWriteTicket(payload: unknown): string {
  const ticket = vaultWriteSchema.pick({ ticket: true }).safeParse(payload);
  return ticket.success ? ticket.data.ticket : '';
}

/** A chat action's id; a bad payload is the store's own parse to answer. */
function vaultChatId(payload: unknown): string {
  const chat = vaultChatSchema.safeParse(payload);
  return chat.success ? chat.data.chatId : '';
}
