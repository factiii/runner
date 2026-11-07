import type {
  RunnerCpuHealth,
  RunnerDiskHealth,
  RunnerHealthLevel,
  RunnerMachineHealth,
  RunnerMemoryUse,
  RunnerService
} from '@shared/all/domains/electron';

// Machine health (.specs/runner-setup.md "Machine health and Free up space"): free disk on each
// disk the runner writes to, and memory pressure. Read on every parts list
// and doctor pass; nothing to install. It warns at DISK_WARN_GB, well before
// DISK_CRITICAL_GB, where adds, model pulls and vault uploads are refused.
// CPU load, memory in use and the services running are for the Status tab
// to show; they never refuse anything.

/** Below this much free, Setup warns and offers Free up space. */
export const DISK_WARN_GB = 20;
/** Below this much free (after the action), the runner refuses to fill the
 *  disk further. The same 5 GB Local AI leaves free after a pull
 *  (localAiModels.ts). */
export const DISK_CRITICAL_GB = 5;
/** Linux: the share of memory still available (MemAvailable). */
const MEMORY_WARN_SHARE = 0.15;
const MEMORY_CRITICAL_SHARE = 0.05;

/** The share of the per-user process limit in use. At the limit the OS
 *  starts nothing for the user, so SSH, login and the runner's own update
 *  all fail and only a power cycle helps. */
const PROCESS_WARN_SHARE = 0.8;
const PROCESS_CRITICAL_SHARE = 0.95;

/** The 1-minute load average per core. Shown only: a busy build is normal,
 *  so CPU never feeds the overall level that gates refusals. */
export const CPU_WARN_LOAD = 0.9;
export const CPU_CRITICAL_LOAD = 1.5;

/** The most services sent: a dev machine can listen on many ports. */
export const MAX_SERVICES = 30;

/** macOS `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
const DARWIN_PRESSURE: Record<string, RunnerHealthLevel> = {
  '1': 'ok',
  '2': 'warn',
  '4': 'critical'
};

const RANK: Record<RunnerHealthLevel, number> = { ok: 0, warn: 1, critical: 2 };
const worst = (levels: RunnerHealthLevel[]): RunnerHealthLevel =>
  levels.reduce<RunnerHealthLevel>((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');

const GIB = 1024 ** 3;
const roundGb = (bytes: number) => Math.floor((bytes / GIB) * 10) / 10;
const KIB = 1024;

/** The number after `name:` at the start of a line ("MemTotal:  16 kB",
 *  "Pages active:  145904."), or NaN. */
const statField = (text: string, name: string) =>
  Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1]);

export function diskLevel(freeGb: number): RunnerHealthLevel {
  if (freeGb < DISK_CRITICAL_GB) return 'critical';
  if (freeGb < DISK_WARN_GB) return 'warn';
  return 'ok';
}

/** Linux /proc/meminfo: the share of MemTotal still available. */
export function meminfoLevel(meminfo: string): RunnerHealthLevel | null {
  const kb = (name: string) => statField(meminfo, name);
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (!total || Number.isNaN(available)) return null;
  const share = available / total;
  if (share < MEMORY_CRITICAL_SHARE) return 'critical';
  if (share < MEMORY_WARN_SHARE) return 'warn';
  return 'ok';
}

export const darwinPressureLevel = (output: string): RunnerHealthLevel | null =>
  DARWIN_PRESSURE[output.trim()] ?? null;

export function processLevel(used: number, max: number): RunnerHealthLevel {
  if (used >= max * PROCESS_CRITICAL_SHARE) return 'critical';
  if (used >= max * PROCESS_WARN_SHARE) return 'warn';
  return 'ok';
}

export function cpuLevel(load: number): RunnerHealthLevel {
  if (load >= CPU_CRITICAL_LOAD) return 'critical';
  if (load >= CPU_WARN_LOAD) return 'warn';
  return 'ok';
}

/** The 1-minute load average over the cores, to 2 decimals, and its level. */
export function cpuHealth(load1: number, cores: number): RunnerCpuHealth | null {
  if (!cores || !Number.isFinite(load1)) return null;
  const load = Math.round((load1 / cores) * 100) / 100;
  return { load, cores, level: cpuLevel(load) };
}

