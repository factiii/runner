// The chat's own Claude: headless (`claude -p`), one run per turn, each
// resuming the session's conversation. Structured where the terminal is a
// screen: nothing it asks can sit unseen on a menu, and Stop ends the turn.
// The chat reads the turn back from the CLI's transcript (chatTranscript.ts),
// the same file whichever of the two ran it.
//
// The terminal is the backup (chatTerminal.ts): opening it resumes the same
// conversation in Claude's full screen, once any turn here has finished, and
// the next message here closes that Claude and carries on from it. Only one
// of the two holds the conversation at a time.

import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';

import type { AgentProvider } from '../../domains/electron';
import { spawnAgent } from '../board-agent-core/agent';
import { type ExecTarget, sessionToken } from '../board-agent-core/exec';
import { killTree } from '../board-agent-core/host-env';
import {
  commandSupport,
  MODEL_RE,
  type RunnerChatCommand
} from './chatCommands';
import { claudeHome, findAgentPane, SESSION_ID_RE } from './chatPane';
import {
  CHAT_SEND_MAX,
  ChatSendError,
  startTerminalAgent,
  stopTerminalAgent,
  typeInPane
} from './chatTerminal';
import { findCodexPane, startCodexAgent, stopCodexAgent } from './codexPane';

/** What the CLI says when `--resume` names a conversation it does not have. */
const NO_CONVERSATION = /no conversation found/i;

/** Whether the CLI wrote `conversation`'s transcript under `cwd`. */
async function transcriptExists(
  target: ExecTarget,
  cwd: string,
  conversation: string
): Promise<boolean> {
  const out = await target
    .run([
      'sh',
      '-c',
      'f="$1/projects/$(printf \'%s\' "$2" | sed \'s/[^A-Za-z0-9]/-/g\')/$3.jsonl"; [ -s "$f" ] && echo yes',
      'sh',
      claudeHome(target),
      cwd,
      conversation
    ])
    .catch(() => '');
  return out.trim() === 'yes';
}

/** Where the chat stands with the terminal, after asking to open it. */
export type ChatTerminalState =
  /** Claude is open in a tab now, or was already. */
  | 'open'
  /** A turn is running here; Claude opens in the terminal when it ends. */
  | 'after-turn'
  /** Every tab is busy (a dev server, a command): nowhere to open it. */
  | 'no-tab';

type Run = {
  proc: ChildProcess | null;
  /** Sent while a turn ran: the next turn takes them together. */
  queue: string[];
  stopped: boolean;
  /** Open the terminal on the conversation once the run is over. */
  toTerminal: boolean;
};

type Deps = {
  target: (postId: string) => ExecTarget | null;
  /** Where the session's Claude runs: its worktree, or the workspace. The
   *  terminal's tabs start there too, so `--resume` finds the conversation
   *  either way (the CLI keys transcripts by cwd). */
  cwd: (postId: string) => string;
  /** The conversation kept with the session, and keeping it there ('' to
   *  forget it). */
  stored: (postId: string) => string | undefined;
  store: (postId: string, conversation: string) => void;
};

export class ChatRuns {
  private runs = new Map<string, Run>();
  /** The conversation the chat runs, per session: stored with the session
   *  where it is one (terminal mode), else for as long as the runner runs. */
  private conversations = new Map<string, string>();
  /** Why the last turn failed (not signed in, the CLI missing), until the
   *  next one starts. */
  private errors = new Map<string, string>();
  /** Turns finished per session, however they ended: a message sent before
   *  one finished either reached the transcript or failed, so the chat stops
   *  showing it as on its way. */
  private finished = new Map<string, number>();
  /** The model picked with the chat's /model, per session, for as long as
   *  the runner runs. None: the CLI's own default. */
  private models = new Map<string, string>();

  constructor(private deps: Deps) {}

  model(postId: string): string {
    return this.models.get(postId) ?? '';
  }

  conversation(postId: string): string | undefined {
    return this.conversations.get(postId) ?? this.deps.stored(postId);
  }

  running(postId: string): boolean {
    return this.runs.has(postId);
  }

  error(postId: string): string {
    return this.errors.get(postId) ?? '';
  }

