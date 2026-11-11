import { z } from 'zod';

import { OPS_NO_SUCH_BOARD } from '@shared/all/helpers/board-agent-core/ops-link';

// The ops socket's wire (.specs/ops-user.md, "The socket"). NDJSON, one
// request per connection: the server's challenge line, the client's request
// line, then the answer (one frame, or a stream for `job-stream`).
//
// The op list is the whole surface. No op returns a secret value, a file
// secret, the age identity, a decrypted path or the password, and adding one
// is a security review.

export const OPS_OPS = [
  'job-list',
  'job-call',
  'job-status',
  'job-cancel',
  'job-active',
  'job-stream',
  'secret-recipient',
  'secret-submit',
  'inbox-list',
  'inbox-answer',
  'gate-state',
  'gate-answer',
  'gate-lock',
  'approval-answer',
  'key-names',
  'audit-read',
  // Store-local actions (store.ts): writes checked by the board password;
  // answers carry names only. A backup stays in the ops home.
  'store-set',
  'store-unset',
  'store-set-file',
  'store-unset-file',
  'store-change-password',
  'backup-export',
  'backup-import',
  // The Secrets tab's reads and the rest of its writes (shared
  // ops-store-actions.ts), names only: whether a store exists, its key and
  // file names with their descriptions, an import's names, an env file's key
  // names. No tail, and never whether two values are equal.
  'store-status',
  'store-init',
  'store-list',
  'store-set-meta',
  'backup-plan',
  'file-env-keys',
  'file-env-set',
  'file-env-unset',
  // A board made after setup, taken for its secrets on its first store op:
  // empty store, no repository, no jobs (serve.ts addBoard). The one op
  // checked by the peer alone, since the board has no token yet.
  'board-add',
  // The ops service's own updater (updater.ts): its state, and "Update now".
  'update-state',
  'update-now'
] as const;

export type OpsOp = (typeof OPS_OPS)[number];

const OPS_OP_SET: ReadonlySet<string> = new Set(OPS_OPS);

/** A board slug as the runner names its dirs. */
export const BOARD_SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/;

/** The challenge nonce: 32 random bytes, hex. Also the challenge file's
 *  name, so nothing but hex can reach a path. */
export const NONCE = /^[0-9a-f]{64}$/;

/** The longest request line taken. A secret-submit carries ciphertext of a
 *  file secret (a certificate), so this is generous; past it is a broken or
 *  hostile client. */
export const MAX_REQUEST_LINE = 8 * 1024 * 1024;

export const REFUSED_PEER = 'The ops socket takes only the runner user (peer check failed).';
export const REFUSED_TOKEN = 'The ops socket takes only the board token the ops service issued.';
export const REFUSED_OP = 'That is not an op of the ops socket.';
export const REFUSED_BOARD = OPS_NO_SUCH_BOARD;
export const OPS_UNREACHABLE =
  'The ops service is not answering (factiii-runner ops status). Jobs and secrets are off until it does.';

export const actorSchema = z.object({
  userId: z.string().max(200),
  name: z.string().max(200)
});

export const viaSchema = z.enum(['api', 'data-channel', 'owner-terminal']);

const requestHead = z.object({
  op: z.string(),
  board: z.string().regex(BOARD_SLUG),
  token: z.string().max(200)
});

export type OpsRequest = { op: OpsOp; board: string; token: string } & Record<
  string,
  unknown
>;

/** One request line, or the reason it is refused. Only the head is checked
 *  here; each op's body is checked by its handler. */
export function parseRequest(line: string): OpsRequest | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { error: 'Malformed request.' };
  }
  const head = requestHead.safeParse(json);
  if (!head.success) return { error: 'Malformed request.' };
  if (!OPS_OP_SET.has(head.data.op)) return { error: REFUSED_OP };
  return json as OpsRequest;
}
