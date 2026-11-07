import type {
  BoardAgentAction,
  BoardAgentActionMap,
  RunnerVaultIngest
} from '@shared/all/domains/electron';
import type { VouchedScope } from '@shared/all/helpers/board-agent-core/runner-access';
import { RUNNER_NO_VAULT } from '@shared/all/helpers/oakboxRunnerSetup';
import { vaultUploadStartSchema } from '@shared/all/validators';

import { freeDiskGb } from '../localAiModel';
import { checkRoom } from '../machineHealth';

import { VAULT_REFUSAL, vaultRole } from './access';
import { type AskEngines, VaultAsk } from './ask';
import { type CategorizeEngines, VaultCategorize } from './categorize';
import { lazyVaultDb, openVaultDb } from './db';
import type { Embedder } from './embedder';
import {
  engineInstalled,
  installRouterClient,
  routerClientInstalled,
  vaultPaths
} from './engine';
import { VaultIngest } from './ingest';
import { FsObjectStore } from './objectStore';
import { RunnerVault, VAULT_ROUTER_UPDATING } from './service';
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

/** An upload that would leave the vault's disk under DISK_CRITICAL_GB is
 *  refused before a byte is written (machineHealth.ts). */
function assertRoom(objectsDir: string, payload: unknown): void {
  const file = vaultUploadStartSchema.safeParse(payload);
  // A bad payload is the Vault's own parse to answer.
  if (!file.success) return;
  const { refuse } = checkRoom(freeDiskGb(objectsDir), file.data.size / GIB, file.data.name);
  if (refuse) throw new Error(refuse);
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
  let vault: RunnerVault | null = null;
  let asker: VaultAsk | null = null;
  let installing: Promise<void> | null = null;

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

  const get = (): RunnerVault => {
    if (!ownerUserId) throw new Error('This runner is not paired.');
    if (!engineInstalled(paths.engine)) {
      // Neutral words, for any app: Oakbox reads them as a runner to set up
      // (isRunnerNoVault).
      throw new Error(RUNNER_NO_VAULT);
    }
    if (!vault) {
      const db = lazyVaultDb(
        () => openVaultDb({ dataDir: paths.db, engineDir: paths.engine }),
        IDLE_MS
      );
      const store = new FsObjectStore(paths.objects);
      let router: RunnerVaultRouter | null = null;
      vault = new RunnerVault(
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
        }
      );
    }
    return vault;
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
      if (ASK_ACTIONS.has(action)) {
        asker ??= new VaultAsk(get(), engines);
        return asker.handle(action, payload, scope);
      }
      // Only to someone let in: anyone else gets the Vault's own refusal.
      if (action === 'vaultUploadStart' && vaultRole(scope, known)) {
        assertRoom(paths.objects, payload);
      }
      return get().handle(action, payload, scope);
    },
    isMember: (userId) => known.has(userId),
    members: () => [...known],
    load: async () => {
      if (!ownerUserId || !engineInstalled(paths.engine)) return;
      if (!fromSource && !routerClientInstalled(paths.engine)) installRouter();
      known = await get().memberIds();
      onMembers([...known]);
      // Files left PENDING when the runner last stopped.
      get().kickIngest();
    },
    ingest: async () => {
      if (!ownerUserId || !engineInstalled(paths.engine)) return null;
      return get().ingestCounts();
    }
  };
}
