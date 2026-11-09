import type {
  RunnerCleanup,
  RunnerCpuHealth,
  RunnerDiskHealth,
  RunnerDiskUse,
  RunnerHealthLevel,
  RunnerMachineHealth,
  RunnerMemoryUse,
  RunnerProcessHealth,
  RunnerService
} from '../domains/electron';
import { bytesLabel } from './runnerPartsCopy';

// How machine health and Free up space read, in one place for the runner's
// CLI and doctor and the runner's Status (Storage, Features) on web and mobile
// (.specs/runner-setup.md "Machine health and Free up space").

const gb = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} GB`;

const joinUses = (uses: string[]) =>
  uses.length > 1
    ? `${uses.slice(0, -1).join(', ')} and ${uses.at(-1)}`
    : (uses[0] ?? '');

/** "Runner folder and Vault: 14 GB free of 494 GB". */
export const diskLine = (disk: RunnerDiskHealth): string =>
  `${joinUses(disk.uses)}: ${gb(disk.freeGb)} free of ${gb(disk.totalGb)}`;

const MEMORY_LINES: Record<RunnerHealthLevel, string> = {
  ok: 'Memory is fine.',
  warn: 'Memory is under pressure. Stop a part you do not use.',
  critical: 'Memory is almost full. Stop a part you do not use.'
};

export const memoryLine = (level: RunnerHealthLevel | null): string =>
  level ? MEMORY_LINES[level] : 'The runner cannot read memory pressure here.';

/** "Processes: 1,712 of 2,666." plus what to do when near the cap, or null
 *  where the runner did not read it. */
export function processLine(
  processes: RunnerProcessHealth | null | undefined
): string | null {
  if (!processes) return null;
  const count = `Processes: ${processes.used.toLocaleString('en-US')} of ${processes.max.toLocaleString('en-US')}.`;
  if (processes.level === 'ok') return count;
  return `${count} Near the limit, nothing new can start, not even a login. Close terminals and sessions you no longer use.`;
}

/** "CPU: 35% busy across 10 cores." plus what it means when high, or null
 *  where the runner did not read it. */
export function cpuLine(
  cpu: RunnerCpuHealth | null | undefined
): string | null {
  if (!cpu) return null;
  const line = `CPU: ${Math.round(cpu.load * 100)}% busy across ${cpu.cores} cores.`;
  if (cpu.level === 'ok') return line;
  return `${line} Builds and sessions will be slow until it settles.`;
}

/** "Memory in use: 11.2 GB of 16 GB.", or null where it was not read. */
export const memoryUseLine = (
  use: RunnerMemoryUse | null | undefined
): string | null =>
  use ? `Memory in use: ${gb(use.usedGb)} of ${gb(use.totalGb)}.` : null;

/** A service's second line: what it is and where it listens. */
export function serviceDetail(service: RunnerService): string {
  const ports = service.ports.map((p) => `:${p}`).join(' ');
  // A listener's detail is its address, which the ports already say.
  const parts =
    service.kind === 'port'
      ? [ports || service.detail]
      : [service.detail, ports];
  return [...parts, service.health].filter(Boolean).join(' · ');
}

// macOS's own listeners run as the runner's user (AirPlay, Handoff), so the
// runner reports them, but they are not anything a board started.
const SYSTEM_LISTENERS = new Set(['ControlCenter', 'rapportd', 'sharingd']);

const KIND_ORDER: Record<RunnerService['kind'], number> = {
  pm2: 0,
  docker: 1,
  launchd: 2,
  port: 3
};
const LEVEL_ORDER = { critical: 0, warn: 1, ok: 2 } as const;

/** The services worth a row: whatever is wrong first, then pm2, Docker,
 *  login agents and other servers, OS noise dropped. */
export const visibleServices = (services: RunnerService[]): RunnerService[] =>
  services
    .filter((s) => !(s.kind === 'port' && SYSTEM_LISTENERS.has(s.name)))
    .sort(
      (a, b) =>
        LEVEL_ORDER[a.level ?? 'ok'] - LEVEL_ORDER[b.level ?? 'ok'] ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    );

/** How a service row's icon is coloured: what is wrong, else up or not. */
export function serviceTone(
  service: RunnerService
): 'critical' | 'warn' | 'up' | 'idle' {
  if (service.level === 'critical' || service.level === 'warn') {
    return service.level;
  }
  return service.running ? 'up' : 'idle';
}

/** A row that needs looking at: crashed, restarting, failed or unhealthy. */
const needsAttention = (s: RunnerService) =>
  s.level === 'critical' || s.level === 'warn';

/** A login agent that is not running and is fine so: one on a schedule
 *  between runs, or one installed and never loaded (an app's updater). */
const quietAgent = (s: RunnerService) =>
  s.kind === 'launchd' && !s.running && !needsAttention(s);

const GROUP_LABELS: Record<RunnerService['kind'], string> = {
  pm2: 'Kept up by pm2',
  // OrbStack or Docker: the same `docker` commands read either.
  docker: 'Containers',
  launchd: 'Login agents',
  port: 'Other servers'
};

type ServiceGroup = {
  key: 'attention' | RunnerService['kind'];
  label: string;
  services: RunnerService[];
};

/** The Services list in sections: what needs looking at first, then by
 *  what keeps each one running. Quiet login agents are left out of their
 *  section and counted in `quiet`, for a "Show" toggle. */
export function serviceGroups(
  services: RunnerService[],
  showQuiet: boolean
): { groups: ServiceGroup[]; quiet: number } {
  const shown = visibleServices(services);
  const attention = shown.filter(needsAttention);
  const quiet = shown.filter(quietAgent);
  const groups: ServiceGroup[] = attention.length
    ? [{ key: 'attention', label: 'Needs attention', services: attention }]
    : [];
  for (const kind of Object.keys(KIND_ORDER) as RunnerService['kind'][]) {
    const rows = shown.filter(
      (s) =>
        s.kind === kind && !needsAttention(s) && (showQuiet || !quietAgent(s))
    );
    if (rows.length) {
      groups.push({ key: kind, label: GROUP_LABELS[kind], services: rows });
    }
  }
  return { groups, quiet: quiet.length };
}

/** The Services list's one line: how many run, and how many need looking
 *  at, with the level it reads at. */
export function servicesSummary(services: RunnerService[]): {
  line: string;
  level: 'ok' | 'warn' | 'critical';
} {
  const shown = visibleServices(services);
  const running = shown.filter((s) => s.running).length;
  const problems = shown.filter(needsAttention);
  const critical = problems.some((s) => s.level === 'critical');
  if (problems.length === 0) {
    return { line: `All ${running} running fine.`, level: 'ok' };
  }
  const names = problems
    .slice(0, 2)
    .map((s) => s.name)
    .join(', ');
  const more = problems.length > 2 ? ` and ${problems.length - 2} more` : '';
  return {
    line: `${running} running. Needs attention: ${names}${more}.`,
    level: critical ? 'critical' : 'warn'
  };
}

/** The toggle under the list for the idle login agents it folds away. */
export function quietAgentsToggle(quiet: number, showing: boolean): string {
  if (showing) return 'Hide idle login agents';
  return `Show ${quiet} idle login ${quiet === 1 ? 'agent' : 'agents'}`;
}

/** When the list was read, as the clock shows it ("Read at 14:02"). */
export const servicesReadAt = (at: number): string =>
  `Read at ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

