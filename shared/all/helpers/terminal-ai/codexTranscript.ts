// The chat view of a Codex conversation: Codex's own session file read the
// way chatTranscript.ts reads Claude Code's, into the same ChatEvents, so the
// web and mobile chats draw either CLI's turns alike.
//
// Codex appends one JSON object per line to
// `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`, whether
// the turn ran headless (`codex exec --json`, chatRun.ts) or in the terminal
// (`codex resume`). Each line is `{timestamp, type, payload}`:
// - `event_msg` / `user_message`: what the person typed, as typed. (The
//   `response_item` user messages also carry what Codex injects: AGENTS.md,
//   the environment context, permissions. Those are never shown.)
// - `response_item` / `message` (role `assistant`): a reply, `output_text`.
// - `response_item` / `custom_tool_call` (`exec`, code mode: a script calling
//   `tools.exec_command(...)`, `tools.apply_patch(...)`), `function_call`
//   (`exec_command`, `shell`, `wait`), `local_shell_call`, `web_search_call`:
//   a tool line, keyed by `call_id`.
// - `custom_tool_call_output` / `function_call_output`: its result.
// Everything else (session_meta, turn_context, reasoning, token counts, the
// `event_msg` copies of replies and items) carries nothing the chat shows.

import type { ChatEvent } from './chatTranscript';

type Row = Record<string, unknown>;

const SUMMARY_MAX = 160;
const PREVIEW_LINES = 6;
const PREVIEW_MAX = 600;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const preview = (text: string): string => {
  const lines = text.split('\n').slice(0, PREVIEW_LINES).join('\n');
  return lines.length > PREVIEW_MAX ? `${lines.slice(0, PREVIEW_MAX)}…` : lines;
};

/** The tool names Codex uses, as the chat names Claude's, so a tool line
 *  reads the same whichever CLI ran it. Anything else keeps its own name. */
const TOOL_NAMES: Record<string, string> = {
  exec_command: 'Bash',
  shell: 'Bash',
  local_shell: 'Bash',
  write_stdin: 'Bash',
  apply_patch: 'Edit',
  view_image: 'Read',
  web_search: 'WebSearch',
  web__run: 'WebSearch',
  update_plan: 'Plan'
};

const toolName = (name: string): string => TOOL_NAMES[name] ?? name;

/** A JS string literal's body, unescaped as JSON would (code mode writes
 *  them that way). The raw body when it is not valid JSON. */
const unquote = (body: string): string => {
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body;
  }
};

const PATCH_FILE_RE = /\*\*\* (?:Update|Add|Delete) File: ([^\n\\]+)/;

/** The argument worth showing for a code-mode script: the first tool it
 *  calls (`tools.exec_command({cmd:"…"})`) and that call's command, file
 *  or first string. */
export function codeModeCall(input: string): { name: string; summary: string } {
  const call = /tools\.([A-Za-z0-9_]+)\(/.exec(input);
  if (!call) return { name: 'exec', summary: oneLine(input, SUMMARY_MAX) };
  const name = call[1]!;
  const rest = input.slice(call.index + call[0].length);
  const patch = PATCH_FILE_RE.exec(rest);
  if (name === 'apply_patch' && patch) {
    return { name, summary: oneLine(patch[1]!, SUMMARY_MAX) };
  }
  const keyed =
    /\b"?(?:cmd|command|path|query|q|chars)"?\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(
      rest
    ) ?? /"((?:[^"\\]|\\.)*)"/.exec(rest);
  return {
    name,
    summary: keyed ? oneLine(unquote(keyed[1]!), SUMMARY_MAX) : ''
  };
}

/** A function call's arguments (a JSON string) as one line. */
function argsSummary(raw: unknown): string {
  let args: unknown = raw;
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw);
    } catch {
      return oneLine(raw, SUMMARY_MAX);
    }
  }
  if (!args || typeof args !== 'object') return '';
  const a = args as Row;
  if (Array.isArray(a.command)) {
    // `shell` takes argv; `bash -lc "<script>"` shows the script.
    const argv = a.command.map(str);
    const script = argv.length >= 3 && /^-l?c$/.test(argv[1]!) ? argv[2]! : '';
    return oneLine(script || argv.join(' '), SUMMARY_MAX);
  }
  const pick =
    str(a.cmd) ||
    str(a.command) ||
    str(a.path) ||
    str(a.query) ||
    Object.values(a).map(str).find(Boolean) ||
    '';
  return oneLine(pick, SUMMARY_MAX);
}

/** Code mode's result header (`Script completed\nWall time 0.7 seconds\n
 *  Output:\n`), which says nothing the line does not. */
