import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import type {
  PendingDangerousApproval,
  PendingSecretsAuth,
  RunnerJobEndState,
  RunnerJobInfo,
  RunnerJobState,
  RunnerJobTargetWait,
  SecretsInboxItem,
  SecretsUnlockWindow
} from '@shared/all/domains/electron';
import { AuditLog } from '@shared/all/helpers/board-agent-core/audit';
import {
  REQUIRED_VARIABLES_PATH,
  requiredVariableKeys
} from '@shared/all/helpers/board-agent-core/host-deploy';
import {
  readSecretMeta,
  runnerRecipient,
  secretsInitialized,
  spaceKeyDir,
  storedSecretFiles,
  storedSecretKeys
} from '@shared/all/helpers/board-agent-core/host-secrets';
import type { JobTargets } from '@shared/all/helpers/board-agent-core/job-targets';
import { filledCommand, JobRunner } from '@shared/all/helpers/board-agent-core/jobs';
import {
  type OwnerApprovalAnswerer,
  type OwnerApprovalChange,
  type OwnerApprovalResult,
  OwnerApprovals
} from '@shared/all/helpers/board-agent-core/owner-approval';
import { describeSecret } from '@shared/all/helpers/board-agent-core/secret-descriptions';
import type { SecretsKeyInfo } from '@shared/all/helpers/board-agent-core/secrets-bridge';
import { type SecretsAuthResult, SecretsGate } from '@shared/all/helpers/board-agent-core/secrets-gate';
import { type InboxSubmit, SecretsInbox } from '@shared/all/helpers/board-agent-core/secrets-inbox';
import { type AuditVia, authorizeAndRun } from '@shared/all/helpers/board-agent-core/secrets-run';
import { UnlockWindow, type WindowActor } from '@shared/all/helpers/board-agent-core/secrets-window';

import { assertOpsPath, type OpsClone } from './opsClone';
import { createOpsStore, type OpsStore } from './store';

// One board on the ops half (.specs/ops-user.md): its store, gate, unlock
// window, dangerous approvals, inbox and job runner, built from the same
// shared modules the in-process runner uses, so the allowlist, the param env,
// the dangerous/approval rule, targets and redaction are the ones already
// tested there. What changes is only where it runs (the ops user) and where a
// job runs from (the ops clone, assertOpsPath).
//
// Everything this hands the socket server is names, states and redacted
// output. Nothing here reads a value except authorizeAndRun, for one spawn.

export type CallMeta = {
  job: string;
  caller: WindowActor;
  startedAt: string;
};

/** What a `job-stream` connection receives. */
export type StreamFrame =
  | {
      type: 'job-state';
      callId: string;
      state: RunnerJobState;
      via: AuditVia;
      wait?: RunnerJobTargetWait;
      meta?: CallMeta;
    }
  | { type: 'job-log'; callId: string; seq: number; text: string }
  | {
      type: 'job-end';
      callId: string;
      state: RunnerJobEndState;
      exitCode: number | null;
    }
  | {
      type: 'gate';
      pending: PendingSecretsAuth | null;
      unlocked: SecretsUnlockWindow | null;
    }
  | { type: 'approvals'; pending: PendingDangerousApproval[] }
  | { type: 'approval'; change: OwnerApprovalChange };

export type OpsBoard = {
  slug: string;
  jobList(): Promise<RunnerJobInfo[]>;
  jobCall(opts: {
    job: string;
    params: Record<string, string>;
    caller: WindowActor;
    via: AuditVia;
    callId?: string;
    from?: string;
    mayRunDangerous: boolean;
  }): Promise<{ callId: string }>;
  jobStatus: JobRunner['status'];
  jobCancel: JobRunner['cancel'];
  jobActive: JobRunner['active'];
  recipient(): Promise<string>;
  secretSubmit(item: InboxSubmit): Promise<{ accepted: true }>;
  inboxList(): Promise<SecretsInboxItem[]>;
  inboxAnswer: SecretsInbox['answer'];
  gateState(): { pending: PendingSecretsAuth | null; unlocked: SecretsUnlockWindow | null };
  gateAnswer(id: string, result: SecretsAuthResult): { success: boolean };
  gateLock(by: WindowActor, via: AuditVia): Promise<{ success: boolean }>;
  approvals(): PendingDangerousApproval[];
  approvalAnswer(id: string, approve: boolean, answerer: OwnerApprovalAnswerer): { success: boolean };
  keyNames(): Promise<SecretsKeyInfo[]>;
  auditRead: AuditLog['read'];
  /** The store-local actions (store.ts): writes and re-keys, names only. */
  store: OpsStore;
  /** The stream: a snapshot first, then every change. */
  subscribe(listener: (frame: StreamFrame) => void): () => void;
  snapshot(): StreamFrame[];
  destroy(): void;
};

