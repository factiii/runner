// The sessions this engine ended, so one is never started again under its
// old id (card d7f20f01). A client's session view starts the session it is
// opened on when the runner holds none (that is how a card's terminal
// begins), so a client that still had an ended session open, a phone coming
// back to the foreground say, started it again: the ended session was back,
// empty, on every client. The apps now leave such a view (shared
// `absentSession`); this holds for an app from before that.
//
// Only the ids made for one launch (`bare-<time>-<random>`, from the launcher
// and start_session): nothing but a stale view asks for one twice. A card's
// session (its card's uuid) and the board's own terminal (`board-<slug>`) are
// started again on purpose after an End. In memory: after a runner restart a
// window reopened on its session starts it again, as before.

/** How many ended ids are remembered; the oldest go first. */
export const ENDED_SESSIONS_KEPT = 500;

export const SESSION_ENDED_ERROR =
  'This session was ended. Start a new one from the sessions list.';

/** An id made for one launch, never used for a second session. */
export const isLaunchSessionId = (postId: string) => postId.startsWith('bare-');

export class EndedSessions {
  // A Set keeps insertion order: the first is the oldest.
  private ids = new Set<string>();

  constructor(private readonly kept = ENDED_SESSIONS_KEPT) {}

  /** `postId` was ended. */
  note(postId: string): void {
    if (!isLaunchSessionId(postId)) return;
    this.ids.delete(postId);
    this.ids.add(postId);
    while (this.ids.size > this.kept) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
  }

  /** `postId` was ended here and must not be started again. */
  has(postId: string): boolean {
    return this.ids.has(postId);
  }
}