  turns(postId: string): number {
    return this.finished.get(postId) ?? 0;
  }

  /** Run `text` as the next turn, or queue it behind the one running. */
  send(postId: string, text: string): void {
    if (typeof text !== 'string') throw new ChatSendError('Nothing to send.');
    const body = text.trim();
    if (!body) return;
    if (body.length > CHAT_SEND_MAX) {
      throw new ChatSendError(
        'That message is too long to send from the chat.'
      );
    }
    if (!this.deps.target(postId)) {
      throw new ChatSendError('No active session for this card.');
    }
    const running = this.runs.get(postId);
    if (running) {
      running.queue.push(body);
      return;
    }
    // Registered before anything awaits, so a second send queues behind it.
    const run: Run = {
      proc: null,
      queue: [body],
      stopped: false,
      toTerminal: false
    };
    this.runs.set(postId, run);
    this.errors.delete(postId);
    void this.drive(postId, run);
  }

  /** End the running turn and drop what was queued. False with no turn. */
  stop(postId: string): boolean {
    const run = this.runs.get(postId);
    if (!run) return false;
    run.stopped = true;
    run.queue = [];
    // TERM, so the CLI writes out what the turn did before it goes.
    if (run.proc) killTree(run.proc, 'SIGTERM');
    return true;
  }

  /** Open the conversation in the terminal: now, or when the turn ends. */
  async toTerminal(postId: string): Promise<ChatTerminalState> {
    const run = this.runs.get(postId);
    if (run) {
      run.toTerminal = true;
      return 'after-turn';
    }
    const target = this.deps.target(postId);
    if (!target) return 'no-tab';
    if (await findAgentPane(target, postId)) return 'open';
    const opened = await startTerminalAgent(
      target,
      postId,
      this.conversation(postId)
    );
    return opened ? 'open' : 'no-tab';
  }

  /** The chat's /resume: carry on `conversation` with the CLI that recorded
   *  it, in the session's first idle tab. Whatever agent is open in the
   *  terminal is closed first, so the tab holds only the picked one. A
   *  Claude conversation becomes the chat's too: the chat shows it, and its
   *  next message carries it on. */
  async resume(
    postId: string,
    provider: AgentProvider,
    conversation: string
  ): Promise<ChatTerminalState> {
    if (!SESSION_ID_RE.test(conversation)) {
      throw new ChatSendError('That is not a conversation this runner has.');
    }
    if (this.runs.has(postId)) {
      throw new ChatSendError(
        'Claude is on a turn here. Stop it, or let it finish, then resume.'
      );
    }
    const target = this.deps.target(postId);
    if (!target) throw new ChatSendError('No active session for this card.');
    const [claude, codex] = await Promise.all([
      findAgentPane(target, postId),
      findCodexPane(target, postId)
    ]);
    if (claude) await stopTerminalAgent(target, claude);
    if (codex) await stopCodexAgent(target, codex);
    if (provider === 'codex') {
      return (await startCodexAgent(target, postId, conversation))
        ? 'open'
        : 'no-tab';
    }
    this.remember(postId, conversation);
    return (await startTerminalAgent(target, postId, conversation))
      ? 'open'
      : 'no-tab';
  }

