// What tmux runs when it creates a terminal tab.
//
// Its own module so the digest can hash it without importing the manager that
// runs it — one file holding both would be an import cycle.

import type { AgentProvider } from '../../domains/electron';

// Colored prompt. `--norc -i` keeps a system/user .bashrc from clobbering our
// PS1. Runs once per session; later attaches reuse the same bash.
//
// Exported for the digest: this is the part that MUTATES the shell, so it is
// the part a running shell cannot pick up again.
export function terminalPrelude(cwd: string, binDir: string): string {
  return [
    // cd in-script, falling back to $HOME. Must match the agent's worktree:
    // the CLIs key transcripts by cwd, so --resume needs it.
    `cd ${cwd} 2>/dev/null || cd "$HOME" 2>/dev/null || cd /`,
    // Prepended here rather than via the session env, so the login shell's
    // own PATH survives.
    `export PATH="${binDir}:$PATH"`,
    `export PS1='\\[\\e[1;32m\\]user@bare\\[\\e[0m\\]:\\w\\$ '`
  ].join('; ');
}

// Conversation ids are UUID-ish and arrive over the wire, so they get
// validated rather than escaped — anything unexpected simply doesn't resume.
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

// Opening prompt for a NEW agent on a card. The card's text is never injected:
// every session gets the factiii-board MCP, so the agent reads it from the
// board. The uuid is named as the `postId` those tools take - a bare id tells
// the agent nothing. Callers validate it with `isCardPostId`, and the prompt
// carries no apostrophes: it is passed inside a single-quoted shell word.
function cardBriefPrompt(postId: string): string {
  return `You are working on a Factiii board card. Its postId is ${postId}. Pass that postId to the factiii-board MCP: get_card to read the card, then card_comments for its discussion. Then start working on it.`;
}

// `auto`: claude's classifier decides, matching the headless pipeline; the user
// is here to answer escalations.
export const CLAUDE_PERMISSION_MODE = `--permission-mode auto`;

// First turn when resuming into the terminal: the board UI ran the agent under
// openui-lang, and this is a plain shell.
const RESUME_SEED =
  'You are now in an interactive terminal, not the board UI. Respond in plain text and use your normal tools; do not use openui-lang or component schemas anymore.';

/** What tmux runs when it CREATES the session. A resume id boots into the
 *  agent; when it exits we fall through to a shell rather than kill the pane. */
export function terminalInitScript(
  cwd: string,
  binDir: string,
  resumeAgentSessionId?: string,
  provider?: AgentProvider,
  cardPostId?: string
): string {
  const prelude = terminalPrelude(cwd, binDir);
  const shell = `exec bash --norc -i`;
  if (!resumeAgentSessionId || !SAFE_SESSION_ID.test(resumeAgentSessionId)) {
    // No thread to resume. With a card to work from, open a NEW agent pointed
    // at it; otherwise fall through to a plain shell.
    if (!cardPostId) return `${prelude}; ${shell}`;
    const prompt = cardBriefPrompt(cardPostId);
    const start =
      provider === 'codex'
        ? `codex '${prompt}'`
        : `claude ${CLAUDE_PERMISSION_MODE} '${prompt}'`;
    return `${prelude}; ${start}; ${shell}`;
  }
  const resume =
    provider === 'codex'
      ? `codex resume ${resumeAgentSessionId} '${RESUME_SEED}'`
      : `claude ${CLAUDE_PERMISSION_MODE} --resume ${resumeAgentSessionId} '${RESUME_SEED}'`;
  return `${prelude}; ${resume}; ${shell}`;
}
