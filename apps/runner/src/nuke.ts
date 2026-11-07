import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  RunnerNukeBoard,
  RunnerNukePlan,
  RunnerNukeProgress,
  RunnerNukeStep
} from '@shared/all/domains/electron';
import {
  storedSecretFiles,
  storedSecretKeys
} from '@shared/all/helpers/board-agent-core/host-secrets';

// Nuke a runner (.specs/runner-setup.md "Nuke a runner"): a clean erase of
// everything on it, secrets included. The order is the point:
//
//   plan → unpair on the server → stop the service → stop sessions (and
//   let go of a closed lid) → erase the keychain entry → erase every
//   board's secrets → erase the folder → exit.
//
// Unpairing first means a runner that dies halfway can no longer use its
// token. Every step is idempotent, and a marker file in the runner folder
// remembers what is already done, so a re-run after a crash finishes the
// job (and skips the server once it said yes).
//
// Nothing outside the runner folder is deleted by this file. The folder must
// be exactly the runner home this process resolves (FACTIII_RUNNER_DIR or
// ~/.factiii-runner), a real directory (not a link), never `/`, the home
// folder or anything above it, and must look like a runner's
// (nukeDirRefusal). What lives outside it (the service file, the keychain
// item, tmux sessions) is the host's to remove, through `NukeHost`. What it
// cannot remove (the lid-closed sudoers grant, root's file) is named in the
// plan and the final output, with where the person removes it.

/** Written first, removed last: a folder holding it is a nuke in progress. */
export const NUKE_MARKER = '.nuke-in-progress';

/** A runner folder has at least one of these (or the marker). */
const RUNNER_MARKERS = ['config.json', 'spaces.json', 'access.json', NUKE_MARKER];

/** Top-level folders of the runner that are not boards (cleanup.ts's list,
 *  and what else the runner keeps beside its boards). */
const NOT_BOARDS = new Set([
  'parts',
  'logs',
  'helpers',
  'agent-home',
  'index-data',
  'plugin',
  'tmux-plugins',
  'tmux-resurrect-state',
  'npm',
  'vault'
]);
/** A board folder has one of these (hostSpacePaths). */
const BOARD_PARTS = ['repo', 'worktrees', 'workspace', 'secrets', 'state', 'scratchpad'];

const inside = (dir: string, target: string) =>
  target === dir || target.startsWith(`${dir}${path.sep}`);

/**
 * Why `dir` may not be nuked, or null when it may. `expectedDir` is the
 * runner home this process resolved; `home` the user's home folder.
 */
export function nukeDirRefusal(
  dir: string,
  opts: { expectedDir: string; home: string }
): string | null {
  if (!dir || !path.isAbsolute(dir)) return 'The runner folder is not an absolute path.';
  const resolved = path.resolve(dir);
  const home = path.resolve(opts.home);
  if (resolved === path.parse(resolved).root) return 'Refusing to erase the root folder.';
  if (resolved === home || inside(resolved, home)) {
    return 'Refusing to erase the home folder or a folder that holds it.';
  }
  if (resolved !== path.resolve(opts.expectedDir)) {
    return `${resolved} is not this runner's folder (${opts.expectedDir}).`;
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    // Already gone: the erase finished. Nothing to delete.
    return null;
  }
  if (stat.isSymbolicLink()) return `${resolved} is a link, not the runner folder itself.`;
  if (!stat.isDirectory()) return `${resolved} is not a folder.`;
  const real = fs.realpathSync(resolved);
  const realHome = fs.existsSync(home) ? fs.realpathSync(home) : home;
  if (real === path.parse(real).root || real === realHome || inside(real, realHome)) {
    return 'Refusing to erase the home folder or a folder that holds it.';
  }
  const entries = fs.readdirSync(resolved);
  if (entries.length && !RUNNER_MARKERS.some((m) => entries.includes(m))) {
    return `${resolved} does not look like a runner folder (no config.json or spaces.json). Nothing was erased.`;
  }
  return null;
}

/** Why the CLI refuses to nuke from this environment, or null. A terminal or
 *  card session the runner started is an agent's shell, and agents may not
 *  nuke (only the owner, at their own terminal or in Runner Settings). The
 *  runner marks its sessions (FACTIII_SESSION, SCRATCHPAD) and runs them on
 *  its own tmux server; Claude Code and Codex mark their shells too. A
 *  speed bump, not a wall: a shell can unset what it inherits, which is why
 *  the owner check lives on the runner for every other road. */
