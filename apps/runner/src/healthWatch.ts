import type { RunnerHealthAlert } from '@shared/all/domains/electron';
import { healthAlertChanged, healthAlertOf } from '@shared/all/helpers/runnerHealthAlert';

import { run } from './machine';
import { machineHealthLevels } from './machineHealthIo';

// The low disk and memory alert's runner half (card b78a269a,
// .specs/runner-setup.md "Low disk and memory alerts"): read the machine's
// disk and memory every 30 s and tell the server when it changes. The server
// shows the owner a banner at warn and pushes them at critical. Only the
// cheap probes (statfs, the pressure level, the process count), never the
// service list, so a reading every 30 s costs nothing.

const CHECK_EVERY_MS = 30 * 1000;
/** While not ok, the reading is said again this often even unchanged, so
 *  the server's reminder push (every 6 h at critical) has a report to ride. */
const RESEND_EVERY_MS = 30 * 60 * 1000;

export type HealthWatch = {
  /** The last reading, for a (re)connect to say again. Null before the first. */
  current(): RunnerHealthAlert | null;
};

/** Read now, then every 30 s; `send` gets each reading that changed. A read
 *  that fails is skipped, never sent as ok. */
export function watchMachineHealth(
  send: (alert: RunnerHealthAlert) => void,
  read: () => Promise<RunnerHealthAlert> = async () => healthAlertOf(await machineHealthLevels(run))
): HealthWatch {
  let last: RunnerHealthAlert | null = null;
  let sentAt = 0;
  const check = async () => {
    const next = await read().catch(() => null);
    if (!next) return;
    const due = next.level !== 'ok' && Date.now() - sentAt >= RESEND_EVERY_MS;
    if (!healthAlertChanged(last, next) && !due) return;
    const was = last?.level ?? 'ok';
    last = next;
    sentAt = Date.now();
    if (next.level !== was) {
      const line = `[health] ${was} -> ${next.level}`;
      if (next.level === 'ok') console.log(line);
      else console.error(line);
    }
    send(next);
  };
  void check();
  setInterval(() => void check(), CHECK_EVERY_MS).unref();
  return { current: () => last };
}
