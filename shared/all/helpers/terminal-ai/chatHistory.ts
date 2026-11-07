// The map of a session's past conversations, for the chat's /resume: every
// conversation Claude Code or Codex recorded for the session's folder, read
// from the CLIs' own session files and never written to.
//
// - Claude Code: `$CLAUDE_CONFIG_DIR/projects/<cwd slug>/<session id>.jsonl`,
//   the same transcript the chat reads (chatTranscript.ts). Its `ai-title` /
//   `custom-title` lines name it, `last-prompt` says what was asked last.
// - Codex: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, one
//   file per conversation across every folder. Its first line is the
//   `session_meta` (id, start, cwd), which is how a folder's are found; the
//   rest are `event_msg` (`user_message`, `agent_message`), `turn_context`
//   (the model) and `response_item` rows.
//
// The runner never ships whole files: a script on the session's ExecTarget
// sends each file's first timestamped lines and the few text lines nearest
// its end, and the summary is made here (so it is tested on fixtures).

import type { AgentProvider } from '../../domains/electron';
import type { ExecTarget } from '../board-agent-core/exec';
import { claudeHome, SESSION_ID_RE } from './chatPane';
import { parseTranscriptLine } from './chatTranscript';

export type PastConversation = {
  provider: AgentProvider;
  /** What `claude --resume` / `codex resume` takes. */
  id: string;
  /** The CLI's own title for it, else what was asked last. */
  title: string;
  /** ISO times: the first line written, and the last (the file's mtime). */
  startedAt: string;
  endedAt: string;
  /** The last thing said, by either side, cut to a line. */
  lastMessage: string;
  lastRole: 'user' | 'assistant' | '';
  /** The model its last turn ran on, '' when the file does not say. */
  model: string;
};

export type ChatConversations = {
  /** The folder they were recorded in: the session's worktree (or the
   *  board's workspace, which every chat on the board shares). */
  cwd: string;
  /** The conversation the chat is on now, '' with none. */
  current: string;
  /** Newest first. */
  conversations: PastConversation[];
};

/** How many of each CLI's newest conversations the map lists. */
const HISTORY_MAX = 25;
/** Codex files older than this are not opened: they share one tree across
 *  every folder, and the scan reads each one's first line. */
const CODEX_DAYS = 120;
/** A line longer than this is a tool's output or a pasted image, never the
 *  text worth showing: the script drops it rather than ship it. */
const LINE_CAP = 32_768;
/** The session_meta line carries the CLI's base instructions. */
const META_CAP = 262_144;
const TEXT_MAX = 200;

/** Separates one file's record from the next, and its head from its tail. */
const RECORD_SEP = '\u001e';
const PART_SEP = '\u001d';

