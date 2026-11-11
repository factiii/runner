import type {
  BoardAgentActionMap,
  SecretFileEnvKey,
  SecretsBackupImportPlan
} from '../../domains/electron';
import { type OpsLink, OPS_NO_SUCH_BOARD, type OpsStoreOp } from './ops-link';
import type { SecretMeta } from './secret-descriptions';
import type { ActionContext } from './engine';

// The board's Secrets tab with the ops user on (.specs/ops-user.md, "Store
// ops"). The store's files belong to the ops user, so the engine cannot read
// them; each of the tab's actions is sent to the ops half as one store op
// instead, with the same password the tab already sends, and answered in the
// tab's own result shape. That is what lets a headless runner's Secrets tab
// work from the web and the phone, with no Factiii Desktop on the machine.
//
// What the ops half answers is names only, so a few answers are thinner than
// the engine's own: no masked tail (an env file's keys, an import plan), no
// "same value" in an import plan (a board's secret of that name always reads
// as different, so the tab asks keep or take), and a backup stays in the ops
// home rather than coming back as a download (`keptOnRunner`). Opening a
// backup shows its values, so it stays refused (OPS_BACKUP_OPEN_REFUSED).

export const OPS_BACKUP_OPEN_REFUSED =
  "Opening a backup shows its values, and this board's secrets live with the ops user, where no value leaves. Import it into a board instead, or open it on a runner without the ops user.";

/** The ops half does not hold this board, and it cannot just take it: the
 *  board's secrets are still in this user's store, and moving them takes
 *  Repair (the admin prompt). */
export const opsBoardMissingLine = (board: string) =>
  `${board}'s secrets are still with this Mac's user, not the ops user. Run Repair This Computer on the runner's Mac to move them.`;

/** The actions answered by the ops half, by the store op each one sends. */
const OPS_STORE_ROUTES = {
  deploySecretsStatus: 'store-status',
  deploySecretsInit: 'store-init',
  deploySecretsList: 'store-list',
  deploySecretsSet: 'store-set',
  deploySecretsUnset: 'store-unset',
  deploySecretsSetFile: 'store-set-file',
  deploySecretsUnsetFile: 'store-unset-file',
  deploySecretsSetMeta: 'store-set-meta',
  secretsChangePassword: 'store-change-password',
  secretsExportBackup: 'backup-export',
  secretsImportBackupPlan: 'backup-plan',
  secretsImportBackupApply: 'backup-import',
  secretFileEnvKeys: 'file-env-keys',
  secretFileEnvSet: 'file-env-set',
  secretFileEnvUnset: 'file-env-unset'
} as const satisfies Partial<Record<keyof BoardAgentActionMap, OpsStoreOp>>;

type RoutedAction = keyof typeof OPS_STORE_ROUTES;

/** Whether the ops half answers `action` when the ops user is on. */
export const isOpsStoreAction = (action: string): action is RoutedAction =>
  Object.hasOwn(OPS_STORE_ROUTES, action);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** An env file's keys as the tab draws them: the ops half sends no tail. */
const envKeys = (value: unknown): SecretFileEnvKey[] =>
  (Array.isArray(value) ? value : []).map((raw: unknown) => {
    const k = (raw ?? {}) as { name?: unknown; editable?: unknown };
    return { name: String(k.name ?? ''), masked: '', editable: k.editable === true };
  });

/** The plan as the tab reads it. A board secret of the same name is
 *  `current` with no tail and `same: false`: the ops half does not say
 *  whether the two are equal, so the tab asks keep or take for each. */
