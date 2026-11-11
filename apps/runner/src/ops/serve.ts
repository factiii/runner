import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { JobTargets } from '@shared/all/helpers/board-agent-core/job-targets';

import { createOpsBoard, type OpsBoard } from './board';
import { opsClone } from './opsClone';
import { challengePeerCheck } from './peer';
import { BOARD_SLUG, REFUSED_BOARD } from './protocol';
import { type OpsServer, startOpsServer } from './server';
import { opsHomePaths, opsRunPaths } from './settings';
import { createOpsUpdater, type OpsUpdater } from './updater';
import { bundleVersion, fetchLatestMac, servicePidFile, spawnApplyHelper, stageMacRelease } from './updaterMac';

/** Set by Factiii Desktop's setup in the daemon's plist: the app bundle this
 *  service runs from, which its updater keeps current. */
export const OPS_APP_ENV = 'FACTIII_OPS_APP';
const UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
const UPDATE_TICK_MS = 60_000;

// `factiii-runner ops serve` (.specs/ops-user.md): the ops half, run by the
// com.factiii.ops LaunchDaemon (or systemd unit) as factiii-ops. It reads its
// own config from the ops home, checks the run dir's owners and modes, mints
// one token per board, and serves the socket.

const configSchema = z.object({
  /** The normal user's uid (members of group factiii). */
  allowedUids: z.array(z.number().int().min(0)).min(1),
  boards: z.array(
    z.object({
      slug: z.string().regex(BOARD_SLUG),
      // '' for a board held for its secrets alone: no repository, no jobs
      // (opsClone OPS_NO_REPO). Only setup or Repair sets one.
      repoUrl: z.string(),
      mainBranch: z.string().min(1).default('main')
    })
  )
});

export type OpsConfig = z.infer<typeof configSchema>;

