// The CLIs a session's chat can run (.specs/card-sessions.md "Chat"): what
// the chat needs of each, so chatRun.ts and chatTranscript.ts never ask which
// one it is. A session's chat runs the session's own CLI: headless, one run
// per turn, resuming its conversation, and reads the turn back from that
// CLI's own session file. The terminal is the same conversation in the CLI's
// full screen; only one of the two holds it at a time.
//
// A new CLI is one more entry in CHAT_CLIS: how it runs headless (spawnAgent
// knows its argv and its JSON stream), where its session files are and how
// to read a line of one, how to find it open in one of the session's tabs,
// close it there, and open it there again.

import type { AgentProvider, CodexAccess } from '../../domains/electron';
import type { SpawnAgentOptions } from '../board-agent-core/agent';
import { codexPermissionArgs } from '../board-agent-core/codex-permissions';
import type { ExecTarget } from '../board-agent-core/exec';
import { claudeHome, findAgentPane, SESSION_ID_RE } from './chatPane';
import { codexHome } from './chatHistory';
import { startTerminalAgent, stopTerminalAgent } from './chatTerminal';
import { parseTranscriptLine, type ChatEvent } from './chatTranscript';
import { findCodexPane, startCodexAgent, stopCodexAgent } from './codexPane';
import { parseCodexLine } from './codexTranscript';

/** The CLI open in one of the session's tabs. */
export type ChatPane = {
  /** tmux's id for the pane, `%4`. */
  paneId: string;
  /** The conversation open there, when the CLI records it (Claude does;
   *  Codex does not: the chat's own is taken to be the one). */
  conversation?: string;
  /** Where it runs, when the CLI records it. */
  cwd?: string;
  /** Close it (TERM, then KILL): the tab drops back to its shell. */
  stop: () => Promise<void>;
};

/** The headless run's options for spawnAgent, past the prompt and the
 *  session's env. */
export type HeadlessOptions = Pick<
  SpawnAgentOptions,
  'allowedTools' | 'permissionMode' | 'model'
>;

export type ChatCli = {
  id: AgentProvider;
  /** As the chat names it: "Claude", "Codex". */
  label: string;
  /** The session file of `conversation`, started in `cwd`; null when there
   *  is none yet. */
  transcriptFile: (
    target: ExecTarget,
    cwd: string,
    conversation: string
  ) => Promise<string | null>;
  /** The chat's events in one line of that file. */
  parseLine: (line: string) => ChatEvent[];
  findPane: (target: ExecTarget, postId: string) => Promise<ChatPane | null>;
  /** Open it in the session's first tab idle at its prompt (only `pane`,
   *  when given), on `conversation` when there is one. False when no tab is
   *  free. */
  openInTab: (
    target: ExecTarget,
    postId: string,
    conversation: string | undefined,
    opts: { pane?: string; codexAccess: CodexAccess }
  ) => Promise<boolean>;
  headless: (opts: {
    codexAccess: CodexAccess;
    /** The chat's /model, '' for the CLI's default. */
    model: string;
  }) => HeadlessOptions;
  /** Whether a new conversation's id is picked here, before the run
   *  (Claude's --session-id). Else the CLI names it as the run starts
   *  (Codex's thread.started), through spawnAgent's onSessionId. */
  namesNewConversation: boolean;
  /** What the CLI says when told to resume a conversation it does not
   *  have: the chat starts a new one with the same message. */
  noConversation: RegExp;
  /** What to type into it, open in a tab, for the chat's /clear and
   *  /compact. */
  typed: { clear: string; compact: string };
};

const claude: ChatCli = {
  id: 'claude',
  label: 'Claude',
  // `$CLAUDE_CONFIG_DIR/projects/<cwd slug>/<id>.jsonl`; the slug is the
  // CLI's own: every character but a letter or digit becomes `-`.
  transcriptFile: (target, cwd, conversation) =>
    Promise.resolve(
      SESSION_ID_RE.test(conversation)
        ? `${claudeHome(target)}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${conversation}.jsonl`
        : null
    ),
  parseLine: parseTranscriptLine,
  findPane: async (target, postId) => {
    const pane = await findAgentPane(target, postId);
    return pane
      ? {
          paneId: pane.paneId,
          conversation: pane.sessionId,
          cwd: pane.cwd,
          stop: () => stopTerminalAgent(target, pane)
        }
      : null;
  },
  openInTab: (target, postId, conversation, { pane }) =>
    startTerminalAgent(target, postId, conversation, pane),
  headless: ({ model }) => ({
    // As in the terminal: auto mode's classifier decides each action.
    allowedTools: '',
    permissionMode: 'auto',
    model: model || undefined
  }),
  namesNewConversation: true,
  noConversation: /no conversation found/i,
  typed: { clear: '/clear', compact: '/compact' }
};

/** Where each Codex conversation's file was found, by home and id: the
 *  file never moves, and finding it is a walk of every day's folder. */
const codexFiles = new Map<string, string>();

// The rollout file of thread $2 under Codex home $1, whichever day it
// started on. Nothing when there is none yet.
const CODEX_FIND_SCRIPT = [
  'for f in "$1"/sessions/*/*/*/rollout-*-"$2".jsonl; do',
  '  [ -f "$f" ] && { printf \'%s\' "$f"; exit 0; }',
  'done'
].join('\n');

const codex: ChatCli = {
  id: 'codex',
  label: 'Codex',
  // `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, one file
  // per conversation whatever folder it ran in (resumes append to it).
  transcriptFile: async (target, _cwd, conversation) => {
    if (!SESSION_ID_RE.test(conversation)) return null;
    const home = codexHome(target);
    if (!home) return null;
    const key = `${home}\0${conversation}`;
    const known = codexFiles.get(key);
    if (known) return known;
    const found = (
      await target
        .run(['sh', '-c', CODEX_FIND_SCRIPT, 'sh', home, conversation])
        .catch(() => '')
    ).trim();
    if (!found.startsWith('/')) return null;
    codexFiles.set(key, found);
    return found;
  },
  parseLine: parseCodexLine,
  findPane: async (target, postId) => {
    const pane = await findCodexPane(target, postId);
    return pane
      ? { paneId: pane.paneId, stop: () => stopCodexAgent(target, pane) }
      : null;
  },
  openInTab: (target, postId, conversation, { pane, codexAccess }) =>
    startCodexAgent(
      target,
      postId,
      conversation,
      // The board's access, as a terminal launch opens Codex.
      codexPermissionArgs({
        level: codexAccess,
        interactive: true,
        paths: target.paths
      }),
      pane
    ),
  // Its configured model: the chat's /model is Claude's only
  // (chatCommands.ts commandSupport).
  headless: ({ codexAccess }) => ({
    allowedTools: '',
    // codexArgs: 'auto' is the standard sandbox (codex-permissions.ts);
    // full access runs with no sandbox and no prompts, as in a tab.
    permissionMode: codexAccess === 'full' ? 'bypassPermissions' : 'auto'
  }),
  namesNewConversation: false,
  noConversation: /no rollout found|no conversation found/i,
  // Codex's word for /clear is /new.
  typed: { clear: '/new', compact: '/compact' }
};

export const CHAT_CLIS: Record<AgentProvider, ChatCli> = { claude, codex };

export const chatCli = (provider: AgentProvider | undefined): ChatCli =>
  CHAT_CLIS[provider ?? 'claude'] ?? claude;
