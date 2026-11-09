import type {
  AgentProvider,
  TerminalClientMessage,
  TerminalServerMessage
} from '../../domains/electron';
import { isCardPostId } from '../board-agent-core/boardTerminal';
import { type ExecTarget, sessionToken } from '../board-agent-core/exec';
import { sessionPortsEnv } from '../board-agent-core/port-blocks';
import {
  respawnTmuxPane,
  resurrectSave,
  safeTmuxName,
  setTmuxSessionOption,
  startTmuxSession,
  tmuxCli,
  type TmuxSession,
  tmuxSessionExists
} from '../board-agent-core/tmux';
import { chunkWire } from '../wireChunk';
import { TERMINAL_FP_OPTION, terminalDigest } from './digest';
import { terminalInitScript } from './initScript';

// One shell per (data channel, sessionId), streamed back only on the
// originating channel - never broadcast to paired devices.

type Send = (frame: string) => void;

// tmux session names must be filesystem-safe. We prefix to namespace our
// sessions away from anything the user might create manually.
export function tmuxName(terminalKey: string): string {
  return `terminal-${safeTmuxName(terminalKey)}`;
}

/** A tab's env: the space's, the session's own FACTIII_PORTS block
 *  (port-blocks.ts; the board's for a session with none), which session it
 *  belongs to (FACTIII_SESSION), which the board MCP's session tools go by
 *  (session-card-tools.ts), with the secret that proves it
 *  (FACTIII_SESSION_TOKEN, exec.ts sessionToken). */
export function sessionEnv(
  target: ExecTarget,
  postId: string
): Record<string, string> {
  return {
    ...target.stateEnv(),
    ...sessionPortsEnv(target.paths.root, postId),
    FACTIII_SESSION: postId,
    FACTIII_SESSION_TOKEN: sessionToken(target.paths.root, postId)
  };
}

/**
 * Restart one tab's process on a freshly built init command. The tmux session
 * survives, so the tab keeps its place and an attached client stays attached;
 * only what ran inside it dies.
 *
 * No resume id and no card brief: a restart drops to a bare shell. Passing them
 * would boot a second agent on a card that may already have one.
 */
export async function restartTerminalSession(opts: {
  target: ExecTarget;
  postId: string;
  terminalKey: string;
  cwd: string;
}): Promise<void> {
  const { target, postId, terminalKey, cwd } = opts;
  await respawnTmuxPane({
    target,
    session: tmuxName(terminalKey),
    argv: ['bash', '-c', terminalInitScript(cwd, target.paths.bin)],
    cwd,
    // Rebuilt rather than inherited: picking up an env the session was created
    // too early to see is half the reason to restart at all.
    env: sessionEnv(target, postId)
  }).catch(() => {
    // The pane can go between the caller's decision and this call - best
    // effort, like killTmuxSession.
  });
  // The pane now runs today's build. Without this the tab reads stale forever
  // and the prompt never clears.
  await terminalDigest(target)
    .then((digest) =>
      setTmuxSessionOption(
        target,
        tmuxName(terminalKey),
        TERMINAL_FP_OPTION,
        digest
      )
    )
    .catch(() => {
      // Worst case the tab is asked about once more.
    });
}

export class TerminalManager {
  private sessions = new Map<string, TmuxSession>();

  constructor(
    private send: Send,
    private getCardTarget: (postId: string) => ExecTarget | null,
    // The card's agent cwd (its worktree). The terminal must cd here so a
    // --resume finds the CLI thread keyed by that dir.
    private getCardWorkdir: (postId: string) => string | null
  ) {}

  /** Terminals this link has attached now (the runner owner's Remote
   *  connections counts them per link). */
  get openCount(): number {
    return this.sessions.size;
  }

  handle(msg: TerminalClientMessage): void {
    switch (msg.op) {
      case 'open':
        void this.open(msg);
        return;
      case 'stdin':
        this.stdin(msg.sessionId, msg.data);
        return;
      case 'resize':
        void this.resize(msg.sessionId, msg.cols, msg.rows);
        return;
      case 'close':
        this.close(msg.sessionId);
        return;
      case 'kill':
        void this.killTmuxSession(msg.postId, msg.terminalKey);
        return;
      case 'restart':
        void this.restart(msg.postId, msg.terminalKey);
        return;
    }
  }