export function readOpsConfig(opsHome: string): OpsConfig {
  const file = opsHomePaths(opsHome).config;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    throw new Error(`${file} is missing or not JSON.`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} is invalid: ${parsed.error.issues[0]?.message ?? ''}`);
  return parsed.data;
}

/** Refuse a run dir someone else could have made or can write: owned by us,
 *  nothing for others, and the peer dir exactly 1730. Creates what is
 *  missing (Linux's RuntimeDirectory starts empty). */
export function assertRunDir(runDir: string, uid: number | undefined = process.getuid?.()): void {
  const { peerDir, tokensDir } = opsRunPaths(runDir);
  fs.mkdirSync(tokensDir, { recursive: true, mode: 0o750 });
  if (!fs.existsSync(peerDir)) {
    fs.mkdirSync(peerDir, { mode: 0o1730 });
    fs.chmodSync(peerDir, 0o1730);
  }
  const check = (dir: string, ok: (mode: number) => boolean, want: string) => {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory.`);
    if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} is not owned by the ops user.`);
    if (!ok(st.mode & 0o7777)) throw new Error(`${dir} has mode ${(st.mode & 0o7777).toString(8)}, want ${want}.`);
  };
  const private_ = (mode: number) => (mode & 0o027) === 0;
  check(runDir, private_, '0750');
  check(tokensDir, private_, '0750');
  check(peerDir, (mode) => mode === 0o1730, '1730');
}

export async function runOpsServe(opts: {
  opsHome: string;
  runDir: string;
  log?: (line: string) => void;
  uid?: number;
}): Promise<{ server: OpsServer; boards: Map<string, OpsBoard>; close: () => Promise<void> }> {
  const log = opts.log ?? ((line: string) => console.log(`[ops] ${line}`));
  const config = readOpsConfig(opts.opsHome);
  assertRunDir(opts.runDir, opts.uid);
  const home = opsHomePaths(opts.opsHome);
  const run = opsRunPaths(opts.runDir);
  // One store of target holds for every board: a target waits across boards.
  const targets = new JobTargets();
  const boards = new Map<string, OpsBoard>();
  const tokens = new Map<string, string>();
  const register = (b: OpsConfig['boards'][number]) => {
    const githubToken = () => {
      try {
        return fs.readFileSync(home.githubToken(b.slug), 'utf-8').trim();
      } catch {
        return '';
      }
    };
    boards.set(
      b.slug,
      createOpsBoard({
        slug: b.slug,
        opsHome: opts.opsHome,
        spaceDir: home.board(b.slug),
        clone: opsClone({
          opsHome: opts.opsHome,
          slug: b.slug,
          repoUrl: b.repoUrl,
          branch: b.mainBranch,
          githubToken,
          uid: opts.uid
        }),
        githubToken,
        targets,
        uid: opts.uid
      })
    );
    // A fresh token each start: a copy from before a restart opens nothing.
    const token = randomBytes(32).toString('hex');
    tokens.set(b.slug, token);
    const file = run.token(b.slug);
    fs.writeFileSync(`${file}.tmp`, `${token}\n`, { mode: 0o640 });
    fs.chmodSync(`${file}.tmp`, 0o640);
    fs.renameSync(`${file}.tmp`, file);
  };
  for (const b of config.boards) register(b);

  /** A board made after setup, taken for its secrets on its first store
   *  op (the session half's board-add): an empty store, no repository, so
   *  no jobs. Connecting a repository, which decides what its jobs run,
   *  stays with setup and Repair, behind the admin prompt. Kept in
   *  ops-config.json so a restart serves it too. */
  const addBoard = (slug: string): boolean => {
    if (boards.has(slug)) return false;
    if (!BOARD_SLUG.test(slug)) throw new Error(REFUSED_BOARD);
    fs.mkdirSync(home.board(slug), { recursive: true, mode: 0o700 });
    const entry = { slug, repoUrl: '', mainBranch: 'main' };
    const current = readOpsConfig(opts.opsHome);
    const next = { ...current, boards: [...current.boards.filter((x) => x.slug !== slug), entry] };
    fs.writeFileSync(`${home.config}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(`${home.config}.tmp`, 0o600);
    fs.renameSync(`${home.config}.tmp`, home.config);
    register(entry);
    log(`took board ${slug} for its secrets (no repository)`);
    return true;
  };
  const updater = macUpdater({ opsHome: opts.opsHome, runDir: opts.runDir, boards, log });
  const server = await startOpsServer({
    socketPath: run.socket,
    peer: challengePeerCheck({ peerDir: run.peerDir, allowedUids: new Set(config.allowedUids) }),
    board: (slug) => boards.get(slug) ?? null,
    tokenFor: (slug) => tokens.get(slug) ?? null,
    addBoard,
    log,
    updater: updater ?? undefined
  });
  // Group factiii reads the pid (`ops status` in the normal user). The
  // LaunchDaemon's UMask=0077 strips the group bit from `mode`, so set it
  // again after the write.
  const pidFile = servicePidFile(opts.runDir);
  fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o640 });
  fs.chmodSync(pidFile, 0o640);
  const ticker = updater ? setInterval(() => void updater.tick(), UPDATE_TICK_MS) : null;
  ticker?.unref();
  log(`serving ${boards.size} board(s) on ${run.socket}${updater ? ', updater on' : ''}`);
  return {
    server,
    boards,
    close: async () => {
      if (ticker) clearInterval(ticker);
      await server.close();
      for (const board of boards.values()) board.destroy();
      for (const slug of boards.keys()) fs.rmSync(run.token(slug), { force: true });
    }
  };
}

/** The updater, when this service runs from an app bundle on macOS
 *  (OPS_APP_ENV). A CLI-run service (npm's node) has none. */
function macUpdater(opts: {
  opsHome: string;
  runDir: string;
  boards: Map<string, OpsBoard>;
  log: (line: string) => void;
}): OpsUpdater | null {
  const app = process.env[OPS_APP_ENV]?.trim();
  if (process.platform !== 'darwin' || !app || !app.endsWith('.app')) return null;
  const current = bundleVersion(app);
  if (!current) return null;
  return createOpsUpdater({
    current,
    intervalMs: UPDATE_INTERVAL_MS,
    now: Date.now,
    fetchLatest: () => fetchLatestMac(),
    activeJobs: () => [...opts.boards.values()].reduce((n, b) => n + b.jobActive().length, 0),
    stage: (release) => stageMacRelease({ release, opsHome: opts.opsHome, app }),
    apply: async (staged) => spawnApplyHelper({ app, staged, opsHome: opts.opsHome, runDir: opts.runDir }),
    log: (line) => opts.log(`update: ${line}`)
  });
}

/** Where a board's token is, for the session half. */
export function readBoardToken(runDir: string, slug: string): string {
  try {
    return fs.readFileSync(path.join(opsRunPaths(runDir).tokensDir, `${slug}.token`), 'utf-8').trim();
  } catch {
    return '';
  }
}