/** How a dangerous approval ended, for its audit line (as the engine's). */
function answerText(result: OwnerApprovalResult): string {
  if (result.approved) return 'approved this call';
  if (result.reason === 'denied') return 'denied';
  if (result.reason === 'timeout') return 'no answer in 10 minutes';
  return 'withdrawn (cancelled)';
}

export function createOpsBoard(opts: {
  slug: string;
  opsHome: string;
  /** `<ops home>/boards/<slug>`: secrets/, audit.jsonl, inbox, meta. */
  spaceDir: string;
  clone: OpsClone;
  githubToken: () => string;
  targets: JobTargets;
  /** The ops user's uid, for the clone's owner check. */
  uid?: number;
  /** Override for tests: how a job spawn is authorized and run. */
  execute?: typeof authorizeAndRun;
}): OpsBoard {
  const { spaceDir, clone } = opts;
  const keyDir = spaceKeyDir(spaceDir);
  fs.mkdirSync(spaceDir, { recursive: true, mode: 0o700 });
  const gate = new SecretsGate();
  const window = new UnlockWindow();
  const audit = new AuditLog(spaceDir);
  const approvals = new OwnerApprovals();
  const execute = opts.execute ?? authorizeAndRun;
  const listeners = new Set<(frame: StreamFrame) => void>();
  const meta = new Map<string, CallMeta>();
  const emit = (frame: StreamFrame) => {
    for (const listener of listeners) listener(frame);
  };
  const gateFrame = (): StreamFrame => ({
    type: 'gate',
    pending: gate.pending(),
    unlocked: window.state()
  });

  // As SpaceCore does: a window opening releases the jobs queued behind the
  // prompt that opened it.
  window.subscribe(() => {
    if (window.identity() !== null) {
      gate.settleQueued((request) => (request.job ? { windowed: true } : null));
    }
    emit(gateFrame());
  });
  gate.subscribe(() => emit(gateFrame()));
  approvals.subscribe((change) => emit({ type: 'approval', change }));

  const inbox = new SecretsInbox({
    configDir: keyDir,
    spaceDir,
    gate,
    audit,
    // The server opened a row per submit; the session half closes it.
    onEnd: (submitId, state) => emit({ type: 'job-end', callId: submitId, state, exitCode: null })
  });
  void inbox.resume().catch(() => undefined);

  const runner = new JobRunner({
    load: () => clone.loadJobs(),
    prepare: () => clone.prepare(),
    execute: (args) => {
      // A job runs from the ops clone and nowhere else, whatever prepare said.
      const cwd = assertOpsPath(args.cwd, opts.opsHome, opts.uid);
      return execute({
        configDir: keyDir,
        spaceDir,
        cwd,
        command: args.def.command,
        keys: args.def.keys,
        files: args.def.files,
        githubToken: opts.githubToken() || undefined,
        origin: `Job ${args.def.name} · ${args.caller.name}`,
        gate,
        window,
        job: args.def.name,
        caller: args.caller,
        env: { ...args.env, WORKSPACE: cwd },
        timeoutMs: args.def.timeoutMin * 60_000,
        audit,
        via: args.via,
        onChunk: args.onChunk,
        onSpawn: args.onSpawn,
        onPhase: args.onPhase,
        signal: args.signal,
        tag: args.callId
      });
    },
    askOwner: async ({ signal, def, env, caller, via }) => {
      const command = filledCommand(def, env);
      const result = await approvals.request(
        {
          job: def.name,
          command,
          caller: { userId: String(caller.userId), name: caller.name },
          spaceSlug: opts.slug
        },
        signal
      );
      const answered = 'by' in result;
      await audit.append({
        actor: answered ? result.by : caller,
        via: answered ? result.via : via,
        action: result.approved ? 'dangerous-approve' : 'dangerous-deny',
        job: def.name,
        keys: [...def.keys, ...def.files],
        command,
        exitCode: null,
        durationMs: null,
        unlockedBy: null,
        detail: `${answerText(result)}; caller: ${caller.name} (${caller.userId})`
      });
      return result.approved;
    },
    targets: { store: opts.targets, board: opts.slug },
    audit,
    onLog: (callId, seq, text) => emit({ type: 'job-log', callId, seq, text }),
    onEnd: (callId, state, exitCode) => {
      emit({ type: 'job-end', callId, state, exitCode });
      meta.delete(callId);
    },
    onState: (callId, state, via, wait) =>
      emit({
        type: 'job-state',
        callId,
        state,
        via,
        ...(wait ? { wait } : {}),
        ...(meta.has(callId) ? { meta: meta.get(callId) } : {})
      })
  });

  return {
    slug: opts.slug,
    jobList: () => runner.list(),
    jobCall: async (call) => {
      // The meta must be known before the runner's first onState, which
      // fires inside call(): the stream's mirror keys its rows on it.
      const callId = call.callId || randomUUID();
      meta.set(callId, {
        job: call.job,
        caller: call.caller,
        startedAt: new Date().toISOString()
      });
      try {
        return await runner.call({ ...call, callId });
      } catch (err) {
        meta.delete(callId);
        throw err;
      }
    },
    jobStatus: (callId, afterSeq, viewer) => runner.status(callId, afterSeq, viewer),
    jobCancel: (callId, by, via, byOwner) => runner.cancel(callId, by, via, byOwner),
    jobActive: (onlyUserId) => runner.active(onlyUserId),
    recipient: async () => {
      if (!(await secretsInitialized(keyDir))) {
        throw new Error('This board has no secrets password yet.');
      }
      return runnerRecipient(keyDir);
    },
    secretSubmit: (item) => inbox.submit(item),
    inboxList: () => inbox.list(),
    inboxAnswer: (payload, by, via) => inbox.answer(payload, by, via),
    gateState: () => ({ pending: gate.pending(), unlocked: window.state() }),
    gateAnswer: (id, result) => gate.answer(id, result),
    gateLock: async (by, via) => {
      const holder = window.holder();
      if (window.lock()) {
        await audit.append({
          actor: by,
          via,
          action: 'lock',
          job: null,
          keys: [],
          exitCode: null,
          durationMs: null,
          unlockedBy: holder?.name ?? null
        });
      }
      return { success: true };
    },
    approvals: () => approvals.pending(),
    approvalAnswer: (id, approve, answerer) => ({
      success: approvals.answer(id, approve, answerer)
    }),
    keyNames: async () => {
      const [env, files, described, contract] = await Promise.all([
        storedSecretKeys(spaceDir),
        storedSecretFiles(spaceDir),
        readSecretMeta(spaceDir),
        clone.readOrigin(REQUIRED_VARIABLES_PATH).catch(() => null)
      ]);
      const declared = new Map(requiredVariableKeys(contract ?? '').map((v) => [v.key, v.kind]));
      const kinds = new Map<string, 'env' | 'file'>();
      for (const k of env) kinds.set(k, 'env');
      for (const f of files) kinds.set(f, 'file');
      for (const [k, kind] of declared) if (!kinds.has(k)) kinds.set(k, kind === 'file' ? 'file' : 'env');
      const stored = new Set([...env, ...files]);
      return [...kinds.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, kind]) => ({
          key,
          kind,
          stored: stored.has(key),
          declared: declared.has(key),
          ...describeSecret(described[key], undefined)
        }));
    },
    auditRead: (query) => audit.read(query),
    store: createOpsStore({
      slug: opts.slug,
      opsHome: opts.opsHome,
      spaceDir,
      audit,
      lockWindow: () => {
        window.lock();
      }
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => [
      gateFrame(),
      { type: 'approvals', pending: approvals.pending() },
      ...runner.active().map(
        (c): StreamFrame => ({
          type: 'job-state',
          callId: c.callId,
          state: c.state,
          via: 'api',
          ...(c.wait ? { wait: c.wait } : {}),
          meta: { job: c.job, caller: c.actor, startedAt: c.startedAt }
        })
      )
    ],
    destroy: () => {
      approvals.destroy();
      runner.destroy();
      inbox.destroy();
      gate.destroy();
      window.destroy();
      listeners.clear();
    }
  };
}