  /** One of the chat's shared commands, mapped to what `provider`'s CLI
   *  takes (chatCommands.ts). Resolves to a line saying what happened. */
  async command(
    postId: string,
    provider: AgentProvider,
    command: RunnerChatCommand,
    arg: string
  ): Promise<string> {
    const support = commandSupport(provider, command);
    if (!support.ok) throw new ChatSendError(support.reason);
    const target = this.deps.target(postId);
    if (!target) throw new ChatSendError('No active session for this card.');
    const model = arg.trim();
    if (command === 'model' && !MODEL_RE.test(model)) {
      throw new ChatSendError('Name a model: /model opus, /model sonnet, …');
    }
    if (provider === 'codex') {
      // The chat cannot run Codex itself yet: its commands go to the Codex
      // open in the terminal, typed as there. Codex's word for /clear is /new.
      const pane = await findCodexPane(target, postId);
      if (!pane) {
        throw new ChatSendError(
          'Codex is not open in the terminal. Resume a conversation or open the terminal first.'
        );
      }
      await typeInPane(target, pane.paneId, command === 'clear' ? '/new' : '/compact');
      return command === 'clear'
        ? 'Codex started a new conversation in the terminal.'
        : 'Codex is compacting the conversation in the terminal.';
    }
    if (command === 'compact') {
      // The headless CLI runs /compact as a turn of its own, and the
      // transcript shows what it printed. Queued behind a running turn.
      this.send(postId, model ? `/compact ${model}` : '/compact');
      return 'Compacting the conversation.';
    }
    if (this.runs.has(postId)) {
      throw new ChatSendError(
        'Claude is on a turn here. Stop it, or let it finish, first.'
      );
    }
    const pane = await findAgentPane(target, postId);
    if (command === 'clear') {
      // Open in the terminal: cleared there, and the chat follows the new
      // conversation its record names. Else the next message starts one.
      if (pane) await typeInPane(target, pane.paneId, '/clear');
      else this.forget(postId);
      return 'The next message starts a new conversation.';
    }
    if (model === 'default') this.models.delete(postId);
    else this.models.set(postId, model);
    if (pane) await typeInPane(target, pane.paneId, `/model ${model}`);
    return model === 'default'
      ? "Back on Claude's default model."
      : `Claude runs on ${model} from the next message.`;
  }

  private remember(postId: string, conversation: string) {
    this.conversations.set(postId, conversation);
    this.deps.store(postId, conversation);
  }

  private forget(postId: string) {
    this.conversations.delete(postId);
    this.deps.store(postId, '');
  }

  private async drive(postId: string, run: Run): Promise<void> {
    try {
      const target = this.deps.target(postId);
      if (!target) return;
      // A Claude open in the terminal holds the conversation: close it, and
      // carry on whichever conversation it had (a `/clear` or `/resume` there
      // moves it).
      const pane = await findAgentPane(target, postId);
      if (pane) {
        await stopTerminalAgent(target, pane);
        this.remember(postId, pane.sessionId);
      }
      // One retry as a new conversation when the kept one is gone.
      let retried = false;
      while (run.queue.length > 0 && !run.stopped) {
        const prompt = run.queue.splice(0).join('\n\n');
        const resume = this.conversation(postId);
        // A first turn names its conversation, so the chat reads it while
        // it runs.
        const fresh = resume ? undefined : randomUUID();
        if (fresh) this.conversations.set(postId, fresh);
        try {
          const { proc, result } = await spawnAgent('claude', target, {
            cwd: this.deps.cwd(postId),
            prompt,
            // As in the terminal: auto mode's classifier decides each action.
            allowedTools: '',
            permissionMode: 'auto',
            resumeSessionId: resume,
            sessionId: fresh,
            // The chat's /model; the CLI's default without one.
            model: this.models.get(postId) || undefined,
            // Which session this is, for the board MCP's session tools, and
            // the secret that proves it (exec.ts sessionToken).
            env: {
              FACTIII_SESSION: postId,
              FACTIII_SESSION_TOKEN: sessionToken(target.paths.root, postId)
            },
            callbacks: {}
          });
          run.proc = proc;
          const { sessionId } = await result;
          this.remember(postId, sessionId || resume || fresh!);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (run.stopped) {
            // Stopped before it wrote anything: nothing to resume.
            if (
              fresh &&
              !(await transcriptExists(target, this.deps.cwd(postId), fresh))
            ) {
              this.conversations.delete(postId);
            }
          } else if (resume && !retried && NO_CONVERSATION.test(message)) {
            // The kept conversation is gone (stopped before it was written,
            // or cleaned away): start a new one with the same message.
            retried = true;
            this.forget(postId);
            run.queue.unshift(prompt);
          } else {
            if (fresh) this.conversations.delete(postId);
            this.errors.set(postId, message);
            run.queue = [];
          }
        } finally {
          run.proc = null;
          this.finished.set(postId, this.turns(postId) + 1);
        }
      }
    } finally {
      this.runs.delete(postId);
      if (run.toTerminal) await this.toTerminal(postId).catch(() => 'no-tab');
    }
  }
}