const memoryUse = (usedBytes: number, totalBytes: number): RunnerMemoryUse => ({
  usedGb: Math.round((usedBytes / GIB) * 10) / 10,
  totalGb: Math.round((totalBytes / GIB) * 10) / 10
});

/** macOS `vm_stat`: active + wired + compressed pages, times the page size
 *  its header names. `os.freemem()` counts the file cache as used, so a Mac
 *  always looks full by it. */
export function vmStatUse(vmStat: string, totalBytes: number): RunnerMemoryUse | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  const pages = (name: string) => statField(vmStat, name);
  const used =
    pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor');
  if (!pageSize || !totalBytes || Number.isNaN(used)) return null;
  return memoryUse(used * pageSize, totalBytes);
}

/** Linux /proc/meminfo: MemTotal less MemAvailable. */
export function meminfoUse(meminfo: string): RunnerMemoryUse | null {
  const kb = (name: string) => statField(meminfo, name);
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (!total || Number.isNaN(available)) return null;
  return memoryUse((total - available) * KIB, total * KIB);
}

const sortedPorts = (ports: Iterable<number>) => [...new Set(ports)].sort((a, b) => a - b);

/** The host ports of a `docker ps` Ports cell ("0.0.0.0:5432->5432/tcp,
 *  [::]:5432->5432/tcp"). A port the container exposes but does not
 *  publish ("5001/tcp") has none. */
function dockerHostPorts(cell: string): number[] {
  const ports: number[] = [];
  for (const part of cell.split(',')) {
    const m = /:(\d+)(?:-(\d+))?->[\d-]+\/tcp/.exec(part.trim());
    if (!m) continue;
    const from = Number(m[1]);
    const to = Math.min(Number(m[2] ?? m[1]), from + MAX_SERVICES);
    for (let port = from; port <= to; port++) ports.push(port);
  }
  return sortedPorts(ports);
}

/** What runs the containers, from `docker context show`: OrbStack's
 *  context is `orbstack`, Colima's `colima`; anything else is Docker. */
export function containerEngine(context: string): string {
  const name = context.trim().toLowerCase();
  if (name.startsWith('orbstack')) return 'OrbStack';
  if (name.startsWith('colima')) return 'Colima';
  return 'Docker';
}

/** The docker CLI is here but `docker ps` could not reach the engine
 *  (OrbStack quit, or stopped when the disk filled): one row saying so,
 *  so the containers it runs do not just vanish from Status. A machine
 *  without the CLI (ENOENT, no output) gets no row. */
export function engineDownRow(
  ps: { code: number; output: string },
  engine: string
): RunnerService | null {
  if (ps.code === 0 || !ps.output.trim()) return null;
  return {
    kind: 'docker',
    name: engine,
    detail: 'not running: its containers are down',
    running: false,
    ports: [],
    level: 'warn'
  };
}

/** `docker ps -a --format '{{json .}}'`: one container per line. Lines that
 *  are not a container (a daemon error) are skipped. */
export function parseDockerPs(output: string): RunnerService[] {
  const services: RunnerService[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const field = (key: string) => {
      const value = (row as Record<string, unknown>)[key];
      return typeof value === 'string' ? value : '';
    };
    if (!field('Names')) continue;
    services.push({
      kind: 'docker',
      name: field('Names'),
      detail: `${field('Image')} · ${field('Status')}`,
      running: field('State') === 'running',
      ports: dockerHostPorts(field('Ports'))
    });
  }
  return services;
}

/** Docker's own processes, which forward the ports its containers publish:
 *  those rows are the containers' already. */
const DOCKER_PROCESS = /^(com\.docker|vpnkit|docker-proxy|OrbStack)/;

const portOf = (address: string) => Number(/:(\d+)$/.exec(address)?.[1]);

/** A row before it is sent: the process behind it, to fold its listening
 *  ports into its pm2 or launchd row, and the script it runs, to know which
 *  health check to ask. */
export type FoundService = RunnerService & { pid?: number; script?: string };

/** `lsof -Fpcn` of listening TCP sockets: `p` starts a process, `c` names
 *  it, `n` is an address ("127.0.0.1:6379", "*:3000", "[::1]:5432"). One row
 *  per process, however many ports it holds. */