export function nukeSessionRefusal(env: NodeJS.ProcessEnv): string | null {
  const tmuxSocket = (env.TMUX ?? '').split(',')[0];
  if (
    env.FACTIII_SESSION !== undefined ||
    env.SCRATCHPAD !== undefined ||
    env.CLAUDECODE !== undefined ||
    env.CODEX_SANDBOX !== undefined ||
    path.basename(tmuxSocket) === 'factiii'
  ) {
    return 'Refusing to nuke from inside a runner session or an AI agent’s shell. Run it in your own terminal, or use Runner Settings > Danger zone.';
  }
  return null;
}

/** What the marker remembers between runs. */
type NukeMarker = { startedAt: string; done: RunnerNukeStep[] };

function readMarker(dir: string): NukeMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, NUKE_MARKER), 'utf-8')) as unknown;
    if (raw && typeof raw === 'object' && Array.isArray((raw as NukeMarker).done)) {
      return raw as NukeMarker;
    }
  } catch {
    // No marker (or a torn one): start from the top.
  }
  return null;
}

function writeMarker(dir: string, marker: NukeMarker): void {
  if (!fs.existsSync(dir)) return;
  fs.writeFileSync(path.join(dir, NUKE_MARKER), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
}

const realDirs = (dir: string): string[] => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};

/** The board folders under the runner home: real folders (a renamed
 *  board's old name is a link, boardRegistry.ts), not the runner's own. */
function boardSlugs(dir: string): string[] {
  return realDirs(dir)
    .filter((name) => !name.startsWith('.') && !NOT_BOARDS.has(name))
    .filter((name) => BOARD_PARTS.some((p) => fs.existsSync(path.join(dir, name, p))))
    .sort();
}

/** What a worktree holds that no remote has (git.ts worktreeWorkState). */
type WorkStateReader = (
  spaceDir: string,
  worktree: string
) => Promise<{ branch: string; dirty: boolean; unpushed: boolean }>;

/** What the host does outside the runner folder. Each must be idempotent:
 *  a second call after the first succeeded does nothing and says so. */
export type NukeHost = {
  /** Whether the runner holds a pairing, and its name. */
  pairing(): { paired: boolean; runnerName: string };
  /** The service name that would be removed, or null with none. */
  serviceName(): Promise<string | null>;
  workState: WorkStateReader;
  /** Unpair on the server, and remove the runner's record there. Resolves
   *  when the server said yes, or that it no longer knows the token.
   *  Rejects when it could not be asked: then nothing is erased. */
  unpair(): Promise<string[]>;
  removeService(): Promise<string[]>;
  /** Every runner tmux session and its process tree, the simulator stream,
   *  keep-awake. */
  stopWork(): Promise<string[]>;
  eraseKeychain(): Promise<string[]>;
  /** Lid closed off (`sudo -n pmset -a disablesleep 0`) when the grant is
   *  there, so the Mac sleeps with its lid shut again. Never throws. */
  releaseLid(): Promise<string[]>;
  /** What stays for the person to remove, and where (plan.leftBehind). */
  leftBehind(): Promise<string[]>;
};

/** Read the plan: nothing is changed. */
export async function readNukePlan(dir: string, host: NukeHost): Promise<RunnerNukePlan> {
  const boards: RunnerNukeBoard[] = [];
  for (const slug of boardSlugs(dir)) {
    const spaceDir = path.join(dir, slug);
    const worktrees = [];
    for (const name of realDirs(path.join(spaceDir, 'worktrees')).sort()) {
      const state = await host
        .workState(spaceDir, path.join(spaceDir, 'worktrees', name))
        .catch(() => ({ branch: '', dirty: true, unpushed: true }));
      worktrees.push({ name, ...state });
    }
    let backups = 0;
    try {
      backups = fs.readdirSync(path.join(spaceDir, 'backups')).length;
    } catch {
      // No backups folder.
    }
    boards.push({
      slug,
      worktrees,
      secrets: (await storedSecretKeys(spaceDir)).length,
      secretFiles: (await storedSecretFiles(spaceDir)).length,
      backups
    });
  }
  const { paired, runnerName } = host.pairing();
  return {
    runnerDir: dir,
    runnerName,
    boards,
    secretsTotal: boards.reduce((n, b) => n + b.secrets + b.secretFiles, 0),
    backupsTotal: boards.reduce((n, b) => n + b.backups, 0),
    paired,
    service: await host.serviceName().catch(() => null),
    leftBehind: await host.leftBehind().catch(() => [])
  };
}

