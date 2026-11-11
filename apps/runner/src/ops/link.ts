import type {
  PendingDangerousApproval,
  PendingSecretsAuth,
  RunnerJobInfo,
  RunnerJobState,
  RunnerJobTargetWait,
  SecretsInboxItem,
  SecretsUnlockWindow
} from '@shared/all/domains/electron';
import type { JobsApi } from '@shared/all/helpers/board-agent-core/jobs';
import {
  type OpsJobHooks,
  type OpsLink,
  type OpsLinkEvent,
  RUNNER_NO_SUCH_JOB_CALL
} from '@shared/all/helpers/board-agent-core/ops-link';
import type { OwnerApprovalChange } from '@shared/all/helpers/board-agent-core/owner-approval';
import type { SecretsKeyInfo } from '@shared/all/helpers/board-agent-core/secrets-bridge';
import type { AuditVia } from '@shared/all/helpers/board-agent-core/secrets-run';
import type { WindowActor } from '@shared/all/helpers/board-agent-core/secrets-window';

import type { OpsClient } from './client';

// The engine's OpsLink (shared ops-link.ts) over the ops socket. One
// `job-stream` connection per board keeps a mirror of the ops half's calls,
// gate and approvals, so what the engine reads synchronously (a call's
// status, the active calls, the pending prompt) is answered here, and what it
// does (call, cancel, answer, lock, submit) is one request each. The mirror
// holds names, states and redacted output, as the ops half sent them.

/** Chunks kept per call, as jobs.ts. */
const MAX_CHUNKS = 5000;
/** Finished calls kept for status reads. */
const MAX_ENDED = 200;
const KEEP_MS = 24 * 60 * 60_000;

type MirrorCall = {
  callId: string;
  job: string;
  caller: WindowActor;
  state: RunnerJobState;
  exitCode: number | null;
  chunks: { seq: number; text: string }[];
  wait: RunnerJobTargetWait | null;
  startedAt: string;
  endedAt: number | null;
};

type EndState = Parameters<NonNullable<OpsJobHooks['onEnd']>>[1];

type Phase = Parameters<NonNullable<OpsJobHooks['onState']>>[1];
const PHASES: ReadonlySet<string> = new Set<Phase>([
  'queued',
  'waiting-owner',
  'waiting-target',
  'waiting-auth',
  'running'
]);
const isPhase = (state: string): state is Phase => PHASES.has(state);

