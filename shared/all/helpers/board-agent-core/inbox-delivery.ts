// One try at putting an inbox message (session-inbox.ts) into a session,
// never over a turn. Apart from the engine so the routing is tested without
// tmux: the engine lends the session's state and the three ways in.
//
// - a chat turn running: queued behind it, as a second chat message is (the
//   chat holds the conversation, so no terminal CLI is closed);
// - the CLI open in a tab: pasted in as its next prompt once its hooks say
//   idle; `busy` while it works or waits on a permission;
// - the CLI open in a tab that has reported nothing: pasted in only when it
//   has taken no prompt yet (below); else `unreported`;
// - neither: a chat turn, as the chat's own Send.
//
// The chat's own send would close a CLI open in the terminal to take the
// conversation (chatRun.ts drive), which is what closed the target's Claude
// mid-turn before the inbox.
//
// A CLI that has reported nothing (card 714c2360): its hooks fire on a
// prompt, a tool and a stop, so one that has run no turn was silent, read as
// not idle, and its message waited until someone typed into it by hand. The
// plugin's SessionStart hook now reports idle as the CLI opens. This covers
// the CLI that opened before that hook shipped, or whose report was lost: a
// conversation with no prompt in it has no turn to cut short and no
// permission prompt to type over, so once the pane has been seen that way
// for UNREPORTED_GRACE_MS (the CLI may still be drawing its prompt) the
// message goes in. One that has taken a prompt and still reports nothing
// (no redis on the host, Codex before its hooks are trusted) stays held:
// its screen may be a permission prompt, where a paste and Enter would
// answer it.

import type { AgentState } from '../../domains/electron';
import type { SessionPhase } from './session';
import type { InboxDelivery } from './session-inbox';

/** How long a CLI pane is seen with nothing reported before a message is
 *  pasted into its first prompt. */
export const UNREPORTED_GRACE_MS = 10_000;

/** The session as the terminal holds it now. */
export type InboxSessionState = {
  phase: SessionPhase;
  agentState?: AgentState;
  /** A tab's CLI has reported something (state or activity). */
  agentLive?: boolean;
  /** The chat's own CLI is on a turn. */
  chatRunning: boolean;
  /** Its workspace can be reached. */
  reachable: boolean;
};

export type InboxDeliveryDeps<P extends { paneId: string }> = {
  /** Null: no such session. */
  session: (postId: string) => InboxSessionState | null;
  /** The tab its CLI is open in, if any. */
  findPane: (postId: string) => Promise<P | null>;
  /** The CLI in `pane` has taken no prompt in its conversation. False when
   *  that cannot be told for sure. */
  neverPrompted: (postId: string, pane: P) => Promise<boolean>;
  /** Into the CLI in that pane, as its next prompt. */
  paste: (postId: string, pane: P, text: string) => Promise<void>;
  /** A chat turn, or queued behind the one running. */
  chatSend: (postId: string, text: string) => void;
  now?: () => number;
};

export class InboxDeliverer<P extends { paneId: string }> {
  /** postId -> the pane first seen with a CLI that had reported nothing,
   *  and when. */
  private unreported = new Map<string, { paneId: string; since: number }>();
  private readonly now: () => number;

  constructor(private readonly deps: InboxDeliveryDeps<P>) {
    this.now = deps.now ?? Date.now;
  }

  async deliver(postId: string, text: string): Promise<InboxDelivery> {
    const session = this.deps.session(postId);
    if (!session || session.phase === 'error') {
      this.unreported.delete(postId);
      return 'gone';
    }
    if (session.phase !== 'bare-active') return 'closed';
    if (session.chatRunning) {
      this.deps.chatSend(postId, text);
      return 'delivered';
    }
    if (!session.reachable) return 'gone';
    if (session.agentState === 'working' || session.agentState === 'blocked') {
      return 'busy';
    }
    const pane = await this.deps.findPane(postId);
    if (pane) {
      // Unknown (no hooks reported yet) is not idle: it goes in only at a
      // first prompt.
      if (
        session.agentState !== 'idle' &&
        !(await this.atFirstPrompt(postId, pane))
      ) {
        return 'unreported';
      }
      this.unreported.delete(postId);
      await this.deps.paste(postId, pane, text);
      return 'delivered';
    }
    this.unreported.delete(postId);
    // A CLI in a tab the runner cannot find (no session record) while the
    // hooks say one is there: never run a second CLI beside it.
    if (session.agentLive && session.agentState !== 'idle') return 'unreported';
    this.deps.chatSend(postId, text);
    return 'delivered';
  }

  /** The CLI in `pane` has reported nothing, has been seen so for the grace
   *  period, and has taken no prompt. */
  private async atFirstPrompt(postId: string, pane: P): Promise<boolean> {
    const seen = this.unreported.get(postId);
    if (!seen || seen.paneId !== pane.paneId) {
      this.unreported.set(postId, { paneId: pane.paneId, since: this.now() });
      return false;
    }
    if (this.now() - seen.since < UNREPORTED_GRACE_MS) return false;
    return this.deps.neverPrompted(postId, pane);
  }
}
