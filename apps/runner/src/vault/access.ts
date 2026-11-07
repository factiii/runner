import type { BoardAgentAction, RunnerAskEngine } from '@shared/all/domains/electron';
import type { VouchedScope } from '@shared/all/helpers/board-agent-core/runner-access';

// Who may do what in the runner's Vault (.specs/runner-vault.md "Sharing").
//
// The same two halves as runner sharing. The server vouches who is on the
// link, and for a member whether they are in the owner's shared vault on
// Factiii (`scope.vault`). The runner keeps its own list of the members the
// owner let in (its VaultShare table) and lets nobody in who is not on it.
// Either half alone gets a member nothing.
//
// Inside, the cloud vault's rules: everyone in reads every file; a file is
// added as the caller's own; delete reaches the caller's own files only;
// only the owner changes who is in.
//
// Ask with the runner's own model (.specs/runner-vault-ask.md "Ask with a runner's
// model"): anyone in may ask with its Ollama models. Claude and Codex run on
// the owner's own sign-in, and what they read leaves the machine, so only the
// owner asks with them; a member is refused here, whatever the app shows.

export type VaultRole = 'owner' | 'member';

export function vaultRole(
  scope: VouchedScope,
  members: ReadonlySet<string>
): VaultRole | null {
  if (scope.role === 'owner') return 'owner';
  return scope.vault === true && members.has(scope.userId) ? 'member' : null;
}

/** Categorize on the runner (categorize.ts): it runs on the owner's machine
 *  and, with Claude or Codex, their sign-in, and it tags every file. */
const CATEGORIZE_ACTIONS: ReadonlySet<BoardAgentAction> = new Set<BoardAgentAction>([
  'vaultCategorizeStatus',
  'vaultCategorizeStart',
  'vaultCategorizeCancel'
]);

/** A file's page and the notes kept from Ask (posts.ts): the owner's own
 *  reading of their Vault. */
const READING_ACTIONS: ReadonlySet<BoardAgentAction> = new Set<BoardAgentAction>([
  'vaultFilePost',
  'vaultNotes',
  'vaultNoteDelete'
]);

export function vaultActionAllowed(role: VaultRole, action: BoardAgentAction): boolean {
  if (role === 'owner') return true;
  return (
    action !== 'vaultShareSet' && !CATEGORIZE_ACTIONS.has(action) && !READING_ACTIONS.has(action)
  );
}

/** Why a member was refused `action`. */
export const vaultOwnerOnly = (action: BoardAgentAction): string => {
  if (CATEGORIZE_ACTIONS.has(action)) return CATEGORIZE_OWNER_ONLY;
  if (READING_ACTIONS.has(action)) return READING_OWNER_ONLY;
  return VAULT_OWNER_ONLY;
};

export const VAULT_REFUSAL =
  'This vault is not shared with you. Its owner lets people in from their runner.';
const VAULT_OWNER_ONLY = 'Only the owner of this vault can change who opens it.';
const CATEGORIZE_OWNER_ONLY = 'Only the owner of this runner categorizes its files.';
const READING_OWNER_ONLY =
  'Only the owner of this runner opens its files’ pages and keeps notes on it.';

/** May `role` ask with `engine`? Ollama for anyone in; Claude and Codex for
 *  the owner. */
export const askEngineAllowed = (role: VaultRole, engine: RunnerAskEngine): boolean =>
  engine === 'ollama' || role === 'owner';

export const ASK_CLI_OWNER_ONLY =
  'Claude and Codex on this runner run on its owner’s sign-in, so only the owner asks with them. Pick one of its Local AI models.';

/** Whose files a read sees: the owner's and every member's. */
export function vaultReaders(ownerId: string, members: ReadonlySet<string>): number[] {
  return [ownerId, ...members].map(Number).filter(Number.isSafeInteger);
}

/** The rows the caller may delete (their own), and how many were kept. */
export function deletableRows<T extends { userId: number }>(
  rows: readonly T[],
  callerId: string
): { mine: T[]; kept: number } {
  const mine = rows.filter((row) => String(row.userId) === callerId);
  return { mine, kept: rows.length - mine.length };
}
