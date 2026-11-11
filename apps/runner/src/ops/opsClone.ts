import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { JOBS_PATH, type JobDef, parseJobs } from '@shared/all/helpers/board-agent-core/jobs';

// The checkout a job runs in, with the ops user on (.specs/ops-user.md, "Jobs
// from the ops clone"): `<ops home>/repos/<slug>`, the ops user's own clone,
// fetched and hard-reset to origin/<default> before every job. Cloned fresh,
// never copied from the normal user: a hook or `core.fsmonitor` planted in a
// normal-user `.git` would run as the ops user.

export type GitRun = (
  cwd: string,
  args: string[],
  env: Record<string, string>
) => Promise<string>;

const defaultGit: GitRun = (cwd, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]}: ${String(stderr).trim() || err.message}`));
        else resolve(String(stdout));
      }
    );
  });

const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

/** Git's auth for the fetch, in env (never argv, which other users can
 *  read), plus no prompts and no hooks of the clone's own. */
export function gitAuthEnv(token: string): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null'
  };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '2';
    env.GIT_CONFIG_KEY_1 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_1 = `AUTHORIZATION: basic ${basic}`;
  }
  return env;
}

/** Refuse a job cwd that is not the ops user's own clone: inside
 *  `<ops home>/repos` (real paths, so a symlink cannot point out) and owned
 *  by `uid`. A normal-user path never gets this far. */
export function assertOpsPath(
  dir: string,
  opsHome: string,
  uid: number | undefined = process.getuid?.()
): string {
  let real: string;
  let root: string;
  try {
    real = fs.realpathSync(dir);
    root = fs.realpathSync(path.join(opsHome, 'repos'));
  } catch {
    throw new Error(`Refusing to run a job from ${dir}: not the ops clone.`);
  }
  if (!real.startsWith(root + path.sep)) {
    throw new Error(`Refusing to run a job from ${dir}: not the ops clone.`);
  }
  if (uid !== undefined && fs.statSync(real).uid !== uid) {
    throw new Error(`Refusing to run a job from ${dir}: not owned by the ops user.`);
  }
  return real;
}

export type OpsClone = {
  dir: string;
  /** jobs.json on origin/<default>, freshly fetched. */
  loadJobs(): Promise<JobDef[]>;
  /** One file on origin/<default> as last fetched, or null. */
  readOrigin(file: string): Promise<string | null>;
  /** Fetch, hard-reset to origin/<default>, clean; the checked path. */
  prepare(): Promise<string>;
};

/** A board the ops user holds for its secrets only. */
export const OPS_NO_REPO =
  "This board has no repository with the ops user, so it has no jobs. Connect one in the board's Settings > General, then run Repair This Computer on the runner's Mac.";

export function opsClone(opts: {
  opsHome: string;
  slug: string;
  repoUrl: string;
  branch: string;
  githubToken: () => string;
  git?: GitRun;
  uid?: number;
}): OpsClone {
  if (!BRANCH.test(opts.branch) || opts.branch.startsWith('-')) {
    throw new Error(`"${opts.branch}" is not a branch name.`);
  }
  const git = opts.git ?? defaultGit;
  const repos = path.join(opts.opsHome, 'repos');
  const dir = path.join(repos, opts.slug);
  const ref = `origin/${opts.branch}`;
  // One git operation at a time per clone: a job list's fetch must not land
  // in the middle of a job's reset.
  let lock: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = lock.then(fn, fn);
    lock = next.catch(() => undefined);
    return next;
  };
  const run = (cwd: string, args: string[]) =>
    git(cwd, args, gitAuthEnv(opts.githubToken()));

  const ensure = async () => {
    // A board taken for its secrets alone (serve.ts addBoard, or staged with
    // none): no repository, so no jobs, until Repair connects one.
    if (!opts.repoUrl) throw new Error(OPS_NO_REPO);
    fs.mkdirSync(repos, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(dir, '.git'))) {
      await run(repos, ['clone', '--no-checkout', '--origin', 'origin', '--', opts.repoUrl, dir]);
    }
    await run(dir, [
      'fetch',
      '--prune',
      'origin',
      `+refs/heads/${opts.branch}:refs/remotes/${ref}`
    ]);
  };

  const readOrigin = async (file: string) => {
    try {
      return await run(dir, ['cat-file', '-p', `${ref}:${file}`]);
    } catch {
      return null;
    }
  };

  return {
    dir,
    loadJobs: () =>
      locked(async () => {
        await ensure();
        const raw = await readOrigin(JOBS_PATH);
        return raw === null ? [] : parseJobs(raw);
      }),
    readOrigin: (file) => locked(() => readOrigin(file)),
    prepare: () =>
      locked(async () => {
        await ensure();
        await run(dir, ['checkout', '--detach', '--force', ref]);
        await run(dir, ['reset', '--hard', ref]);
        // Untracked leftovers of the last job go; ignored files
        // (node_modules) stay, so an install is not cold every time.
        await run(dir, ['clean', '-ffd']);
        return assertOpsPath(dir, opts.opsHome, opts.uid);
      })
  };
}
