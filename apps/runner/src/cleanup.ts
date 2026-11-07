import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { RunnerCleanupItem } from '@shared/all/domains/electron';
import { bytesLabel } from '@shared/all/helpers/runnerPartsCopy';

// Free up space (.specs/runner-setup.md "Machine health and Free up space"): what the runner
// made and makes again on its own, and the caches of the tools boards use.
// Old build output in a board's `builds`, a board's job checkout (`jobs`,
// re-added by the next job) unused for a week, the service log's old copy,
// Ollama models the runner pulled that are no longer picked, and the caches
// diskCaches.ts knows (each cleared by its tool's own command). The plan is a
// dry run; a run removes only items of a fresh plan, and each path passes
// `cleanableRefusal` again right before it goes.
//
// Never the vault (its files, database, engine or search models), secrets,
// keys, a board's clone, worktrees or backups, or anything outside the
// runner folder: those fail the guard even when listed.

/** Output this old is no longer used. */
const STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Top-level folders of the runner that are not boards. */
const NOT_BOARDS = new Set([
  'parts',
  'logs',
  'helpers',
  'agent-home',
  'index-data',
  'plugin',
  'tmux-plugins'
]);
/** A path through one of these is never removed, wherever it sits. */
const PROTECTED_NAMES = new Set(['parts', 'secrets', 'vault', 'state', 'backups']);

const OLD_LOG = ['logs', 'runner.log.1'];

const inside = (dir: string, target: string) =>
  target === dir || target.startsWith(`${dir}${path.sep}`);

const realOrNull = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * Why `target` may not be removed, or null when it may: it must resolve (links
 * followed) to something the runner made under `runnerDir`, and to nothing
 * under `protectedDirs` (the vault, its search models, Ollama's models).
 */
export function cleanableRefusal(
  runnerDir: string,
  target: string,
  protectedDirs: readonly string[]
): string | null {
  const root = realOrNull(runnerDir);
  const real = realOrNull(target);
  if (!root || !real) return 'It is not there.';
  for (const dir of protectedDirs) {
    const guarded = realOrNull(dir) ?? path.resolve(dir);
    if (inside(guarded, real) || inside(real, guarded)) {
      return 'It holds vault or model data.';
    }
  }
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return 'It is outside the runner folder.';
  }
  const parts = rel.split(path.sep);
  if (parts.some((p) => PROTECTED_NAMES.has(p))) {
    return 'It holds vault data, secrets or backups.';
  }
  const board = !NOT_BOARDS.has(parts[0]);
  const ok =
    (board && parts.length >= 3 && parts[1] === 'builds') ||
    (board && parts.length === 2 && parts[1] === 'jobs') ||
    rel === path.join(...OLD_LOG);
  return ok ? null : 'The runner did not make it.';
}

export type CleanupIo = {
  runnerDir: string;
  /** Never removed, even through a link: the vault, its search models and
   *  Ollama's models folder. */
  protectedDirs: string[];
  now(): number;
  /** Bytes under a path, links not followed. */
  size(p: string): Promise<number>;
  remove(p: string): void;
  /** Models the runner pulled that are no longer picked (localAiModel.ts). */
  unusedModels(): { id: string; bytes: number }[];
  removeModel(id: string, onLine: (line: string) => void): Promise<boolean>;
  /** Tools' caches Free up space can clear (diskCaches.ts). */
  caches?(): Promise<RunnerCleanupItem[]>;
  /** Clear one cache of a fresh plan, by id, with its tool's own command. */
  clearCache?(id: string, onLine: (line: string) => void): Promise<boolean>;
};

const MODEL_PREFIX = 'ollama:';

function entries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const mtime = (p: string): number => {
  try {
    return fs.lstatSync(p).mtimeMs;
  } catch {
    return Infinity;
  }
};

/** The newest change to a folder or what sits directly in it. */
const newest = (dir: string): number =>
  Math.max(mtime(dir), ...entries(dir).map((e) => mtime(path.join(dir, e.name))));

/** The dry run: everything Free up space would remove now, with sizes. */
export async function planCleanup(io: CleanupIo): Promise<RunnerCleanupItem[]> {
  const stale = io.now() - STALE_DAYS * DAY_MS;
  const found: { id: string; title: string; rel: string }[] = [];
  for (const board of entries(io.runnerDir)) {
    if (!board.isDirectory() || NOT_BOARDS.has(board.name)) continue;
    const builds = path.join(io.runnerDir, board.name, 'builds');
    for (const entry of entries(builds)) {
      if (mtime(path.join(builds, entry.name)) < stale) {
        const rel = path.join(board.name, 'builds', entry.name);
        found.push({ id: `builds:${rel}`, title: 'Old build output', rel });
      }
    }
    const jobs = path.join(io.runnerDir, board.name, 'jobs');
    if (fs.existsSync(jobs) && newest(jobs) < stale) {
      const rel = path.join(board.name, 'jobs');
      found.push({ id: `jobs:${rel}`, title: 'Job checkout, unused for a week', rel });
    }
  }
  const log = path.join(...OLD_LOG);
  if (fs.existsSync(path.join(io.runnerDir, log))) {
    found.push({ id: `log:${log}`, title: 'Old runner log', rel: log });
  }

  const items: RunnerCleanupItem[] = [];
  for (const { id, title, rel } of found) {
    const full = path.join(io.runnerDir, rel);
    if (cleanableRefusal(io.runnerDir, full, io.protectedDirs)) continue;
    items.push({ id, title, path: rel, bytes: await io.size(full) });
  }
  for (const model of io.unusedModels()) {
    items.push({
      id: `${MODEL_PREFIX}${model.id}`,
      title: 'Ollama model no longer picked',
      path: model.id,
      bytes: model.bytes
    });
  }
  return [...items, ...((await io.caches?.().catch(() => [])) ?? [])];
}

