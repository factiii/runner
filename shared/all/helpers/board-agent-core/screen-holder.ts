import type { BoardAgentAction, ScreenHolderView } from '../../domains/electron';

// Who has the runner's video stream (.specs/simulator-panel.md "One viewer").
//
// A machine has one encoder and each peer one video track, which the
// simulator uses. So there is one holder for the machine, not one per
// simulator and not one per board. The holder is a link (one
// peer connection), named by the user the server vouched for on it. The runner
// sends frames to the holder's track only and takes input from the holder
// only; a second viewer blacked out by its own app would still receive the
// frames.
//
// No takeover: the hold ends when the holder detaches, their link closes or
// their level goes. The owner waits like anyone else.

/** What is on the stream. Only the simulator now: the desktop view
 *  (`screen` in ScreenHolderView, from an older runner) was removed. */
export type ScreenKind = Extract<ScreenHolderView['kind'], 'simulator'>;

/** `L` is whatever identifies a link to the daemon; compared by identity. */
export type ScreenHold<L> = {
  link: L;
  userId: string;
  name: string;
  kind: ScreenKind;
  /** The board the attach came in on: where the holder's level is read. */
  spaceSlug: string;
};

export type ScreenUse = 'attach' | 'input' | 'detach';

const SCREEN_USES: Partial<
  Record<BoardAgentAction, { use: ScreenUse; kind: ScreenKind }>
> = {
  simulatorAttach: { use: 'attach', kind: 'simulator' },
  simulatorInput: { use: 'input', kind: 'simulator' },
  simulatorDetach: { use: 'detach', kind: 'simulator' }
};

/** What `action` does to the video stream, or null when it does not touch it
 *  (listing devices, reading permissions). */
export function screenUse(
  action: BoardAgentAction
): { use: ScreenUse; kind: ScreenKind } | null {
  return SCREEN_USES[action] ?? null;
}

/** The first words of a refusal because someone else holds the stream. */
export const SCREEN_IN_USE = 'SCREEN_IN_USE';
export const SCREEN_NEEDS_VIDEO =
  'This link carries no video, so it cannot open the simulator.';

const KIND_NAME: Record<ScreenKind, string> = {
  simulator: 'the simulator'
};

export type ScreenDecision<L> = {
  /** The holder after this request. */
  holder: ScreenHold<L> | null;
  /** Whether the engine runs the action. */
  run: boolean;
  /** The error for the caller. A detach by a non-holder has none: it is
   *  answered as done, and stops nothing. */
  refusal?: string;
};

/**
 * Decide one attach, input or detach.
 *
 * - attach: taken when nobody holds the stream, or by the holder again (new
 *   encoder options). A link with no
 *   video track never takes it: it would hold the screen and see nothing.
 * - input: the holder only, and only for the screen it has up.
 * - detach: the holder's ends the hold. Anyone else's does nothing, so a
 *   blacked-out panel that closes cannot stop the holder's picture.
 */
export function decideScreenUse<L>(
  holder: ScreenHold<L> | null,
  request: {
    link: L;
    userId: string;
    name: string;
    spaceSlug: string;
    use: ScreenUse;
    kind: ScreenKind;
    hasVideo: boolean;
  }
): ScreenDecision<L> {
  const { link, userId, name, spaceSlug, use, kind } = request;
  const mine = holder !== null && holder.link === link;
  const inUse = () =>
    `${SCREEN_IN_USE}: ${holder?.name || 'Someone else'} is using ${
      KIND_NAME[holder?.kind ?? kind]
    }. One person at a time.`;

  if (use === 'attach') {
    if (holder && !mine) return { holder, run: false, refusal: inUse() };
    if (!request.hasVideo) {
      return { holder, run: false, refusal: SCREEN_NEEDS_VIDEO };
    }
    return { holder: { link, userId, name, kind, spaceSlug }, run: true };
  }
  if (use === 'input') {
    if (mine && holder.kind === kind) return { holder, run: true };
    return {
      holder,
      run: false,
      refusal: holder ? inUse() : `Open ${KIND_NAME[kind]} first.`
    };
  }
  if (mine && holder.kind === kind) return { holder: null, run: true };
  return { holder, run: false };
}

/** The holder as one channel is told it. */
export function screenHolderView<L>(
  holder: ScreenHold<L> | null,
  link: L
): ScreenHolderView | null {
  if (!holder) return null;
  return {
    kind: holder.kind,
    userId: holder.userId,
    name: holder.name,
    mine: holder.link === link
  };
}
