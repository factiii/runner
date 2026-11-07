import { createRequire } from 'node:module';
import path from 'node:path';

import type { VaultRpcPath } from '@shared/all/validators';
import {
  createVaultRouter,
  type VaultCaller,
  type VaultPorts
} from '@shared/vault-router';
import {
  type PrismaVaultTypes,
  prismaVaultDb,
  type VaultScope,
  type VaultSqlTag
} from '@shared/vault-router/prismaDb';
import SuperJSON from 'superjson';

import type { VaultDb } from './db';
import type { Embedder } from './embedder';
import { VAULT_CLIENT_FILE } from './engine';
import type { FsObjectStore } from './objectStore';
import { vaultIpcAdapter } from './prismaIpc';

// The runner's adapter for the shared vault router (@shared/vault-router,
// .specs/vault-router.md → What is in the router). Its ports are the same Prisma
// queries the server runs (prismaDb.ts), on the Vault's own database through
// the driver adapter in its database process (prismaIpc.ts → dbChild.ts), the
// bytes in its own store, and query vectors from its own embedder: nothing
// leaves the machine. The `vaultRpc` action answers through it.

/** The generated vault-only client module (shared/vault-router/generated). */
type ClientModule = Pick<
  typeof import('@shared/vault-router/generated/client'),
  'PrismaClient' | 'Prisma'
>;

/**
 * The vault-only Prisma client: from the Vault's engine folder in a built
 * runner, where adding the Vault part put it (engine.ts), or from the
 * workspace's generated client when run from a checkout. Required by a path
 * the bundler does not follow, so dist/cli.js never carries it.
 */
export function loadVaultClient(engineDir: string): ClientModule {
  if (__filename.endsWith('.ts')) {
    const generated = path.resolve(__dirname, '../../../../shared/vault-router/generated/client.ts');
    return require(generated) as ClientModule;
  }
  return createRequire(path.join(engineDir, 'package.json'))(
    `./${VAULT_CLIENT_FILE}`
  ) as ClientModule;
}

/** A post as a runner search hands it back. `id` is its uuid, as on the
 *  server's PostDto. */
type RunnerVaultPost = {
  id: string;
  title: string | null;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  uploads: { id: string; name: string | null }[];
};

/** A signed read: redeemed with `vaultRead` over the same link, since the
 *  runner has no HTTP port to hand a URL out for. */
type RunnerVaultDownload = {
  ticket: string;
  size: number;
  name: string;
  contentType: string;
};

export type RunnerVaultTypes = PrismaVaultTypes & {
  post: RunnerVaultPost;
  // Who added a shared vault's file. The runner has no profiles; the client
  // has the account.
  person: { userId: number };
  download: RunnerVaultDownload;
};

const DOWNLOAD_EXPIRES_S = 900;
const NOT_HERE = 'That file is not in this vault.';
const SEARCH_NOT_READY = 'Vault search is not ready on this runner yet.';

/** Every upload in the runner's database is a vault file: there are no post
 *  photos or avatars here to keep out. */
const runnerScope = (tag: VaultSqlTag): VaultScope => ({
  uploads: async () => ({}),
  posts: async () => tag.sql`true`,
  defaultSource: null
});

const vaultRouter = createVaultRouter<RunnerVaultTypes>();

/** What `vaultRpc` answers: the result, encoded as the server's tRPC
 *  transformer encodes one, so one client link reads both backends. */
export type VaultRpcResult = ReturnType<typeof SuperJSON.serialize>;

export class RunnerVaultRouter {
  private ports: VaultPorts<RunnerVaultTypes> | null = null;

  constructor(
    private readonly db: VaultDb,
    private readonly store: FsObjectStore,
    private readonly embedder: Embedder | null,
    /** The generated client, loaded on the first call. */
    private readonly load: () => ClientModule
  ) {}

  private portsFor(): VaultPorts<RunnerVaultTypes> {
    if (this.ports) return this.ports;
    const { PrismaClient, Prisma } = this.load();
    const client = new PrismaClient({ adapter: vaultIpcAdapter(this.db) });
    const tag = { sql: Prisma.sql, join: Prisma.join };
    const { store, embedder } = this;
    this.ports = {
      db: prismaVaultDb<RunnerVaultTypes>({
        client,
        tag,
        scope: runnerScope(tag),
        hydratePosts: async (caller, postIds) =>
          (
            await client.post.findMany({
              where: {
                id: { in: postIds },
                userId: { in: caller.vaultUsers },
                status: 'PRIVATE'
              },
              select: {
                uuid: true,
                title: true,
                content: true,
                createdAt: true,
                updatedAt: true,
                uploads: { select: { id: true, name: true } }
              }
            })
          ).map(({ uuid, ...post }) => ({ id: uuid, ...post })),
        // The runner keeps no skip marks: they are the server's Categorize's.
        skippedFolders: async () => [],
        deleteObjects: (keys) => store.deleteMany(keys),
        folderEmptied: async () => undefined
      }),
      objects: {
        signDownload: async (file) => {
          const head = await store.head(file.key);
          if (!head) throw new Error(NOT_HERE);
          const name = file.name ?? file.key;
          return {
            ticket: await store.presignGet(file.key, DOWNLOAD_EXPIRES_S, name.split('/').pop()),
            size: head.size,
            name,
            contentType: head.contentType
          };
        }
      },
      embed: {
        // This machine's embedder only, never the server's.
        queryVector: async (text) => {
          if (embedder?.state() !== 'ready') throw new Error(SEARCH_NOT_READY);
          return embedder.embed({ text });
        }
      },
      people: {
        addedBy: async (caller) => (ownerId) =>
          ownerId === caller.userId ? null : { userId: ownerId }
      }
    };
    return this.ports;
  }

  /** One procedure of the shared router, for a caller the Vault let in. The
   *  procedure validates its own input. */
  async call(caller: VaultCaller, path: VaultRpcPath, input: unknown): Promise<VaultRpcResult> {
    const procedures = vaultRouter.createCaller({ caller, ports: this.portsFor() });
    const result = await (procedures[path] as (input: unknown) => Promise<unknown>)(input);
    return SuperJSON.serialize(result);
  }
}
