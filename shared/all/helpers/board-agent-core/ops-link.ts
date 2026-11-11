import type {
  PendingDangerousApproval,
  PendingSecretsAuth,
  SecretsInboxItem,
  SecretsUnlockWindow
} from '../../domains/electron';
import type { JobHost, JobsApi } from './jobs';
import type { OwnerApprovalAnswerer, OwnerApprovalChange } from './owner-approval';
import type { SecretsKeyInfo } from './secrets-bridge';
import type { InboxSubmit } from './secrets-inbox';
import type { AuditVia } from './secrets-run';
import type { WindowActor } from './secrets-window';

// The session half's view of the ops user (.specs/ops-user.md). With the
// runner's ops setting on, a board's store, gate, unlock window, job runner,
// dangerous approvals and inbox live in the `factiii-ops` user, behind the
// ops socket (apps/runner/src/ops). The engine routes those actions here
// instead of to its in-process objects. Nothing on this type can return a
// secret value: the socket has no op that would.

/** The engine's job hooks, called by the link as the ops half reports. */
export type OpsJobHooks = Pick<JobHost, 'onLog' | 'onEnd' | 'onState'>;

/** A change the engine republishes to clients: the gate or the window moved,
 *  or a dangerous approval opened or closed. */
export type OpsLinkEvent =
  | { type: 'gate' }
  | { type: 'approval'; change: OwnerApprovalChange };

export type OpsLink = {
  /** The ops half's job runner, mirrored (status and active are local). */
  jobs: JobsApi;
  /** As last reported by the ops half. */
  gateState(): {
    pending: PendingSecretsAuth | null;
    unlocked: SecretsUnlockWindow | null;
  };
  /** Forward an answer. Success means the id is the one on screen; the ops
   *  half checks the password and re-prompts on a wrong one. */
  gateAnswer(
    id: string,
    answer: {
      password?: string;
      unlockFor?: number;
      by: WindowActor;
      via: AuditVia;
    }
  ): { success: boolean };
  lock(by: WindowActor, via: AuditVia): Promise<{ success: boolean }>;
  approvals(): PendingDangerousApproval[];
  approvalAnswer(
    id: string,
    approve: boolean,
    answerer: OwnerApprovalAnswerer
  ): { success: boolean };
  /** Key NAMES and descriptions, never values. */
  keyNames(): Promise<SecretsKeyInfo[]>;
  /** The board's public age recipient, for an encrypted update. */
  recipient(): Promise<string>;
  inboxSubmit(item: InboxSubmit): Promise<{ accepted: true }>;
  inboxList(): Promise<SecretsInboxItem[]>;
  inboxAnswer(
    payload: { id: string; password?: string; approve: boolean; unlockFor?: number },
    by: WindowActor,
    via: AuditVia
  ): Promise<{ success: boolean }>;
  /** One of the Secrets tab's store ops (ops-store-actions.ts), answered
   *  with names only; throws the ops half's refusal. */
  storeCall(op: OpsStoreOp, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Have the ops half take this board, made after setup, for its secrets:
   *  an empty store, no repository, no jobs. */
  addBoard(): Promise<{ added: boolean }>;
  subscribe(listener: (event: OpsLinkEvent) => void): () => void;
  close(): void;
};

/** The ops socket's refusal for a board it does not serve (the runner's
 *  protocol.ts REFUSED_BOARD): one made after the computer was set up. */
export const OPS_NO_SUCH_BOARD = 'The ops service has no such board.';

/** The ops socket's store ops the engine sends (the runner's protocol.ts
 *  OPS_OPS has them all). */
export type OpsStoreOp =
  | 'store-status'
  | 'store-init'
  | 'store-list'
  | 'store-set'
  | 'store-unset'
  | 'store-set-file'
  | 'store-unset-file'
  | 'store-set-meta'
  | 'store-change-password'
  | 'backup-export'
  | 'backup-plan'
  | 'backup-import'
  | 'file-env-keys'
  | 'file-env-set'
  | 'file-env-unset';

export type OpsLinkFactory = (hooks: OpsJobHooks) => OpsLink;

/** The mirror refuses an unknown call with the runner's own words. */
export { RUNNER_NO_SUCH_JOB_CALL } from '../../validators/runnerJobs';

/** `factiii-secrets run` with the ops user on: the command would run as the
 *  ops user with the whole store reachable, so it is refused. */
export const OPS_FREE_COMMAND_REFUSED =
  'factiii-secrets run is off on this runner: secrets live with the ops user, and only named jobs run with them. Use a job (factiii-runner job --list).';
