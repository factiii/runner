// Where a viewer stopped in a long video, so it opens there next time
// (.specs/uploads.md → "Resume where you stopped"). Web (hooks/useVideoResume)
// and mobile (components/posts/PostVideo.tsx) both decide through here; the
// server only stores the number (routers/watchProgress.ts).

/**
 * Videos this long or longer remember a position. The same line as the
 * default `hlsMinDurationSeconds`: a short clip replays from the top, which is
 * what a viewer of one expects.
 */
export const WATCH_PROGRESS_MIN_DURATION_SECONDS = 60;

/** A position this close to the start is not worth resuming: it is cleared. */
export const WATCH_PROGRESS_MIN_POSITION_SECONDS = 5;

/**
 * A position this close to the end (or past WATCH_PROGRESS_FINISHED_FRACTION)
 * counts as finished: it is cleared, so the next open starts from the top
 * instead of a few seconds before the credits end.
 */
export const WATCH_PROGRESS_END_MARGIN_SECONDS = 10;
export const WATCH_PROGRESS_FINISHED_FRACTION = 0.95;

/** How often a playing video sends its position. */
export const WATCH_PROGRESS_SAVE_INTERVAL_MS = 15_000;

/** A save that moves the stored position by less than this is not sent. */
export const WATCH_PROGRESS_MIN_CHANGE_SECONDS = 2;

/** The longest position the server takes (validators), 24 hours. */
export const WATCH_PROGRESS_MAX_SECONDS = 24 * 60 * 60;

const isUsableDuration = (duration: number): boolean =>
  Number.isFinite(duration) && duration > 0;

/** Whether a video of this duration remembers where it was stopped. */
export const tracksWatchProgress = (duration: number): boolean =>
  isUsableDuration(duration) && duration >= WATCH_PROGRESS_MIN_DURATION_SECONDS;

const isNearEnd = (position: number, duration: number): boolean =>
  position >= duration - WATCH_PROGRESS_END_MARGIN_SECONDS ||
  position >= duration * WATCH_PROGRESS_FINISHED_FRACTION;

/**
 * The whole seconds to store for a position, `0` to clear it (near the start,
 * or finished), or null when this video keeps no position at all.
 */
export const positionToSave = (
  position: number,
  duration: number
): number | null => {
  if (!tracksWatchProgress(duration) || !Number.isFinite(position)) return null;
  if (position < WATCH_PROGRESS_MIN_POSITION_SECONDS) return 0;
  if (isNearEnd(position, duration)) return 0;
  return Math.min(Math.floor(position), WATCH_PROGRESS_MAX_SECONDS);
};

/**
 * Where to start a video from a stored position, or null to start from the
 * top: nothing stored, a short video, or a position that is now near the end
 * (a stored row from before the rules above, or a video that was replaced).
 */
export const resumePositionOf = (
  saved: number | null | undefined,
  duration: number
): number | null => {
  if (saved === null || saved === undefined) return null;
  if (!tracksWatchProgress(duration)) return null;
  if (saved < WATCH_PROGRESS_MIN_POSITION_SECONDS) return null;
  if (isNearEnd(saved, duration)) return null;
  return saved;
};
