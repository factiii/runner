import fs from 'fs/promises';
import net from 'net';
import path from 'path';
import { StringDecoder } from 'string_decoder';

import type {
  RunnerJobInfo,
  RunnerJobState,
  RunnerJobTargetWait
} from '../../domains/electron';
import type { BoardMcpChannel, BoardMcpRelay } from './board-mcp-relay';
import { hostSpacePaths } from './spacePaths';

// The socket behind `factiii-secrets` (apps/runner/plugin/factiii/bin). The
// agent runs an ordinary blocking command; this is what that command talks to.
//
// The CLI is a PROXY, not a carrier: it sends a command string plus the NAMES
// of the keys that command needs, and receives output. The decrypted values
// never leave the runner process, so they are never in an environment the
// agent can read, and the agent's turn does not have to end for the owner to
// authorize.
//
// Naming the keys is what makes the authorization card honest: the owner is
// shown the exact set the command will receive, and the command receives
// nothing else in the store. A request that names none gets none.
//
// The request also carries the caller's session token: the socket takes any
// connection from this user, so that is the only thing separating a session
// the runner spawned from anything else that found the node (secrets-gate.ts).
//
// Everything secret-shaped stays behind `handlers`: this file knows nothing
// about sops, age, or passwords, which is also what lets it be tested without
// either binary installed.

export type SecretsRunResult =
  | { denied: true }
  | { code: number; output: string };

/** One row of `factiii-secrets list`: a NAME, whether the store holds it,
 *  whether the deploy contract declares it, and what it is FOR. Never a
 *  value. */
export type SecretsKeyInfo = {
  key: string;
  /** The store has a value under this name. */
  stored: boolean;
  /** required-variables.json declares it. Undeclared-but-stored keys are
   *  reported too: hiding them would make `list` a worse answer to "what is
   *  in here" than the file it reads. */
  declared: boolean;
  /** Short label, '' when nobody has described the key yet. */
  title: string;
  /** What the key is for. This is the whole point of the row for an agent: a
   *  bare name tells it a credential exists, not which command wants it. */
  description: string;
  /** Grouping, 'general' by default. */
  category: string;
  /** 'file' for a sops blob, asked for with `--file`. Absent = an env key
   *  (and every row from an older runner). */
  kind?: 'env' | 'file';
  /** On a declared key the store lacks: the undeclared key it holds under a
   *  similar name (similarSecretKey.ts), likely the same credential stored
   *  under the wrong name. Absent when nothing is close, and from an older
   *  runner. */
  storedAs?: string;
};

/** A key name a shell can carry. Anything else is a confused caller, and
 *  quietly injecting it would put a name in the env no `$NAME` can read. */
