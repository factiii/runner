// One line of what the CLI is doing right now, for the sessions rail.
//
// report-state.sh publishes the hook's raw JSON and the line is derived here:
// bash has no JSON parser to rely on, and a better wording then ships with the
// runner rather than with each CLI's copy of the plugin. The script caps the
// payload, so the JSON can arrive cut mid-string; every field is read with a
// real parse first, then a lenient scan that tolerates the cut.

import type { AgentState } from './agentState';

/** Channel and key mirror agentState's, so one redis-cli subscriber reads both. */
export const AGENT_ACTIVITY_CHANNEL = 'agent-activity';

export function agentActivityKey(paneId: string): string {
  return `agent-activity:${paneId}`;
}

/** Long enough for a command or a sentence, short enough for every client to
 *  carry on each update. The rail truncates further to its own width. */
const MAX_LINE = 140;

/** `<paneId> <hook JSON>`, as report-state.sh publishes it. */
export function parseActivityMessage(
  payload: string
): { paneId: string; raw: string } | null {
  const at = payload.indexOf(' ');
  if (at <= 0) return null;
  return { paneId: payload.slice(0, at), raw: payload.slice(at + 1) };
}

type HookInput = Record<string, unknown>;

function parseLenient(raw: string): HookInput | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as HookInput) : null;
  } catch {
    return null;
  }
}

/** The first string value under `key` in raw JSON, tolerating a closing quote
 *  that was cut off. Unescaped the way JSON.parse would. */
function scanString(raw: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(raw);
  if (!match) return undefined;
  // A cut can land between a backslash and what it escapes.
  const body = match[1]!.replace(/\\$/, '');
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body;
  }
}

/** A field of the hook input, or of its `tool_input`, from whichever read
 *  worked. The scan finds the first occurrence anywhere, which for the keys
 *  asked for here is the one inside `tool_input`. */
function field(
  parsed: HookInput | null,
  raw: string,
  key: string,
  inTool = false
): string | undefined {
  const holder = inTool ? parsed?.tool_input : parsed;
  if (holder && typeof holder === 'object') {
    const value = (holder as HookInput)[key];
    if (typeof value === 'string') return value;
    // Codex hands some commands over as argv.
    if (Array.isArray(value)) return value.map(String).join(' ');
    if (parsed) return undefined;
  }
  return scanString(raw, key);
}

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? '';

/** The first line worth reading: not blank, not a fence or a rule, with the
 *  markdown that would show as literal characters taken off. */
function firstLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s*(#{1,6}\s+|[-*>]\s+|\d+\.\s+)/, '')
      .replace(/\*\*|__|`/g, '')
      .trim();
    if (line && !/^(```|---|___|\*\*\*)/.test(raw.trim())) return line;
  }
  return '';
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

/** The file a patch touches, for codex's apply_patch. */
function patchTarget(raw: string): string {
  const match = /\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+)/.exec(raw);
  return match ? baseName(match[1]!.trim()) : '';
}

/** What a tool call is about to do, in the rail's words. Null for tools that
 *  are bookkeeping rather than work, so the line keeps saying what the agent
 *  was doing before them. */
