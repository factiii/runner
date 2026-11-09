import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RunnerMachineHealth } from '@shared/all/domains/electron';

import type { CleanupIo } from './cleanup';
import {
  diskOf,
  type LocalAiModelIo,
  ollamaModelsDir,
  removeUnusedModel,
  unusedModels
} from './localAiModel';
import {
  containerEngine,
  darwinPressureLevel,
  embedderHealth,
  engineDownRow,
  type FoundService,
  type HealthIo,
  isEmbedderScript,
  meminfoLevel,
  meminfoUse,
  mergeServices,
  nameListeners,
  parseDockerPs,
  parseLaunchctlList,
  plistProgram,
  parseLsofListen,
  parsePm2Jlist,
  parsePsCommands,
  readHealth,
  sentService,
  vmStatUse
} from './machineHealth';
import { CONFIG_DIR } from './paths';
import { embedderPaths } from './vault/embedderInstall';
import { storePaths, vaultPaths } from './vault/engine';

// The real machine behind machineHealth.ts and cleanup.ts: statfs on the
// runner's folders, the OS's own memory pressure, `du` for sizes, and for
// the Status tab the load average, memory in use, `docker ps`, `pm2 jlist`,
// `launchctl list`, `lsof` and the embedder's `/health`. Read-only but for
// `remove`, which cleanup.ts calls only on a path its guard passed.

type Run = (
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number }
) => Promise<{ code: number; output: string }>;

const KIB = 1024;
/** A health read never waits on a hung `docker` or `lsof` longer than this. */
const READ_TIMEOUT_MS = 3000;

/** Free disk where the runner writes, memory pressure, CPU load, memory in
 *  use and what is running, on this machine. */
export function machineHealth(run: Run): Promise<RunnerMachineHealth> {
  return readHealth({
    ...levelsIo(run),
    cpu: () => ({ load1: os.loadavg()[0], cores: os.cpus().length }),
    memoryUse: () => memoryInUse(run),
    services: () => runningServices(run)
  });
}

/** Only what sets the level: the disks, memory pressure and the process
 *  count. Cheap enough for the alert's 30 s watch (healthWatch.ts). */
export function machineHealthLevels(run: Run): Promise<RunnerMachineHealth> {
  return readHealth(levelsIo(run));
}

/** The probes behind the level, shared by both reads above. */
function levelsIo(run: Run): HealthIo {
  return {
    // Builds and job checkouts live in each board's folder, under the
    // runner folder (spacePaths.ts).
    folders: [
      { use: 'Runner folder', dir: CONFIG_DIR },
      { use: 'Vault', dir: vaultPaths(CONFIG_DIR).objects },
      // Once it has a file (vault/daemonVault.ts makes it on the first).
      ...(fs.existsSync(storePaths(CONFIG_DIR, 'runner').objects)
        ? [{ use: 'Runner Storage', dir: storePaths(CONFIG_DIR, 'runner').objects }]
        : []),
      { use: 'Ollama models', dir: ollamaModelsDir() }
    ],
    disk(dir) {
      try {
        return diskOf(dir);
      } catch {
        return null;
      }
    },
    async memory() {
      if (process.platform === 'darwin') {
        const res = await run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']);
        return res.code === 0 ? darwinPressureLevel(res.output) : null;
      }
      if (process.platform === 'linux') {
        return meminfoLevel(fs.readFileSync('/proc/meminfo', 'utf-8'));
      }
      return null;
    },
    processes: () => processCount(run)
  };
}

/** Memory in use, or null. macOS from `vm_stat` (`os.freemem()` counts the
 *  file cache as used there), Linux from /proc/meminfo, null elsewhere. */
async function memoryInUse(run: Run) {
  if (process.platform === 'darwin') {
    const res = await run('vm_stat', [], { timeoutMs: READ_TIMEOUT_MS });
    return res.code === 0 ? vmStatUse(res.output, os.totalmem()) : null;
  }
  if (process.platform === 'linux') {
    return meminfoUse(fs.readFileSync('/proc/meminfo', 'utf-8'));
  }
  return null;
}

/** What each agent runs (plistProgram), by label. */
function launchAgentPrograms(labels: string[]): Map<string, string> {
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const programs = new Map<string, string>();
  for (const label of labels) {
    try {
      const program = plistProgram(fs.readFileSync(path.join(dir, `${label}.plist`), 'utf-8'));
      if (program) programs.set(label, program);
    } catch {
      // Unreadable: the row stays, without a script.
    }
  }
  return programs;
}

/** The labels of the agents in the user's LaunchAgents folder (macOS). */
function launchAgentLabels(): string[] {
  if (process.platform !== 'darwin') return [];
  try {
    return fs
      .readdirSync(path.join(os.homedir(), 'Library', 'LaunchAgents'))
      .filter((f) => f.endsWith('.plist'))
      .map((f) => f.slice(0, -'.plist'.length))
      .sort();
  } catch {
    return [];
  }
}

/** Whether a pm2 daemon is up. Asked first because `pm2 jlist` starts one
 *  when none is, and a health read must not start anything. */
function pm2Running(): boolean {
  const home = process.env.PM2_HOME ?? path.join(os.homedir(), '.pm2');
  try {
    const pid = Number(fs.readFileSync(path.join(home, 'pm2.pid'), 'utf-8'));
    process.kill(pid, 0);
    return pid > 0;
  } catch {
    return false;
  }
}

