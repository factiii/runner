// The chat view of a terminal session: what its Claude said and did, read
// from the CLI's own transcript rather than scraped off the screen.
//
// Claude Code appends one JSON object per line to
// `$CLAUDE_CONFIG_DIR/projects/<cwd slug>/<session id>.jsonl` as the
// conversation goes. The chat reads that file from a byte offset, so each poll
// costs only what was appended since the last one. It is the same file
// whichever ran the turn: the chat's own headless Claude (chatRun.ts) or the
// one resumed in the terminal (chatTerminal.ts).
//
// Read through the session's ExecTarget, not the runner's own fs, so it works
// the same wherever the session runs (the host today, a VM later).

import type { ExecTarget } from '../board-agent-core/exec';
import { claudeHome, findAgentPane, SESSION_ID_RE } from './chatPane';

/** One thing the chat shows, in transcript order. Tool results arrive as
 *  their own event and the client folds them into the tool line by `toolId`,
 *  because the result is usually appended after the poll that saw the call. */
export type ChatEvent =
  | { type: 'user'; id: string; text: string; time: string }
  | { type: 'assistant'; id: string; text: string; time: string }
  | {
      type: 'tool';
      id: string;
      toolId: string;
      name: string;
      /** The one argument that says what the call is about (the command, the
       *  file, the pattern), cut to a line. */
      summary: string;
      time: string;
    }
  | {
      type: 'tool-result';
      id: string;
      toolId: string;
      isError: boolean;
      /** The first lines of the output, enough to see what happened. */
      preview: string;
    };

export type ChatTranscript = {
  /** False until the CLI has written the file (it does on the first prompt). */
  found: boolean;
  /** The conversation read: the card's Claude tab's (chatPane.ts), else the
   *  chat's own (chatRun.ts). Neither: nothing yet. */
  sessionId: string;
  events: ChatEvent[];
  /** Pass back as `offset` next time. Always at a line boundary. */
  offset: number;
  /** The chat's own Claude is on a turn, or has one queued (chatRun.ts).
   *  Absent from a runner whose chat typed into the terminal instead. */
  running?: boolean;
  /** Why the chat's last turn failed, until the next one starts. */
  error?: string;
  /** How many of the chat's turns have finished, however they ended. */
  turns?: number;
};

/** One read's ceiling. The first read of a long session starts this far from
 *  the end rather than at the top: the chat opens on the recent conversation,
 *  and a multi-megabyte file never crosses the data channel in one reply. */
export const CHAT_READ_CAP = 1024 * 1024;

const SUMMARY_MAX = 160;
const PREVIEW_LINES = 6;
const PREVIEW_MAX = 600;


/** Text the CLI injects as a user turn that the person did not type: hook and
 *  command wrappers, reminders, task notifications. */
const INJECTED_RE =
  /^\s*<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)\b/;

type Block = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The argument worth showing for a tool call, by what the common tools take. */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const pick =
    str(i.command) ||
    str(i.file_path) ||
    str(i.notebook_path) ||
    str(i.pattern) ||
    str(i.url) ||
    str(i.query) ||
    str(i.description) ||
    str(i.prompt) ||
    str(i.skill) ||
    Object.values(i).map(str).find(Boolean) ||
    '';
  return oneLine(pick, SUMMARY_MAX);
}

function resultPreview(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b: Block) => (b.type === 'text' ? str(b.text) : '[image]'))
      .join('\n');
  }
  const lines = text.split('\n').slice(0, PREVIEW_LINES).join('\n');
  return lines.length > PREVIEW_MAX ? `${lines.slice(0, PREVIEW_MAX)}…` : lines;
}

/** What the person typed in a user turn, without what the CLI wrapped it in.
 *  Empty when the whole turn was injected. */