function plan(answer: Record<string, unknown>): SecretsBackupImportPlan {
  const rows = (value: unknown) =>
    (Array.isArray(value) ? value : []) as { name?: unknown; size?: unknown; exists?: unknown }[];
  return {
    board: String(answer.board ?? ''),
    createdAt: String(answer.createdAt ?? ''),
    secrets: rows(answer.secrets).map((r) => ({
      name: String(r.name ?? ''),
      masked: '',
      current: r.exists === true ? { masked: '', same: false } : null
    })),
    files: rows(answer.files).map((r) => ({
      name: String(r.name ?? ''),
      size: Number(r.size ?? 0),
      current: r.exists === true ? { size: 0, same: false } : null
    }))
  };
}

/**
 * Send one of the Secrets tab's actions to the ops half and answer in the
 * tab's shape. `provided` is what the runner's own GitHub connection answers
 * for (the engine's deploySecretsList), which the ops half does not know.
 */
export async function runOpsStoreAction<A extends RoutedAction>(
  link: OpsLink,
  action: A,
  payload: BoardAgentActionMap[A]['payload'],
  ctx: ActionContext,
  provided: string[],
  /** The board's name, and whether its secrets are still in this user's
   *  store (from before the ops user), for a board the ops half does not
   *  hold yet. */
  board: { name: string; hasLocalStore: () => Promise<boolean> }
): Promise<BoardAgentActionMap[A]['result']> {
  const actor = { by: { userId: String(ctx.actor.userId), name: ctx.actor.name }, via: ctx.via };
  const op = OPS_STORE_ROUTES[action];
  const fields = (payload ?? {}) as Record<string, unknown>;
  // The two that take no actor: a status read, and a description.
  const body = op === 'store-status' || op === 'store-set-meta' ? fields : { ...fields, ...actor };
  // A board made after setup: the ops half takes it on its first store op,
  // with an empty store, and the op is sent again. One whose secrets are
  // still in this user's store is not taken (an empty one would hide them):
  // moving those is Repair's.
  const send = async (b: Record<string, unknown>) => {
    try {
      return await link.storeCall(op, b);
    } catch (err) {
      if (!(err instanceof Error) || err.message !== OPS_NO_SUCH_BOARD) throw err;
      if (await board.hasLocalStore()) throw new Error(opsBoardMissingLine(board.name));
      await link.addBoard();
      return link.storeCall(op, b);
    }
  };
  type Result = BoardAgentActionMap[A]['result'];

  switch (action) {
    case 'deploySecretsStatus': {
      const answer = await send({});
      return { initialized: answer.initialized === true } as Result;
    }
    case 'deploySecretsList': {
      const answer = await send(body);
      return {
        keys: strings(answer.keys),
        meta: (answer.meta ?? {}) as Record<string, SecretMeta>,
        files: strings(answer.files),
        provided
      } as Result;
    }
    case 'secretsExportBackup': {
      const answer = await send(body);
      const file = String(answer.file ?? '');
      // No bundle: it stays in the ops home. Copying it out takes the
      // person's admin prompt in Factiii Desktop ("Save a copy").
      return { filename: file, bundle: '', keptOnRunner: file } as Result;
    }
    case 'secretsImportBackupPlan':
      return plan(await send(body)) as Result;
    case 'secretsImportBackupApply': {
      const { secrets, files, ...rest } = fields;
      const answer = await send({ ...rest, ...actor, picks: { secrets, files } });
      return { secrets: strings(answer.secrets), files: strings(answer.files) } as Result;
    }
    case 'secretFileEnvKeys': {
      const answer = await send(body);
      return (answer.env === true ? { env: true, keys: envKeys(answer.keys) } : { env: false }) as Result;
    }
    case 'secretFileEnvSet': {
      const answer = await send(body);
      return { success: true, occurrences: Number(answer.occurrences ?? 0), keys: envKeys(answer.keys) } as Result;
    }
    case 'secretFileEnvUnset': {
      const answer = await send(body);
      return { success: true, removed: Number(answer.removed ?? 0), keys: envKeys(answer.keys) } as Result;
    }
    default: {
      // The writes: set, remove, files, init, describe, password.
      const answer = await send(body);
      return { success: answer.success !== false } as Result;
    }
  }
}
