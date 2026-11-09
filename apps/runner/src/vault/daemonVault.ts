import fs from 'node:fs';

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
import {
  payloadStore,
  vaultAskPollSchema,
  vaultAskSchema,
  vaultChatSchema,
  vaultFilesSchema,
  vaultMoveSchema,
  RUNNER_VAULT_READ_CHUNK_BYTES,
  RUNNER_VAULT_WRITE_CHUNK_BYTES,
  vaultSearchSchema,
  vaultUploadStartSchema,
  vaultWriteSchema
} from '@shared/all/validators';

import { freeDiskGb } from '../localAiModel';
import { checkRoom } from '../machineHealth';

import { NO_RUNNER_STORAGE, VAULT_REFUSAL, vaultRole } from './access';
import { type AskEngines, VaultAsk } from './ask';
import { type CategorizeEngines, VaultCategorize } from './categorize';
import { lazyVaultDb, openVaultDb } from './db';
import type { Embedder } from './embedder';
import {
  engineInstalled,
  installRouterClient,
  routerClientInstalled,
  type StorePaths,
  storePaths,
  vaultPaths
} from './engine';
import { VaultIngest } from './ingest';
import { FsObjectStore, RUNNER_STORAGE_TICKET_SCHEME, ticketStore } from './objectStore';
import { NOT_HERE, RunnerVault, VAULT_ROUTER_UPDATING } from './service';
import { loadVaultClient, RunnerVaultRouter } from './vaultRouter';

// The Vault as the daemon holds it: one per runner, its database started on
// the first call and stopped after IDLE_MS. `isMember` answers at once from
// the last read of the share table, because the daemon asks it while a link
// is being opened. Its embedder is the daemon's.
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
// AI only, and Runner Storage, which Claude and Codex may read. Each is its
// own RunnerVault on its own database process and files folder
// (engine.ts `storePaths`), the same code on other paths. An action goes to
// the store its payload names (`store`), the Vault when it names none, so an
// app from before Runner Storage keeps working. With no store named, a list,
// a search, a status, Ask's chats and a lookup by id answer from both, each
// row tagged with its store. A ticket goes back to the store that signed it.
// Runner Storage is made by the first file added to it: until then the
// runner has none, and nothing starts its database.

const IDLE_MS = 10 * 60_000;

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

/** An upload that would leave the store's disk under DISK_CRITICAL_GB is
 *  refused before a byte is written (machineHealth.ts). */
function assertRoom(objectsDir: string, payload: unknown): void {
  const file = vaultUploadStartSchema.safeParse(payload);
  // A bad payload is the Vault's own parse to answer.
  if (!file.success) return;
  const { refuse } = checkRoom(freeDiskGb(objectsDir), file.data.size / GIB, file.data.name);
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
   *  call). */
  close(): Promise<void>;
};

/** One store as the daemon holds it. */
type Slot = {
  name: RunnerStoreName;
  paths: StorePaths;
  vault: RunnerVault | null;
  asker: VaultAsk | null;
  /** Its database process, for `close`. */
  db: { close(): Promise<void> } | null;
};

