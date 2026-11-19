// A session's inbox: where message_session's text lands, from this runner or
// relayed from another (.specs/card-sessions.md "Session tools", "Across
// runners"). It goes into the session's chat only when that never cuts a
// turn short: behind a chat turn that is running (queued, the way the chat
// queues a second message), or into the CLI open in the terminal once its
// hooks say it is idle. Until then it waits here, with the reason it waits
// (`hold`), and after SESSION_MESSAGE_HOLD_MS, or the sender's own shorter
// `holdMs`, it is "expired". Its sender can take it back while it waits
// (`cancel`): a message that went in after the work was done elsewhere would
// repeat it (card 714c2360).
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
  type RelayMessageHold,
  type RelayMessageState,
  SESSION_MESSAGE_HOLD_MS,
  SESSION_MESSAGES_HELD_MAX
} from '../../domains/sessionRelay';

/** What one try at delivery found. A hold (`busy`: a turn is running or a
 *  prompt is waiting on the user; `closed`: no terminal open yet;
 *  `unreported`: a CLI that has not said what it is doing): try again later.
 *  `gone`: no such session any more. */
export type InboxDelivery = 'delivered' | 'gone' | RelayMessageHold;

/** `cancelled`: taken back by its sender while it waited. Only here: a
 *  message that crossed the relay is the server's to hold. */
export type InboxState = RelayMessageState | 'cancelled';

export type InboxEntry = {
  id: string;
  postId: string;
  text: string;
  at: number;
  state: InboxState;
  /** While `waiting`: why, as the last try found it. */
  hold?: RelayMessageHold;
  /** When it stops waiting and is `expired`. */
  until: number;
  /** Who sent it (`<board>/<session>`), the only one who may cancel it.
   *  Absent: relayed from another runner. */
  from?: string;
};

export type InboxAddOptions = {
  /** The sender's id for it: see `add`. */
  id?: string;
  /** How long it may wait, when shorter than SESSION_MESSAGE_HOLD_MS. */
  holdMs?: number;
  from?: string;
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
   *  entry after that first try: `delivered`, or `waiting` with its `hold`.
   *  `id` is the sender's id for it (a relayed message keeps the server's):
   *  one already here, waiting or settled, is not added again, only its entry
   *  answered (the server resends a message whose answer it did not get).
   *  Throws when the session already has SESSION_MESSAGES_HELD_MAX waiting. */
  async add(
    postId: string,
    text: string,
    opts: InboxAddOptions = {}
  ): Promise<InboxEntry> {
    const { id } = opts;
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
      state: 'waiting',
      until:
        this.now() +
        Math.min(
          SESSION_MESSAGE_HOLD_MS,
          opts.holdMs && opts.holdMs > 0 ? opts.holdMs : SESSION_MESSAGE_HOLD_MS
        ),
      from: opts.from
    };
    this.waiting.push(entry);
    await this.flush();
    this.arm();
    return { ...entry };
  }

  /** Take back a message that still waits, for the sender it came from
   *  (`from`, as `add` was given it). False when it is not waiting here any
   *  more (delivered, expired, cancelled) or is not that sender's. A try in
   *  progress may still deliver it: then this is false too. */
  async cancel(id: string, from: string): Promise<boolean> {
    // Behind a try in progress: a message going in right now is not cancelled.
    await this.flushing;
    const entry = this.waiting.find((e) => e.id === id);
    if (!entry || entry.from !== from) return false;
    this.settle(entry, 'cancelled');
    if (this.waiting.length === 0) this.close();
    return true;
  }

  /** A message's state, while it is kept. */
  state(id: string): InboxState | null {
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
      // Cancelled while an earlier one was being tried.
      if (!this.waiting.includes(entry)) continue;
      if (this.now() > entry.until) {
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
      else {
        entry.hold = result;
        blocked.add(entry.postId);
      }
    }
    if (this.waiting.length === 0) this.close();
  }

  private settle(entry: InboxEntry, state: InboxState): void {
    this.waiting = this.waiting.filter((e) => e !== entry);
    entry.state = state;
    delete entry.hold;
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
