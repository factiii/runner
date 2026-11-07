import type { RunnerHealthLevel } from '@shared/all/domains/electron';
import { processLine } from '@shared/all/helpers/runnerHealthCopy';

import { run } from './machine';
import { processLevel } from './machineHealth';
import { processCount } from './machineHealthIo';

// At the per-user process limit the OS starts nothing for the runner's user:
// SSH, screen sharing, jobs and the runner's own update all fail, and only a
// power cycle helps (the Mac Mini, 2026-10-16). Health shows the count when
// someone looks; this writes it to the service log on its own, as it nears
// the limit, so the log says why before the machine locks up.

const CHECK_EVERY_MS = 10 * 60 * 1000;

/** Check now, then every 10 minutes. Logs once per change of level. */
export function watchProcessCount(): void {
  let last: RunnerHealthLevel = 'ok';
  const check = async () => {
    const count = await processCount(run).catch(() => null);
    if (!count) return;
    const processes = { ...count, level: processLevel(count.used, count.max) };
    if (processes.level === last) return;
    last = processes.level;
    const line = processLine(processes);
    if (processes.level === 'ok') console.log(`[processes] back to normal. ${line}`);
    else console.error(`[processes] ${processes.level}: ${line}`);
  };
  void check();
  setInterval(() => void check(), CHECK_EVERY_MS).unref();
}
