// Which of a card's tabs has Claude open in it, found on the runner.
//
// Claude Code records each live session in $CLAUDE_CONFIG_DIR/sessions/<pid>.json:
// its session id (the transcript's file name), its cwd, its pid, and the tmux
// pane it runs in. The chat reads that conversation while it is open in the
// terminal, closes that Claude before running a turn of its own (chatRun.ts),
// and stops a turn there with Esc only in a pane where Claude itself is the
// process, never a dev server or a shell.

import type { ExecTarget } from '../board-agent-core/exec';
import { tmuxCli } from '../board-agent-core/tmux';
import { tmuxName } from './terminal';

export type AgentPane = {
  /** The tmux session, `terminal-<card>-<n>`. */
  session: string;
  /** tmux's own id for the pane, `%4`: unique on the server. */
  paneId: string;
  /** The transcript's file name, without `.jsonl`. */
  sessionId: string;
  /** Where Claude runs: the transcript lives under this cwd's slug. */
  cwd: string;
  /** Claude's process, to close it when the chat takes the conversation. */
  pid: number;
};

/** Session ids are uuids. Anything else never reaches a shell or a path. */
export const SESSION_ID_RE = /^[0-9a-zA-Z-]{8,64}$/;

/** `terminal-<card>-<n>:@<window>.%<pane>`, as the record writes it. */
const TMUX_FIELD_RE = /^([^:\s]+):@\d+\.(%\d+)$/;

/** Separates one record from the next in the script's output. */
const RECORD_SEP = '\u001e';

// Every record whose process is still alive: a session that crashed leaves
// its file behind, and that pane may be a shell by now.
const RECORDS_SCRIPT = [
  'for f in "$1"/sessions/*.json; do',
  '  [ -f "$f" ] || continue',
  '  p=$(basename "$f" .json)',
  '  case "$p" in *[!0-9]*) continue;; esac',
  '  kill -0 "$p" 2>/dev/null || continue',
  `  cat "$f"; printf '\\n${RECORD_SEP}\\n'`,
  'done'
].join('\n');

/** The Claude config dir the runner's agents use. */
export function claudeHome(target: ExecTarget): string {
  const env = target.stateEnv();
  return env.CLAUDE_CONFIG_DIR || `${env.HOME || '~'}/.claude`;
}

type SessionRecord = {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  tmux?: unknown;
};

/** The card's live Claude session, from the lowest-numbered tab running one.
 *  Null when no tab is running Claude (or the CLI predates the records). */
export async function findAgentPane(
  target: ExecTarget,
  postId: string
): Promise<AgentPane | null> {
  const prefix = `${tmuxName(postId)}-`;
  const [records, panes] = await Promise.all([
    target
      .run(['sh', '-c', RECORDS_SCRIPT, 'sh', claudeHome(target)])
      .catch(() => ''),
    target
      .sh(`${tmuxCli(target)} list-panes -a -F '#{session_name} #{pane_id}'`)
      .catch(() => '')
  ]);
  // The pane must still be in that session on this runner's tmux server.
  const live = new Set(panes.split('\n').map((line) => line.trim()));

  const found: (AgentPane & { tab: number })[] = [];
  for (const raw of records.split(RECORD_SEP)) {
    let rec: SessionRecord;
    try {
      rec = JSON.parse(raw.trim()) as SessionRecord;
    } catch {
      continue;
    }
    const tmux = typeof rec.tmux === 'string' ? TMUX_FIELD_RE.exec(rec.tmux) : null;
    if (!tmux) continue;
    const [, session, paneId] = tmux;
    // Digits after the prefix: `abc-1`, not another card `abc-def`'s tab.
    const tab = session!.startsWith(prefix) ? session!.slice(prefix.length) : '';
    if (!/^\d+$/.test(tab) || !live.has(`${session} ${paneId}`)) continue;
    if (typeof rec.sessionId !== 'string' || !SESSION_ID_RE.test(rec.sessionId)) {
      continue;
    }
    if (typeof rec.cwd !== 'string' || !rec.cwd.startsWith('/')) continue;
    if (typeof rec.pid !== 'number' || !Number.isSafeInteger(rec.pid)) continue;
    found.push({
      session: session!,
      paneId: paneId!,
      sessionId: rec.sessionId,
      cwd: rec.cwd,
      pid: rec.pid,
      tab: parseInt(tab, 10)
    });
  }
  found.sort((a, b) => a.tab - b.tab);
  const first = found[0];
  if (!first) return null;
  return {
    session: first.session,
    paneId: first.paneId,
    sessionId: first.sessionId,
    cwd: first.cwd,
    pid: first.pid
  };
}
