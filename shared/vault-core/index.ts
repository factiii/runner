// The shared vault router (.specs/vault-router.md): the procedures, inputs and
// ports the server and the runner both answer with. Its Prisma queries are
// `./prismaDb`, on the client vault.prisma generates (postinstall). They live
// in vault-core, the open part of the runner's stores, so the runner and the
// public mirror have one package for them and the server imports the same one.
export * from './inputs';
export type * from './ports';
export {
  containsPattern,
  createVaultRouter,
  latestFileIds,
  MEANING_CANDIDATES,
  type VaultRouter
} from './router';
export { skipCovering } from './skippedFolders';
