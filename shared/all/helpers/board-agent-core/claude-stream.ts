import type { ChildProcess } from 'child_process';

import {
  type ClaudeTypes,
  ContentType,
  type Input,
  type MessageContent,
  RoleEnum,
  type ToolUseResultClass
} from './claude-stream-types';

export type LogEntry = {
  type: 'system' | 'text' | 'text-append' | 'tool' | 'error' | 'thinking';
  content: string;
};

export type TodoItem = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export interface ClaudeStreamCallbacks {
  onLog?: (entry: LogEntry) => void;
  onTodos?: (todos: TodoItem[]) => void;
  // Tasks persist across turns but each spawn gets a fresh parser, so without
  // this seed a later TaskUpdate targets an empty list and is dropped.
  initialTodos?: TodoItem[];
  // Audit taps: raw, untruncated tool calls/results (onLog truncates for display).
  onToolUse?: (t: {
    id?: string;
    name: string;
    input: Record<string, unknown>;
  }) => void;
  onToolResult?: (r: {
    toolUseId?: string;
    content: string;
    isError: boolean;
  }) => void;
  /** The conversation's id as soon as the CLI names it (Codex's
   *  thread.started), before the run ends: the chat reads a new
   *  conversation's file while its first turn runs (chatRun.ts). */
  onSessionId?: (id: string) => void;
}

// ── Formatting helpers ──

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function formatToolUse(name: string, input: Input): string {
  if (name === 'Read' && input.file_path) return `Read ${input.file_path}`;
  if (name === 'Edit' && input.file_path) return `Edit ${input.file_path}`;
  if (name === 'Write' && input.file_path) return `Write ${input.file_path}`;
  if (name === 'Glob' && input.pattern) return `Glob ${input.pattern}`;
  if (name === 'Grep' && input.pattern) return `Grep "${input.pattern}"`;
  if (name === 'Bash' && input.command) return `$ ${String(input.command)}`;
  if (name === 'Agent' && (input.description || input.prompt))
    return `Agent: ${String(input.description || input.prompt)}`;
  return `${name} ${JSON.stringify(input)}`;
}

function formatToolResult(r: ToolUseResultClass): string | null {
  // Edit
  if (r.filePath && r.structuredPatch) {
    const lines = r.structuredPatch.reduce((s, p) => s + p.lines.length, 0);
    return `Edited ${r.filePath} (${lines} lines changed)`;
  }
  // Read
  if (r.file) return `${r.file.filePath} (${r.file.numLines} lines)`;
  // Glob / Grep
  if (r.filenames) {
    const count = r.numFiles ?? r.filenames.length;
    if (count === 0) return 'No files found';
    const names = r.filenames.slice(0, 5).join(', ');
    const more = count > 5 ? ` (+${count - 5} more)` : '';
    return `Found ${count} file(s): ${names}${more}`;
  }
  // Agent completion
  if (r.agentId && r.totalDurationMs != null) {
    const secs = Math.round(r.totalDurationMs / 1000);
    const tools = r.totalToolUseCount ?? 0;
    return `Agent completed in ${secs}s (${tools} tool calls)`;
  }
  return null;
}

