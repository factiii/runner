// The terminal side of a session's chat. The chat runs its own Claude,
// headless, one run per turn (chatRun.ts); the terminal is where the same
// conversation goes for what only Claude's full screen has (its menus,
// settings, sign-in). Only one of the two holds the conversation at a time:
// opening the terminal resumes it in the session's first idle tab, and the
// next chat message closes that Claude again (stopTerminalAgent) and carries
// on from what it did.
//
// A tab is only ever typed into at its shell prompt, found on the runner: a
// tab running a dev server, or Claude itself, is never typed over.

import type { ExecTarget } from '../board-agent-core/exec';
import { tmuxCli } from '../board-agent-core/tmux';
import {
  type AgentPane,
  claudeHome,
  findAgentPane,
  SESSION_ID_RE
} from './chatPane';
import { CLAUDE_PERMISSION_MODE } from './initScript';
import { tmuxName } from './terminal';

/** A chat message is a prompt, not a document. */
export const CHAT_SEND_MAX = 20_000;

export class ChatSendError extends Error {}

/** What a tab's foreground process is called while it sits at its prompt. */
const SHELLS = new Set(['bash', 'zsh', 'sh']);

/** The session's first tab sitting at its shell prompt: a dev server or any
 *  other foreground process is never typed over. */
export async function idleShellPane(
  target: ExecTarget,
  postId: string
): Promise<string | null> {
  const prefix = `${tmuxName(postId)}-`;
  const out = await target
    .sh(
      `${tmuxCli(target)} list-panes -a -F '#{session_name} #{pane_id} #{pane_current_command}'`
    )
    .catch(() => '');
  const idle: { tab: number; paneId: string }[] = [];
  for (const line of out.split('\n')) {
    const [session, paneId, command] = line.trim().split(' ');
    if (!session?.startsWith(prefix) || !paneId || !command) continue;
    // Digits after the prefix: `abc-1`, not another card `abc-def`'s tab.
    const tab = session.slice(prefix.length);
    if (!/^\d+$/.test(tab) || !/^%\d+$/.test(paneId)) continue;
    if (SHELLS.has(command.replace(/^-/, ''))) {
      idle.push({ tab: parseInt(tab, 10), paneId });
    }
  }
  idle.sort((a, b) => a.tab - b.tab);
  return idle[0]?.paneId ?? null;
}

// Marks a folder trusted in the CLI's own config ($1/.claude.json), as
// answering "Yes, I trust this folder" would, through a temp file and a rename
// so a Claude running elsewhere never reads it half-written.
const TRUST_SCRIPT = `
const fs = require('fs');
const [file, dir] = process.argv.slice(1);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
cfg.projects = cfg.projects || {};
const p = cfg.projects[dir] || {};
if (p.hasTrustDialogAccepted) process.exit(0);
cfg.projects[dir] = { ...p, hasTrustDialogAccepted: true };
const tmp = file + '.' + process.pid + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
fs.renameSync(tmp, file);
`;

/** The trust prompt is drawn before the conversation comes back, and the
 *  chat already ran Claude there headless (where it never asks). The folder is
 *  the runner's own (its workspace or a session worktree). */
async function trustFolder(target: ExecTarget, pane: string): Promise<void> {
  const dir = (
    await target.sh(
      `${tmuxCli(target)} display-message -p -t ${pane} '#{pane_current_path}'`
    )
  ).trim();
  if (!dir.startsWith('/')) return;
  await target
    .run([
      'node',
      '-e',
      TRUST_SCRIPT,
      `${claudeHome(target)}/.claude.json`,
      dir
    ])
    .catch(() => {
      // Worst case Claude asks, and the terminal is one click away.
    });
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Open Claude in the session's first tab idle at its prompt, on
 *  `conversation` when there is one. False when no tab is free. */
export async function startTerminalAgent(
  target: ExecTarget,
  postId: string,
  conversation: string | undefined
): Promise<boolean> {
  const shell = await idleShellPane(target, postId);
  if (!shell) return false;
  await trustFolder(target, shell);
  // Validated rather than quoted: an id is a uuid, anything else starts a new
  // conversation.
  const resume =
    conversation && SESSION_ID_RE.test(conversation)
      ? ` --resume ${conversation}`
      : '';
  await typeInPane(target, shell, `claude ${CLAUDE_PERMISSION_MODE}${resume}`);
  return true;
}

/** Type one line into a pane and press Enter: a command at a shell prompt,
 *  or a slash command into the CLI open there (the chat's /clear, /model).
 *  The caller builds `line` from validated parts. */
export async function typeInPane(
  target: ExecTarget,
  pane: string,
  line: string
): Promise<void> {
  const tmux = tmuxCli(target);
  // `copy-mode -q` first: a pane someone scrolled back in (mouse is on) sits
  // in copy mode, where every typed key is a copy-mode command, so the line
  // never reaches the shell and tmux fails the send ("not in a mode", "no
  // current client"). It leaves any mode and is a no-op in none.
  // C-e C-u then clears anything left half-typed at the prompt.
  await target.sh(
    `${tmux} copy-mode -q -t ${pane} && ${tmux} send-keys -t ${pane} C-e C-u && ${tmux} send-keys -t ${pane} -l ${shellQuote(line)} && ${tmux} send-keys -t ${pane} Enter`
  );
}

/** Close the Claude open in a tab, so the chat can carry its conversation on:
 *  two CLIs appending to one transcript would interleave it. TERM lets it save
 *  what it has; after five seconds it is killed. The tab drops back to its
 *  shell. */
export async function stopTerminalAgent(
  target: ExecTarget,
  pane: AgentPane
): Promise<void> {
  const pid = pane.pid;
  await target.sh(
    `kill -TERM ${pid} 2>/dev/null; for i in $(seq 50); do kill -0 ${pid} 2>/dev/null || exit 0; sleep 0.1; done; kill -KILL ${pid} 2>/dev/null; true`
  );
}

/** Stop the turn of the Claude open in the terminal: Esc, as typed there.
 *  For a turn started in the terminal, which the chat shows but did not run.
 *  False with no Claude open there. */
export async function terminalInterrupt(
  target: ExecTarget,
  postId: string
): Promise<boolean> {
  const pane = await findAgentPane(target, postId);
  if (!pane) return false;
  // tmux's pane id: exact, where a session name would match its prefixes too.
  // Out of copy mode first (see typeInPane): there, Escape would only leave
  // the mode and never reach Claude.
  const tmux = tmuxCli(target);
  await target.sh(
    `${tmux} copy-mode -q -t ${pane.paneId} && ${tmux} send-keys -t ${pane.paneId} Escape`
  );
  return true;
}