export function createDaemonVault(
  runnerDir: string,
  ownerUserId: string | null,
  onMembers: (members: string[]) => void,
  embedder: Embedder,
  engines: AskEngines,
  categorizeEngines: CategorizeEngines
): DaemonVault {
  const paths = vaultPaths(runnerDir);
  let known = new Set<string>();
  let installing: Promise<void> | null = null;
  const slots: Record<RunnerStoreName, Slot> = {
    vault: { name: 'vault', paths: storePaths(runnerDir, 'vault'), vault: null, asker: null, db: null },
    runner: { name: 'runner', paths: storePaths(runnerDir, 'runner'), vault: null, asker: null, db: null }
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

  /** Runner Storage is there once a file was first added to it. The Vault
   *  is there with the engine. */
  const exists = (name: RunnerStoreName): boolean =>
    engineInstalled(paths.engine) && (name === 'vault' || fs.existsSync(slots.runner.paths.db));

  /** The stores a read with no `store` answers from. */
  const present = (): RunnerStoreName[] => STORES.filter(exists);

  const get = (name: RunnerStoreName = 'vault'): RunnerVault => {
    if (!ownerUserId) throw new Error('This runner is not paired.');
    if (!engineInstalled(paths.engine)) {
      // Neutral words, for any app: Oakbox reads them as a runner to set up
      // (isRunnerNoVault).
      throw new Error(RUNNER_NO_VAULT);
    }
    const slot = slots[name];
    if (!slot.vault) {
      const db = lazyVaultDb(
        () => openVaultDb({ dataDir: slot.paths.db, engineDir: paths.engine }),
        IDLE_MS
      );
      slot.db = db;
      const store = new FsObjectStore(
        slot.paths.objects,
        Date.now,
        name === 'runner' ? RUNNER_STORAGE_TICKET_SCHEME : undefined
      );
      let router: RunnerVaultRouter | null = null;
      slot.vault = new RunnerVault(
        db,
        store,
        ownerUserId,
        (members) => {
          known = new Set(members);
          onMembers(members);
        },
        new VaultIngest(db, store, embedder),
        embedder,
        new VaultCategorize(db, categorizeEngines),
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
        // Who is let in is the Vault's to keep; Runner Storage reads it.
        name === 'runner'
          ? { storeName: 'runner', members: () => get('vault').memberIds() }
          : { storeName: 'vault' }
      );
    }
    return slot.vault;
  };

  /** A store an action named. Runner Storage before its first file is
   *  refused in plain words, not made by a read. */
  const named = (name: RunnerStoreName): RunnerVault => {
    if (name === 'runner' && engineInstalled(paths.engine) && !exists('runner')) {
      throw new Error(NO_RUNNER_STORAGE);
    }
    return get(name);
  };

  const asker = (name: RunnerStoreName): VaultAsk => {
    const slot = slots[name];
    slot.asker ??= new VaultAsk(name === 'vault' ? get('vault') : named('runner'), engines);
    return slot.asker;
  };

  /** Ask a lookup by id of each store in turn, until one has it. */
  const firstWith = async (
    action: BoardAgentAction,
    payload: unknown,
    scope: VouchedScope,
    missing: string
  ): Promise<unknown> => {
    const stores = present();
    for (const [i, name] of stores.entries()) {
      try {
        return await get(name).handle(action, payload, scope);
      } catch (err) {
        if (message(err) !== missing || i === stores.length - 1) throw err;
      }
    }
    // No store at all: the Vault's own answer (RUNNER_NO_VAULT).
    return get('vault').handle(action, payload, scope);
  };

  const files = async (payload: unknown, scope: VouchedScope) => {
    const stores = present();
    if (stores.length < 2) return get('vault').handle('vaultFiles', payload, scope);
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
    const stores = present();
    if (stores.length < 2) return get('vault').handle('vaultSearch', payload, scope);
    const input = vaultSearchSchema.parse(payload);
    const answers = (await Promise.all(
      stores.map((name) => get(name).handle('vaultSearch', payload, scope))
    )) as BoardAgentActionMap['vaultSearch']['result'][];
    return mergeSearches(answers, input.limit ?? 50);
  };

  /** The Vault's status, with Runner Storage's counts beside it. */
  const status = async (scope: VouchedScope): Promise<RunnerVaultStatus> => {
    const vault = (await get('vault').handle('vaultStatus', {}, scope)) as RunnerVaultStatus;
    if (!exists('runner')) return { ...vault, runnerStorage: null };
    const runner = (await get('runner').handle('vaultStatus', {}, scope)) as RunnerVaultStatus;
    return { ...vault, runnerStorage: { files: runner.files, bytes: runner.bytes } };
  };

  /** The store a follow-up's chat is kept in. */
  const chatStore = async (chatId: string, scope: VouchedScope): Promise<RunnerStoreName> => {
    for (const name of present()) {
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
    switch (action) {
      case 'vaultAskModels': {
        const models = (await asker('vault').handle(action, payload, scope)) as RunnerAskModels;
        return { ...models, runnerStorage: exists('runner') } satisfies RunnerAskModels;
      }
      case 'vaultAsk': {
        const { chatId } = vaultAskSchema.parse(payload);
        const target = asked ?? (chatId ? await chatStore(chatId, scope) : 'vault');
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
          present().map(async (name) => {
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
        return asker(asked ?? 'vault').handle(action, payload, scope);
    }
  };

  /**
   * Move to… (.specs/runner-vault.md "Two stores"): each of the owner's files
   * copied into the other store a range at a time, through the same actions
   * an app uses, then deleted where it was. Explicit, never automatic, and
   * the owner's alone. A file that fails stays where it was.
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
        await source.handle('vaultDelete', { uploadIds: [uploadId] }, scope);
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
      present().map(
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
      const asked = payloadStore(payload);
      if (ASK_ACTIONS.has(action)) return ask(action, payload, asked, scope);
      switch (action) {
        // A ticket goes back to the store that signed it.
        case 'vaultWrite':
        case 'vaultRead':
          return get(ticketStore(vaultWriteTicket(payload))).handle(action, payload, scope);
        // Who is let in is runner-wide, kept in the Vault.
        case 'vaultShareSet':
          return get('vault').handle(action, payload, scope);
        case 'vaultUploadStart': {
          const target = asked ?? 'vault';
          // Only to someone let in: anyone else gets the Vault's own refusal.
          if (vaultRole(scope, known)) assertRoom(slots[target].paths.objects, payload);
          // The first file added to Runner Storage makes it.
          return get(target).handle(action, payload, scope);
        }
        case 'vaultFiles':
          if (asked === 'runner' && !exists('runner')) return { files: [], more: false };
          return asked ? get(asked).handle(action, payload, scope) : files(payload, scope);
        case 'vaultSearch':
          if (asked === 'runner' && !exists('runner')) return { hits: [], mode: 'absent' };
          return asked ? get(asked).handle(action, payload, scope) : search(payload, scope);
        case 'vaultStatus':
          return asked ? named(asked).handle(action, payload, scope) : status(scope);
        case 'vaultDownload':
        case 'vaultFilePost':
          return asked
            ? named(asked).handle(action, payload, scope)
            : firstWith(action, payload, scope, NOT_HERE);
        case 'vaultDelete': {
          if (asked) return named(asked).handle(action, payload, scope);
          // Each store deletes what it holds of the ids.
          let deleted = 0;
          let kept = 0;
          for (const name of present()) {
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
          return asked ? named(asked).handle(action, payload, scope) : notes(payload, scope);
        case 'vaultNoteDelete': {
          if (asked) return named(asked).handle(action, payload, scope);
          let deleted = false;
          for (const name of present()) {
            const one = (await get(name).handle(action, payload, scope)) as { deleted: boolean };
            deleted ||= one.deleted;
          }
          return { deleted } satisfies BoardAgentActionMap['vaultNoteDelete']['result'];
        }
        case 'vaultMove':
          return move(payload, scope);
        // vaultRpc, Categorize: the store named, else the Vault.
        default:
          return named(asked ?? 'vault').handle(action, payload, scope);
      }
    },
    isMember: (userId) => known.has(userId),
    members: () => [...known],
    load: async () => {
      if (!ownerUserId || !engineInstalled(paths.engine)) return;
      if (!fromSource && !routerClientInstalled(paths.engine)) installRouter();
      known = await get('vault').memberIds();
      onMembers([...known]);
      // Files left PENDING when the runner last stopped, in either store.
      for (const name of present()) get(name).kickIngest();
    },
    ingest: async () => {
      if (!ownerUserId || !engineInstalled(paths.engine)) return null;
      return get('vault').ingestCounts();
    },
    close: async () => {
      await Promise.all(STORES.map((name) => slots[name].db?.close()));
    }
  };
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