const SCRIPT_HEADER_RE =
  /^Script (completed|failed|running[^\n]*)\n(?:Wall time[^\n]*\n)?(?:Output:\n)?/;

/** A tool's output as the chat previews it, and whether it failed. */
export function codexOutput(output: unknown): {
  isError: boolean;
  preview: string;
} {
  let text = '';
  let isError = false;
  if (typeof output === 'string') {
    text = output;
    // Older Codex: `{"output":"…","metadata":{"exit_code":1}}` as a string.
    if (output.startsWith('{')) {
      try {
        const o = JSON.parse(output) as Row;
        if (typeof o.output === 'string') {
          text = o.output;
          const code = (o.metadata as Row | undefined)?.exit_code;
          isError = typeof code === 'number' && code !== 0;
        }
      } catch {
        // Not that shape: the string as it is.
      }
    }
  } else if (Array.isArray(output)) {
    text = output
      .map((b: Row) =>
        b && typeof b === 'object'
          ? str(b.text) || (str(b.type).includes('image') ? '[image]' : '')
          : ''
      )
      .filter(Boolean)
      .join('');
  } else if (output && typeof output === 'object') {
    const o = output as Row;
    text = str(o.content) || str(o.output);
    if (o.success === false) isError = true;
  }
  const header = SCRIPT_HEADER_RE.exec(text);
  if (header) {
    if (header[1] === 'failed') isError = true;
    text = text.slice(header[0].length);
  }
  return { isError, preview: preview(text.trim()) };
}

/** The chat's events in one Codex session line. */
export function parseCodexLine(line: string): ChatEvent[] {
  let row: Row;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') return [];
    row = parsed as Row;
  } catch {
    return [];
  }
  const p = row.payload as Row | undefined;
  if (!p || typeof p !== 'object') return [];
  const time = str(row.timestamp);

  if (row.type === 'event_msg') {
    if (p.type !== 'user_message') return [];
    const images = Array.isArray(p.images) ? p.images.length : 0;
    const typed = str(p.message).trim();
    const text = [typed, ...Array<string>(images).fill('[image]')]
      .filter(Boolean)
      .join('\n');
    return text ? [{ type: 'user', id: `u:${time}`, text, time }] : [];
  }
  if (row.type !== 'response_item') return [];

  const callId = str(p.call_id) || str(p.id);
  switch (p.type) {
    case 'message': {
      if (p.role !== 'assistant' || !Array.isArray(p.content)) return [];
      const base = str(p.id) || `a:${time}`;
      const events: ChatEvent[] = [];
      // `output_text`, or a `refusal`'s text: either is what it said.
      p.content.forEach((b: Row, n) => {
        const text =
          b && typeof b === 'object'
            ? (str(b.text) || str(b.refusal)).trim()
            : '';
        if (text) {
          events.push({ type: 'assistant', id: `${base}:${n}`, text, time });
        }
      });
      return events;
    }
    case 'custom_tool_call': {
      const name = str(p.name);
      const call =
        name === 'exec'
          ? codeModeCall(str(p.input))
          : {
              name,
              summary:
                name === 'apply_patch'
                  ? oneLine(
                      PATCH_FILE_RE.exec(str(p.input))?.[1] ?? '',
                      SUMMARY_MAX
                    )
                  : oneLine(str(p.input), SUMMARY_MAX)
            };
      return [
        {
          type: 'tool',
          id: `t:${callId}`,
          toolId: callId,
          name: toolName(call.name),
          summary: call.summary,
          time
        }
      ];
    }
    case 'function_call':
      return [
        {
          type: 'tool',
          id: `t:${callId}`,
          toolId: callId,
          name: toolName(str(p.name)),
          summary: argsSummary(p.arguments),
          time
        }
      ];
    case 'local_shell_call': {
      const action = (p.action ?? {}) as Row;
      return [
        {
          type: 'tool',
          id: `t:${callId}`,
          toolId: callId,
          name: 'Bash',
          summary: argsSummary({ command: action.command }),
          time
        }
      ];
    }
    case 'web_search_call': {
      const action = (p.action ?? {}) as Row;
      return [
        {
          type: 'tool',
          id: `t:${callId || time}`,
          toolId: callId,
          name: 'WebSearch',
          summary: oneLine(str(action.query), SUMMARY_MAX),
          time
        }
      ];
    }
    case 'custom_tool_call_output':
    case 'function_call_output':
      return [
        {
          type: 'tool-result',
          id: `r:${callId}`,
          toolId: callId,
          ...codexOutput(p.output)
        }
      ];
    default:
      return [];
  }
}