function toolLine(parsed: HookInput | null, raw: string): string | null {
  const tool = field(parsed, raw, 'tool_name') ?? '';
  const input = (key: string) => field(parsed, raw, key, true);
  const file = () =>
    baseName(input('file_path') ?? input('notebook_path') ?? '');

  switch (tool) {
    case 'Bash':
    case 'shell':
    case 'exec_command':
    case 'local_shell': {
      // Claude's own description reads better than the command it runs.
      const described = input('description');
      if (described) return described;
      const command = input('command') ?? input('cmd');
      return command ? `Running ${firstLine(command)}` : 'Running a command';
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${file()}`;
    case 'Write':
      return `Writing ${file()}`;
    case 'apply_patch':
      return `Editing ${patchTarget(raw) || 'files'}`;
    case 'Read':
      return `Reading ${file()}`;
    case 'Grep':
      return `Searching for ${input('pattern') ?? ''}`;
    case 'Glob':
      return `Finding ${input('pattern') ?? 'files'}`;
    case 'WebFetch': {
      const url = input('url') ?? '';
      const host = /^https?:\/\/([^/]+)/.exec(url)?.[1];
      return `Reading ${host ?? 'a web page'}`;
    }
    case 'WebSearch':
    case 'web_search':
      return `Searching the web for ${input('query') ?? ''}`;
    case 'Task':
    case 'Agent':
      return `Delegating: ${input('description') ?? 'a subtask'}`;
    case 'TaskCreate':
      return `Planning: ${input('subject') ?? ''}`;
    case 'TodoWrite': {
      // Older claude: the whole list on every write, with the item now under
      // way marked in_progress. Its activeForm is the spinner's own line.
      const todos = (parsed?.tool_input as HookInput | undefined)?.todos;
      if (!Array.isArray(todos)) return null;
      const doing = (todos as HookInput[]).find(
        (t) => t.status === 'in_progress'
      );
      const text = doing?.activeForm ?? doing?.content;
      return typeof text === 'string' ? text : null;
    }
    case 'update_plan': {
      const plan = (parsed?.tool_input as HookInput | undefined)?.plan;
      if (!Array.isArray(plan)) return null;
      const doing = (plan as HookInput[]).find(
        (s) => s.status === 'in_progress'
      );
      return typeof doing?.step === 'string' ? doing.step : null;
    }
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'ToolSearch':
      return null;
    default: {
      if (!tool) return null;
      // mcp__<server>__<tool>
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
      if (mcp) return `Using ${mcp[1]} ${mcp[2]!.replace(/_/g, ' ')}`;
      return `Using ${tool}`;
    }
  }
}

/**
 * The rail's line for one hook event, or null to keep the line it has.
 *
 * - A tool about to run says what it does.
 * - A permission request names the tool waiting on you.
 * - A turn starting shows what was asked, until the first tool replaces it.
 * - A turn ending shows the first line of the agent's reply: what it did.
 */
export function activityLine(raw: string): string | null {
  const parsed = parseLenient(raw);
  const event = field(parsed, raw, 'hook_event_name');
  let line: string | null = null;
  switch (event) {
    case 'PreToolUse':
      line = toolLine(parsed, raw);
      break;
    case 'PermissionRequest': {
      const action = toolLine(parsed, raw);
      line = action ? `Needs approval: ${action}` : null;
      break;
    }
    case 'UserPromptSubmit': {
      const prompt = firstLine(field(parsed, raw, 'prompt') ?? '');
      line = prompt ? `Asked: ${prompt}` : null;
      break;
    }
    case 'Stop': {
      const reply = firstLine(
        field(parsed, raw, 'last_assistant_message') ?? ''
      );
      line = reply || null;
      break;
    }
    default:
      line = null;
  }
  if (line === null) return null;
  const clipped = clip(line);
  return clipped || null;
}

/** The hook event a payload came from, for the cases a line cannot express:
 *  SessionEnd means the agent in that pane is gone. */
export function hookEvent(raw: string): string | undefined {
  return field(parseLenient(raw), raw, 'hook_event_name');
}

/** One agent in one tab of a session, as its hooks last reported it. */
export type PaneAgent = {
  state?: AgentState;
  line?: string;
  /** When it last reported, for picking the freshest line. */
  at: number;
  /** The tab's place in the strip, 1-based, for naming it when there are
   *  several agents. */
  tab: number;
};

/**
 * Several agents in one session's tabs, as the one row the rail has for it.
 * The state is the one that needs most from you: any tab waiting on approval
 * makes the row Needs you, any tab working makes it Working. The line comes
 * from a tab in that state, the freshest one, and names the tab when there
 * is more than one agent — otherwise "Running tests" could be any of them.
 */
export function rollUpAgents(agents: PaneAgent[]): {
  state?: AgentState;
  line?: string;
} {
  // Needs you first, then Working; with neither, every agent is idle or has
  // not reported yet, and any of them can speak for the row.
  const lead = (['blocked', 'working'] as const).find((state) =>
    agents.some((a) => a.state === state)
  );
  const leading = lead ? agents.filter((a) => a.state === lead) : agents;
  const state = lead ?? agents.find((a) => a.state)?.state;
  const pick = leading
    .filter((a) => a.line)
    .reduce<
      PaneAgent | undefined
    >((a, b) => (!a || b.at > a.at ? b : a), undefined);
  const line =
    pick?.line && agents.length > 1
      ? `Tab ${pick.tab} · ${pick.line}`
      : pick?.line;
  return { state, line };
}
