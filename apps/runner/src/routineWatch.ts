import type { HypervisorSession } from '@shared/all/helpers/board-agent-core/session-hypervisor';
import type { ChatEvent } from '@shared/all/helpers/terminal-ai/chatTranscript';
import {
  ROUTINE_OUTPUT_MAX,
  type RoutineResultFrame
} from '@shared/all/validators';

// A Routine's session on this runner (.todos/routines.md): once the daemon has
// started it (`runner:routine-due`), this waits for the session to finish and
// says how it ended, so the run on the server gets the session's answer
// instead of staying RUNNING. Pure: the daemon lends the session's state, its
// transcript and a clock.

/** How often the session is looked at. */
export const ROUTINE_POLL_MS = 15_000;
/** How long a session may take before the run is called failed. Under the
 *  server's own limit (RUNNER_RUN_STALE_MS, 3 h), so the runner's word, with
 *  its reason, arrives first. */
export const ROUTINE_TIMEOUT_MS = 2.5 * 60 * 60 * 1000;

export type RoutineWatchDeps = {
  /** The session's state now; null once it is gone (ended or removed). */
  state(): HypervisorSession['state'] | null;
  transcript(): Promise<ChatEvent[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

type Result = Pick<RoutineResultFrame, 'status' | 'output' | 'error'>;

/** What the session said after the last message it was given: its answer.
 *  Empty while it has not answered yet. */
export function sessionAnswer(events: ChatEvent[]): string {
  let lastUser = -1;
  events.forEach((e, i) => {
    if (e.type === 'user') lastUser = i;
  });
  if (lastUser < 0) return '';
  const said = events
    .slice(lastUser + 1)
    .flatMap((e) => (e.type === 'assistant' ? [e.text.trim()] : []))
    .filter(Boolean);
  // The end of a long answer is its summary: keep that when it must be cut.
  return said.join('\n\n').slice(-ROUTINE_OUTPUT_MAX);
}

export async function watchRoutineSession(
  deps: RoutineWatchDeps,
  opts: { pollMs?: number; timeoutMs?: number } = {}
): Promise<Result> {
  const pollMs = opts.pollMs ?? ROUTINE_POLL_MS;
  const deadline = deps.now() + (opts.timeoutMs ?? ROUTINE_TIMEOUT_MS);
  const answer = () => deps.transcript().then(sessionAnswer, () => '');

  for (;;) {
    const state = deps.state();
    if (state === null) {
      const output = await answer();
      return output
        ? { status: 'DONE', output }
        : { status: 'FAILED', error: 'The session ended before it answered.' };
    }
    if (state === 'error') {
      const output = await answer();
      return {
        status: 'FAILED',
        output: output || undefined,
        error: 'The session stopped with an error.'
      };
    }
    // Idle with an answer: it is done. Idle before it answered is the moment
    // between the session starting and the prompt going in.
    if (state === 'idle') {
      const output = await answer();
      if (output) return { status: 'DONE', output };
    }
    if (deps.now() >= deadline) {
      const output = await answer();
      return {
        status: 'FAILED',
        output: output || undefined,
        error:
          state === 'needs you'
            ? 'The session was still waiting for a permission when time ran out.'
            : 'The session was still working when time ran out.'
      };
    }
    await deps.sleep(pollMs);
  }
}