export function createOpsLink(opts: {
  client: OpsClient;
  hooks: OpsJobHooks;
  log?: (line: string) => void;
  /** First reconnect delay; doubles to 30 s. */
  reconnectMs?: number;
  now?: () => number;
}): OpsLink {
  const { client, hooks } = opts;
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? Date.now;
  const calls = new Map<string, MirrorCall>();
  let gate: { pending: PendingSecretsAuth | null; unlocked: SecretsUnlockWindow | null } = {
    pending: null,
    unlocked: null
  };
  let approvals: PendingDangerousApproval[] = [];
  const listeners = new Set<(event: OpsLinkEvent) => void>();
  const emit = (event: OpsLinkEvent) => {
    for (const listener of listeners) listener(event);
  };
  let closed = false;
  let current: { close: () => void } | null = null;
  let delay = opts.reconnectMs ?? 1000;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const row = (callId: string, meta?: { job: string; caller: WindowActor; startedAt: string }) => {
    let call = calls.get(callId);
    if (!call && meta) {
      call = {
        callId,
        job: meta.job,
        caller: { userId: String(meta.caller.userId), name: meta.caller.name },
        state: 'queued',
        exitCode: null,
        chunks: [],
        wait: null,
        startedAt: meta.startedAt,
        endedAt: null
      };
      calls.set(callId, call);
    }
    return call ?? null;
  };

  /** The one place a mirrored call moves. A phase moves an open call only,
   *  and an end settles it once: what the stream sends after (a snapshot
   *  that still lists a call the drop already failed) changes nothing.
   *  True when it moved. */
  const move = (
    call: MirrorCall,
    to: { phase: Phase; wait: RunnerJobTargetWait | null } | { end: EndState; exitCode: number | null }
  ): boolean => {
    if (call.endedAt !== null) return false;
    if ('end' in to) {
      call.state = to.end;
      call.exitCode = to.exitCode;
      call.wait = null;
      call.endedAt = now();
    } else {
      call.state = to.phase;
      call.wait = to.wait;
    }
    return true;
  };

  const prune = () => {
    const cutoff = now() - KEEP_MS;
    const ended = [...calls.values()].filter((c) => c.endedAt !== null);
    for (const c of ended) if ((c.endedAt ?? 0) < cutoff) calls.delete(c.callId);
    const rest = ended.filter((c) => calls.has(c.callId)).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    while (rest.length > MAX_ENDED) calls.delete(rest.shift()!.callId);
  };

  const onFrame = (frame: Record<string, unknown>) => {
    delay = opts.reconnectMs ?? 1000;
    switch (frame.type) {
      case 'gate':
        gate = {
          pending: (frame.pending as PendingSecretsAuth | null) ?? null,
          unlocked: (frame.unlocked as SecretsUnlockWindow | null) ?? null
        };
        emit({ type: 'gate' });
        return;
      case 'approvals': {
        // The snapshot after a (re)connect: close what is gone, open what is new.
        const next = (frame.pending as PendingDangerousApproval[]) ?? [];
        const before = new Set(approvals.map((a) => a.id));
        const after = new Set(next.map((a) => a.id));
        approvals = next;
        for (const id of before) if (!after.has(id)) emit({ type: 'approval', change: { closed: id } });
        for (const a of next) if (!before.has(a.id)) emit({ type: 'approval', change: { opened: a } });
        return;
      }
      case 'approval': {
        const change = frame.change as OwnerApprovalChange;
        if ('opened' in change) approvals = [...approvals, change.opened];
        else approvals = approvals.filter((a) => a.id !== change.closed);
        emit({ type: 'approval', change });
        return;
      }
      case 'job-state': {
        const callId = String(frame.callId);
        const call = row(callId, frame.meta as MirrorCall | undefined);
        const state = String(frame.state);
        // A phase only: an end comes as 'job-end'.
        if (!isPhase(state)) return;
        const wait = (frame.wait as RunnerJobTargetWait | undefined) ?? undefined;
        if (call && !move(call, { phase: state, wait: wait ?? null })) return;
        hooks.onState?.(callId, state, frame.via as AuditVia, wait);
        return;
      }
      case 'job-log': {
        const callId = String(frame.callId);
        const seq = Number(frame.seq);
        const text = String(frame.text);
        const call = calls.get(callId);
        if (call) {
          call.chunks.push({ seq, text });
          if (call.chunks.length > MAX_CHUNKS) call.chunks.splice(0, call.chunks.length - MAX_CHUNKS);
        }
        hooks.onLog?.(callId, seq, text);
        return;
      }
      case 'job-end': {
        const callId = String(frame.callId);
        const state = frame.state as EndState;
        const exitCode = typeof frame.exitCode === 'number' ? frame.exitCode : null;
        const call = calls.get(callId);
        if (call && !move(call, { end: state, exitCode })) return;
        hooks.onEnd?.(callId, state, exitCode);
        prune();
        return;
      }
      case 'error':
        log(`ops stream refused: ${String(frame.message)}`);
        return;
      default:
        return;
    }
  };

  const connect = () => {
    if (closed) return;
    current = client.stream(onFrame, (err) => {
      current = null;
      if (closed) return;
      if (err) log(err.message);
      // The ops half restarted or is down: what it held is gone with it
      // (holds and waits are memory only), so the mirror's open calls fail.
      for (const call of calls.values()) {
        if (move(call, { end: 'failed', exitCode: null })) hooks.onEnd?.(call.callId, 'failed', null);
      }
      if (gate.pending || gate.unlocked) {
        gate = { pending: null, unlocked: null };
        emit({ type: 'gate' });
      }
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    });
  };
  connect();

  const jobs: JobsApi = {
    list: async () => (await client.call('job-list')).jobs as RunnerJobInfo[],
    call: async (call) => {
      const frame = await client.call('job-call', {
        job: call.job,
        params: call.params ?? {},
        caller: { userId: String(call.caller.userId), name: call.caller.name },
        via: call.via,
        ...(call.callId ? { callId: call.callId } : {}),
        ...(call.from ? { from: call.from } : {}),
        mayRunDangerous: call.mayRunDangerous === true
      });
      const callId = String(frame.callId);
      row(callId, { job: call.job, caller: call.caller, startedAt: new Date(now()).toISOString() });
      return { callId };
    },
    cancel: async (callId, by, via, byOwner) => {
      const frame = await client.call('job-cancel', { callId, by, via, byOwner });
      return { cancelled: frame.cancelled === true };
    },
    status: (callId, afterSeq = 0, viewer) => {
      const call = calls.get(callId);
      if (
        !call ||
        (viewer && !viewer.byOwner && String(viewer.by.userId) !== String(call.caller.userId))
      ) {
        throw new Error(RUNNER_NO_SUCH_JOB_CALL);
      }
      return {
        state: call.state,
        exitCode: call.exitCode,
        chunks: call.chunks.filter((c) => c.seq > afterSeq),
        ...(call.wait ? { wait: call.wait } : {})
      };
    },
    active: (onlyUserId) =>
      [...calls.values()]
        .filter((c) => c.endedAt === null)
        .filter((c) => onlyUserId === undefined || String(c.caller.userId) === String(onlyUserId))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .map((c) => ({
          callId: c.callId,
          job: c.job,
          state: c.state,
          actor: { userId: c.caller.userId, name: c.caller.name },
          startedAt: c.startedAt,
          ...(c.wait ? { wait: c.wait } : {})
        })),
    busy: () => [...calls.values()].some((c) => c.endedAt === null),
    destroy: () => undefined
  };

  const fire = (op: 'gate-answer' | 'approval-answer', body: Record<string, unknown>) => {
    void client.call(op, body).catch((err: unknown) => {
      log(`${op} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  return {
    jobs,
    gateState: () => gate,
    gateAnswer: (id, answer) => {
      fire('gate-answer', {
        id,
        ...(answer.password === undefined ? {} : { password: answer.password }),
        ...(answer.unlockFor === undefined ? {} : { unlockFor: answer.unlockFor }),
        by: { userId: String(answer.by.userId), name: answer.by.name },
        via: answer.via
      });
      return { success: gate.pending?.id === id };
    },
    lock: async (by, via) => {
      const frame = await client.call('gate-lock', { by, via });
      return { success: frame.success === true };
    },
    approvals: () => approvals,
    approvalAnswer: (id, approve, answerer) => {
      fire('approval-answer', { id, approve, by: answerer.by, via: answerer.via });
      return { success: approvals.some((a) => a.id === id) };
    },
    keyNames: async () => (await client.call('key-names')).entries as SecretsKeyInfo[],
    recipient: async () => String((await client.call('secret-recipient')).recipient),
    addBoard: async () => ({ added: (await client.call('board-add')).added === true }),
    storeCall: async (op, body) => {
      const { type: _type, ...answer } = await client.call(op, body);
      return answer;
    },
    inboxSubmit: async (item) => {
      await client.call('secret-submit', item);
      return { accepted: true };
    },
    inboxList: async () => (await client.call('inbox-list')).items as SecretsInboxItem[],
    inboxAnswer: async (payload, by, via) => {
      const frame = await client.call('inbox-answer', { ...payload, by, via });
      return { success: frame.success === true };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      closed = true;
      if (retry) clearTimeout(retry);
      current?.close();
      listeners.clear();
    }
  };
}
