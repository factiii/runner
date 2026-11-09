// The chat's own agent: the session's CLI (chatCli.ts) headless (`claude -p`,
// `codex exec --json`), one run per turn, each resuming the session's
// conversation. Structured where the terminal is a screen: nothing it asks
// can sit unseen on a menu, and Stop ends the turn. The chat reads the turn
// back from the CLI's transcript (chatTranscript.ts, codexTranscript.ts), the
// same file whichever of the two ran it.
//
// The terminal is the backup (chatTerminal.ts, codexPane.ts): opening it
// resumes the same conversation in the CLI's full screen, once any turn here
// has finished, and the next message here closes that CLI, carries on from
// it, and opens it again in its tab when the turn ends. Only one of the two
// holds the conversation at a time.

import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';

import type { AgentProvider } from '../../domains/electron';
import { spawnAgent } from '../board-agent-core/agent';
import {
  CODEX_ACCESS_DEFAULT,
  type CodexAccess
} from '../board-agent-core/codex-permissions';
import { type ExecTarget, sessionToken } from '../board-agent-core/exec';
import { killTree } from '../board-agent-core/host-env';
import { sessionPortsEnv } from '../board-agent-core/port-blocks';
import { CHAT_CLIS, type ChatCli, chatCli } from './chatCli';
import {
  commandSupport,
  MODEL_RE,
  type RunnerChatCommand
} from './chatCommands';
import { SESSION_ID_RE } from './chatPane';
import { CHAT_SEND_MAX, ChatSendError, typeInPane } from './chatTerminal';

/** Whether `cli` wrote `conversation`'s transcript (started in `cwd`). */
async function transcriptExists(
  cli: ChatCli,
  target: ExecTarget,
  cwd: string,
  conversation: string
): Promise<boolean> {
  const file = await cli.transcriptFile(target, cwd, conversation);
  if (!file) return false;
  const out = await target
    .run(['sh', '-c', '[ -s "$1" ] && echo yes', 'sh', file])
    .catch(() => '');
  return out.trim() === 'yes';
}

/** Where the chat stands with the terminal, after asking to open it. */
export type ChatTerminalState =
  /** The CLI is open in a tab now, or was already. */
  | 'open'
  /** A turn is running here; the CLI opens in the terminal when it ends. */
  | 'after-turn'
  /** Every tab is busy (a dev server, a command): nowhere to open it. */
  | 'no-tab';

/** Who has the conversation while it is not in the terminal, for the terminal
 *  to say so instead of looking like a plain shell. */
export type ChatHold =
  /** A chat turn is running, headless: the CLI is in no tab. */
  | 'turn'
  /** The CLI is being opened in a tab (after a turn, or asked for). */
  | 'opening'
  /** Neither: the CLI is in a tab, or nowhere until someone opens it. */
  | '';

type Run = {
  proc: ChildProcess | null;
  /** Sent while a turn ran: the next turn takes them together. */
  queue: string[];
  stopped: boolean;
  /** Open the terminal on the conversation once the run is over. */
  toTerminal: boolean;
  /** The tab whose CLI the run closed to take the conversation: it opens
   *  again there once the run is over, however it ended. */
  reopenPane: string | null;
  /** The session's CLI, fixed for the run. */
  cli: ChatCli;
};