/** Remove `ids`, and only those still in a fresh plan. Resolves the bytes
 *  freed. */
export async function runCleanup(
  io: CleanupIo,
  ids: readonly string[],
  onLine: (line: string) => void
): Promise<number> {
  let freed = 0;
  for (const item of await planCleanup(io)) {
    if (!ids.includes(item.id)) continue;
    if (item.id.startsWith(MODEL_PREFIX)) {
      if (await io.removeModel(item.path, onLine)) freed += item.bytes;
      continue;
    }
    // A cache is cleared by its id, never by a path: diskCaches.ts knows
    // each one's own command.
    if (item.kind === 'cache') {
      if (await io.clearCache?.(item.id, onLine)) freed += item.bytes;
      continue;
    }
    const full = path.join(io.runnerDir, item.path);
    const refusal = cleanableRefusal(io.runnerDir, full, io.protectedDirs);
    if (refusal) {
      onLine(`Left ${item.path}: ${refusal}`);
      continue;
    }
    try {
      io.remove(full);
      freed += item.bytes;
      onLine(`Removed ${item.path} (${bytesLabel(item.bytes)}).`);
    } catch (err) {
      onLine(`Could not remove ${item.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return freed;
}

// ── The desktop view's leftovers ──
// Runners before 0.37 built "Factiii Screen" for the desktop view, which
// Screen Sharing over Tailscale replaced (.specs/runner-window.md). What that
// version made: one app bundle beside the boards, `helpers/FactiiiScreen.app`
// (bundle id `com.factiii.runner.screen`, signed ad hoc), and the Screen
// Recording and Accessibility switches the owner turned on for it. It never
// installed a LaunchAgent or a login item, and ran only as the runner's child.

const SCREEN_APP = ['helpers', 'FactiiiScreen.app'];
const SCREEN_BUNDLE_ID = 'com.factiii.runner.screen';
/** The two privacy switches the helper held (tccutil's service names). */
const SCREEN_GRANTS = ['ScreenCapture', 'Accessibility'];

export type DesktopViewLeftoversIo = {
  runnerDir: string;
  /** process.platform when left out. */
  platform?: NodeJS.Platform;
  /** Reset one privacy switch for the bundle id; false when tccutil refused.
   *  tccutil when left out. */
  resetGrant?(service: string, bundleId: string): boolean;
};

const TCCUTIL_TIMEOUT_MS = 10_000;

const resetGrantWithTccutil = (service: string, bundleId: string): boolean => {
  try {
    execFileSync('tccutil', ['reset', service, bundleId], {
      stdio: 'ignore',
      timeout: TCCUTIL_TIMEOUT_MS
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Remove what the desktop view left on this machine, at runner start. Runs its
 * steps only while the bundle is there, so it is done once: a second start
 * finds nothing and does nothing. Answers with a line per thing removed.
 */
export function removeDesktopViewLeftovers(io: DesktopViewLeftoversIo): string[] {
  const app = path.join(io.runnerDir, ...SCREEN_APP);
  if (!fs.existsSync(app)) return [];
  const lines: string[] = [];
  try {
    fs.rmSync(app, { recursive: true, force: true });
    lines.push(`Removed ${path.join(...SCREEN_APP)} (the old desktop view's helper).`);
  } catch (err) {
    // Left in place: the next start tries again.
    return [
      `Could not remove ${path.join(...SCREEN_APP)}: ${err instanceof Error ? err.message : String(err)}`
    ];
  }
  // The switches are macOS's, and outlive the bundle in System Settings.
  if ((io.platform ?? process.platform) === 'darwin') {
    const reset = io.resetGrant ?? resetGrantWithTccutil;
    for (const service of SCREEN_GRANTS) {
      if (reset(service, SCREEN_BUNDLE_ID)) {
        lines.push(`Reset the ${service} switch for "Factiii Screen".`);
      }
    }
  }
  // An empty helpers folder goes too; one holding anything else stays.
  const helpers = path.join(io.runnerDir, SCREEN_APP[0]);
  try {
    fs.rmdirSync(helpers);
  } catch {
    // Not empty, or not there.
  }
  return lines;
}
