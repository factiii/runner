import type { ChildProcess } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import type { AuditLog } from './audit';
import { spaceEnv } from './host-deploy';
import { execLogin, killTree } from './host-env';
import {
  readSecretFileWithIdentity,
  secretsForIdentity,
  unwrapIdentity
} from './host-secrets';
import { isFailedPasswordAttempt } from './password-throttle';
import { redactor } from './secrets-bridge';
import type { SecretsGate } from './secrets-gate';
import {
  unlockMinutes,
  type UnlockWindow,
  type WindowActor
} from './secrets-window';

// Running one authorized command, for every origin there is: `factiii-secrets
// run` from any session the runner spawned (the deploy run's included), and a
// job call. It lived in the deploy run executor until the gate went
// space-level (secrets-gate.ts).

// An authorized command is often a whole release lane - two local EAS builds,
// or six notarized desktop targets - and those print all the way through. So
// silence is what marks a stuck one; the wall clock is only a backstop.
const COMMAND_IDLE_TIMEOUT_MS = 45 * 60_000;
const COMMAND_TIMEOUT_MS = 6 * 60 * 60_000;

/** How long a cancelled command gets to exit on SIGTERM before SIGKILL. */
const CANCEL_GRACE_MS = 10_000;

/** SIGTERM the command's whole process group now, SIGKILL whatever of the
 *  group is left after the grace period. The group, not the child: a job's
 *  shell has children (builds, uploads) that outlive a signal aimed at it. */
function cancelProcess(proc: ChildProcess, graceMs: number): void {
  killTree(proc, 'SIGTERM');
  const pid = proc.pid;
  if (pid === undefined) return;
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 0); // throws when the group is gone
    } catch {
      return;
    }
    killTree(proc, 'SIGKILL');
  }, graceMs);
  (timer as { unref?: () => void }).unref?.();
}

const tail = (s: string, max = 8000) => (s.length > max ? s.slice(-max) : s);

/** `cwd` when it sits inside the space dir, else null. Compared on the resolved
 *  path with a separator appended, so `<space>-other` cannot pass as `<space>`. */
export function containedCwd(cwd: string, spaceDir: string): string | null {
  if (!cwd) return null;
  const resolved = path.resolve(cwd);
  const root = path.resolve(spaceDir);
  return resolved === root || resolved.startsWith(root + path.sep)
    ? resolved
    : null;
}

/** A run's result, plus who opened the window it ran in (null = it was
 *  answered on its own, or denied). */
export type AuthorizedRunResult =
  | { denied: true }
  | { code: number; output: string; unlockedBy: string | null };

/** Where an action came from, for the audit log. */
export type AuditVia = 'api' | 'data-channel' | 'owner-terminal';

/**
 * Split text into what is safe to emit now and what must wait: a value can
 * straddle two chunks, so only complete lines are redacted and passed on, and
 * the partial last line waits for the rest of itself.
 */
function lineStreamer(
  redact: (text: string) => string,
  emit: (text: string) => void
): { push: (text: string) => void; flush: () => void } {
  let pending = '';
  return {
    push: (text) => {
      pending += text;
      const cut = pending.lastIndexOf('\n');
      if (cut === -1) {
        // A command printing one endless line must not grow this forever.
        if (pending.length < 64 * 1024) return;
        emit(redact(pending));
        pending = '';
        return;
      }
      emit(redact(pending.slice(0, cut + 1)));
      pending = pending.slice(cut + 1);
    },
    flush: () => {
      if (pending) emit(redact(pending));
      pending = '';
    }
  };
}

/** `KEY=value` (optionally `export KEY=value`) in a dotenv blob. */
const DOTENV_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/;
/** Dotenv values too common to redact without wrecking the log. */
const PLAIN_ENV_VALUE =
  /^(?:true|false|yes|no|on|off|production|development|staging|test|localhost|[0-9.:]+)$/i;
/** The shortest dotenv value redacted on its own. */
const MIN_ENV_VALUE = 6;

/** The names `gh` and most GitHub tooling read a token from. The runner's
 *  GitHub connection answers for these when the store has no value. */
export const GITHUB_TOKEN_KEYS: ReadonlySet<string> = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN'
]);

