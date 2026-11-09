import type { ChildProcess } from 'child_process';

import type { ClaudeStreamCallbacks, TodoItem } from './claude-stream';

// Parser for `codex exec --json`: newline-delimited thread events, mapped onto
// the same callback surface the Claude parser feeds, so UIs stay provider-blind.

type CodexItem = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: { path?: string; kind?: string }[];
  items?: { text?: string; completed?: boolean }[];
  server?: string;
  tool?: string;
  query?: string;
  message?: string;
};

type CodexEvent = {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  item?: CodexItem;
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

const CHANGE_VERBS: Record<string, string> = {
  add: 'Write',
  update: 'Edit',
  delete: 'Delete'
};

type StreamState = {
  fullText: string;
  sessionId: string;
  // A turn.failed event, or pure-junk stdout with no valid events, is fatal.
  failed: boolean;
  // We parsed at least one recognized event, so any non-JSON line is noise.
  sawValid: boolean;
  // Non-JSON stdout lines (shell diagnostics on a real exec failure).
  junk: string;
};

function processEvent(
  e: CodexEvent,
  state: StreamState,
  cb: ClaudeStreamCallbacks
): void {
  state.sawValid = true;

  if (e.type === 'thread.started') {
    if (e.thread_id) {
      state.sessionId = e.thread_id;
      cb.onSessionId?.(e.thread_id);
    }
    return;
  }

  if (e.type === 'turn.failed') {
    state.failed = true;
    const message = e.error?.message || 'Codex turn failed';
    state.fullText = message;
    cb.onLog?.({ type: 'error', content: message });
    return;
  }

  // Top-level error events also cover transient reconnect notices, which are
  // non-fatal - surface them without failing the run (turn.failed decides).
  if (e.type === 'error') {
    if (e.message) cb.onLog?.({ type: 'error', content: e.message });
    return;
  }

  const item = e.item;
  if (!item?.type) return;

  // The plan tool streams updates on every check-off; mirror each into todos.
  if (item.type === 'todo_list' && item.items) {
    const todos: TodoItem[] = item.items.map((t) => ({
      content: String(t.text || ''),
      status: t.completed ? 'completed' : 'pending'
    }));
    cb.onTodos?.(todos);
    return;
  }

  if (e.type === 'item.started' && item.type === 'command_execution') {
    if (item.command) {
      cb.onToolUse?.({
        id: item.id,
        name: 'Bash',
        input: { command: item.command }
      });
      cb.onLog?.({ type: 'tool', content: `$ ${item.command}` });
    }
    return;
  }

  if (e.type !== 'item.completed') return;

  switch (item.type) {
    case 'agent_message':
      if (item.text) {
        state.fullText += state.fullText ? `\n${item.text}` : item.text;
        cb.onLog?.({ type: 'text', content: item.text });
      }
      return;
    case 'reasoning':
      if (item.text) cb.onLog?.({ type: 'thinking', content: item.text });
      return;
    case 'command_execution': {
      const output = item.aggregated_output || '';
      const isError = item.status === 'failed' || (item.exit_code ?? 0) !== 0;
      cb.onToolResult?.({ toolUseId: item.id, content: output, isError });
      if (output) {
        cb.onLog?.({
          type: isError ? 'tool' : 'text',
          content: isError
            ? truncate(`Tool error: ${output}`, 2000)
            : truncate(output, 2000)
        });
      }
      return;
    }
    case 'file_change':
      for (const change of item.changes ?? []) {
        if (!change.path) continue;
        const verb = CHANGE_VERBS[change.kind ?? ''] ?? 'Edit';
        cb.onLog?.({ type: 'tool', content: `${verb} ${change.path}` });
      }
      return;
    case 'web_search':
      if (item.query) {
        cb.onLog?.({ type: 'tool', content: `WebSearch "${item.query}"` });
      }
      return;
    case 'mcp_tool_call':
      cb.onLog?.({
        type: 'tool',
        content: `MCP ${[item.server, item.tool].filter(Boolean).join('.')}`
      });
      return;
    case 'error':
      // Item-level errors are non-fatal warnings.
      if (item.message) cb.onLog?.({ type: 'error', content: item.message });
      return;
  }
}

/** Same surface as pipeClaudeStream. sessionId is the codex thread id, used
 *  with `codex exec resume`. */
export function pipeCodexStream(
  proc: ChildProcess,
  callbacks: ClaudeStreamCallbacks
): { fullText: () => string; sessionId: () => string; isError: () => boolean } {
  const state: StreamState = {
    fullText: '',
    sessionId: '',
    failed: false,
    sawValid: false,
    junk: ''
  };
  let buffer = '';

  const drain = (flush: boolean) => {
    const lines = buffer.split('\n');
    buffer = flush ? '' : lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Anything not JSON is a diagnostic or a banner. Only fatal when NO
      // valid events arrived, so a banner can't sink a good turn.
      if (trimmed[0] !== '{') {
        state.junk = state.junk ? `${state.junk}\n${trimmed}` : trimmed;
        continue;
      }
      try {
        processEvent(JSON.parse(trimmed) as CodexEvent, state, callbacks);
      } catch (err) {
        console.error(
          '[codex-stream] Failed to process line:',
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
    fullText: () => state.fullText || state.junk,
    sessionId: () => state.sessionId,
    isError: () => state.failed || (Boolean(state.junk) && !state.sawValid)
  };
}
