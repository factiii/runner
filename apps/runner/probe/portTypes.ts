// Probe (types only: `tsc --noEmit --strict --skipLibCheck probe/portTypes.ts`): can ONE VaultDb port type, written
// against the runner's vault-only client, accept the server's full client?
// If it can, the shared router is typed once and both adapters pass their own
// PrismaClient in.
import type { PrismaClient as ServerClient } from "../../server/src/generated/prisma/client";
import type { PrismaClient as VaultClient } from "./generated/client";

type VaultModels =
  | "upload"
  | "post"
  | "postContent"
  | "searchVector"
  | "mediaVector"
  | "vaultFolder"
  | "vaultShare"
  | "postFactiiiCount"
  | "postFactiii"
  | "spaceTime";

export type VaultDbPort = Pick<
  VaultClient,
  VaultModels | "$queryRaw" | "$executeRaw" | "$transaction"
>;

declare const server: ServerClient;
declare const runner: VaultClient;

export const fromRunner: VaultDbPort = runner;
// Found 2026-10-29: the server's full client is NOT assignable. Its create
// inputs carry relations (Post.user, Upload.user, ...) that the vault-only
// schema drops, so `upload.create` and friends differ. Kept as expected errors
// so this file records the answer and still compiles.
// @ts-expect-error the full client's write inputs differ (see above)
export const fromServer: VaultDbPort = server;

// The narrowest useful case: one delegate.
// @ts-expect-error same reason: `upload.create` differs
export const uploadOnly: Pick<VaultClient, "upload"> = server;

// Reads and raw SQL DO assign: findMany/count/findFirst and $queryRaw.
type Reads<D> = Pick<D, Extract<keyof D, "findMany" | "count" | "findFirst">>;
export const readsOnly: Reads<VaultClient["upload"]> = server.upload;
export const rawOnly: Pick<VaultClient, "$queryRaw" | "$executeRaw"> = server;