/** Every string worth redacting from one secret: the whole value, and for a
 *  multi-line one (a PEM key, a whole .env) each substantial line, because a
 *  command that prints part of it prints lines, not the whole. A dotenv line
 *  also gives its bare value: `docker compose config` or `echo
 *  "$DATABASE_URL"` prints the value without the `KEY=`. */
function redactionValues(value: string): string[] {
  const out = [value];
  if (value.includes('\n')) {
    for (const line of value.split('\n')) {
      if (line.trim().length >= 16) out.push(line.trim());
      const m = DOTENV_LINE.exec(line);
      if (!m) continue;
      const bare = m[1].replace(/^(['"])(.*)\1$/, '$2');
      if (bare.length >= MIN_ENV_VALUE && !PLAIN_ENV_VALUE.test(bare)) {
        out.push(bare);
      }
    }
  }
  return out;
}

/** A blob as text when it is text (an SSH key, an .env file), so it can be
 *  redacted; null for true binary (a .p12), which no log prints legibly. */
function asText(data: Buffer): string | null {
  if (data.includes(0)) return null;
  const text = data.toString('utf-8');
  return text.includes('\uFFFD') ? null : text;
}

/** Overwrite, then delete. The temp dir is 0700 and each file 0600, so this
 *  is about the disk, not other users. */
async function wipeDir(dir: string): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const file = path.join(dir, name);
    const size = (await fs.stat(file).catch(() => null))?.size ?? 0;
    if (size)
      await fs.writeFile(file, Buffer.alloc(size)).catch(() => undefined);
  }
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Authorize, decrypt for THIS spawn, run it with ONLY the requested keys in its
 * env, redact against the whole store, drop everything.
 *
 * Decrypting all of it to inject part of it is deliberate: the store is one
 * sops file, and the values that do NOT go in still feed the redactor.
 *
 * A free command (no `job`) prompts every time, even while an unlock window is
 * open: the window covers jobs only (.specs/runner-secrets-gate.md). Its
 * answer can still OPEN a window, for the jobs that follow. A job spawn inside
 * an open window runs without a prompt.
 */
export async function authorizeAndRun(opts: {
  configDir: string;
  spaceDir: string;
  /** Where to run it. The caller's cwd when it is inside the space. */
  cwd: string;
  command: string;
  /** The names the caller asked for, and the only ones injected. */
  keys: string[];
  /** File secrets (sops blobs) to hand over as 0600 temp files, each path in
   *  `$NAME`, wiped when the command ends. */
  files?: string[];
  /** Which session asked, already resolved from its token and shown to the
   *  owner on the prompt. */
  origin: string;
  gate: SecretsGate;
  /** The space's unlock window. Read only when `job` is set. */
  window?: UnlockWindow;
  /** The job this spawn runs, when it is one. Only a job can ride a window. */
  job?: string;
  /** Who asked, server-vouched, when it is not the owner's own session. */
  caller?: WindowActor;
  /** Who a free command's audit line names when no `caller` is set: the
   *  runner owner, whose session ran it. */
  auditActor?: WindowActor;
  /** Extra env for the command (a job's JOB_PARAM_* values). Never secret. */
  env?: Record<string, string>;
  /** The runner's own GitHub connection (Setup > Sources). It answers for
   *  GH_TOKEN and GITHUB_TOKEN when the store holds neither, so a board needs
   *  no second GitHub token typed into Secrets. A stored one still wins. */
  githubToken?: string;
  /** Wall-clock ceiling; defaults to the long release lane's. */
  timeoutMs?: number;
  audit?: AuditLog;
  via?: AuditVia;
  /** The deploy run's timeline. Absent for origins that have no log of their
   *  own - a terminal session sees the CLI's own stderr instead. */
  sendLog?: (entry: { type: string; content: string }) => void;
  /** Progress for the caller that is blocking on this (the CLI). */
  status?: (text: string) => void;
  /** Redacted output as it arrives, in whole lines. */
  onChunk?: (text: string) => void;
  /** The child, once it is running, so a caller can kill it. */
  onSpawn?: (proc: ChildProcess) => void;
  /** Told when the request starts waiting on a password holder, and when it
   *  starts running. A job's state follows these. */
  onPhase?: (phase: 'waiting-auth' | 'running') => void;
  /** Cancel: withdraws the gate request while waiting, and stops the running
   *  command (SIGTERM its group, SIGKILL after `cancelGraceMs`). The result
   *  is then a denial or the killed command's code; the caller knows it
   *  cancelled. Temp secret files are wiped as on any end. */
  signal?: AbortSignal;
  /** Tags this call's gate request, so a cancel withdraws exactly it. */
  tag?: string;
  cancelGraceMs?: number;
}): Promise<AuthorizedRunResult> {
  const { command, gate } = opts;
  const scope = opts.keys;
  const files = opts.files ?? [];
  const clash = files.find((name) => scope.includes(name));
  if (clash) {
    throw new Error(
      `${clash} is asked for as both a key and a file; one name can hold only one of them.`
    );
  }
  const shown = [...scope, ...files];
  const forJob = Boolean(opts.job);
  if (opts.signal?.aborted) return { denied: true };
  const tag = opts.tag;
  const onAbort = () => {
    if (tag) gate.withdrawTag(tag);
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const audit = (record: Parameters<AuditLog['append']>[0]) =>
    opts.audit ? opts.audit.append(record) : Promise.resolve();
  // A free command is audited too (spec: every secret-bearing run is in the
  // log), as the owner's session, with the origin and who answered.
  const sessionActor = opts.caller ??
    opts.auditActor ?? { userId: '', name: 'Owner' };
  let approvedBy: WindowActor | null = null;

  // A job inside an open window needs nobody. A free command never looks.
  let identity = forJob ? (opts.window?.identity() ?? null) : null;
  let unlockedBy = identity ? (opts.window?.holder()?.name ?? null) : null;

  if (!identity) {
    opts.onPhase?.('waiting-auth');
    opts.status?.(
      shown.length
        ? `waiting for the owner to authorize this command (${shown.join(', ')})`
        : 'waiting for the owner to authorize this command (no secrets requested)'
    );
  }

  // Wrong password re-prompts the SAME command with the error shown; it must
  // never kill the run.
  let error = '';
  while (!identity) {
    const auth = await gate.request({
      command,
      keys: shown,
      origin: opts.origin,
      error,
      caller: opts.caller,
      job: opts.job,
      tag,
      // A job waits its turn rather than bumping (or being bumped by) a
      // session's prompt; see secrets-gate.ts.
      queued: forJob
    });
    if ('denied' in auth) {
      opts.signal?.removeEventListener('abort', onAbort);
      // A cancel is audited by whoever cancelled, not as a denial. Every
      // answer line (denied here, run below) has one rule: `actor` is who
      // answered, `via` is the road the COMMAND came by; the caller goes in
      // the detail.
      if (forJob && opts.caller && !opts.signal?.aborted) {
        await audit({
          actor: auth.by ?? opts.caller,
          via: opts.via ?? 'api',
          action: 'denied',
          job: opts.job ?? null,
          keys: shown,
          command,
          exitCode: null,
          durationMs: null,
          unlockedBy: null,
          detail: `caller: ${opts.caller.name} (${opts.caller.userId})`
        });
      }
      if (!forJob && !opts.signal?.aborted) {
        await audit({
          actor: auth.by ?? sessionActor,
          via: opts.via ?? 'owner-terminal',
          action: 'denied',
          job: null,
          keys: shown,
          command,
          exitCode: null,
          durationMs: null,
          unlockedBy: null,
          detail: `free command from ${opts.origin}; caller: ${sessionActor.name}`
        });
      }
      return { denied: true };
    }
    if ('windowed' in auth) {
      identity = opts.window?.identity() ?? null;
      unlockedBy = identity ? (opts.window?.holder()?.name ?? null) : null;
      continue;
    }
    try {
      identity = await unwrapIdentity(opts.configDir, auth.password);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      opts.status?.(`authorization failed: ${error}`);
      // Every failed guess is on the record, with who typed it; the limit
      // itself is in unwrapIdentity (password-throttle.ts).
      if (isFailedPasswordAttempt(err)) {
        await audit({
          // Who typed it, not who called the job.
          actor: auth.by ?? { userId: '', name: 'Unknown' },
          via: auth.via ?? 'data-channel',
          action: 'auth-failed',
          job: opts.job ?? null,
          keys: shown,
          command,
          exitCode: null,
          durationMs: null,
          unlockedBy: null,
          detail: error
        });
      }
      continue;
    }
    approvedBy = auth.by ?? null;
    const minutes = unlockMinutes(auth.unlockFor, forJob);
    if (opts.window && minutes > 0) {
      const by = auth.by ?? opts.caller ?? { userId: '', name: 'Owner' };
      opts.window.open(identity, minutes, by);
      unlockedBy = by.name;
      await audit({
        actor: by,
        // The answerer's road, not the job's: a job called through the server
        // is still unlocked by a password typed on a data channel.
        via: auth.via ?? 'data-channel',
        action: 'unlock',
        job: opts.job ?? null,
        keys: [],
        command: null,
        exitCode: null,
        durationMs: minutes * 60_000,
        unlockedBy: by.name
      });
    }
  }

  opts.signal?.removeEventListener('abort', onAbort);
  if (opts.signal?.aborted) return { denied: true };
  const store = await secretsForIdentity(opts.spaceDir, identity);

  const injected: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of scope) {
    if (key in store) injected[key] = store[key];
    else if (GITHUB_TOKEN_KEYS.has(key) && opts.githubToken) {
      injected[key] = opts.githubToken;
    } else missing.push(key);
  }
  // Say it rather than let the command fail on an empty variable: an unset key
  // and a misspelled one look identical from inside the command.
  if (missing.length) {
    const note = `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the store, so the command sees ${missing.length === 1 ? 'it' : 'them'} empty.`;
    opts.status?.(note);
    opts.sendLog?.({ type: 'system', content: note });
  }

  // The WHOLE store, not just what was injected: see the note above.
  const secrets = Object.values(store).flatMap(redactionValues);
  // The connection's token too: it is not in the store, and a command that
  // was handed it can print it like any other.
  if (opts.githubToken) secrets.push(...redactionValues(opts.githubToken));

  // File secrets: decrypted into a private temp dir for this spawn only.
  let tempDir: string | null = null;
  const fileEnv: Record<string, string> = {};
  try {
    if (files.length) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'factiii-secrets-'));
      await fs.chmod(tempDir, 0o700);
      for (const name of files) {
        const data = await readSecretFileWithIdentity(
          opts.spaceDir,
          identity,
          name
        );
        const file = path.join(tempDir, name);
        await fs.writeFile(file, data, { mode: 0o600 });
        const text = asText(data);
        if (text) secrets.push(...redactionValues(text));
        data.fill(0);
        fileEnv[name] = file;
      }
    }

    const redact = redactor(secrets);
    const names = [...Object.keys(injected), ...files];
    opts.status?.('authorized, running');
    opts.onPhase?.('running');
    opts.sendLog?.({
      type: 'system',
      content: `Authorized. Running the command with ${
        names.length ? `${names.join(', ')} injected` : 'no secrets injected'
      }...`
    });
    const stream = opts.onChunk ? lineStreamer(redact, opts.onChunk) : null;
    const started = Date.now();
    // Login-shell execution, stdin closed (execLogin): the same environment the
    // checker validated, with no way for shell-init prompts to hang a deploy.
    const res = await execLogin(command, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...spaceEnv(opts.spaceDir),
        ...(opts.env ?? {}),
        ...injected,
        ...fileEnv
      },
      timeout: opts.timeoutMs ?? COMMAND_TIMEOUT_MS,
      idleTimeout: COMMAND_IDLE_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      onChunk: stream ? (text) => stream.push(text) : undefined,
      onSpawn: (proc) => {
        opts.onSpawn?.(proc);
        const signal = opts.signal;
        if (!signal) return;
        const stop = () =>
          cancelProcess(proc, opts.cancelGraceMs ?? CANCEL_GRACE_MS);
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      }
    });
    stream?.flush();
    if (!forJob) {
      await audit({
        actor: approvedBy ?? sessionActor,
        via: opts.via ?? 'owner-terminal',
        action: 'run',
        job: null,
        keys: names,
        command,
        exitCode: res.code,
        durationMs: Date.now() - started,
        unlockedBy,
        detail: `free command from ${opts.origin}; caller: ${sessionActor.name}; approved`
      });
    }
    const output = redact(res.output);
    opts.sendLog?.({ type: 'tool', content: `$ ${command}\n${tail(output)}` });
    return { code: res.code, output, unlockedBy };
  } finally {
    if (tempDir) await wipeDir(tempDir);
  }
}
