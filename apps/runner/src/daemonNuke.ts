import type {
  RunnerNukeProgress,
  RunnerNukeResult
} from '@shared/all/domains/electron';
import type { ChannelTransport } from '@shared/all/helpers/board-agent-core/runner-access';
import { NUKE_ALREADY_RUNNING, nukeRefusal } from '@shared/all/helpers/runnerNuke';
import { runnerNukeSchema } from '@shared/all/validators';

import { readNukePlan, runNuke, type NukeHost } from './nuke';

// "Nuke this runner" from Runner Settings (web, mobile, desktop), as the
// daemon answers it (.specs/runner-setup.md "Nuke a runner"). The runner
// decides: the owner by id, a direct link, and the phrase exactly as typed,
// checked here again whatever the app showed. The answer goes back first;
// the erase then reports `runner-nuke` frames and the process exits, and
// stays offline (the supervisor relaunches only after an update).

export type DaemonNuke = {
  handle(
    payload: unknown,
    scope: { role: 'owner' | 'member'; userId: string },
    transport: ChannelTransport
  ): Promise<RunnerNukeResult>;
  /** True from the start of an erase: `runnerRevoked` (from our own unpair)
   *  must not end the process before the erase is done. */
  running(): boolean;
};

export function createDaemonNuke(opts: {
  dir: string;
  /** The runner home as this process resolves it now (runner-dir.ts):
   *  the erase refuses a `dir` that is not it. */
  expectedDir: string;
  ownerUserId: string | null;
  host: NukeHost;
  /** Every owner link, one frame. */
  broadcast: (progress: RunnerNukeProgress) => void;
  /** After the last frame. */
  exit: () => void;
  /** Lets the answer reach the caller before the erase begins. */
  later?: (fn: () => void) => void;
}): DaemonNuke {
  let busy = false;
  const later = opts.later ?? ((fn) => setTimeout(fn, 250));

  return {
    running: () => busy,
    async handle(payload, scope, transport) {
      const parsed = runnerNukeSchema.safeParse(payload ?? {});
      if (!parsed.success) throw new Error('A nuke takes only confirm and the phrase.');
      const refusal = nukeRefusal({
        role: scope.role,
        actorUserId: scope.userId,
        ownerUserId: opts.ownerUserId,
        transport,
        confirm: parsed.data.confirm,
        phrase: parsed.data.phrase
      });
      if (refusal) throw new Error(refusal);
      if (busy) throw new Error(NUKE_ALREADY_RUNNING);
      const plan = await readNukePlan(opts.dir, opts.host);
      if (!parsed.data.confirm) return { plan, started: false };
      // Again after the await: a second confirm may have begun one meanwhile.
      if (busy) throw new Error(NUKE_ALREADY_RUNNING);
      busy = true;
      later(() => {
        void runNuke({
          dir: opts.dir,
          expectedDir: opts.expectedDir,
          host: opts.host,
          onProgress: opts.broadcast
        }).then(
          () => opts.exit(),
          (err: unknown) => {
            // The failed frame went out; a re-run finishes from that step.
            console.error(`[nuke] ${err instanceof Error ? err.message : String(err)}`);
            busy = false;
          }
        );
      });
      return { plan, started: true };
    }
  };
}