function userText(content: unknown): string {
  if (typeof content === 'string') {
    return INJECTED_RE.test(content) ? '' : content.trim();
  }
  if (!Array.isArray(content)) return '';
  return content
    .map((b: Block) => {
      if (b.type === 'image') return '[image]';
      if (b.type !== 'text') return '';
      const t = str(b.text);
      return INJECTED_RE.test(t) ? '' : t;
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

const COMMAND_OUTPUT_RE =
  /^<local-command-(?:stdout|stderr)>([\s\S]*)<\/local-command-(?:stdout|stderr)>$/;

/** A slash command the headless CLI ran itself (`/login`, `/cost`): one line
 *  for the command as typed, one for what it printed. A command only Claude's
 *  full screen has says so, and where to go for it. */
function localCommandEvents(row: Record<string, unknown>): ChatEvent[] {
  const content = str(row.content).trim();
  const id = str(row.uuid);
  const time = str(row.timestamp);
  const output = COMMAND_OUTPUT_RE.exec(content);
  if (!output) {
    return content.startsWith('/')
      ? [{ type: 'user', id, text: content, time }]
      : [];
  }
  let text = output[1]!.trim();
  const outcome = row.commandOutcome as Record<string, unknown> | undefined;
  if (outcome?.kind === 'unavailable_headless') {
    text = `${text} Open the Terminal for it.`;
  }
  return text ? [{ type: 'assistant', id, text, time }] : [];
}

/** The chat's events in one transcript line. Most lines (snapshots, request
 *  records, mode changes, sub-agent turns) carry none. */
export function parseTranscriptLine(line: string): ChatEvent[] {
  let row: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') return [];
    row = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  if (row.isSidechain === true || row.isMeta === true) return [];
  if (row.type === 'system' && row.subtype === 'local_command') {
    return localCommandEvents(row);
  }
  const message = row.message as Record<string, unknown> | undefined;
  if (!message) return [];
  const id = str(row.uuid);
  const time = str(row.timestamp);
  const content = message.content;

  if (row.type === 'user') {
    if (Array.isArray(content) && content.some((b: Block) => b.type === 'tool_result')) {
      return content
        .filter((b: Block) => b.type === 'tool_result')
        .map((b: Block, n) => ({
          type: 'tool-result' as const,
          id: `${id}:${n}`,
          toolId: str(b.tool_use_id),
          isError: b.is_error === true,
          preview: resultPreview(b.content)
        }));
    }
    const text = userText(content);
    return text ? [{ type: 'user', id, text, time }] : [];
  }

  if (row.type === 'assistant' && Array.isArray(content)) {
    const events: ChatEvent[] = [];
    content.forEach((b: Block, n) => {
      if (b.type === 'text' && str(b.text).trim()) {
        events.push({
          type: 'assistant',
          id: `${id}:${n}`,
          text: str(b.text).trim(),
          time
        });
      } else if (b.type === 'tool_use') {
        events.push({
          type: 'tool',
          id: `${id}:${n}`,
          toolId: str(b.id),
          name: str(b.name),
          summary: toolSummary(b.input),
          time
        });
      }
    });
    return events;
  }
  return [];
}

/** Parse a chunk read from `start`, which is always a line boundary. Only
 *  whole lines count: a trailing line still being written is left for the
 *  next read. Whole lines are whole UTF-8 too (a newline is never inside a
 *  character), so their byte length is the file's. */
export function parseTranscriptChunk(
  chunk: string,
  start: number
): { events: ChatEvent[]; offset: number } {
  const lastNl = chunk.lastIndexOf('\n');
  if (lastNl === -1) return { events: [], offset: start };
  const whole = chunk.slice(0, lastNl);
  return {
    events: whole.split('\n').flatMap(parseTranscriptLine),
    offset: start + Buffer.byteLength(chunk.slice(0, lastNl + 1), 'utf8')
  };
}

// The transcript in the project dir for `cwd` (the CLI's slug of it: every
// character but a letter or digit becomes `-`), named by session id. Never
// "the newest file there": every chat session on a board shares the
// workspace, so that would be another session's conversation. Prints its id
// and size, then up to $5 bytes from byte $4.
const READ_SCRIPT = [
  'd="$1/projects/$(printf \'%s\' "$2" | sed \'s/[^A-Za-z0-9]/-/g\')"',
  '[ -n "$3" ] || exit 0',
  'f="$d/$3.jsonl"; [ -f "$f" ] || exit 0',
  'basename "$f" .jsonl',
  'wc -c < "$f" | tr -d " "',
  'tail -c +$(($4 + 1)) "$f" | head -c "$5"'
].join('\n');

// Where the line holding byte $4 ends, as bytes past $4 (its newline
// included), counted by wc so a cut through a character cannot skew it. A
// second line says whether the file's last byte is a newline: if the count
// runs to the end of the file and it is not, the line is still being written.
const LINE_END_SCRIPT = [
  'f="$1/projects/$(printf \'%s\' "$2" | sed \'s/[^A-Za-z0-9]/-/g\')/$3.jsonl"',
  '[ -f "$f" ] || exit 0',
  'tail -c +$(($4 + 1)) "$f" | head -n 1 | wc -c | tr -d " "',
  'tail -c 1 "$f" | od -An -tx1 | tr -d " \n"'
].join('\n');

/** What the transcript of the card's agent gained since `offset`. `sessionId`
 *  names the file `offset` belongs to ('' on the first read): when the
 *  conversation is another one now, the read starts that one from the top and
 *  the reply's `sessionId` tells the client to start over. `workspace` is
 *  where to look while no tab is running Claude, and `conversation` the
 *  chat's own there; with neither, the chat has said nothing yet. */
export async function readChatTranscript(
  target: ExecTarget,
  postId: string,
  workspace: string,
  sessionId: string,
  offset: number,
  conversation?: string
): Promise<ChatTranscript> {
  const none: ChatTranscript = { found: false, sessionId: '', events: [], offset: 0 };
  if (sessionId && !SESSION_ID_RE.test(sessionId)) return none;
  const home = claudeHome(target);
  const pane = await findAgentPane(target, postId);
  const cwd = pane?.cwd ?? workspace;
  const read = async (from: number) => {
    const out = await target.run([
      'sh',
      '-c',
      READ_SCRIPT,
      'sh',
      home,
      cwd,
      pane?.sessionId ??
        (conversation && SESSION_ID_RE.test(conversation) ? conversation : ''),
      String(from),
      String(CHAT_READ_CAP)
    ]);
    const first = out.indexOf('\n');
    const second = first === -1 ? -1 : out.indexOf('\n', first + 1);
    if (second === -1) return null;
    const id = out.slice(0, first);
    const size = Number(out.slice(first + 1, second));
    if (!SESSION_ID_RE.test(id) || !Number.isSafeInteger(size)) return null;
    return { id, size, chunk: out.slice(second + 1) };
  };
  /** Bytes from `from` to just past the end of its line; null while that
   *  line is still being written. */
  const lineEnd = async (id: string, size: number, from: number) => {
    const out = await target.run([
      'sh',
      '-c',
      LINE_END_SCRIPT,
      'sh',
      home,
      cwd,
      id,
      String(from)
    ]);
    const [count, last] = out.trim().split('\n');
    const bytes = Number(count);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return null;
    if (from + bytes >= size && last !== '0a') return null;
    return bytes;
  };

  // From the client: anything but a whole, non-negative byte count is a
  // first read.
  let start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  let got = await read(start);
  if (!got) return none;
  // Another file than the offset's, or the same one cut shorter: from the top.
  if (start > 0 && (got.id !== sessionId || start > got.size)) {
    start = 0;
    got = await read(0);
    if (!got) return none;
  }
  // A long conversation opens on its last CHAT_READ_CAP bytes, from the first
  // line that starts in them.
  if (start === 0 && got.size > CHAT_READ_CAP) {
    const from = got.size - CHAT_READ_CAP;
    const skip = await lineEnd(got.id, got.size, from);
    if (skip === null) return { found: true, sessionId: got.id, events: [], offset: 0 };
    start = from + skip;
    got = await read(start);
    if (!got) return none;
  }
  const parsed = parseTranscriptChunk(got.chunk, start);
  // One line longer than a whole read (a pasted screenshot is base64 inside
  // its line): step over it, or every poll would read the same bytes again.
  if (
    parsed.offset === start &&
    parsed.events.length === 0 &&
    got.size - start >= CHAT_READ_CAP
  ) {
    const skip = await lineEnd(got.id, got.size, start);
    if (skip !== null) parsed.offset = start + skip;
  }
  return { found: true, sessionId: got.id, ...parsed };
}

// The folder the conversation's last line was written in ($3's transcript
// under the project dir for $2), and the project it is in: one line, the
// git top, then "git" when it is a checkout; just the folder otherwise. Reads
// only the file's end. Nothing when there is no transcript or no such folder.
// The project a folder is in ($d): the git top and "git", or the folder.
const PROJECT_OF =
  'if t=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null); then printf \'%s\\ngit\\n\' "$t"; else (cd "$d" && pwd -P); fi';

const WORK_PATH_SCRIPT = [
  'f="$1/projects/$(printf \'%s\' "$2" | sed \'s/[^A-Za-z0-9]/-/g\')/$3.jsonl"',
  '[ -f "$f" ] || exit 0',
  'd=$(tail -c 262144 "$f" | grep -o \'"cwd":"[^"]*"\' | tail -n 1 | sed \'s/^"cwd":"//; s/"$//\')',
  '[ -n "$d" ] && [ -d "$d" ] || exit 0',
  PROJECT_OF
].join('\n');

const parseProject = (out: string): { path: string; git: boolean } | null => {
  const [path, git] = out.split('\n');
  if (!path?.startsWith('/')) return null;
  return { path, git: git === 'git' };
};

/** The project `dir` is in (its git top, or the folder itself), for an
 *  agent saying where it works (set_work_path). Null when it is no folder. */
export async function resolveWorkPath(
  target: ExecTarget,
  dir: string
): Promise<{ path: string; git: boolean } | null> {
  if (!dir.startsWith('/')) return null;
  const out = await target
    .run(['sh', '-c', `d="$1"; [ -d "$d" ] || exit 0\n${PROJECT_OF}`, 'sh', dir])
    .catch(() => '');
  return parseProject(out);
}

/** Where the agent of `conversation` (started in `cwd`) is working now: the
 *  project of the folder its last step ran in, as the CLI records it on
 *  every line. Null when nothing says. */
export async function readWorkPath(
  target: ExecTarget,
  cwd: string,
  conversation: string
): Promise<{ path: string; git: boolean } | null> {
  if (!SESSION_ID_RE.test(conversation)) return null;
  const out = await target
    .run(['sh', '-c', WORK_PATH_SCRIPT, 'sh', claudeHome(target), cwd, conversation])
    .catch(() => '');
  return parseProject(out);
}