// $1 Claude home, $2 Codex home, $3 cwd, $4 how many per CLI. For each file:
// RS provider TAB path TAB mtime, its first timestamped lines, GS, then the
// last few lines from near its end matching emit's $5 (titles, the model:
// Claude repeats its title lines all through a file, so they get their own
// few), then the last text lines, matching $3 and not $4 (Claude's tool
// results carry text too). Codex files are matched on the cwd their first
// line records. Claude writes a user row's `type` ahead of its message and
// an assistant row's after it, so the text pattern takes either order.
const LIST_SCRIPT = [
  'emit() {',
  `  printf '${RECORD_SEP}%s\\t%s\\t%s\\n' "$1" "$2" "$(date -r "$2" +%s 2>/dev/null || echo 0)"`,
  `  head -n 40 "$2" | awk 'length($0) <= ${META_CAP}' | grep -m 2 '"timestamp":"'`,
  `  printf '${PART_SEP}\\n'`,
  `  t=$(tail -c 524288 "$2" | awk 'length($0) <= ${LINE_CAP}')`,
  `  printf '%s\\n' "$t" | grep -E "$5" | tail -n 3`,
  `  printf '%s\\n' "$t" | grep -E "$3" | grep -vE "\${4:-^$}" | tail -n 6`,
  '}',
  'd="$1/projects/$(printf \'%s\' "$3" | sed \'s/[^A-Za-z0-9]/-/g\')"',
  'cwd="$3"',
  'if [ -d "$d" ]; then',
  '  ls -t "$d" | grep -E \'^[0-9A-Za-z-]+\\.jsonl$\' | head -n "$4" | while IFS= read -r n; do',
  `    emit claude "$d/$n" '"type":"(user|assistant)".*("type":"text"|"content":")|"type":"text".*"type":"(user|assistant)"' '"tool_use_id"' '"type":"(ai-title|custom-title|last-prompt)"'`,
  '  done',
  'fi',
  'if [ -n "$2" ] && [ -d "$2/sessions" ]; then',
  `  find "$2/sessions" -type f -name 'rollout-*.jsonl' -mtime -${CODEX_DAYS} 2>/dev/null | while IFS= read -r f; do`,
  '    head -n 1 "$f" | grep -qF "\\"cwd\\":\\"$cwd\\"" && printf \'%s\\t%s\\n\' "$(date -r "$f" +%s 2>/dev/null || echo 0)" "$f"',
  '  done | sort -rn | head -n "$4" | cut -f2- | while IFS= read -r f; do',
  `    emit codex "$f" '"type":"(user_message|agent_message)"' '' '"type":"turn_context"'`,
  '  done',
  'fi'
].join('\n');

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const oneLine = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}…` : flat;
};

const parse = (line: string): Row | null => {
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === 'object' ? (v as Row) : null;
  } catch {
    return null;
  }
};

const isoOf = (epochSeconds: number): string =>
  epochSeconds > 0 ? new Date(epochSeconds * 1000).toISOString() : '';

/** A Claude Code conversation from its file's head and tail lines. Null when
 *  nothing was ever said in it (a run stopped before its first line). */
export function summarizeClaude(
  id: string,
  head: string[],
  tail: string[],
  mtime: number
): PastConversation | null {
  if (!SESSION_ID_RE.test(id)) return null;
  let startedAt = '';
  for (const line of head) {
    const t = str(parse(line)?.timestamp);
    if (t) {
      startedAt = t;
      break;
    }
  }
  let aiTitle = '';
  let customTitle = '';
  let lastPrompt = '';
  let lastMessage = '';
  let lastRole: PastConversation['lastRole'] = '';
  let lastTime = '';
  let model = '';
  for (const line of tail) {
    const row = parse(line);
    if (!row) continue;
    if (row.type === 'ai-title') aiTitle = str(row.aiTitle) || aiTitle;
    else if (row.type === 'custom-title') {
      customTitle = str(row.customTitle) || customTitle;
    } else if (row.type === 'last-prompt') {
      lastPrompt = str(row.lastPrompt) || lastPrompt;
    } else {
      const m = str((row.message as Row | undefined)?.model);
      // `<synthetic>` marks a reply the CLI made up (an error), not a model.
      if (row.type === 'assistant' && m && !m.startsWith('<')) model = m;
      for (const event of parseTranscriptLine(line)) {
        if (event.type !== 'user' && event.type !== 'assistant') continue;
        lastMessage = event.text;
        lastRole = event.type;
        lastTime = event.time || lastTime;
      }
    }
  }
  if (!startedAt && !lastMessage && !lastPrompt) return null;
  const endedAt = isoOf(mtime) || lastTime || startedAt;
  return {
    provider: 'claude',
    id,
    title: oneLine(customTitle || aiTitle || lastPrompt || lastMessage),
    startedAt: startedAt || endedAt,
    endedAt,
    lastMessage: oneLine(lastMessage),
    lastRole,
    model
  };
}

/** The id at the end of a Codex file's name:
 *  `rollout-2026-10-27T09-12-44-<uuid>.jsonl`. */
const CODEX_FILE_ID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** A Codex conversation from its file's head and tail lines, when its
 *  session_meta records `cwd`. */
export function summarizeCodex(
  path: string,
  head: string[],
  tail: string[],
  mtime: number,
  cwd: string
): PastConversation | null {
  const meta = head.map(parse).find((r) => r?.type === 'session_meta');
  const payload = (meta?.payload ?? {}) as Row;
  // The scan matched the folder as text; the parsed line has the last word.
  if (meta && str(payload.cwd) !== cwd) return null;
  const id = str(payload.id) || (CODEX_FILE_ID_RE.exec(path)?.[1] ?? '');
  if (!SESSION_ID_RE.test(id)) return null;
  const startedAt =
    str(payload.timestamp) || str(meta?.timestamp) || str(parse(head[0] ?? '')?.timestamp);
  let lastMessage = '';
  let lastRole: PastConversation['lastRole'] = '';
  let lastUser = '';
  let lastTime = '';
  let model = '';
  for (const line of tail) {
    const row = parse(line);
    if (!row) continue;
    const p = (row.payload ?? {}) as Row;
    if (row.type === 'turn_context') {
      model = str(p.model) || model;
    } else if (row.type === 'event_msg') {
      const text = str(p.message).trim();
      if (!text) continue;
      if (p.type === 'user_message') {
        lastMessage = text;
        lastRole = 'user';
        lastUser = text;
      } else if (p.type === 'agent_message') {
        lastMessage = text;
        lastRole = 'assistant';
      } else {
        continue;
      }
      lastTime = str(row.timestamp) || lastTime;
    }
  }
  if (!startedAt && !lastMessage) return null;
  const endedAt = isoOf(mtime) || lastTime || startedAt;
  return {
    provider: 'codex',
    id,
    title: oneLine(lastUser || lastMessage),
    startedAt: startedAt || endedAt,
    endedAt,
    lastMessage: oneLine(lastMessage),
    lastRole,
    model
  };
}

/** The script's output, as conversations: newest first, both CLIs. */
export function parseHistory(out: string, cwd: string): PastConversation[] {
  const found: PastConversation[] = [];
  for (const record of out.split(RECORD_SEP)) {
    const nl = record.indexOf('\n');
    if (nl === -1) continue;
    const [provider, path, mtimeRaw] = record.slice(0, nl).split('\t');
    if (!path) continue;
    const body = record.slice(nl + 1);
    const cut = body.indexOf(`${PART_SEP}\n`);
    const lines = (s: string) => s.split('\n').filter((l) => l.trim());
    const head = lines(cut === -1 ? body : body.slice(0, cut));
    const tail = cut === -1 ? [] : lines(body.slice(cut + PART_SEP.length + 1));
    const mtime = Number(mtimeRaw) || 0;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const summary =
      provider === 'codex'
        ? summarizeCodex(path, head, tail, mtime, cwd)
        : provider === 'claude'
          ? summarizeClaude(name.replace(/\.jsonl$/, ''), head, tail, mtime)
          : null;
    if (summary) found.push(summary);
  }
  // One Codex conversation resumed many times is one file; Claude's are one
  // file each too. Still, never list an id twice.
  const seen = new Set<string>();
  return found
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
    .filter((c) => {
      const key = `${c.provider}:${c.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The Codex home the runner's agents use ('' when there is none). */
export function codexHome(target: ExecTarget): string {
  const env = target.stateEnv();
  return env.CODEX_HOME || (env.HOME ? `${env.HOME}/.codex` : '');
}

/** Every conversation either CLI recorded for `cwd`, newest first. */
export async function listConversations(
  target: ExecTarget,
  cwd: string
): Promise<PastConversation[]> {
  if (!cwd.startsWith('/')) return [];
  const out = await target
    .run([
      'sh',
      '-c',
      LIST_SCRIPT,
      'sh',
      claudeHome(target),
      codexHome(target),
      cwd,
      String(HISTORY_MAX)
    ])
    .catch(() => '');
  return parseHistory(out, cwd);
}