/** What the Services list says when it has nothing to show. */
export const servicesEmpty = (services: RunnerService[] | undefined): string =>
  services === undefined
    ? 'Update the runner to see the servers and containers running on it.'
    : 'Nothing is running: no pm2 processes, no containers and no servers listening.';

/** The row's one line: fine, low, or almost gone. */
export function healthHeadline(health: RunnerMachineHealth): string {
  const low = health.disks.reduce<RunnerDiskHealth | null>(
    (min, d) => (!min || d.freeGb < min.freeGb ? d : min),
    null
  );
  const diskLevel = low?.level ?? 'ok';
  if (low && diskLevel === 'critical') {
    return `Disk space is almost gone: ${gb(low.freeGb)} free. Adds and uploads stop below ${gb(health.criticalGb)}.`;
  }
  if (low && diskLevel === 'warn') {
    return `Disk space is low: ${gb(low.freeGb)} free. Adds and uploads stop below ${gb(health.criticalGb)}.`;
  }
  if (health.processes && health.processes.level !== 'ok')
    return 'Too many processes are running. Close terminals and sessions you no longer use.';
  if (health.memory && health.memory !== 'ok')
    return MEMORY_LINES[health.memory];
  return low
    ? `Disk and memory are fine. ${gb(low.freeGb)} free.`
    : 'Disk and memory are fine.';
}

/** What Free up space does, and what it never touches. */
export const CLEANUP_SAFE_NOTE =
  'It removes what the runner made and can make again, and clears tools’ caches with their own commands. It never touches your vault, its search models, your secrets, the model in use, a board’s clone, workspace or worktrees, or anything else you keep.';

type CleanupItem = RunnerCleanup['items'][number];

/** "about 2.1 GB", or "up to about 7.4 GB" when a prune is among them. */
const freesLabel = (items: CleanupItem[]): string => {
  const bytes = items.reduce((sum, i) => sum + i.bytes, 0);
  return `${items.some((i) => i.upTo) ? 'up to about' : 'about'} ${bytesLabel(bytes)}`;
};

/** "Frees about 2.1 GB." or that there is nothing to free. */
export const cleanupSummary = (cleanup: RunnerCleanup): string =>
  cleanup.items.length
    ? `Frees ${freesLabel(cleanup.items)}.`
    : 'Nothing to free. The runner keeps only what it needs.';

/** One item: "Old build output · factiii-board/builds/59374f079 · 1.2 GB". */
export const cleanupItemLine = (item: CleanupItem): string =>
  `${item.title} · ${item.path} · ${item.upTo ? 'up to ' : ''}${bytesLabel(item.bytes)}`;

/** The items left ticked, and the button that clears them: "Clear 3 (about
 *  4.2 GB)", or null when none is. */
export function cleanupSelection(
  items: CleanupItem[],
  unticked: readonly string[]
): { items: CleanupItem[]; button: string | null } {
  const picked = items.filter((i) => !unticked.includes(i.id));
  return {
    items: picked,
    button: picked.length
      ? `Clear ${picked.length} (${freesLabel(picked)})`
      : null
  };
}

/** The share of a disk in use, 0 to 1, for its bar. */
export const diskUsedShare = (disk: RunnerDiskHealth): number =>
  disk.totalGb > 0
    ? Math.min(1, Math.max(0, (disk.totalGb - disk.freeGb) / disk.totalGb))
    : 0;

/** A folder's bar against the biggest one listed, 0 to 1. */
export const diskUseShare = (
  use: RunnerDiskUse,
  all: readonly RunnerDiskUse[]
): number => {
  const max = Math.max(...all.map((u) => u.bytes), 1);
  return use.bytes / max;
};

/** What the biggest-folders list says while it reads, when it has nothing,
 *  and above the list. */
export const DISK_USE_READING =
  'Weighing every folder. On a full disk this takes up to a minute.';
export const DISK_USE_EMPTY = 'No folder holds more than 500 MB.';
export const DISK_USE_NOTE =
  'A reading only. Free up space never removes these by their path; what in them is safe to clear is listed under Free up space.';
