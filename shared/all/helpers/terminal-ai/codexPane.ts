// Which of a card's tabs has Codex open in it, found on the runner, and the
// chat's shared commands typed there.
//
// Codex keeps no record of its live sessions the way Claude Code does
// (chatPane.ts), and its tab reports `node` (the npm launcher) as its
// command. So it is found the way `ps` would: a process whose argv is the
// codex launcher or binary, on the tty of one of the card's tabs. The chat
// cannot read Codex's transcript yet, so its commands are typed into that
// tab, as the person would type them there.

import type { ExecTarget } from '../board-agent-core/exec';
import { tmuxCli } from '../board-agent-core/tmux';
import { SESSION_ID_RE } from './chatPane';
import { idleShellPane, typeInPane } from './chatTerminal';
import { tmuxName } from './terminal';

type CodexPane = {
  /** The tmux session, `terminal-<card>-<n>`. */
  session: string;
  /** tmux's own id for the pane, `%4`. */
  paneId: string;
  /** Every Codex process on its tty: the launcher and the binary it runs. */
  pids: number[];
};

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Whether a `ps` command line is Codex: `codex …`, `/…/bin/codex …`, or
 *  `node /…/codex.js …`. Never `codex-code-mode-host` or a dev server. */
export function isCodexCommand(command: string): boolean {
  const [argv0 = '', argv1 = ''] = command.trim().split(/\s+/);
  const bin = baseName(argv0);
  if (bin === 'codex') return true;
  return /^node(js)?$/.test(bin) && /^codex(\.js)?$/.test(baseName(argv1));
}

/** The card's lowest-numbered tab running Codex, from tmux's pane list
 *  (`session pane_id pane_tty`) and `ps -A -o tty=,pid=,command=`. */
export function pickCodexPane(
  postId: string,
  panes: string,
  ps: string
): CodexPane | null {
  const prefix = `${tmuxName(postId)}-`;
  const byTty = new Map<string, number[]>();
  for (const line of ps.split('\n')) {
    const match = /^\s*(\S+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || !isCodexCommand(match[3]!)) continue;
    // macOS prints `ttys003`, Linux `pts/3`; tmux names the device.
    const tty = match[1]!.replace(/^\/dev\//, '');
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid)) continue;
    byTty.set(tty, [...(byTty.get(tty) ?? []), pid]);
  }
  const found: (CodexPane & { tab: number })[] = [];
  for (const line of panes.split('\n')) {
    const [session, paneId, tty] = line.trim().split(' ');
    if (!session?.startsWith(prefix) || !paneId || !tty) continue;
    // Digits after the prefix: `abc-1`, not another card `abc-def`'s tab.
    const tab = session.slice(prefix.length);
    if (!/^\d+$/.test(tab) || !/^%\d+$/.test(paneId)) continue;
    const pids = byTty.get(tty.replace(/^\/dev\//, ''));
    if (pids) found.push({ session, paneId, pids, tab: parseInt(tab, 10) });
  }
  found.sort((a, b) => a.tab - b.tab);
  const first = found[0];
  return first
    ? { session: first.session, paneId: first.paneId, pids: first.pids }
    : null;
}

export async function findCodexPane(
  target: ExecTarget,
  postId: string
): Promise<CodexPane | null> {
  const [panes, ps] = await Promise.all([
    target
      .sh(
        `${tmuxCli(target)} list-panes -a -F '#{session_name} #{pane_id} #{pane_tty}'`
      )
      .catch(() => ''),
    target.run(['ps', '-A', '-o', 'tty=,pid=,command=']).catch(() => '')
  ]);
  return pickCodexPane(postId, panes, ps);
}

/** Close the Codex open in a tab, as stopTerminalAgent closes Claude: TERM,
 *  then KILL after five seconds. The tab drops back to its shell. */
export async function stopCodexAgent(
  target: ExecTarget,
  pane: CodexPane
): Promise<void> {
  const pids = pane.pids.join(' ');
  await target.sh(
    `kill -TERM ${pids} 2>/dev/null; for i in $(seq 50); do kill -0 ${pids} 2>/dev/null || exit 0; sleep 0.1; done; kill -KILL ${pids} 2>/dev/null; true`
  );
}

/** Resume a Codex conversation in the session's first tab idle at its
 *  prompt. False when no tab is free. */
export async function startCodexAgent(
  target: ExecTarget,
  postId: string,
  conversation: string
): Promise<boolean> {
  if (!SESSION_ID_RE.test(conversation)) return false;
  const shell = await idleShellPane(target, postId);
  if (!shell) return false;
  await typeInPane(target, shell, `codex resume ${conversation}`);
  return true;
}

/** Stop Codex's turn: Esc, as typed there. False with no Codex open. */
export async function codexInterrupt(
  target: ExecTarget,
  postId: string
): Promise<boolean> {
  const pane = await findCodexPane(target, postId);
  if (!pane) return false;
  // Out of copy mode first (chatTerminal.ts typeInPane): there, Escape would
  // only leave the mode and never reach Codex.
  const tmux = tmuxCli(target);
  await target.sh(
    `${tmux} copy-mode -q -t ${pane.paneId} && ${tmux} send-keys -t ${pane.paneId} Escape`
  );
  return true;
}
