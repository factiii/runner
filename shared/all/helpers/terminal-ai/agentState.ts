// What the CLI is doing, as the factiii plugin's hooks report it.
//
// Carried on the space's own redis, `redis-cli` over a unix socket. Redis is
// push with no debounce and needs no filesystem watcher per engine. It is an
// extra (toolchain.ts EXTRA_TOOLS): where it is not installed the hook's
// redis-cli fails silently and the dots keep no live state; card state does
// not depend on it (state.ts keeps that in files).
//
// It replaced a tmux heuristic that watched pane output. That worked for
// claude and was wrong for codex, which re-emits its prompt frame every couple
// of seconds while idle and so never looked idle. Neither could tell "thinking"
// from "waiting for you to approve something", which is the state actually
// worth showing.

import type { AgentState } from '../../domains/electron';

export type { AgentState };

const STATES = new Set<AgentState>(['working', 'idle', 'blocked']);

/** One channel for the whole space, with the pane in the payload. A channel
 *  per session would mean re-subscribing every time one starts. */
export const AGENT_STATE_CHANNEL = 'agent-state';

/** Last reported state, keyed by pane, so a subscriber that starts mid-session
 *  — a runner restart — reads where things stand instead of waiting for the
 *  next hook to fire. */
export function agentStateKey(paneId: string): string {
  return `agent-state:${paneId}`;
}

/** `<paneId> <state>`, as report-state.sh publishes it. The pane is the
 *  identity because it is the one thing the hook can read without being told:
 *  tmux sets it at pane creation, so sessions that predate a runner upgrade
 *  have it, where an injected variable would only reach new ones. */
export function parseAgentMessage(
  payload: string
): { paneId: string; state: AgentState } | null {
  const at = payload.indexOf(' ');
  if (at <= 0) return null;
  const state = parseAgentState(payload.slice(at + 1));
  return state ? { paneId: payload.slice(0, at), state } : null;
}

/** Which session owns a tmux session name, given the sessions in play.
 *  Mirrors tmuxName(): `terminal-<sanitized(postId)>-<tab>`. The sanitiser is
 *  not reversible, so the caller's own ids are the lookup. */
export function postIdForSessionName(
  sessionName: string,
  postIds: Iterable<string>
): string | null {
  for (const postId of postIds) {
    if (sessionName.startsWith(sessionNamePrefix(postId))) return postId;
  }
  return null;
}

/** `terminal-<sanitized(postId)>-`: every tab's tmux session name starts with
 *  it, and the tab id is what follows. */
export function sessionNamePrefix(postId: string): string {
  return `terminal-${postId.replace(/[^a-zA-Z0-9._-]/g, '_')}-`;
}

/** Returns null for anything unrecognised — a truncated line, a state from a
 *  newer plugin — so the dot keeps its last value rather than inventing one. */
export function parseAgentState(text: string): AgentState | null {
  const word = text.trim();
  return STATES.has(word as AgentState) ? (word as AgentState) : null;
}

/**
 * Pull complete messages out of a `redis-cli subscribe` stream.
 *
 * In non-tty mode redis-cli prints each reply element on its own line, so one
 * published message arrives as three: `message`, the channel, then the payload.
 * stdout arrives in arbitrary chunks, so anything short of a whole group is
 * handed back as `rest` for the next chunk to complete.
 *
 * The channel rides along: one subscriber serves both the state and the
 * activity channel (agentActivity.ts), and the payloads tell them apart only
 * by where they came from.
 */
export function drainPubSub(buffer: string): {
  messages: { channel: string; payload: string }[];
  rest: string;
} {
  const lines = buffer.split('\n');
  // Whatever follows the last newline is a partial line, never a whole one.
  const partial = lines.pop() ?? '';
  const messages: { channel: string; payload: string }[] = [];
  let i = 0;
  let consumed = 0;
  while (i < lines.length) {
    if (lines[i] !== 'message') {
      // The subscribe/channel/count preamble, and anything else redis says.
      i += 1;
      consumed = i;
      continue;
    }
    if (i + 2 >= lines.length) break;
    messages.push({ channel: lines[i + 1]!, payload: lines[i + 2]! });
    i += 3;
    consumed = i;
  }
  return { messages, rest: [...lines.slice(consumed), partial].join('\n') };
}