  private async open(
    msg: Extract<TerminalClientMessage, { op: 'open' }>
  ): Promise<void> {
    if (this.sessions.has(msg.sessionId)) {
      this.emitError(msg.sessionId, 'Session already open.');
      return;
    }

    const target = this.getCardTarget(msg.postId);
    if (!target) {
      this.emitError(
        msg.sessionId,
        `No active card session for postId=${msg.postId}.`
      );
      return;
    }

    const tmuxSession = tmuxName(msg.terminalKey);
    // Only when there's no thread to resume: a resumed conversation already
    // knows the card. The id check is what keeps the prompt shell-inert -
    // synthetic launcher/board ids never reach a command line.
    const cardPostId =
      msg.briefCard && !msg.resumeAgentSessionId && isCardPostId(msg.postId)
        ? msg.postId
        : undefined;

    const init = this.buildInit(target, msg.postId, {
      resumeAgentSessionId: msg.resumeAgentSessionId,
      provider: msg.resumeProvider,
      cardPostId
    });

    // Before the attach-or-create below: the only moment the two can be told
    // apart. Stamping an existing session would erase the staleness we are
    // looking for.
    const creating = !(await tmuxSessionExists(target, tmuxSession));

    try {
      const session = await startTmuxSession({
        target,
        session: tmuxSession,
        // Attach if it exists, else create. This is what makes the shell
        // survive modal close/reopen: the server holds it, we just view.
        attachExisting: true,
        size: { cols: msg.cols, rows: msg.rows },
        // Without these, `claude` in the shell reads the default ~/.claude and
        // asks to sign in, while the agent spawns (which pass agentEnv) don't.
        env: sessionEnv(target, msg.postId),
        argv: init.argv
      });

      this.sessions.set(msg.sessionId, session);

      // A session created now runs today's config by definition. Sessions
      // predating the stamp carry none and read as stale, which is honest.
      if (creating) {
        // The layout changed, so write it out. On create and close rather
        // than on a timer: a save every fifteen minutes loses the tab made
        // three minutes before a crash.
        void resurrectSave(target);
        void terminalDigest(target)
          .then((digest) =>
            setTmuxSessionOption(
              target,
              tmuxSession,
              TERMINAL_FP_OPTION,
              digest
            )
          )
          .catch(() => {
            // An unstamped session reads as stale and prompts once. Cheap
            // enough that it must never block opening a terminal.
          });
      }

      session.onData((data) =>
        this.emit({
          type: 'terminal',
          op: 'stdout',
          sessionId: msg.sessionId,
          data: data.toString('base64')
        })
      );

      session.onError((err) => {
        this.cleanup(msg.sessionId);
        this.emitError(msg.sessionId, err.message);
      });

      session.onClose((code) => {
        if (!this.sessions.has(msg.sessionId)) return;
        this.cleanup(msg.sessionId);
        this.emit({
          type: 'terminal',
          op: 'exit',
          sessionId: msg.sessionId,
          code
        });
      });

      this.emit({ type: 'terminal', op: 'opened', sessionId: msg.sessionId });
    } catch (err) {
      this.emitError(
        msg.sessionId,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /** What tmux runs for a tab, and where. One builder so `open` and `restart`
   *  cannot drift. */
  private buildInit(
    target: ExecTarget,
    postId: string,
    agent?: {
      resumeAgentSessionId?: string;
      provider?: AgentProvider;
      cardPostId?: string;
    }
  ): { argv: string[]; cwd: string } {
    const cwd = this.getCardWorkdir(postId) || target.paths.workspace;
    return {
      cwd,
      argv: [
        'bash',
        '-c',
        terminalInitScript(
          cwd,
          target.paths.bin,
          agent?.resumeAgentSessionId,
          agent?.provider,
          agent?.cardPostId
        )
      ]
    };
  }

  /** Restart the tab's process while keeping the tab. */
  private async restart(postId: string, terminalKey: string): Promise<void> {
    const target = this.getCardTarget(postId);
    if (!target) return;
    await restartTerminalSession({
      target,
      postId,
      terminalKey,
      cwd: this.getCardWorkdir(postId) || target.paths.workspace
    });
  }

  private stdin(sessionId: string, b64: string): void {
    this.sessions.get(sessionId)?.write(Buffer.from(b64, 'base64'));
  }

  private async resize(
    sessionId: string,
    cols: number,
    rows: number
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    if (cols < 1 || rows < 1) return;
    await session.resize(cols, rows).catch(() => {
      // session died between the client's resize and ours
    });
  }

  private close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Drop it first: killing our own client must not read as the session
    // ending. The server keeps the bash for the next attach.
    this.sessions.delete(sessionId);
    session.detach();
  }

  /** Tear down the tmux session for a tab. Used when the user explicitly
   *  removes a tab (the X button), not on transient detach. */
  private async killTmuxSession(
    postId: string,
    terminalKey: string
  ): Promise<void> {
    const target = this.getCardTarget(postId);
    if (!target) return;
    await target
      .sh(
        `${tmuxCli(target)} kill-session -t ${tmuxName(terminalKey)} 2>/dev/null || true`
      )
      .catch(() => {
        // session may already be gone — best-effort
      });
    // One fewer tab to bring back after a reboot.
    await resurrectSave(target);
  }

  destroyAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.close(sessionId);
    }
  }

  private cleanup(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private emitError(sessionId: string, message: string): void {
    this.emit({ type: 'terminal', op: 'error', sessionId, message });
  }

  private emit(msg: TerminalServerMessage): void {
    const wire = JSON.stringify(msg);
    for (const frame of chunkWire(wire)) this.send(frame);
  }
}