export function parseLsofListen(output: string): FoundService[] {
  const found = new Map<string, { name: string; pid: number; addresses: string[] }>();
  let pid = '';
  let command = '';
  for (const line of output.split('\n')) {
    const value = line.slice(1).trim();
    if (line.startsWith('p')) {
      pid = value;
      command = '';
    } else if (line.startsWith('c')) {
      command = value;
    } else if (line.startsWith('n') && pid && command && !DOCKER_PROCESS.test(command)) {
      const key = `${command}\0${pid}`;
      const row = found.get(key) ?? { name: command, pid: Number(pid), addresses: [] };
      row.addresses.push(value);
      found.set(key, row);
    }
  }
  return [...found.values()].map(({ name, pid, addresses }) => ({
    kind: 'port' as const,
    name,
    detail: addresses[0],
    running: true,
    ports: sortedPorts(addresses.map(portOf).filter((p) => p > 0)),
    pid
  }));
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "4 min", "3 h", "8 days". */
export function since(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.floor(ms / MINUTE_MS))} min`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} h`;
  const days = Math.floor(ms / DAY_MS);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

const restarts = (n: number) => `${n} ${n === 1 ? 'restart' : 'restarts'}`;

/** The JSON line of `pm2 jlist`. Its output also carries stderr, and pm2
 *  can print notices ("[PM2] Spawning PM2 daemon") on either side of it. */
function pm2List(output: string): unknown[] | null {
  for (const line of output.split('\n')) {
    if (!line.startsWith('[')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // A notice, not the list.
    }
  }
  return null;
}

/** `pm2 jlist`: every process pm2 keeps, up or not. `errored` (pm2 gave up
 *  restarting it) is critical; `stopped`, or restarts pm2 counts as unstable,
 *  warn. Output that is not the list (pm2 missing) is no processes. */
export function parsePm2Jlist(output: string, now: number): FoundService[] {
  const list = pm2List(output);
  if (!list) return [];
  const services: FoundService[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const proc = item as { name?: unknown; pid?: unknown; pm2_env?: Record<string, unknown> };
    const env = proc.pm2_env ?? {};
    if (typeof proc.name !== 'string') continue;
    const status = typeof env.status === 'string' ? env.status : 'unknown';
    const restartCount = Number(env.restart_time) || 0;
    const unstable = Number(env.unstable_restarts) || 0;
    const online = status === 'online';
    const upSince = Number(env.pm_uptime);
    const parts = [status];
    if (online && upSince > 0) parts.push(`up ${since(now - upSince)}`);
    parts.push(restarts(restartCount));
    let level: RunnerService['level'];
    if (status === 'errored') level = 'critical';
    else if (!online || unstable > 0) level = 'warn';
    services.push({
      kind: 'pm2',
      name: proc.name,
      detail: parts.join(' · '),
      running: online,
      ports: [],
      ...(level ? { level } : {}),
      ...(online && Number(proc.pid) > 0 ? { pid: Number(proc.pid) } : {}),
      ...(typeof env.pm_exec_path === 'string' ? { script: env.pm_exec_path } : {})
    });
  }
  return services;
}

/** `launchctl list` ("PID\tStatus\tLabel") for the agents in the user's
 *  LaunchAgents folder, `labels`. Not running is normal for one that runs
 *  on a schedule; a non-zero last exit warns. One in the folder but not
 *  loaded is shown as such. */
/** What a launch agent's plist runs: `Program`, or its `ProgramArguments`
 *  joined by spaces, so the script it starts can be recognised (the embedder
 *  run by launchd rather than pm2). An XML plist only; a binary one, or none,
 *  is undefined. */
