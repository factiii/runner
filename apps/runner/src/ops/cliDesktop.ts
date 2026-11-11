import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Command } from 'commander';

import { listConfiguredSlugs, localConfigProvider } from '../agent-adapter';
import { CONFIG_DIR, safeSlug, spaceDirPath } from '../paths';
import { opsClient } from './client';
import { OPS_OPS, type OpsOp } from './protocol';
import { OPS_APP_ENV, readBoardToken } from './serve';
import { opsRunPaths, readOpsSettings } from './settings';
import { removeOldStores, writeOpsStage } from './stage';
import { opsStatusReport } from './status';
import { applyMacUpdate } from './updaterMac';

// The `ops` commands Factiii Desktop's "Set up this computer" and its ops
// panel drive (.specs/ops-user.md, "Factiii Desktop"). Each answers JSON on
// stdout, so Desktop reads results, never scrapes text. None of them uses
// sudo: the one privileged step is Desktop's admin prompt.

/** The ops the panel may send through `ops call`: the store-local actions,
 *  the updater, and the prompt answered straight to the ops half. */
export const PANEL_OPS: ReadonlySet<OpsOp> = new Set<OpsOp>([
  'store-set',
  'store-unset',
  'store-set-file',
  'store-unset-file',
  'store-change-password',
  'backup-export',
  'backup-import',
  'update-state',
  'update-now',
  'gate-state',
  'gate-answer',
  'key-names',
  'inbox-list'
]);

/** Who the panel acts as in the ops audit log. */
const PANEL_ACTOR = { userId: 'owner', name: 'This computer (Factiii Desktop)' };

const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
      text += chunk;
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}

/** The daemon's argv and env for an app bundle: the app's own Electron as
 *  Node, the runner it carries (Contents/Resources/runner). */
export function appServeProgram(
  app: string,
  opsHome: string,
  runDir: string
): { program: string[]; env: Record<string, string> } {
  const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf-8');
  const exe = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (!exe) throw new Error(`${app} has no CFBundleExecutable.`);
  const entry = path.join(app, 'Contents', 'Resources', 'runner', 'dist', 'cli.js');
  if (!fs.existsSync(entry)) throw new Error(`${app} carries no runner (${entry}).`);
  return {
    program: [path.join(app, 'Contents', 'MacOS', exe), entry, 'ops', 'serve', '--home', opsHome, '--run', runDir],
    env: { ELECTRON_RUN_AS_NODE: '1', FACTIII_BUNDLED_RUNNER: '1', [OPS_APP_ENV]: app }
  };
}

export function registerOpsDesktopCommands(ops: Command): void {
  ops
    .command('stage <dir>')
    .description('Write ops-config.json and the GitHub tokens for the setup script, and back up each store')
    .option('--backup <dir>', 'copy each board store here first')
    .action((dir: string, opts: { backup?: string }) => {
      const boards = listConfiguredSlugs().map((slug) => {
        const config = localConfigProvider.readConfig(slug);
        return {
          slug: safeSlug(slug),
          repoUrl: config.repoUrl,
          mainBranch: config.mainBranch,
          githubToken: config.githubToken
        };
      });
      const uid = os.userInfo().uid;
      json(
        writeOpsStage({
          stageDir: path.resolve(dir),
          uid,
          boards,
          spaceDir: spaceDirPath,
          backupDir: opts.backup ? path.resolve(opts.backup) : undefined
        })
      );
    });

  ops
    .command('remove-old-copies')
    .description("Delete this user's copy of each board store the ops half has run a job with")
    .action(async () => {
      const report = await opsStatusReport({ configDir: CONFIG_DIR, slugs: listConfiguredSlugs().map(safeSlug) });
      if (!report.enabled || !report.healthy) {
        json({ ok: false, error: 'The ops user is not on and answering; the old copies are the only ones that work.' });
        process.exit(1);
      }
      const slugs = report.boards.filter((b) => b.served && b.jobSucceeded).map((b) => b.slug);
      const waiting = report.boards.filter((b) => b.served && !b.jobSucceeded).map((b) => b.slug);
      json({ ok: true, removed: removeOldStores({ slugs, spaceDir: spaceDirPath }), waiting });
    });

  ops
    .command('call <op>')
    .description("Send one ops-panel op (JSON body on stdin) to the ops service; prints the answer")
    .requiredOption('--board <slug>', 'the board')
    .action(async (op: string, opts: { board: string }) => {
      if (!(OPS_OPS as readonly string[]).includes(op) || !PANEL_OPS.has(op as OpsOp)) {
        json({ ok: false, error: `${op} is not an ops-panel op.` });
        process.exit(1);
      }
      let body: Record<string, unknown> = {};
      try {
        const text = (await readStdin()).trim();
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        json({ ok: false, error: 'The request body is not JSON.' });
        process.exit(1);
      }
      const settings = readOpsSettings(CONFIG_DIR);
      const run = opsRunPaths(settings.runDir);
      const board = safeSlug(opts.board);
      try {
        const client = opsClient({
          socketPath: run.socket,
          peerDir: run.peerDir,
          board,
          token: () => readBoardToken(settings.runDir, board)
        });
        const answer = await client.call(op as Exclude<OpsOp, 'job-stream'>, {
          by: PANEL_ACTOR,
          via: 'owner-terminal',
          ...body
        });
        json({ ok: true, answer });
      } catch (err) {
        json({ ok: false, error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      }
    });

  ops
    .command('apply-update')
    .description('Swap in a verified release, restart the ops service, roll back on a failed health check (the updater runs it)')
    .requiredOption('--app <path>', 'the installed app')
    .requiredOption('--staged <path>', 'the verified release')
    .requiredOption('--home <dir>', 'the ops home')
    .requiredOption('--run <dir>', 'the ops run dir')
    .requiredOption('--pid <pid>', 'the ops service to restart')
    .action(async (opts: { app: string; staged: string; home: string; run: string; pid: string }) => {
      const res = await applyMacUpdate({
        app: opts.app,
        staged: opts.staged,
        opsHome: opts.home,
        runDir: opts.run,
        pid: Number(opts.pid),
        log: (line) => console.log(`[update] ${line}`)
      });
      console.log(`[update] ${JSON.stringify(res)}`);
      process.exit(res.ok ? 0 : 1);
    });
}