const SECRET_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type SecretsBridgeHandlers = {
  /** Authorize the command with the owner, then run it with the values for
   *  `keys` - and only those - injected. `status` reports progress to the
   *  waiting CLI (the gate can sit open for as long as the owner takes).
   *  Output must already be redacted: the bridge writes it straight to a
   *  process the agent spawned. */
  run: (opts: {
    command: string;
    cwd: string;
    /** The names the caller asked for. Empty means the command gets no
     *  secrets at all, which is a legitimate (if pointless) request. */
    keys: string[];
    /** File secrets (sops blobs) the caller asked for with `--file`. Each
     *  reaches the command as a 0600 temp file whose path is in `$NAME`. An
     *  older CLI sends none. */
    files: string[];
    /** The caller's session token, verbatim and unvalidated - '' when it sent
     *  none. Only the handler knows which tokens this runner issued. */
    token: string;
    status: (text: string) => void;
  }) => Promise<SecretsRunResult>;
  /** Key NAMES and their status. Never values - nothing here can return one. */
  list: () => Promise<SecretsKeyInfo[]>;
  /** The runner's access token as it is now, for `factiii-expose`: frpc
   *  presents it to frps when it opens a tunnel, and nothing on disk holds it
   *  any more (.specs/runner-link.md, "Runner credential service"). Carries the
   *  session token; the handler refuses one this runner did not issue. The
   *  answer is that one token and nothing from the secrets store. Absent or
   *  throwing = this host opens no tunnels (desktop). */
  tunnelToken?: (token: string) => Promise<string>;
  /** The board's GitHub token as it is now, for git's credential helper in a
   *  session (`factiii-secrets git-credential`). Carries the session token;
   *  the handler refuses one this runner did not issue, and throws when the
   *  board has no GitHub connection. Absent = no GitHub credential here. */
  gitCredential?: (token: string) => Promise<string>;
  /** Open the board MCP for one agent (`factiii-board-mcp`, the stdio MCP
   *  server of the plugin; board-mcp-relay.ts). The one op that keeps its
   *  connection: after the answer `board-mcp-ready`, each line in either
   *  direction is one frame (see serveBoardMcp). Carries the session token;
   *  the handler throws for one this runner did not issue, and on a host with
   *  no runner token (desktop), before any call to the server. Absent = no
   *  board MCP here. `session` is the asking session's id, from its
   *  FACTIII_SESSION ('' from a bridge or session that predates it), for the
   *  session tools (session-card-tools.ts), and `sessionToken` its
   *  FACTIII_SESSION_TOKEN, verbatim and unvalidated ('' from a bridge or
   *  session that predates it): the handler checks it against `session`. */
  boardMcp?: (
    token: string,
    channel: BoardMcpChannel,
    session: string,
    sessionToken: string
  ) => Promise<BoardMcpRelay>;
  /** The space's jobs, for a session ON this runner (`factiii-runner job` in
   *  a Deploy-button run, a card or a terminal), which has no Factiii login
   *  to go through the server with. Each op carries the session token; the
   *  handler refuses one this runner did not issue. Absent = no jobs here. */
  jobs?: {
    list: (token: string) => Promise<RunnerJobInfo[]>;
    call: (
      token: string,
      job: string,
      params: Record<string, string>
    ) => Promise<{ callId: string }>;
    status: (
      token: string,
      callId: string,
      afterSeq: number
    ) => Promise<{
      state: RunnerJobState;
      exitCode: number | null;
      chunks: { seq: number; text: string }[];
      wait?: RunnerJobTargetWait;
    }>;
    /** Sessions on this runner act as the owner, so they may cancel any. */
    cancel: (token: string, callId: string) => Promise<{ cancelled: boolean }>;
  };
};

export type SecretsBridge = { close: () => Promise<void> };

/** Where the CLI looks for us: under the space's own `state` dir, so its
 *  walk-up search finds it from anywhere in the tree. */
export function secretsSocketPath(spaceDir: string): string {
  return path.join(hostSpacePaths(spaceDir).state, 'secrets.sock');
}

/**
 * Scrub every known secret value out of text before it reaches the agent, the
 * wire, or the journal.
 *
 * Values under 4 characters are skipped: they collide with ordinary words far
 * more often than they protect anything, and a redaction that eats half the
 * build log is its own kind of failure.
 */
export function redactor(values: string[]): (text: string) => string {
  // Longest first: when one value contains another, replacing the short one
  // first would split the long one and leave its tail in the clear.
  const significant = [...new Set(values.filter((v) => v.length >= 4))].sort(
    (a, b) => b.length - a.length
  );
  return (text) => {
    let out = text;
    for (const value of significant) {
      out = out.split(value).join('[REDACTED]');
    }
    return out;
  };
}

/** Thrown at a `tunnel-token` caller on a host with no runner token. */
export const NO_TUNNELS = 'This host opens no public tunnels.';

/** Thrown at a `git-credential` caller when the board has no GitHub
 *  connection (never made, or disconnected). */
export const NO_GITHUB =
  'This board has no GitHub connection. Connect GitHub in Setup > Sources.';

/** Thrown at a `board-mcp` caller on a host with no runner token. */
export const NO_BOARD_MCP =
  'This host has no board tools: it is not a paired runner.';

/** The longest line a `board-mcp` connection may send. The server takes 4 MB
 *  per request; a line past this is not a message, it is a broken client. */
const MAX_BOARD_MCP_LINE = 8 * 1024 * 1024;

type Reply = (message: Record<string, unknown>) => void;

/** One line of NDJSON per message, in both directions. */
function replier(conn: net.Socket): Reply {
  return (message) => {
    if (conn.destroyed) return;
    conn.write(`${JSON.stringify(message)}\n`);
  };
}

