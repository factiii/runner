import fs from 'node:fs';
import path from 'node:path';

import { BOARD_SLUG } from './protocol';
import type { OpsConfig } from './serve';

// What the normal user prepares before the one admin prompt
// (.specs/ops-user.md, "Setup and repair"): the files the privileged script
// installs into the ops home, and a backup of every board's store. Run as
// the normal user (`factiii-runner ops stage`), because the board settings
// are sealed under this user's keychain key, which root cannot open.
//
// The stage dir is 0700 and is removed by the privileged script once it has
// copied it. Nothing here needs a password or reads a secret value: the
// GitHub token comes from the board's own connection, and the store is
// copied as the ciphertext it already is.

export type StageBoard = {
  slug: string;
  repoUrl: string;
  mainBranch: string;
  githubToken: string;
};

/** What `ops stage --json` prints, and Desktop reads. No token in it. */
export type StageReport = {
  stageDir: string;
  backupDir: string | null;
  boards: { slug: string; hasStore: boolean; hasGithubToken: boolean; repoUrl: string }[];
  skipped: { slug: string; reason: string }[];
};

/** The store files of a board in the runner dir, as the migration copies
 *  them (spec "Migration", step 2). `secrets/` holds the age key, the sops
 *  files, the inbox and `secrets.meta.json`. */
export const STORE_ENTRIES = ['secrets', 'audit.jsonl'] as const;

/** A board has a store when its age key is there. */
export function hasStore(spaceDir: string): boolean {
  return fs.existsSync(path.join(spaceDir, 'secrets', 'age-identity.enc'));
}

/** ops-config.json as `ops serve` reads it (serve.ts configSchema). */
export function opsConfigFor(uid: number, boards: StageBoard[]): OpsConfig {
  return {
    allowedUids: [uid],
    boards: boards.map((b) => ({ slug: b.slug, repoUrl: b.repoUrl, mainBranch: b.mainBranch || 'main' }))
  };
}

/**
 * Write the stage: `ops-config.json` and `boards/<slug>/github-token`, all
 * 0600 in a 0700 dir. A board without a repo URL cannot have an ops clone,
 * so it is skipped (and said). With `backupDir`, each board's store is copied
 * there first, byte for byte: the ciphertext opens with the board password,
 * so the backup needs none (spec "Rollout", backup first).
 */
export function writeOpsStage(opts: {
  stageDir: string;
  uid: number;
  boards: StageBoard[];
  /** `<runner dir>/<slug>`, where the board's store is today. */
  spaceDir: (slug: string) => string;
  backupDir?: string;
}): StageReport {
  const kept: StageBoard[] = [];
  const skipped: StageReport['skipped'] = [];
  for (const b of opts.boards) {
    if (!BOARD_SLUG.test(b.slug)) skipped.push({ slug: b.slug, reason: 'its name cannot be an ops board name' });
    // A board with no repository moves too, for its secrets: it has no jobs
    // until a Repair after one is connected (opsClone OPS_NO_REPO).
    else kept.push(b);
  }
  fs.rmSync(opts.stageDir, { recursive: true, force: true });
  fs.mkdirSync(opts.stageDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(opts.stageDir, 0o700);
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };
  write(path.join(opts.stageDir, 'ops-config.json'), `${JSON.stringify(opsConfigFor(opts.uid, kept), null, 2)}\n`);
  for (const b of kept) {
    const token = b.githubToken.replace(/\s/g, '');
    if (token) write(path.join(opts.stageDir, 'boards', b.slug, 'github-token'), `${token}\n`);
  }
  let backupDir: string | null = null;
  if (opts.backupDir) {
    backupDir = opts.backupDir;
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(backupDir, 0o700);
    for (const b of kept) {
      const from = opts.spaceDir(b.slug);
      if (!hasStore(from)) continue;
      for (const entry of STORE_ENTRIES) {
        const src = path.join(from, entry);
        if (!fs.existsSync(src)) continue;
        fs.cpSync(src, path.join(backupDir, b.slug, entry), { recursive: true, errorOnExist: false, force: true });
      }
    }
  }
  return {
    stageDir: opts.stageDir,
    backupDir,
    boards: kept.map((b) => ({
      slug: b.slug,
      hasStore: hasStore(opts.spaceDir(b.slug)),
      hasGithubToken: b.githubToken.trim() !== '',
      repoUrl: b.repoUrl
    })),
    skipped
  };
}

/** After a job on the ops half succeeded: the normal user's copies of each
 *  board's store go (spec "Migration", step 5). Only the store entries, and
 *  only of boards the ops half serves. */
export function removeOldStores(opts: { slugs: string[]; spaceDir: (slug: string) => string }): string[] {
  const removed: string[] = [];
  for (const slug of opts.slugs) {
    if (!BOARD_SLUG.test(slug)) continue;
    for (const entry of STORE_ENTRIES) {
      const target = path.join(opts.spaceDir(slug), entry);
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
  }
  return removed;
}