function extractContentText(block: MessageContent): string {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .filter((c) => c.type === ContentType.Text && c.text)
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Main processing ──

function processLine(
  trimmed: string,
  state: {
    fullText: string;
    receivedDeltas: boolean;
    sessionId: string;
    isError: boolean;
    tasks: TodoItem[];
  },
  cb: ClaudeStreamCallbacks
): void {
  const e = JSON.parse(trimmed) as ClaudeTypes;

  if (e.session_id) state.sessionId = e.session_id;

  // ── system ──
  if (e.type === RoleEnum.System) {
    if (e.subtype === 'init') {
      cb.onLog?.({
        type: 'system',
        content: `Claude ${e.claude_code_version ?? ''} (${e.model ?? 'unknown'})`
      });
      return;
    }

    if (e.subtype === 'task_started') {
      cb.onLog?.({
        type: 'tool',
        content: `Agent: ${e.description ?? e.prompt ?? ''}`
      });
      return;
    }

    if (e.subtype === 'task_progress' && e.description) {
      const usage = e.usage;
      const parts = [e.description];
      if (usage?.tool_uses) parts.push(`(${usage.tool_uses} tools`);
      if (usage?.duration_ms)
        parts.push(
          `${parts.length > 1 ? ', ' : '('}${formatDuration(usage.duration_ms)}`
        );
      if (parts.length > 1) parts.push(')');
      cb.onLog?.({ type: 'tool', content: parts.join('') });
      return;
    }

    if (e.subtype === 'task_notification') {
      const usage = e.usage;
      const parts = [`Agent done: ${e.summary ?? ''}`];
      if (usage?.tool_uses) parts.push(`${usage.tool_uses} tools`);
      if (usage?.duration_ms) parts.push(formatDuration(usage.duration_ms));
      if (usage?.total_tokens)
        parts.push(`${(usage.total_tokens / 1000).toFixed(1)}k tokens`);
      cb.onLog?.({
        type: 'system',
        content:
          parts.length > 1
            ? `${parts[0]} (${parts.slice(1).join(', ')})`
            : parts[0]
      });
      return;
    }

    if (e.subtype === 'task_completed') {
      cb.onLog?.({
        type: 'system',
        content: `Agent done: ${e.description ?? ''}`
      });
      return;
    }

    return;
  }

  // ── rate_limit_event ──
  if (e.type === RoleEnum.RateLimitEvent && e.rate_limit_info) {
    if (e.rate_limit_info.status === 'rejected') {
      state.isError = true;
      const resets = new Date(
        e.rate_limit_info.resetsAt * 1000
      ).toLocaleTimeString();
      cb.onLog?.({
        type: 'error',
        content: `Rate limited (resets ${resets})`
      });
    }
    return;
  }

  // ── assistant ──
  if (e.type === RoleEnum.Assistant && e.message) {
    // Audit tap: the complete message arrives exactly once, deltas don't.
    for (const block of e.message.content) {
      if (block.type === ContentType.ToolUse && block.name && block.input) {
        cb.onToolUse?.({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>
        });
        const rawInput = block.input as Record<string, unknown>;
        if (block.name === 'TodoWrite' && rawInput.todos) {
          state.tasks = (rawInput.todos as TodoItem[]).map((t) => ({
            content: String(t.content || ''),
            status: (t.status || 'pending') as TodoItem['status']
          }));
          cb.onTodos?.(state.tasks);
        } else if (block.name === 'TaskCreate') {
          const content = String(
            rawInput.subject || rawInput.description || rawInput.content || ''
          );
          if (content) {
            state.tasks = [...state.tasks, { content, status: 'pending' }];
            cb.onTodos?.(state.tasks);
          }
        } else if (block.name === 'TaskUpdate' && rawInput.taskId) {
          const idx = Number(rawInput.taskId) - 1;
          const task = state.tasks[idx];
          if (task) {
            state.tasks = state.tasks.map((t, i) =>
              i === idx
                ? {
                    content: String(rawInput.subject || t.content),
                    status: (rawInput.status || t.status) as TodoItem['status']
                  }
                : t
            );
            cb.onTodos?.(state.tasks);
          }
        }
      }
    }

    if (state.receivedDeltas || state.isError) return;

    for (const block of e.message.content) {
      if (block.type === ContentType.Text && block.text) {
        state.fullText += block.text;
        cb.onLog?.({ type: 'text', content: block.text });
      }
      if (block.type === ContentType.Thinking && block.thinking) {
        cb.onLog?.({ type: 'thinking', content: block.thinking });
      }
      if (block.type === ContentType.ToolUse && block.name && block.input) {
        cb.onLog?.({
          type: 'tool',
          content: formatToolUse(block.name, block.input)
        });
      }
    }
    return;
  }

  // ── user (tool results) ──
  if (e.type === RoleEnum.User && e.message) {
    for (const block of e.message.content) {
      if (block.type === ContentType.ToolResult) {
        const text = extractContentText(block);
        cb.onToolResult?.({
          toolUseId: block.tool_use_id,
          content: text,
          isError: block.is_error === true
        });
        if (text) {
          cb.onLog?.({
            type: block.is_error ? 'tool' : 'text',
            content: block.is_error
              ? truncate(`Tool error: ${text}`, 2000)
              : truncate(text, 2000)
          });
        }
      }
      if (
        block.type === ContentType.Text &&
        block.text &&
        e.parent_tool_use_id
      ) {
        cb.onLog?.({
          type: 'system',
          content: truncate(`Agent input: ${block.text}`, 1000)
        });
      }
    }

    if (e.tool_use_result && typeof e.tool_use_result !== 'string') {
      const summary = formatToolResult(e.tool_use_result);
      if (summary) cb.onLog?.({ type: 'text', content: summary });
    }
    if (typeof e.tool_use_result === 'string' && e.tool_use_result) {
      cb.onLog?.({
        type: 'tool',
        content: truncate(`Tool error: ${e.tool_use_result}`, 2000)
      });
    }

    state.receivedDeltas = false;
    return;
  }

  // ── result ──
  if (e.type === RoleEnum.Result) {
    if (e.is_error) {
      state.isError = true;
      const errorText = e.result || 'Claude encountered an error';
      state.fullText = errorText;
      cb.onLog?.({ type: 'error', content: errorText });
      return;
    }
    if (e.result && !state.fullText) {
      state.fullText = e.result;
      cb.onLog?.({ type: 'text', content: e.result });
    }
    const parts = [];
    if (e.num_turns) parts.push(`${e.num_turns} turns`);
    if (e.duration_ms) parts.push(formatDuration(e.duration_ms));
    if (e.total_cost_usd != null) parts.push(`$${e.total_cost_usd.toFixed(2)}`);
    if (parts.length) {
      cb.onLog?.({ type: 'system', content: `Done (${parts.join(', ')})` });
    }
  }
}

// ── Stream-event handling (--include-partial-messages) ──

function processStreamEvent(
  raw: { type: string; event?: Record<string, unknown> },
  state: { fullText: string; receivedDeltas: boolean },
  cb: ClaudeStreamCallbacks
): boolean {
  if (raw.type !== 'stream_event' || !raw.event) return false;
  const evt = raw.event as {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string };
    content_block?: {
      type?: string;
      name?: string;
      input?: Input;
    };
  };

  if (evt.type === 'content_block_delta') {
    if (evt.delta?.type === 'text_delta' && evt.delta.text) {
      state.receivedDeltas = true;
      state.fullText += evt.delta.text;
      cb.onLog?.({ type: 'text-append', content: evt.delta.text });
    }
    if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
      cb.onLog?.({ type: 'thinking', content: evt.delta.thinking });
    }
  }

  if (
    evt.type === 'content_block_start' &&
    evt.content_block?.type === 'tool_use' &&
    evt.content_block.name
  ) {
    cb.onLog?.({
      type: 'tool',
      content: formatToolUse(
        evt.content_block.name,
        evt.content_block.input || {}
      )
    });
  }

  return true;
}