export function plistProgram(xml: string): string | undefined {
  const unescape = (v: string) =>
    v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const args = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (args) {
    const words = [...args[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
      unescape(m[1].trim())
    );
    if (words.length > 0) return words.join(' ');
  }
  const program = /<key>\s*Program\s*<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(xml);
  return program ? unescape(program[1].trim()) : undefined;
}

/** `programs`: each label's plistProgram, kept as the row's script so a
 *  known service's health check is asked whichever manager runs it. */
export function parseLaunchctlList(
  output: string,
  labels: string[],
  programs: Map<string, string> = new Map()
): FoundService[] {
  const loaded = new Map<string, { pid: number; status: number }>();
  for (const line of output.split('\n')) {
    const [pid, status, label] = line.split('\t');
    if (!label || pid === 'PID') continue;
    loaded.set(label.trim(), { pid: Number(pid), status: Number(status) });
  }
  return labels.map((label): FoundService => {
    const agent = loaded.get(label);
    const program = programs.get(label);
    const script = program ? { script: program } : {};
    if (!agent) {
      return {
        kind: 'launchd',
        name: label,
        detail: 'not loaded',
        running: false,
        ports: [],
        ...script
      };
    }
    const running = agent.pid > 0;
    const failed = Number.isFinite(agent.status) && agent.status !== 0;
    const detail = running
      ? 'running'
      : `not running · last exit ${Number.isFinite(agent.status) ? agent.status : '?'}`;
    return {
      kind: 'launchd',
      name: label,
      detail,
      running,
      ports: [],
      ...(failed && !running ? { level: 'warn' as const } : {}),
      ...(running ? { pid: agent.pid } : {}),
      ...script
    };
  });
}

/** Folds each listening process into the pm2 or launchd row that runs it,
 *  so the embedder is one row "embedder · :8000", not that and a "Python".
 *  Keeps the internal fields; `sentService` drops them. */
export function mergeServices(rows: FoundService[]): FoundService[] {
  const owners = new Map<number, FoundService>();
  for (const row of rows) {
    if (row.kind !== 'port' && row.pid) owners.set(row.pid, row);
  }
  const merged: FoundService[] = [];
  for (const row of rows) {
    const owner = row.kind === 'port' && row.pid ? owners.get(row.pid) : undefined;
    if (owner) owner.ports = sortedPorts([...owner.ports, ...row.ports]);
    else merged.push(row);
  }
  return merged;
}

/** `ps -o pid=,command=`: each process's full command line. */
export function parsePsCommands(output: string): Map<number, string> {
  const commands = new Map<number, string>();
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) commands.set(Number(m[1]), m[2].trim());
  }
  return commands;
}

/** Flags of node, tsx and java that take the next word as their value. */
const VALUE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--env-file',
  '-cp',
  '-classpath',
  '--class-path',
  '--module-path',
  '-p'
]);
/** A Java main class ("org.gradle.launcher.daemon.bootstrap.GradleDaemon"). */
const JAVA_CLASS = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;
const lastSegments = (p: string, n: number) => p.split(/[/\\]/).filter(Boolean).slice(-n).join('/');

/** What a listener runs, shorter than its command line, so six "node" rows
 *  say which is which: "react-native start", "@factiii/runner index/index.js",
 *  "server/src/index.ts". Null when the command says no more than its name. */
export function commandLabel(command: string): string | null {
  const words = command.split(/\s+/).filter(Boolean);
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i += VALUE_FLAGS.has(words[i]) ? 2 : 1;
  const script = words[i];
  if (!script) return null;
  const next = words[i + 1] && !words[i + 1].startsWith('-') ? ` ${words[i + 1]}` : '';
  const bin = /node_modules[/\\]\.bin[/\\]([^/\\]+)$/.exec(script);
  if (bin) return `${bin[1]}${next}`;
  const pkg = /node_modules[/\\]((?:@[^/\\]+[/\\])?[^/\\]+)[/\\](.+)$/.exec(script);
  if (pkg) return `${pkg[1]} ${lastSegments(pkg[2], 2)}`;
  // java's main class: its own name says what it is ("GradleDaemon").
  if (JAVA_CLASS.test(script) && /(^|[/\\])java$/.test(words[0])) return script.split('.').pop() ?? null;
  return script.includes('/') ? lastSegments(script, 3) : null;
}

/** Names each listener by what it runs, where `commands` knows it. */
export function nameListeners(rows: FoundService[], commands: Map<number, string>): FoundService[] {
  return rows.map((row) => {
    const command = row.kind === 'port' && row.pid ? commands.get(row.pid) : undefined;
    const label = command ? commandLabel(command) : null;
    // The command line is the script too, so a known service a launch
    // agent's shell started as a child (not folded into the agent's row)
    // is still recognised by what it runs.
    const named = label ? { ...row, name: label } : row;
    return command && !named.script ? { ...named, script: command } : named;
  });
}

/** The fields a row is sent with. */
export const sentService = ({ pid: _pid, script: _script, ...row }: FoundService): RunnerService =>
  row;

