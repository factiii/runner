import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';

import { z } from 'zod';

import type { OpsBoard, StreamFrame } from './board';
import type { OpsUpdaterHandle } from './updater';
import type { PeerCheck } from './peer';
import {
  actorSchema,
  MAX_REQUEST_LINE,
  type OpsRequest,
  parseRequest,
  REFUSED_BOARD,
  REFUSED_PEER,
  REFUSED_TOKEN,
  viaSchema
} from './protocol';

// The ops socket (.specs/ops-user.md, "The socket"), served by the ops user.
// Each connection: our challenge, the peer's request line, the peer check,
// the board token, then exactly one allowlisted op. Every answer is built
// here from named fields, so no handler can hand the wire an object it did
// not mean to (a store row, a decrypted file): the reply shapes below are the
// whole of what leaves the ops user.

/** A connection that has not sent its request by now is dropped. */
const REQUEST_TIMEOUT_MS = 10_000;

type Reply = (message: Record<string, unknown>) => void;

export type OpsServer = { close: () => Promise<void> };

export async function startOpsServer(opts: {
  socketPath: string;
  peer: PeerCheck;
  board: (slug: string) => OpsBoard | null;
  tokenFor: (slug: string) => string | null;
  /** After listen: the socket's mode (0660; group factiii reaches it). */
  mode?: number;
  log?: (line: string) => void;
  /** The release updater (updater.ts), when this service runs from an app. */
  updater?: OpsUpdaterHandle;
  /** Take a board made after setup, for its secrets (serve.ts addBoard).
   *  True when it was taken, false when it was already served. */
  addBoard?: (slug: string) => boolean;
}): Promise<OpsServer> {
  await fs.rm(opts.socketPath, { force: true });
  const live = new Set<net.Socket>();
  const log = opts.log ?? (() => undefined);

  const server = net.createServer((conn) => {
    live.add(conn);
    conn.on('close', () => live.delete(conn));
    conn.on('error', () => undefined);
    const reply: Reply = (message) => {
      if (!conn.destroyed) conn.write(`${JSON.stringify(message)}\n`);
    };
    const refuse = (message: string) => {
      reply({ type: 'error', message });
      conn.end();
    };
    const nonce = opts.peer.challenge();
    reply({ type: 'challenge', nonce });
    const timer = setTimeout(() => conn.destroy(), REQUEST_TIMEOUT_MS);
    let buffer = '';
    let handled = false;
    conn.on('data', (chunk: Buffer) => {
      if (handled) return;
      buffer += chunk.toString('utf-8');
      if (buffer.length > MAX_REQUEST_LINE) {
        handled = true;
        refuse('Request too large.');
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      handled = true;
      clearTimeout(timer);
      const request = parseRequest(buffer.slice(0, newline));
      if ('error' in request) {
        refuse(String(request.error));
        return;
      }
      void (async () => {
        // Who, then which board, then the token: nothing past the peer check
        // runs for a caller that is not the runner user.
        try {
          await opts.peer.verify(nonce);
        } catch (err) {
          log(`peer refused: ${err instanceof Error ? err.message : String(err)}`);
          refuse(REFUSED_PEER);
          return;
        }
        // A board made after setup has no token yet, so this one op is
        // checked by the peer alone: the runner user asks for a board it
        // has, and gets an empty store with no repository and no jobs.
        if (request.op === 'board-add') {
          try {
            if (!opts.addBoard) throw new Error('This ops service does not take boards after setup.');
            reply({ type: 'board', added: opts.addBoard(request.board) });
          } catch (err) {
            reply({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          }
          conn.end();
          return;
        }
        const board = opts.board(request.board);
        const expected = opts.tokenFor(request.board);
        if (!board || !expected) {
          refuse(REFUSED_BOARD);
          return;
        }
        if (!sameToken(request.token, expected)) {
          refuse(REFUSED_TOKEN);
          return;
        }
        if (request.op === 'job-stream') {
          stream(conn, reply, board);
          return;
        }
        try {
          reply(await handle(request, board, opts.updater));
        } catch (err) {
          reply({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
        conn.end();
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  await fs.chmod(opts.socketPath, opts.mode ?? 0o660);

  return {
    close: async () => {
      for (const conn of live) conn.destroy();
      live.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(opts.socketPath, { force: true });
    }
  };
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The long-lived op: a snapshot, then each change, until the peer goes. */
function stream(conn: net.Socket, reply: Reply, board: OpsBoard): void {
  const send = (frame: StreamFrame) => reply(streamFrame(frame));
  for (const frame of board.snapshot()) send(frame);
  const stop = board.subscribe(send);
  conn.on('close', stop);
}

/** A stream frame, field by field. */
function streamFrame(frame: StreamFrame): Record<string, unknown> {
  switch (frame.type) {
    case 'job-state':
      return {
        type: 'job-state',
        callId: frame.callId,
        state: frame.state,
        via: frame.via,
        ...(frame.wait ? { wait: frame.wait } : {}),
        ...(frame.meta
          ? {
              meta: {
                job: frame.meta.job,
                caller: actorOut(frame.meta.caller),
                startedAt: frame.meta.startedAt
              }
            }
          : {})
      };
    case 'job-log':
      return { type: 'job-log', callId: frame.callId, seq: frame.seq, text: frame.text };
    case 'job-end':
      return {
        type: 'job-end',
        callId: frame.callId,
        state: frame.state,
        exitCode: frame.exitCode
      };
    case 'gate':
      return gateOut(frame);
    case 'approvals':
      return { type: 'approvals', pending: frame.pending.map(approvalOut) };
    case 'approval':
      return {
        type: 'approval',
        change:
          'opened' in frame.change
            ? { opened: approvalOut(frame.change.opened) }
            : { closed: frame.change.closed }
      };
  }
}

const actorOut = (a: { userId: string; name: string }) => ({
  userId: String(a.userId),
  name: a.name
});

function gateOut(state: ReturnType<OpsBoard['gateState']>): Record<string, unknown> {
  const p = state.pending;
  return {
    type: 'gate',
    pending: p
      ? {
          id: p.id,
          command: p.command,
          keys: [...p.keys],
          origin: p.origin,
          error: p.error,
          requestedAt: p.requestedAt,
          ...(p.caller ? { caller: actorOut(p.caller) } : {}),
          ...(p.job ? { job: p.job } : {}),
          ...(p.inbox
            ? {
                inbox: {
                  id: p.inbox.id,
                  key: p.inbox.key,
                  kind: p.inbox.kind,
                  replaces: p.inbox.replaces
                }
              }
            : {})
        }
      : null,
    unlocked: state.unlocked
      ? {
          until: state.unlocked.until,
          byUserId: state.unlocked.byUserId,
          byName: state.unlocked.byName
        }
      : null
  };
}

function approvalOut(a: ReturnType<OpsBoard['approvals']>[number]): Record<string, unknown> {
  return {
    id: a.id,
    job: a.job,
    command: a.command,
    caller: actorOut(a.caller),
    spaceSlug: a.spaceSlug,
    requestedAt: a.requestedAt,
    expiresAt: a.expiresAt
  };
}

const callIdSchema = z.string().min(1).max(100);

const storeActor = { by: actorSchema, via: viaSchema };
const password = z.string().min(1).max(1000);
const backupPick = z.object({ name: z.string().max(200), conflict: z.enum(['keep', 'take']).optional() });

const bodies = {
  'store-set': z.object({ ...storeActor, password, key: z.string().max(200), value: z.string().max(1_000_000) }),
  'store-unset': z.object({ ...storeActor, password, key: z.string().max(200) }),
  'store-set-file': z.object({
    ...storeActor,
    password,
    name: z.string().max(200),
    contentBase64: z.string().max(8 * 1024 * 1024)
  }),
  'store-unset-file': z.object({ ...storeActor, password, name: z.string().max(200) }),
  'store-change-password': z.object({ ...storeActor, oldPassword: password, newPassword: password }),
  'backup-export': z.object({ ...storeActor, password, passphrase: password }),
  'backup-import': z.object({
    ...storeActor,
    bundle: z.string().max(8 * 1024 * 1024),
    passphrase: password,
    targetPassword: password,
    // The Secrets tab's picks; absent, every secret in the backup (the panel).
    picks: z
      .object({ secrets: z.array(backupPick).max(2000), files: z.array(backupPick).max(2000) })
      .optional()
  }),
  'store-init': z.object({ ...storeActor, password }),
  'store-list': z.object({ ...storeActor, password }),
  'store-set-meta': z.object({
    key: z.string().max(200),
    title: z.string().max(500).optional(),
    description: z.string().max(5000).optional(),
    category: z.string().max(200).optional(),
    source: z.string().max(200).optional()
  }),
  'backup-plan': z.object({
    ...storeActor,
    bundle: z.string().max(8 * 1024 * 1024),
    passphrase: password,
    targetPassword: password
  }),
  'file-env-keys': z.object({ ...storeActor, password, name: z.string().max(200) }),
  'file-env-set': z.object({
    ...storeActor,
    password,
    name: z.string().max(200),
    key: z.string().max(200),
    value: z.string().max(1_000_000)
  }),
  'file-env-unset': z.object({ ...storeActor, password, name: z.string().max(200), key: z.string().max(200) }),
  'job-call': z.object({
    job: z.string().max(200),
    params: z.record(z.string(), z.string()).default({}),
    caller: actorSchema,
    via: viaSchema,
    callId: callIdSchema.optional(),
    from: z.string().max(500).optional(),
    mayRunDangerous: z.boolean()
  }),
  'job-status': z.object({
    callId: callIdSchema,
    afterSeq: z.number().int().min(0).default(0),
    viewer: z.object({ by: actorSchema, byOwner: z.boolean() }).optional()
  }),
  'job-cancel': z.object({
    callId: callIdSchema,
    by: actorSchema,
    via: viaSchema,
    byOwner: z.boolean()
  }),
  'job-active': z.object({ onlyUserId: z.string().max(200).optional() }),
  'secret-submit': z.object({
    submitId: z.string().max(100),
    key: z.string().max(200),
    kind: z.enum(['env', 'file']),
    ciphertext: z.string(),
    actor: actorSchema
  }),
  'inbox-answer': z.object({
    id: z.string().max(100),
    password: z.string().max(1000).optional(),
    approve: z.boolean(),
    unlockFor: z.number().optional(),
    by: actorSchema,
    via: viaSchema
  }),
  'gate-answer': z.object({
    id: z.string().max(100),
    password: z.string().max(1000).optional(),
    unlockFor: z.number().optional(),
    by: actorSchema,
    via: viaSchema
  }),
  'gate-lock': z.object({ by: actorSchema, via: viaSchema }),
  'approval-answer': z.object({
    id: z.string().max(100),
    approve: z.boolean(),
    by: actorSchema,
    via: viaSchema
  }),
  'audit-read': z.object({
    limit: z.number().int().min(1).max(1000).optional(),
    beforeTs: z.string().max(100).optional(),
    actorUserId: z.string().max(200).optional(),
    job: z.string().max(200).optional(),
    key: z.string().max(200).optional()
  })
};

function body<K extends keyof typeof bodies>(
  op: K,
  request: OpsRequest
): z.infer<(typeof bodies)[K]> {
  const parsed = bodies[op].safeParse(request);
  if (!parsed.success) throw new Error(`Malformed ${op} request.`);
  return parsed.data as z.infer<(typeof bodies)[K]>;
}

/** One request-answer op. Each answer names its fields. */
async function handle(
  request: OpsRequest,
  board: OpsBoard,
  updater: OpsUpdaterHandle | undefined
): Promise<Record<string, unknown>> {
  switch (request.op) {
    case 'store-set': {
      const b = body('store-set', request);
      return { type: 'stored', success: (await board.store.set(b)).success };
    }
    case 'store-unset': {
      const b = body('store-unset', request);
      return { type: 'stored', success: (await board.store.unset(b)).success };
    }
    case 'store-set-file': {
      const b = body('store-set-file', request);
      return { type: 'stored', success: (await board.store.setFile(b)).success };
    }
    case 'store-unset-file': {
      const b = body('store-unset-file', request);
      return { type: 'stored', success: (await board.store.unsetFile(b)).success };
    }
    case 'store-change-password': {
      const b = body('store-change-password', request);
      return { type: 'stored', success: (await board.store.changePassword(b)).success };
    }
    case 'backup-export': {
      const b = body('backup-export', request);
      return { type: 'backup', file: (await board.store.backupExport(b)).file };
    }
    case 'backup-import': {
      const b = body('backup-import', request);
      const res = await board.store.backupImport(b);
      return { type: 'imported', secrets: [...res.secrets], files: [...res.files] };
    }
    case 'board-add':
      // Answered before the token check, in the connection handler.
      throw new Error('board-add is answered before a board is chosen.');
    case 'store-status':
      return { type: 'store-status', initialized: (await board.store.status()).initialized };
    case 'store-init': {
      const b = body('store-init', request);
      return { type: 'stored', success: (await board.store.init(b)).success };
    }
    case 'store-list': {
      const b = body('store-list', request);
      const res = await board.store.list(b);
      return {
        type: 'store-list',
        keys: [...res.keys],
        meta: Object.fromEntries(
          Object.entries(res.meta).map(([key, m]) => [
            key,
            { title: m.title, description: m.description, category: m.category, source: m.source }
          ])
        ),
        files: [...res.files]
      };
    }
    case 'store-set-meta': {
      const { key, ...patch } = body('store-set-meta', request);
      return { type: 'stored', success: (await board.store.setMeta({ key, patch })).success };
    }
    case 'backup-plan': {
      const b = body('backup-plan', request);
      const plan = await board.store.backupPlan(b);
      return {
        type: 'backup-plan',
        board: plan.board,
        createdAt: plan.createdAt,
        secrets: plan.secrets.map((x) => ({ name: x.name, exists: x.exists })),
        files: plan.files.map((x) => ({ name: x.name, size: x.size, exists: x.exists }))
      };
    }
    case 'file-env-keys': {
      const b = body('file-env-keys', request);
      const keys = await board.store.fileEnvKeys(b);
      return keys
        ? { type: 'file-env', env: true, keys: keys.map((k) => ({ name: k.name, editable: k.editable })) }
        : { type: 'file-env', env: false };
    }
    case 'file-env-set': {
      const b = body('file-env-set', request);
      const res = await board.store.fileEnvSet(b);
      return {
        type: 'file-env',
        env: true,
        occurrences: res.occurrences,
        keys: res.keys.map((k) => ({ name: k.name, editable: k.editable }))
      };
    }
    case 'file-env-unset': {
      const b = body('file-env-unset', request);
      const res = await board.store.fileEnvUnset(b);
      return {
        type: 'file-env',
        env: true,
        removed: res.removed,
        keys: res.keys.map((k) => ({ name: k.name, editable: k.editable }))
      };
    }
    case 'update-state':
    case 'update-now': {
      if (!updater) throw new Error('This ops service does not run from Factiii.app, so it has no updater.');
      const state = request.op === 'update-now' ? await updater.updateNow() : updater.state();
      return {
        type: 'update',
        current: state.current,
        phase: state.phase,
        latest: state.latest,
        lastCheckAt: state.lastCheckAt,
        message: state.message
      };
    }
    case 'job-list':
      return {
        type: 'jobs',
        jobs: (await board.jobList()).map((j) => ({
          name: j.name,
          description: j.description,
          keys: [...j.keys],
          files: [...j.files],
          params: { ...j.params },
          dangerous: j.dangerous === true
        }))
      };
    case 'job-call': {
      const b = body('job-call', request);
      const { callId } = await board.jobCall(b);
      return { type: 'job-accepted', callId };
    }
    case 'job-status': {
      const b = body('job-status', request);
      const s = board.jobStatus(b.callId, b.afterSeq, b.viewer);
      return {
        type: 'job-status',
        state: s.state,
        exitCode: s.exitCode,
        chunks: s.chunks.map((c) => ({ seq: c.seq, text: c.text })),
        ...(s.wait ? { wait: s.wait } : {})
      };
    }
    case 'job-cancel': {
      const b = body('job-cancel', request);
      const { cancelled } = await board.jobCancel(b.callId, b.by, b.via, b.byOwner);
      return { type: 'cancelled', cancelled };
    }
    case 'job-active': {
      const b = body('job-active', request);
      return {
        type: 'job-active',
        calls: board.jobActive(b.onlyUserId).map((c) => ({
          callId: c.callId,
          job: c.job,
          state: c.state,
          actor: actorOut(c.actor),
          startedAt: c.startedAt,
          ...(c.wait ? { wait: c.wait } : {})
        }))
      };
    }
    case 'secret-recipient':
      return { type: 'recipient', recipient: await board.recipient() };
    case 'secret-submit': {
      const b = body('secret-submit', request);
      await board.secretSubmit(b);
      return { type: 'accepted' };
    }
    case 'inbox-list':
      return {
        type: 'inbox',
        items: (await board.inboxList()).map((i) => ({
          id: i.id,
          key: i.key,
          kind: i.kind,
          replaces: i.replaces,
          byUserId: i.byUserId,
          byName: i.byName,
          at: i.at
        }))
      };
    case 'inbox-answer': {
      const b = body('inbox-answer', request);
      const { success } = await board.inboxAnswer(
        { id: b.id, password: b.password, approve: b.approve, unlockFor: b.unlockFor },
        b.by,
        b.via
      );
      return { type: 'answered', success };
    }
    case 'gate-state':
      return gateOut(board.gateState());
    case 'gate-answer': {
      const b = body('gate-answer', request);
      const { success } = board.gateAnswer(
        b.id,
        b.password === undefined
          ? { denied: true, by: b.by, via: b.via }
          : { password: b.password, unlockFor: b.unlockFor, by: b.by, via: b.via }
      );
      return { type: 'answered', success };
    }
    case 'gate-lock': {
      const b = body('gate-lock', request);
      const { success } = await board.gateLock(b.by, b.via);
      return { type: 'locked', success };
    }
    case 'approval-answer': {
      const b = body('approval-answer', request);
      const { success } = board.approvalAnswer(b.id, b.approve, { by: b.by, via: b.via });
      return { type: 'answered', success };
    }
    case 'key-names':
      return {
        type: 'keys',
        entries: (await board.keyNames()).map((k) => ({
          key: k.key,
          stored: k.stored,
          declared: k.declared,
          title: k.title,
          description: k.description,
          category: k.category,
          ...(k.kind ? { kind: k.kind } : {})
        }))
      };
    case 'audit-read': {
      const b = body('audit-read', request);
      const read = await board.auditRead(b);
      return {
        type: 'audit',
        entries: read.entries,
        chainIntact: read.chainIntact,
        firstBrokenTs: read.firstBrokenTs
      };
    }
    case 'job-stream':
      throw new Error('job-stream is a stream.');
  }
}