// ── Public API ──

export function pipeClaudeStream(
  proc: ChildProcess,
  callbacks: ClaudeStreamCallbacks
): { fullText: () => string; sessionId: () => string; isError: () => boolean } {
  const state = {
    fullText: '',
    receivedDeltas: false,
    sessionId: '',
    isError: false,
    // TaskCreate/TaskUpdate tracking; ids are creation order, carried over
    // from the previous turn via initialTodos.
    tasks: [...(callbacks.initialTodos ?? [])] as TodoItem[]
  };
  let buffer = '';

  const drain = (flush: boolean) => {
    const lines = buffer.split('\n');
    buffer = flush ? '' : lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // stream-json is one JSON object per line; anything else is a spawn
      // diagnostic. Capture it, or the cause is lost behind a bare exit code.
      if (trimmed[0] !== '{' && trimmed[0] !== '[') {
        state.isError = true;
        state.fullText = state.fullText
          ? `${state.fullText}\n${trimmed}`
          : trimmed;
        continue;
      }
      try {
        const raw = JSON.parse(trimmed);
        if (processStreamEvent(raw, state, callbacks)) continue;
        processLine(trimmed, state, callbacks);
      } catch (err) {
        console.error(
          '[claude-stream] Failed to process line:',
          err,
          trimmed.slice(0, 200)
        );
      }
    }
  };

  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    drain(false);
  });

  proc.stdout?.on('end', () => {
    if (buffer.trim()) drain(true);
  });

  return {
    fullText: () => state.fullText,
    sessionId: () => state.sessionId,
    isError: () => state.isError
  };
}