type Deps = {
  target: (postId: string) => ExecTarget | null;
  /** Where the session's CLI runs: its worktree, or the workspace. The
   *  terminal's tabs start there too, so `--resume` finds the conversation
   *  either way (the CLI keys transcripts by cwd). */
  cwd: (postId: string) => string;
  /** The conversation kept with the session, and keeping it there ('' to
   *  forget it). */
  stored: (postId: string) => string | undefined;
  store: (postId: string, conversation: string) => void;
  /** A turn started (true) or the last queued one ended (false). The rail
   *  reads its Working/Idle dot from the terminal's hooks, which a chat turn
   *  (headless, in no tab) never fires, so this tells it instead. */
  onRunning?: (postId: string, running: boolean) => void;
  /** The chat's hold on the conversation moved (see ChatHold): a turn
   *  started, ended, or the CLI finished opening in a tab. The terminal
   *  shows this, and clears it the moment the CLI is there. */
  onHold?: (postId: string, hold: ChatHold) => void;
  /** The board's Codex access (codex-permissions.ts), read when the chat
   *  runs Codex or opens it in a tab. Absent: standard. */
  codexAccess?: () => CodexAccess;
  /** The session's CLI, which the chat runs (chatCli.ts). Absent: Claude. */
  provider?: (postId: string) => AgentProvider | undefined;
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
  /** The CLI being opened in the terminal, per session: a second open waits
   *  on it, and a turn waits so it finds (and closes) that CLI, so two CLIs
   *  never hold one transcript. */
  private opening = new Map<string, Promise<ChatTerminalState>>();
  /** The hold last reported through onHold, per session ('' is absent). */
  private holds = new Map<string, ChatHold>();

  constructor(private deps: Deps) {}

  /** The session's CLI, which its chat runs. */
  cli(postId: string): ChatCli {
    return chatCli(this.deps.provider?.(postId));
  }

  private codexAccess(): CodexAccess {
    return this.deps.codexAccess?.() ?? CODEX_ACCESS_DEFAULT;
  }

  model(postId: string): string {
    return this.models.get(postId) ?? '';
  }

  conversation(postId: string): string | undefined {
    return this.conversations.get(postId) ?? this.deps.stored(postId);
  }

  running(postId: string): boolean {
    return this.runs.has(postId);
  }

  /** Whether the chat has the conversation now, and how (ChatHold). */
  hold(postId: string): ChatHold {
    if (this.runs.has(postId)) return 'turn';
    return this.opening.has(postId) ? 'opening' : '';
  }

  /** Report the hold when it moved. Called wherever `runs` or `opening`
   *  changes. */
  private syncHold(postId: string): void {
    const hold = this.hold(postId);
    if ((this.holds.get(postId) ?? '') === hold) return;
    if (hold) this.holds.set(postId, hold);
    else this.holds.delete(postId);
    this.deps.onHold?.(postId, hold);
  }

  /** A terminal tab is being created for the session. While the chat holds
   *  the conversation the tab must not resume (or brief) a CLI of its own: two
   *  CLIs would write one transcript. True then, and the CLI opens in the
   *  first idle tab once the turn ends, as asking from the chat would. */
  claimTab(postId: string): boolean {
    const run = this.runs.get(postId);
    if (run) {
      run.toTerminal = true;
      return true;
    }
    return this.opening.has(postId);
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
      toTerminal: false,
      reopenPane: null,
      cli: this.cli(postId)
    };
    this.runs.set(postId, run);
    this.errors.delete(postId);
    this.deps.onRunning?.(postId, true);
    this.syncHold(postId);
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
    return this.openTerminal(postId);
  }

  /** Open the session's CLI in the terminal on the chat's conversation, in
   *  `pane` only when given. One open at a time per session (see
   *  `opening`). */
  private openTerminal(
    postId: string,
    pane?: string
  ): Promise<ChatTerminalState> {
    const pending = this.opening.get(postId);
    if (pending) return pending;
    const opening = (async (): Promise<ChatTerminalState> => {
      const target = this.deps.target(postId);
      if (!target) return 'no-tab';
      const cli = this.cli(postId);
      // Already open (the user opened it again): never a second CLI.
      if (await cli.findPane(target, postId)) return 'open';
      const opened = await cli.openInTab(
        target,
        postId,
        this.conversation(postId),
        { pane, codexAccess: this.codexAccess() }
      );
      return opened ? 'open' : 'no-tab';
    })().finally(() => {
      if (this.opening.get(postId) === opening) this.opening.delete(postId);
      this.syncHold(postId);
    });
    this.opening.set(postId, opening);
    this.syncHold(postId);
    return opening;
  }

  /** The chat's /resume: carry on `conversation` with the CLI that recorded
   *  it, in the session's first idle tab. Whatever agent is open in the
   *  terminal is closed first, so the tab holds only the picked one. A
   *  conversation of the session's own CLI becomes the chat's too: the chat
   *  shows it, and its next message carries it on. The other CLI's opens in
   *  the terminal only. */
  async resume(
    postId: string,
    provider: AgentProvider,
    conversation: string
  ): Promise<ChatTerminalState> {
    if (!SESSION_ID_RE.test(conversation)) {
      throw new ChatSendError('That is not a conversation this runner has.');
    }
    const own = this.cli(postId);
    if (this.runs.has(postId)) {
      throw new ChatSendError(
        `${own.label} is on a turn here. Stop it, or let it finish, then resume.`
      );
    }
    const target = this.deps.target(postId);
    if (!target) throw new ChatSendError('No active session for this card.');
    // A CLI still opening (a reopen after a turn) is closed with the rest,
    // not raced: the two would be two CLIs on one transcript.
    await this.opening.get(postId)?.catch(() => 'no-tab');
    const open = await Promise.all(
      Object.values(CHAT_CLIS).map((c) => c.findPane(target, postId))
    );
    for (const pane of open) if (pane) await pane.stop();
    if (provider !== own.id) {
      return (await CHAT_CLIS[provider].openInTab(
        target,
        postId,
        conversation,
        { codexAccess: this.codexAccess() }
      ))
        ? 'open'
        : 'no-tab';
    }
    this.remember(postId, conversation);
    // Through the one-open-at-a-time guard, on the conversation just
    // remembered.
    return this.openTerminal(postId);
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
    const cli = CHAT_CLIS[provider];
    if (command === 'compact') {
      if (provider === 'claude') {
        // The headless CLI runs /compact as a turn of its own, and the
        // transcript shows what it printed. Queued behind a running turn.
        this.send(postId, model ? `/compact ${model}` : '/compact');
        return 'Compacting the conversation.';
      }
      // `codex exec` takes no slash commands: /compact is its full
      // screen's, typed into the Codex open in the terminal.
      const pane = await cli.findPane(target, postId);
      if (!pane) {
        throw new ChatSendError(
          `${cli.label} compacts on its own screen: open the terminal, then /compact again.`
        );
      }
      await typeInPane(target, pane.paneId, cli.typed.compact);
      return `${cli.label} is compacting the conversation in the terminal.`;
    }
    if (this.runs.has(postId)) {
      throw new ChatSendError(
        `${cli.label} is on a turn here. Stop it, or let it finish, first.`
      );
    }
    const pane = await cli.findPane(target, postId);
    if (command === 'clear') {
      // Open in the terminal: cleared there (Codex's /new). Claude's record
      // names the new conversation, so the chat follows it; Codex keeps no
      // record, so the chat lets go of the old one. Else the next message
      // starts one.
      if (pane) await typeInPane(target, pane.paneId, cli.typed.clear);
      if (!pane?.conversation) this.forget(postId);
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
      const cli = run.cli;
      // A CLI still opening in the terminal is looked for once it is open.
      await this.opening.get(postId)?.catch(() => 'no-tab');
      // The CLI open in the terminal holds the conversation: close it, and
      // carry on whichever conversation it had when it records one (a
      // `/clear` or `/resume` in Claude moves it). It opens again in its tab
      // when the run ends.
      const pane = await cli.findPane(target, postId);
      if (pane) {
        run.reopenPane = pane.paneId;
        await pane.stop();
        if (pane.conversation) this.remember(postId, pane.conversation);
      }
      // One retry as a new conversation when the kept one is gone.
      let retried = false;
      while (run.queue.length > 0 && !run.stopped) {
        const prompt = run.queue.splice(0).join('\n\n');
        const resume = this.conversation(postId);
        // A first turn's conversation is known as it starts, so the chat
        // reads it while it runs: Claude takes the id it is given; Codex
        // names its thread first thing (onSessionId).
        let fresh: string | undefined =
          resume || !cli.namesNewConversation ? undefined : randomUUID();
        if (fresh) this.conversations.set(postId, fresh);
        const named = (id: string) => {
          if (resume || fresh || !SESSION_ID_RE.test(id)) return;
          fresh = id;
          this.conversations.set(postId, id);
        };
        try {
          const { proc, result } = await spawnAgent(cli.id, target, {
            cwd: this.deps.cwd(postId),
            prompt,
            // The chat's /model (Claude's); the CLI's default without one.
            ...cli.headless({
              codexAccess: this.codexAccess(),
              model: this.models.get(postId) ?? ''
            }),
            resumeSessionId: resume,
            sessionId: cli.namesNewConversation ? fresh : undefined,
            // Which session this is, for the board MCP's session tools, and
            // the secret that proves it (exec.ts sessionToken). Its own
            // ports too, as its terminal tabs have (port-blocks.ts).
            env: {
              ...sessionPortsEnv(target.paths.root, postId),
              FACTIII_SESSION: postId,
              FACTIII_SESSION_TOKEN: sessionToken(target.paths.root, postId)
            },
            callbacks: { onSessionId: named }
          });
          run.proc = proc;
          const { sessionId } = await result;
          const kept = sessionId || resume || fresh;
          if (kept) this.remember(postId, kept);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (run.stopped) {
            // Stopped before it wrote anything: nothing to resume.
            if (
              fresh &&
              !(await transcriptExists(
                cli,
                target,
                this.deps.cwd(postId),
                fresh
              ))
            ) {
              this.conversations.delete(postId);
            }
          } else if (resume && !retried && cli.noConversation.test(message)) {
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
      this.deps.onRunning?.(postId, false);
      // Asked for from the chat: any idle tab. Else back in the tab the run
      // closed it in, or nowhere when that tab is gone or busy.
      if (run.toTerminal || run.reopenPane) {
        await this.openTerminal(
          postId,
          run.toTerminal ? undefined : (run.reopenPane ?? undefined)
        ).catch(() => 'no-tab');
      }
      // Nothing to open: the hold ends with the run. (An open reports its own
      // end, once the CLI is in its tab.)
      this.syncHold(postId);
    }
  }
}
