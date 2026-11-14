import fs from 'fs';
import path from 'path';

// The first AI session after "Set up this computer" (card d26fbbbb step 4;
// .specs/runner-setup.md, "The onboarding session"). Factiii Desktop asks for
// it by writing `<runner dir>/onboarding.json` once the runner is online and
// the AI signed in; the daemon, which watches for that file, starts it at
// once on the owner's profile board (every account has one): a Chat session
// whose opening message runs the plugin's `runner-onboarding` skill. It
// writes `onboarding-started.json`, which the Desktop reads to open that
// session's window, and which keeps it from ever being asked for again on
// this runner.

export const ONBOARDING_REQUEST_FILE = 'onboarding.json';
export const ONBOARDING_STARTED_FILE = 'onboarding-started.json';

export const ONBOARDING_TITLE = 'Set up this runner';

/** The session's opening message: the skill does the rest by conversation. */
export const ONBOARDING_MESSAGE =
  'This runner was just set up by Factiii Desktop. Use the runner-onboarding skill to walk me through the rest, one step at a time.';

export type OnboardingStarted = {
  spaceSlug: string;
  postId: string;
  /** ISO. */
  at: string;
};

function writeWhole(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** The session it started, or null (none yet, or an unreadable file). */
export function readOnboardingStarted(
  runnerDir: string
): OnboardingStarted | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(runnerDir, ONBOARDING_STARTED_FILE), 'utf-8')
    ) as Partial<OnboardingStarted>;
    if (
      typeof raw.spaceSlug !== 'string' ||
      typeof raw.postId !== 'string' ||
      typeof raw.at !== 'string'
    ) {
      return null;
    }
    return { spaceSlug: raw.spaceSlug, postId: raw.postId, at: raw.at };
  } catch {
    return null;
  }
}

/** Factiii Desktop's side: ask for the session, once per runner. Answers
 *  what is there now: `started` (it ran already), else `requested`. Asking
 *  again (Retry) writes the request again, which the daemon's watch sees as
 *  a fresh ask. */
export function requestOnboarding(
  runnerDir: string,
  now: Date = new Date()
): 'requested' | 'started' {
  if (fs.existsSync(path.join(runnerDir, ONBOARDING_STARTED_FILE))) {
    return 'started';
  }
  fs.mkdirSync(runnerDir, { recursive: true });
  writeWhole(path.join(runnerDir, ONBOARDING_REQUEST_FILE), {
    requestedAt: now.toISOString()
  });
  return 'requested';
}

/** Whether a session is asked for and not started yet. */
export function onboardingPending(runnerDir: string): boolean {
  return (
    fs.existsSync(path.join(runnerDir, ONBOARDING_REQUEST_FILE)) &&
    !fs.existsSync(path.join(runnerDir, ONBOARDING_STARTED_FILE))
  );
}

/** The daemon's side, once the session exists: the request is answered. */
export function markOnboardingStarted(
  runnerDir: string,
  started: Omit<OnboardingStarted, 'at'>,
  now: Date = new Date()
): void {
  writeWhole(path.join(runnerDir, ONBOARDING_STARTED_FILE), {
    ...started,
    at: now.toISOString()
  });
  fs.rmSync(path.join(runnerDir, ONBOARDING_REQUEST_FILE), { force: true });
}
