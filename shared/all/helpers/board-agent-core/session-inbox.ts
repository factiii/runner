// A session's inbox: where message_session's text lands, from this runner or
// relayed from another (.specs/card-sessions.md "Session tools", "Across
// runners"). It goes into the session's chat only when that never cuts a
// turn short: behind a chat turn that is running (queued, the way the chat
// queues a second message), or into the CLI open in the terminal once its
// hooks say it is idle. Until then it waits here, and after
// SESSION_MESSAGE_HOLD_MS it is "expired".
//
// It replaced a straight chat send, which closed the Claude open in the
// target's terminal (chatRun.ts takes the conversation from a terminal CLI
// by stopping it) even in the middle of a turn: card 6336db91.
//
// Kept in memory: a message waits here only while its session is busy, and
// a runner restart drops what is still waiting (the session is restarted
// too). One held for an offline runner waits on the server instead.

import { randomUUID } from 'crypto';

import {
  type RelayMessageState,
  SESSION_MESSAGE_HOLD_MS,
  SESSION_MESSAGES_HELD_MAX
} from '../../domains/sessionRelay';

/** What one try at delivery found. `busy`: a turn is running or a prompt is
 *  waiting on the user: try again later. `gone`: no such session any more. */
export type InboxDelivery = 'delivered' | 'busy' | 'gone';

export type InboxEntry = {
  id: string;
  postId: string;
  text: string;
  at: number;
  state: RelayMessageState;
};

export type SessionInboxOptions = {
  /** One try at putting `text` in the session's chat. Never cuts a turn
   *  short: answers `busy` instead. */
  deliver: (postId: string, text: string) => Promise<InboxDelivery>;
  now?: () => number;
  /** How often waiting messages are tried again. */
  retryMs?: number;
  /** A message was delivered or gave up. */
  onSettled?: (entry: InboxEntry) => void;
};

/** How often a waiting message is tried again. A turn's end is seen within
 *  this. */
export const INBOX_RETRY_MS = 3000;
/** Settled entries kept for their state, per inbox. */
const SETTLED_KEPT = 200;

export class SessionInbox {
  private waiting: InboxEntry[] = [];
  private settled = new Map<string, InboxEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: SessionInboxOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Put `text` in `postId`'s inbox and try it at once. Resolves with the
   *  entry after that first try: `delivered`, or `waiting`. `id` is the
   *  sender's id for it (a relayed message keeps the server's): one already
   *  here, waiting or settled, is not added again, only its entry answered
   *  (the server resends a message whose answer it did not get). Throws when
   *  the session already has SESSION_MESSAGES_HELD_MAX waiting. */
  async add(postId: string, text: string, id?: string): Promise<InboxEntry> {
    const known = id
      ? (this.waiting.find((e) => e.id === id) ?? this.settled.get(id))
      : undefined;
    if (known) return { ...known };
    const queued = this.waiting.filter((e) => e.postId === postId).length;
    if (queued >= SESSION_MESSAGES_HELD_MAX) {
      throw new Error(
        `That session already has ${queued} messages waiting for it. Wait for it to read them.`
      );
    }
    const entry: InboxEntry = {
      id: id ?? randomUUID(),
      postId,
      text,
      at: this.now(),
      state: 'waiting'
    };
    this.waiting.push(entry);
    await this.flush();
    this.arm();
    return { ...entry };
  }

  /** A message's state, while it is kept. */
  state(id: string): RelayMessageState | null {
    const waiting = this.waiting.find((e) => e.id === id);
    return waiting?.state ?? this.settled.get(id)?.state ?? null;
  }

  /** The messages still waiting, oldest first. */
  pending(postId?: string): InboxEntry[] {
    return this.waiting
      .filter((e) => !postId || e.postId === postId)
      .map((e) => ({ ...e }));
  }

  /** Try every waiting message once, oldest first, one session at a time:
   *  a session's second message never overtakes its first. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.flushOnce().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async flushOnce(): Promise<void> {
    const blocked = new Set<string>();
    for (const entry of [...this.waiting]) {
      if (this.now() - entry.at > SESSION_MESSAGE_HOLD_MS) {
        this.settle(entry, 'expired');
        continue;
      }
      if (blocked.has(entry.postId)) continue;
      let result: InboxDelivery;
      try {
        result = await this.opts.deliver(entry.postId, entry.text);
      } catch {
        // A failed try (tmux gone for a moment) is a busy one: kept.
        result = 'busy';
      }
      if (result === 'delivered') this.settle(entry, 'delivered');
      else if (result === 'gone') this.settle(entry, 'failed');
      else blocked.add(entry.postId);
    }
    if (this.waiting.length === 0) this.close();
  }

  private settle(entry: InboxEntry, state: RelayMessageState): void {
    this.waiting = this.waiting.filter((e) => e !== entry);
    entry.state = state;
    this.settled.set(entry.id, entry);
    // The text is not kept once it is settled: only that it was.
    entry.text = '';
    while (this.settled.size > SETTLED_KEPT) {
      const oldest = this.settled.keys().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
    this.opts.onSettled?.({ ...entry });
  }

  private arm(): void {
    if (this.timer || this.waiting.length === 0) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.opts.retryMs ?? INBOX_RETRY_MS);
    // Never what keeps the process alive.
    (this.timer as { unref?: () => void }).unref?.();
  }
}
