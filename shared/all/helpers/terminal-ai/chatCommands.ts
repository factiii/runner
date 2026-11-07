// The commands a session's chat box takes, the same for Claude Code and
// Codex: /resume, /clear, /model, /compact and Stop. Each is mapped to what
// the session's CLI accepts (the runner does that, chatRun.ts and
// codexPane.ts); one a CLI has no way to take is shown disabled, with why.
//
// No node imports: web and mobile read this table too.

import type { AgentProvider } from '../../domains/electron';

export type ChatCommand = 'resume' | 'clear' | 'model' | 'compact' | 'interrupt';

/** The ones the runner runs (bareChatCommand). /resume opens the map of past
 *  conversations instead, and Stop is bareChatInterrupt. */
export type RunnerChatCommand = Extract<ChatCommand, 'clear' | 'model' | 'compact'>;

type CommandSupport = { ok: true } | { ok: false; reason: string };

/** In the order the chat box draws them. */
export const CHAT_COMMANDS: { command: ChatCommand; label: string; hint: string }[] = [
  { command: 'resume', label: '/resume', hint: 'Pick up a past conversation' },
  { command: 'clear', label: '/clear', hint: 'Start a new conversation' },
  { command: 'model', label: '/model', hint: 'Change the model' },
  { command: 'compact', label: '/compact', hint: 'Summarize to free up context' },
  { command: 'interrupt', label: 'Stop', hint: 'Stop the running turn (Esc)' }
];

/** What `/model` offers for Claude: the CLI's own aliases, so they follow
 *  whatever model each currently names. `default` drops the choice. */
export const CLAUDE_MODELS = ['default', 'opus', 'sonnet', 'haiku'] as const;

/** A model name as the CLIs take one (`opus`, `claude-opus-4-1`,
 *  `sonnet[1m]`). Validated, not quoted: it is typed into a terminal. */
export const MODEL_RE = /^[A-Za-z0-9._[\]-]{1,64}$/;

/** Whether `provider`'s CLI can take `command` from the chat. */
export function commandSupport(
  provider: AgentProvider,
  command: ChatCommand
): CommandSupport {
  if (provider === 'codex' && command === 'model') {
    return {
      ok: false,
      reason:
        'Codex picks its model on its own screen: open the terminal and type /model there.'
    };
  }
  return { ok: true };
}

/** A shared command typed in the chat box (`/clear`, `/model opus`), or null
 *  for anything else, which goes to the agent as typed (`/cost`, a prompt).
 *  `/new` is Codex's word for /clear, and `/stop` is the Stop button. */
export function parseChatCommand(
  text: string
): { command: ChatCommand; arg: string } | null {
  const match = /^\/(resume|clear|new|model|compact|stop|interrupt)(?:\s+([\s\S]*))?$/i.exec(
    text.trim()
  );
  if (!match) return null;
  const word = match[1]!.toLowerCase();
  const arg = (match[2] ?? '').trim();
  if (word === 'new') return { command: 'clear', arg };
  if (word === 'stop') return { command: 'interrupt', arg };
  return { command: word as ChatCommand, arg };
}