async function handleRun(
  request: Record<string, unknown>,
  handlers: SecretsBridgeHandlers,
  reply: Reply
): Promise<void> {
  const command =
    typeof request.command === 'string' ? request.command.trim() : '';
  if (!command) {
    reply({ type: 'error', message: 'No command was sent.' });
    return;
  }
  const cwd = typeof request.cwd === 'string' ? request.cwd : '';
  // A pre-key CLI sends no `keys` at all. It gets an empty set, same as one
  // that named none: the scope a caller did not state is not "everything".
  const requested = Array.isArray(request.keys) ? request.keys : [];
  const keys: string[] = [];
  for (const entry of requested) {
    if (typeof entry !== 'string' || !SECRET_KEY_PATTERN.test(entry)) {
      reply({
        type: 'error',
        message: `"${String(entry)}" is not a key name.`
      });
      return;
    }
    if (!keys.includes(entry)) keys.push(entry);
  }
  const asked = Array.isArray(request.files) ? request.files : [];
  const files: string[] = [];
  for (const entry of asked) {
    if (typeof entry !== 'string' || !SECRET_KEY_PATTERN.test(entry)) {
      reply({
        type: 'error',
        message: `"${String(entry)}" is not a file secret name.`
      });
      return;
    }
    if (!files.includes(entry)) files.push(entry);
  }
  const result = await handlers.run({
    command,
    cwd,
    keys,
    files,
    token: typeof request.token === 'string' ? request.token : '',
    status: (text) => reply({ type: 'status', text })
  });
  if ('denied' in result) {
    reply({ type: 'denied' });
    return;
  }
  if (result.output) reply({ type: 'output', chunk: result.output });
  reply({ type: 'exit', code: result.code });
}

/**
 * Serve the secrets socket for one space.
 *
 * Requests are SERIALISED. Each one opens the owner's authorization gate, and
 * that gate is a single slot: an agent that backgrounds two secret-bearing
 * commands would otherwise have the second overwrite the first's pending
 * prompt, losing a command the owner already approved. Queued callers are told
 * they are queued rather than left staring at a silent socket.
 */