/** `services/embedder`'s `GET /health`, as a line and a level. */
export function embedderHealth(body: unknown): Pick<RunnerService, 'health' | 'level'> {
  const health = (body ?? {}) as { model_loaded?: unknown; compute?: unknown };
  if (health.model_loaded !== true) return { health: 'Model not loaded', level: 'critical' };
  const compute = { ne: 'Neural Engine', gpu: 'GPU', cpu: 'CPU' }[String(health.compute)];
  return { health: compute ? `Model loaded · ${compute}` : 'Model loaded' };
}

/** The production embedder (services/embedder), by the script that runs it:
 *  pm2's script, a launch agent's program, or a listener's command line. */
export const isEmbedderScript = (script: string | undefined) =>
  Boolean(script && /[/\\]services[/\\]embedder[/\\]/.test(script));

export type HealthIo = {
  /** What each folder the runner writes to holds ("Vault"). */
  folders: { use: string; dir: string }[];
  /** The disk under `dir` (or its nearest existing parent), or null. */
  disk(dir: string): { id: number; freeBytes: number; totalBytes: number } | null;
  memory(): Promise<RunnerHealthLevel | null>;
  /** The runner user's process count and the OS's per-user limit, or null. */
  processes(): Promise<{ used: number; max: number } | null>;
  /** The 1-minute load average and the core count. */
  cpu?(): { load1: number; cores: number } | null;
  /** Memory in use and the total, or null. */
  memoryUse?(): Promise<RunnerMemoryUse | null>;
  /** Docker containers, pm2 processes, login agents and the runner user's
   *  listening processes. */
  services?(): Promise<RunnerService[]>;
};

/** Each disk once, with what it holds, the memory, and what the Status tab
 *  shows besides: CPU load, memory in use and the services running. */
export async function readHealth(io: HealthIo): Promise<RunnerMachineHealth> {
  const disks = new Map<number, RunnerDiskHealth>();
  for (const { use, dir } of io.folders) {
    const disk = io.disk(dir);
    if (!disk) continue;
    const seen = disks.get(disk.id);
    if (seen) {
      if (!seen.uses.includes(use)) seen.uses.push(use);
      continue;
    }
    const freeGb = roundGb(disk.freeBytes);
    disks.set(disk.id, {
      uses: [use],
      freeGb,
      totalGb: roundGb(disk.totalBytes),
      level: diskLevel(freeGb)
    });
  }
  const memory = await io.memory().catch(() => null);
  const count = await io.processes().catch(() => null);
  const processes = count ? { ...count, level: processLevel(count.used, count.max) } : null;
  const load = io.cpu?.() ?? null;
  const cpu = load ? cpuHealth(load.load1, load.cores) : null;
  const memoryInUse = (await io.memoryUse?.().catch(() => null)) ?? null;
  const services = (await io.services?.().catch(() => [])) ?? [];
  const list = [...disks.values()];
  return {
    // Not CPU: a busy build is normal, and `level` gates refusals.
    level: worst([...list.map((d) => d.level), memory ?? 'ok', processes?.level ?? 'ok']),
    disks: list,
    memory,
    processes,
    cpu,
    memoryUse: memoryInUse,
    services: services.slice(0, MAX_SERVICES),
    warnGb: DISK_WARN_GB,
    criticalGb: DISK_CRITICAL_GB
  };
}

const gb = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} GB`;

/** Before an action that writes `needGb` to a disk with `freeGb` free:
 *  `refuse` when it would leave less than DISK_CRITICAL_GB, `warn` when less
 *  than DISK_WARN_GB. Both null when there is room. */
export function checkRoom(
  freeGb: number,
  needGb: number,
  what: string
): { refuse: string | null; warn: string | null } {
  const left = freeGb - needGb;
  const said = `${what} needs about ${gb(Math.ceil(needGb * 10) / 10)}; ${gb(freeGb)} is free.`;
  if (left < DISK_CRITICAL_GB) {
    return {
      refuse: `${said} That would leave under ${gb(DISK_CRITICAL_GB)}. Free up space on the runner first.`,
      warn: null
    };
  }
  if (left < DISK_WARN_GB) {
    return { refuse: null, warn: `${said} Disk space will be low after it.` };
  }
  return { refuse: null, warn: null };
}