/** Remove `target`, which must sit inside `dir`. Links are removed, never
 *  followed (fs.rm does not follow them). */
function removeInside(dir: string, target: string): void {
  const rel = path.relative(dir, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to remove ${target}: it is outside ${dir}.`);
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

/** Every board's secrets store: the age identity, the encrypted secrets and
 *  files, the inbox. Plus the at-rest key file Windows keeps here. */
function eraseSecrets(dir: string): string[] {
  const lines: string[] = [];
  for (const name of realDirs(dir)) {
    const secrets = path.join(dir, name, 'secrets');
    if (fs.existsSync(secrets)) {
      removeInside(dir, secrets);
      lines.push(`Erased ${name}'s secrets store.`);
    }
  }
  for (const file of ['config-key.dpapi', 'age-identity.enc']) {
    const at = path.join(dir, file);
    if (fs.existsSync(at)) {
      removeInside(dir, at);
      lines.push(`Erased ${file}.`);
    }
  }
  if (!lines.length) lines.push('No secrets store was left.');
  return lines;
}

/** Everything in the folder but the marker, then the marker, then the
 *  folder itself. */
function eraseFolder(dir: string): string[] {
  if (!fs.existsSync(dir)) return ['The runner folder is already gone.'];
  for (const name of fs.readdirSync(dir)) {
    if (name !== NUKE_MARKER) removeInside(dir, path.join(dir, name));
  }
  fs.rmSync(path.join(dir, NUKE_MARKER), { force: true });
  fs.rmdirSync(dir);
  return [`Erased ${dir}.`];
}

export type NukeOptions = {
  dir: string;
  /** The runner home this process resolved (paths.ts CONFIG_DIR). */
  expectedDir: string;
  home?: string;
  host: NukeHost;
  onProgress?: (progress: RunnerNukeProgress) => void;
};

/**
 * Erase the runner. The caller has checked the phrase and the owner
 * (runnerNuke.ts); this checks the folder before every step that deletes.
 * Throws at the first step that fails, after a `failed` frame: a re-run
 * starts from that step.
 */
export async function runNuke(opts: NukeOptions): Promise<RunnerNukePlan> {
  const { dir, host } = opts;
  const guard = () => {
    const refusal = nukeDirRefusal(dir, {
      expectedDir: opts.expectedDir,
      home: opts.home ?? os.homedir()
    });
    if (refusal) throw new Error(refusal);
  };
  const report = (step: RunnerNukeStep, state: RunnerNukeProgress['state'], lines: string[] = []) =>
    opts.onProgress?.({ step, state, lines });

  guard();
  // The folder goes last, after the server said yes: with no folder, there
  // is nothing left to do.
  if (!fs.existsSync(dir)) {
    report('done', 'done', ['The runner folder is already gone.']);
    return readNukePlan(dir, host);
  }
  report('plan', 'running');
  const plan = await readNukePlan(dir, host);
  const marker: NukeMarker = readMarker(dir) ?? {
    startedAt: new Date().toISOString(),
    done: []
  };
  writeMarker(dir, marker);
  report('plan', 'done', [`${plan.boards.length} boards, ${plan.secretsTotal} secrets.`]);

  const steps: [RunnerNukeStep, () => Promise<string[]> | string[]][] = [
    ['unpair', () => host.unpair()],
    ['service', () => host.removeService()],
    // Keep-awake stops with the sessions; then a closed lid is let go.
    ['sessions', async () => [...(await host.stopWork()), ...(await host.releaseLid())]],
    ['keychain', () => host.eraseKeychain()],
    [
      'secrets',
      () => {
        guard();
        return eraseSecrets(dir);
      }
    ],
    [
      'folder',
      () => {
        guard();
        return eraseFolder(dir);
      }
    ]
  ];
  for (const [step, run] of steps) {
    // The server already said yes: a re-run with no network finishes.
    if (step === 'unpair' && marker.done.includes('unpair')) {
      report(step, 'done', ['Already unpaired.']);
      continue;
    }
    report(step, 'running');
    try {
      const lines = await run();
      if (step !== 'folder') {
        marker.done = [...new Set([...marker.done, step])];
        writeMarker(dir, marker);
      }
      report(step, 'done', lines);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report(step, 'failed', [message]);
      throw new Error(`${step} failed: ${message}`);
    }
  }
  // The last word is what is still on the machine for the person to remove.
  report('done', 'done', plan.leftBehind ?? []);
  return plan;
}
