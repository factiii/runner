import type {
  RunnerHealthAlert,
  RunnerHealthLevel,
  RunnerMachineHealth
} from '../domains/electron';

// The low disk and memory alert (card b78a269a, .specs/runner-setup.md "Low
// disk and memory alerts"), shared by the runner that reports it, the server
// that checks, relays and pushes it, and the banners on web and mobile.

const LEVELS: readonly RunnerHealthLevel[] = ['ok', 'warn', 'critical'];

/** A free-space change this large is worth a new report while the level is
 *  not ok, so the banner's "3 GB left" keeps up as the disk fills. */
export const ALERT_FREE_STEP_GB = 1;

/** The alert for a health reading: the overall level, the disk with the
 *  least free, memory pressure and the process level. */
export function healthAlertOf(health: RunnerMachineHealth): RunnerHealthAlert {
  const lowest = health.disks.reduce<
    RunnerMachineHealth['disks'][number] | null
  >((low, disk) => (!low || disk.freeGb < low.freeGb ? disk : low), null);
  return {
    level: health.level,
    disk: lowest ? { freeGb: lowest.freeGb, level: lowest.level } : null,
    memory: health.memory,
    processes: health.processes?.level ?? null
  };
}

/** Whether `next` is worth sending after `prev`: the first reading, any level
 *  change, or (while not ok) the lowest disk moving by a GB or more. */
export function healthAlertChanged(
  prev: RunnerHealthAlert | null,
  next: RunnerHealthAlert
): boolean {
  if (!prev) return true;
  if (
    prev.level !== next.level ||
    prev.memory !== next.memory ||
    prev.processes !== next.processes ||
    prev.disk?.level !== next.disk?.level
  ) {
    return true;
  }
  if (next.level === 'ok' || !prev.disk || !next.disk) return false;
  return Math.abs(prev.disk.freeGb - next.disk.freeGb) >= ALERT_FREE_STEP_GB;
}

const isLevel = (value: unknown): value is RunnerHealthLevel =>
  typeof value === 'string' && (LEVELS as readonly string[]).includes(value);

const levelOrNull = (value: unknown): RunnerHealthLevel | null | undefined => {
  if (value === null) return null;
  return isLevel(value) ? value : undefined;
};

/** A report from a runner, checked field by field (the server never trusts
 *  the shape), or null when it is malformed. */
export function parseRunnerHealthAlert(
  data: unknown
): RunnerHealthAlert | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (!isLevel(raw.level)) return null;
  const memory = levelOrNull(raw.memory);
  const processes = levelOrNull(raw.processes);
  if (memory === undefined || processes === undefined) return null;
  let disk: RunnerHealthAlert['disk'] = null;
  if (raw.disk !== null) {
    if (!raw.disk || typeof raw.disk !== 'object') return null;
    const { freeGb, level } = raw.disk as Record<string, unknown>;
    if (typeof freeGb !== 'number' || !Number.isFinite(freeGb) || freeGb < 0) {
      return null;
    }
    if (!isLevel(level)) return null;
    disk = { freeGb: Math.round(freeGb * 10) / 10, level };
  }
  return { level: raw.level, disk, memory, processes };
}

const gb = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} GB`;

/** What is wrong, most pressing first: "3 GB of disk left" and "memory
 *  almost full". Empty at ok. */
export function healthAlertProblems(alert: RunnerHealthAlert): string[] {
  const out: { level: RunnerHealthLevel; text: string }[] = [];
  if (alert.disk && alert.disk.level !== 'ok') {
    out.push({
      level: alert.disk.level,
      text: `${gb(alert.disk.freeGb)} of disk left`
    });
  }
  if (alert.memory && alert.memory !== 'ok') {
    out.push({
      level: alert.memory,
      text:
        alert.memory === 'critical'
          ? 'memory almost full'
          : 'memory under pressure'
    });
  }
  if (alert.processes && alert.processes !== 'ok') {
    out.push({ level: alert.processes, text: 'near the process limit' });
  }
  return out
    .sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level))
    .map((p) => p.text);
}

/** The banner's and the push's line: "Mac Mini: 3 GB of disk left, memory
 *  under pressure." */
export function healthAlertLine(
  name: string,
  alert: RunnerHealthAlert
): string {
  const problems = healthAlertProblems(alert);
  const what = problems.length ? problems.join(', ') : 'running low';
  return `${name}: ${what}.`;
}

/** What the banner offers to do about it. */
export const HEALTH_ALERT_HINT =
  'Open Status, then Free up space, or stop a part you do not use.';

/** The banner's second line for a runner shared with you: its owner is the
 *  one who frees it up (and the only one pushed at critical). */
export const HEALTH_ALERT_SHARED_HINT =
  'Shared with you. Its owner can free up space from Status.';