export async function startSecretsBridge(opts: {
  spaceDir: string;
  handlers: SecretsBridgeHandlers;
}): Promise<SecretsBridge> {
  const socketPath = secretsSocketPath(opts.spaceDir);
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  // A crashed runner leaves the node behind, and listen() on an existing path
  // fails with EADDRINUSE. Nothing else owns this name.
  await fs.rm(socketPath, { force: true });

  const { handlers } = opts;
  let queue: Promise<void> = Promise.resolve();
  let queueDepth = 0;

  const live = new Set<net.Socket>();
  const server = net.createServer((conn) => {
    live.add(conn);
    conn.on('close', () => live.delete(conn));
    const reply = replier(conn);
    let buffer = '';
    let handled = false;
    // Set by the one op that keeps its connection (`board-mcp`): from then on
    // every chunk is that op's, and no line is read as a new request.
    let stream: ((chunk: Buffer) => void) | null = null;

    conn.on('error', () => {
      // The CLI going away mid-command is normal (a cancelled run kills the
      // agent's whole process tree). The queued work still settles.
    });

    conn.on('data', (chunk: Buffer) => {
      if (stream) {
        stream(chunk);
        return;
      }
      if (handled) return;
      buffer += chunk.toString('utf-8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      handled = true;

      let request: { op?: unknown } & Record<string, unknown>;
      try {
        request = JSON.parse(buffer.slice(0, newline)) as typeof request;
      } catch {
        reply({ type: 'error', message: 'Malformed request.' });
        conn.end();
        return;
      }

      if (request.op === 'list') {
        void handlers
          .list()
          // `entries`: each key with the status the CLI prints.
          .then((entries) => reply({ type: 'keys', entries }))
          .catch((err: unknown) =>
            reply({ type: 'error', message: errorText(err) })
          )
          .finally(() => conn.end());
        return;
      }

      // The board MCP for one agent. Not in the run queue, and the connection
      // stays open: what follows the first line is the stream.
      if (request.op === 'board-mcp') {
        stream = serveBoardMcp({
          conn,
          reply,
          open: handlers.boardMcp,
          token: tokenOf(request),
          session:
            typeof request.session === 'string' ? request.session : '',
          sessionToken:
            typeof request.sessionToken === 'string'
              ? request.sessionToken
              : '',
          rest: buffer.slice(newline + 1)
        });
        return;
      }

      // Not in the run queue: nothing is asked of the owner, and a tunnel
      // must not wait behind a command that sits at the authorization gate.
      if (request.op === 'tunnel-token') {
        const tunnelToken = handlers.tunnelToken;
        if (!tunnelToken) {
          reply({ type: 'error', message: NO_TUNNELS });
          conn.end();
          return;
        }
        void tunnelToken(tokenOf(request))
          .then((token) => reply({ type: 'tunnel-token', token }))
          .catch((err: unknown) =>
            reply({ type: 'error', message: errorText(err) })
          )
          .finally(() => conn.end());
        return;
      }

      // Not in the run queue either: git waits on this answer, and nothing is
      // asked of the owner.
      if (request.op === 'git-credential') {
        const gitCredential = handlers.gitCredential;
        if (!gitCredential) {
          reply({ type: 'error', message: NO_GITHUB });
          conn.end();
          return;
        }
        void gitCredential(tokenOf(request))
          .then((password) => reply({ type: 'git-credential', password }))
          .catch((err: unknown) =>
            reply({ type: 'error', message: errorText(err) })
          )
          .finally(() => conn.end());
        return;
      }

      if (
        request.op === 'job-list' ||
        request.op === 'job-call' ||
        request.op === 'job-status' ||
        request.op === 'job-cancel'
      ) {
        const jobs = handlers.jobs;
        if (!jobs) {
          reply({ type: 'error', message: 'This runner serves no jobs here.' });
          conn.end();
          return;
        }
        void handleJobOp(request, jobs, reply, conn)
          .catch((err: unknown) =>
            reply({ type: 'error', message: errorText(err) })
          )
          .finally(() => conn.end());
        return;
      }

      if (request.op !== 'run') {
        reply({ type: 'error', message: 'Unknown operation.' });
        conn.end();
        return;
      }

      // Tell the caller before it waits, not after: a queued command that
      // prints nothing for ten minutes reads as a hung tunnel.
      if (queueDepth > 0) {
        reply({
          type: 'status',
          text: 'queued behind another command awaiting authorization'
        });
      }
      queueDepth += 1;
      queue = queue
        .then(() => {
          // Gone while queued - its turn ended, or the run was cancelled.
          // Opening an authorization gate for a command nobody is waiting on
          // parks the run on a prompt that can no longer mean anything.
          if (conn.destroyed) return undefined;
          return handleRun(request, handlers, reply);
        })
        .catch((err: unknown) =>
          reply({ type: 'error', message: errorText(err) })
        )
        .finally(() => {
          queueDepth -= 1;
          conn.end();
        });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // Owner-only. It buys little on a host where the agent runs as this same
  // user, but it keeps the socket off-limits to every OTHER account on a
  // shared machine, which is exactly who the file mode can still stop.
  await fs.chmod(socketPath, 0o600).catch(() => undefined);

  return {
    close: async () => {
      // Destroy first, then close. `server.close` waits for every open
      // connection, and a `factiii-secrets` the agent backgrounded can still
      // be sitting at an authorization gate when the run finishes - waiting on
      // it would hang the runner on a prompt nobody is going to answer.
      for (const conn of live) conn.destroy();
      live.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(socketPath, { force: true });
    }
  };
}

/**
 * The `board-mcp` op: one agent's MCP connection to the board, on a socket
 * connection that stays open (board-mcp-relay.ts does the talking to the
 * server; this is only the wire).
 *
 * The first line is the request, like every op: `{ op: 'board-mcp', token,
 * session, sessionToken }`.
 * The answer is `{ type: 'board-mcp-ready' }`, or `{ type: 'error' }` and the
 * connection is closed. After `board-mcp-ready`, each line is one frame:
 *
 *   agent  -> runner  { type: 'mcp', message: <JSON-RPC message> }
 *   runner -> agent   { type: 'mcp', message: <JSON-RPC message> }
 *   runner -> agent   { type: 'log', text }     a line for the bridge's stderr
 *   runner -> agent   { type: 'error', message } fatal; the connection closes
 *
 * A frame has `type` and never `op`, and a request has `op` and never `type`,
 * so neither can be read as the other; a one-shot client never sees a frame,
 * because only this op sends them. Lines the agent sends before the answer
 * are kept and handled after it.
 *
 * Returns what takes the connection's bytes from here on.
 */
function serveBoardMcp(opts: {
  conn: net.Socket;
  reply: Reply;
  open: SecretsBridgeHandlers['boardMcp'];
  token: string;
  session: string;
  sessionToken: string;
  /** What arrived after the request line in the same chunk. */
  rest: string;
}): (chunk: Buffer) => void {
  const { conn, reply, open } = opts;
  if (!open) {
    reply({ type: 'error', message: NO_BOARD_MCP });
    conn.end();
    return () => undefined;
  }
  // Not chunk.toString(): a multi-byte character split over two chunks must
  // not become two broken ones in a card's text.
  const decoder = new StringDecoder('utf-8');
  let pending = opts.rest;
  let relay: BoardMcpRelay | null = null;
  let over = false;

  const stop = (message: string): void => {
    if (over) return;
    over = true;
    reply({ type: 'error', message });
    conn.end();
  };

  const drain = (): void => {
    // Until the relay is open the lines wait here, in order.
    while (relay && !over) {
      const newline = pending.indexOf('\n');
      if (newline === -1) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        frame = null;
      }
      if (
        typeof frame !== 'object' ||
        frame === null ||
        (frame as { type?: unknown }).type !== 'mcp' ||
        !('message' in frame)
      ) {
        stop('Malformed board MCP frame.');
        return;
      }
      relay.receive((frame as { message: unknown }).message);
    }
    if (pending.length > MAX_BOARD_MCP_LINE) stop('Board MCP frame too large.');
  };

  conn.on('close', () => {
    over = true;
    relay?.close();
  });

  void open(
    opts.token,
    {
      send: (message) => reply({ type: 'mcp', message }),
      log: (text) => reply({ type: 'log', text })
    },
    opts.session,
    opts.sessionToken
  )
    .then((opened) => {
      // Gone while the handler checked the token.
      if (over || conn.destroyed) {
        opened.close();
        return;
      }
      relay = opened;
      reply({ type: 'board-mcp-ready' });
      drain();
    })
    .catch((err: unknown) => stop(errorText(err)));

  return (chunk) => {
    if (over) return;
    pending += decoder.write(chunk);
    drain();
  };
}

/** How often a followed job call is polled for new output. */
const FOLLOW_POLL_MS = 500;
/** A job's exit code when it failed without one (it never started). */
const NOT_STARTED = 3;

const tokenOf = (request: Record<string, unknown>) =>
  typeof request.token === 'string' ? request.token : '';

/**
 * The job ops (see SecretsBridgeHandlers.jobs). Not in the run queue: a job
 * call returns at once, and the job waits its turn in the space's own job
 * queue and on the gate - holding the run queue for it would block every
 * `factiii-secrets run` in the space for the whole job.
 *
 * `job-call` with `follow: true` streams the call like `run` does: `output`
 * chunks as they arrive, then `exit` or `denied`.
 */
async function handleJobOp(
  request: Record<string, unknown>,
  jobs: NonNullable<SecretsBridgeHandlers['jobs']>,
  reply: Reply,
  conn: net.Socket
): Promise<void> {
  const token = tokenOf(request);
  if (request.op === 'job-list') {
    reply({ type: 'jobs', jobs: await jobs.list(token) });
    return;
  }
  if (request.op === 'job-cancel') {
    const callId = typeof request.callId === 'string' ? request.callId : '';
    const { cancelled } = await jobs.cancel(token, callId);
    reply({ type: 'cancelled', cancelled });
    return;
  }
  if (request.op === 'job-status') {
    const callId = typeof request.callId === 'string' ? request.callId : '';
    const afterSeq =
      typeof request.afterSeq === 'number' ? request.afterSeq : 0;
    reply({
      type: 'job-status',
      ...(await jobs.status(token, callId, afterSeq))
    });
    return;
  }
  // job-call
  const job = typeof request.job === 'string' ? request.job : '';
  const raw =
    request.params && typeof request.params === 'object'
      ? (request.params as Record<string, unknown>)
      : {};
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      reply({ type: 'error', message: `Param "${name}" must be a string.` });
      return;
    }
    params[name] = value;
  }
  const { callId } = await jobs.call(token, job, params);
  reply({ type: 'job-accepted', callId });
  if (request.follow !== true) return;

  let afterSeq = 0;
  let lastState = '';
  let lastWait = '';
  while (!conn.destroyed) {
    const status = await jobs.status(token, callId, afterSeq);
    // A wait on a target is re-sent each time its holder or place moves.
    const waitKey = status.wait ? JSON.stringify(status.wait) : '';
    if (status.state !== lastState || waitKey !== lastWait) {
      lastState = status.state;
      lastWait = waitKey;
      reply(
        status.wait
          ? { type: 'status', text: status.state, wait: status.wait }
          : { type: 'status', text: status.state }
      );
    }
    for (const chunk of status.chunks) {
      reply({ type: 'output', chunk: chunk.text });
      afterSeq = chunk.seq;
    }
    if (status.state === 'denied') {
      reply({ type: 'denied' });
      return;
    }
    if (status.state === 'cancelled') {
      reply({ type: 'cancelled', cancelled: true });
      return;
    }
    if (status.state === 'done' || status.state === 'failed') {
      reply({ type: 'exit', code: status.exitCode ?? NOT_STARTED });
      return;
    }
    await new Promise((r) => setTimeout(r, FOLLOW_POLL_MS));
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
