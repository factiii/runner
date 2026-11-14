import fs from 'fs';
import path from 'path';

import type { SessionStarter } from '@shared/all/helpers/board-agent-core/session';
import type { HypervisorBoard } from '@shared/all/helpers/board-agent-core/session-hypervisor';
import {
  markOnboardingStarted,
  ONBOARDING_MESSAGE,
  ONBOARDING_REQUEST_FILE,
  ONBOARDING_TITLE,
  onboardingPending
} from '@shared/all/helpers/runnerOnboarding';

// The first AI session after Factiii Desktop's "Set up this computer"
// (shared/all/helpers/runnerOnboarding.ts; .specs/runner-setup.md, "The
// onboarding session"). Asked for by the Desktop; started here, as a Chat
// session acting for the owner the way a routine's is, on the owner's
// profile board (every account has one; the server makes it if missing), as
// soon as it is asked for and the runner is connected. No board has to be
// opened first. Once: its started file stays.

/** The owner's profile board, as the server names it to this runner
 *  (`runner:profile-board`), or null when the server cannot say now. */
export type ProfileBoardRef = { id: number; slug: string };

export type OnboardingDeps = {
  runnerDir: string;
  /** Asked of the server over the runner's own connection, so it is always
   *  the runner owner's board, never a member's. */
  profileBoard: () => Promise<ProfileBoardRef | null>;
  /** The engine for that board (the daemon's getEngine). */
  board: (ref: ProfileBoardRef) => OnboardingBoard;
  owner: () => SessionStarter;
  log: (line: string) => void;
};

export type OnboardingBoard = Pick<HypervisorBoard, 'start' | 'audit'>;

/** Call when the Desktop may have asked (on connect, and when its request
 *  file appears); starts the session at most once, and never while one start
 *  is in flight. Resolves with its id when this call started it. Only the
 *  runner itself calls it: a member's dispatch never does. */
export function createOnboardingStarter(
  deps: OnboardingDeps
): () => Promise<string | null> {
  let starting = false;
  // This process started it: never again, even when its record could not be
  // written below.
  let started = false;
  return async () => {
    if (starting || started || !onboardingPending(deps.runnerDir)) return null;
    starting = true;
    let slug = 'the profile board';
    try {
      const ref = await deps.profileBoard();
      if (!ref) {
        deps.log('Onboarding: the server did not name the profile board; trying again on the next connect.');
        return null;
      }
      slug = ref.slug;
      const owner = deps.owner();
      const target = deps.board(ref);
      const postId = await target.start({
        title: ONBOARDING_TITLE,
        code: false,
        baseBranch: '',
        cardId: null,
        message: ONBOARDING_MESSAGE,
        startedBy: owner,
        startedVia: 'onboarding'
      });
      started = true;
      // Its own try: the session exists now, so failing to record it must not
      // reach the catch below, which leaves the request for a retry and so
      // would start a second one. Without the record, the request at least
      // goes, so a restart does not ask again either.
      try {
        markOnboardingStarted(deps.runnerDir, { spaceSlug: ref.slug, postId });
      } catch (err) {
        deps.log(
          `Onboarding: started session ${postId} on ${ref.slug}, but could not record it: ${err instanceof Error ? err.message : String(err)}`
        );
        try {
          fs.rmSync(path.join(deps.runnerDir, ONBOARDING_REQUEST_FILE), { force: true });
        } catch {
          // The flag above still keeps this process from a second start.
        }
      }
      await target
        .audit({
          actor: owner,
          action: 'session-start',
          detail: `Chat session ${postId} "${ONBOARDING_TITLE}": the first session after Set up this computer`
        })
        .catch(() => undefined);
      deps.log(`Onboarding: started session ${postId} on ${ref.slug}.`);
      return postId;
    } catch (err) {
      // The request stays: the next connect, or the Desktop's Retry (which
      // writes the request again), tries again.
      deps.log(`Onboarding: could not start its session on ${slug}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      starting = false;
    }
  };
}

/** A burst of events (the temp file, then its rename) is one ask. */
const WATCH_SETTLE_MS = 200;

/** Calls `onRequest` whenever the Desktop writes its request file, so the
 *  session starts while the runner is already online. Returns the stop. A
 *  folder that cannot be watched leaves the connect-time check alone. The
 *  file is written as a temp file and renamed, and a platform may name
 *  either one in the event, so both count; the call comes once they
 *  settle. */
export function watchOnboardingRequest(
  runnerDir: string,
  onRequest: () => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const watcher = fs.watch(runnerDir, (_event, name) => {
      if (!String(name ?? '').startsWith(ONBOARDING_REQUEST_FILE)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onRequest();
      }, WATCH_SETTLE_MS);
    });
    watcher.on('error', () => watcher.close());
    return () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  } catch {
    return () => undefined;
  }
}