/** Asks a known service its own health. Only the production embedder today;
 *  a row it cannot ask is left as it is. */
async function withHealth(row: FoundService): Promise<FoundService> {
  if (!isEmbedderScript(row.script) || !row.running || row.ports.length === 0) return row;
  try {
    const res = await fetch(`http://127.0.0.1:${row.ports[0]}/health`, {
      signal: AbortSignal.timeout(READ_TIMEOUT_MS)
    });
    if (!res.ok) return { ...row, health: `Health check answered ${res.status}`, level: 'critical' };
    const checked = embedderHealth(await res.json());
    return { ...row, ...checked, level: checked.level ?? row.level };
  } catch {
    return { ...row, health: 'Health check did not answer', level: 'critical' };
  }
}

/** Containers (OrbStack's or Docker's), pm2 processes, the user's login
 *  agents, then the runner user's other processes listening on TCP. No
 *  docker CLI, pm2 or launchd is none of those; a docker CLI whose engine
 *  is down is one row saying so. */
export async function runningServices(run: Run) {
  const labels = launchAgentLabels();
  const [docker, context, pm2, launchctl, lsof] = await Promise.all([
    run('docker', ['ps', '-a', '--format', '{{json .}}'], { timeoutMs: READ_TIMEOUT_MS }),
    // Reads the CLI's config only; it never reaches the engine.
    run('docker', ['context', 'show'], { timeoutMs: READ_TIMEOUT_MS }),
    pm2Running()
      ? run('pm2', ['jlist'], { timeoutMs: READ_TIMEOUT_MS })
      : Promise.resolve({ code: 1, output: '' }),
    labels.length > 0
      ? run('launchctl', ['list'], { timeoutMs: READ_TIMEOUT_MS })
      : Promise.resolve({ code: 1, output: '' }),
    // `-a`: lsof ORs its selections without it, so `-u` would list every
    // file the user has open.
    run(
      'lsof',
      ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-u', os.userInfo().username, '-Fpcn'],
      { timeoutMs: READ_TIMEOUT_MS }
    )
  ]);
  const engineDown = engineDownRow(docker, containerEngine(context.code === 0 ? context.output : ''));
  // lsof exits 1 when nothing listens, so its output is read either way.
  const rows = mergeServices([
    ...(docker.code === 0 ? parseDockerPs(docker.output) : []),
    ...(engineDown ? [engineDown] : []),
    ...(pm2.code === 0 ? parsePm2Jlist(pm2.output, Date.now()) : []),
    ...(launchctl.code === 0
      ? parseLaunchctlList(launchctl.output, labels, launchAgentPrograms(labels))
      : []),
    ...parseLsofListen(lsof.output)
  ]);
  const pids = rows.filter((r) => r.kind === 'port' && r.pid).map((r) => String(r.pid));
  const ps =
    pids.length > 0
      ? await run('ps', ['-o', 'pid=,command=', '-p', pids.join(',')], { timeoutMs: READ_TIMEOUT_MS })
      : { code: 1, output: '' };
  // ps exits 1 when one of the processes has gone since lsof, so its
  // output is read either way.
  const named = nameListeners(rows, parsePsCommands(ps.output));
  return (await Promise.all(named.map(withHealth))).map(sentService);
}

/** This user's processes against the per-user limit, or null. macOS only:
 *  the 2026-10-16 lock-up was kern.maxprocperuid on the Mac Mini, and
 *  Linux's cap (RLIMIT_NPROC) is often unlimited. */
export async function processCount(run: Run): Promise<{ used: number; max: number } | null> {
  if (process.platform !== 'darwin') return null;
  const limit = await run('sysctl', ['-n', 'kern.maxprocperuid']);
  const list = await run('ps', ['-U', os.userInfo().username, '-o', 'pid=']);
  const max = Number(limit.output.trim());
  if (limit.code !== 0 || list.code !== 0 || !max) return null;
  return { used: list.output.split('\n').filter((l) => l.trim()).length, max };
}

/** Bytes under a path. `du -sk` never follows a link under it. */
export const diskSize =
  (run: Run) =>
  async (p: string): Promise<number> => {
    const res = await run('du', ['-sk', p]);
    const kb = Number(res.output.trim().split(/\s/)[0]);
    return res.code === 0 && Number.isFinite(kb) ? kb * KIB : 0;
  };

/** Free up space on this machine. */
export function cleanupIo(run: Run, model: LocalAiModelIo): CleanupIo {
  return {
    runnerDir: CONFIG_DIR,
    protectedDirs: [
      vaultPaths(CONFIG_DIR).db,
      vaultPaths(CONFIG_DIR).objects,
      vaultPaths(CONFIG_DIR).engine,
      // Runner Storage, the runner's second store (vault/engine.ts).
      storePaths(CONFIG_DIR, 'runner').db,
      storePaths(CONFIG_DIR, 'runner').objects,
      embedderPaths(CONFIG_DIR).root,
      ollamaModelsDir(),
      // The keychain's file store on Linux, and macOS's own keychains.
      path.join(os.homedir(), '.local', 'share', 'keyrings'),
      path.join(os.homedir(), 'Library', 'Keychains')
    ],
    now: Date.now,
    size: diskSize(run),
    remove: (p) => fs.rmSync(p, { recursive: true, force: true }),
    unusedModels: () => unusedModels(model),
    removeModel: (id, onLine) => removeUnusedModel(model, id, onLine)
  };
}
