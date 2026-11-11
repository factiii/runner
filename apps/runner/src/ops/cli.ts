import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Command } from 'commander';

import { listConfiguredSlugs } from '../agent-adapter';
import { CONFIG_DIR, safeSlug } from '../paths';
import { appServeProgram, registerOpsDesktopCommands } from './cliDesktop';
import { runOpsServe } from './serve';
import {
  MACHINE_SERVERS,
  NORMAL_USER_SERVICES,
  renderSystemdUnit,
  serverLabel,
  serverPlists
} from './servers';
import { linuxSetupScript, type MacMigration, macSetupScript } from './setup';
import { linuxTeardownScript, macTeardownScript } from './teardown';
import { defaultOpsHome, defaultRunDir, OPS_USER, writeOpsSettings } from './settings';
import { printOpsStatus, opsStatusReport } from './status';
import { verifyMacApp } from './updateVerify';

// `factiii-runner ops ...` (.specs/ops-user.md): the owner's controls for the
// ops user. Nothing here creates a user, installs a daemon or uses sudo: the
// setup script is printed for the person to read and run.

/** argv of `ops serve` as the LaunchDaemon runs it: this node and this CLI.
 *  Factiii Desktop replaces it with Electron's Node from /Applications. */
function serveProgram(opsHome: string, runDir: string): string[] {
  return [process.execPath, path.resolve(process.argv[1] ?? 'factiii-runner'), 'ops', 'serve', '--home', opsHome, '--run', runDir];
}

export function registerOpsCommands(program: Command): void {
  const ops = program
    .command('ops')
    .description('The ops user: secrets, jobs and Factiii servers under factiii-ops (off by default)');

  ops
    .command('status')
    .description('The setting, the socket, and whether the ops service answers for each board')
    .option('--json', 'print it as JSON (Factiii Desktop reads this)')
    .action(async (opts: { json?: boolean }) => {
      const report = await opsStatusReport({ configDir: CONFIG_DIR, slugs: listConfiguredSlugs().map(safeSlug) });
      if (opts.json) process.stdout.write(`${JSON.stringify(report)}\n`);
      else printOpsStatus(report);
    });

  for (const [name, enabled] of [
    ['on', true],
    ['off', false]
  ] as const) {
    ops
      .command(name)
      .description(`Turn the ops user ${name} for this runner (takes effect at the next start)`)
      .option('--run <dir>', 'the ops run dir', defaultRunDir())
      .action((opts: { run: string }) => {
        writeOpsSettings(CONFIG_DIR, { enabled, runDir: opts.run });
        console.log(`Ops user ${name}. Restart the runner: launchctl kickstart -k gui/$(id -u)/com.factiii.runner`);
      });
  }

  ops
    .command('serve')
    .description('Serve the ops socket (run by the com.factiii.ops daemon as factiii-ops)')
    .option('--home <dir>', 'the ops home', defaultOpsHome())
    .option('--run <dir>', 'the ops run dir', defaultRunDir())
    .action(async (opts: { home: string; run: string }) => {
      if (os.userInfo().username !== OPS_USER) {
        console.error(`ops serve runs as ${OPS_USER} only (the LaunchDaemon starts it).`);
        process.exit(1);
      }
      const served = await runOpsServe({ opsHome: opts.home, runDir: opts.run });
      const stop = () => void served.close().then(() => process.exit(0));
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    });

  ops
    .command('servers')
    .description('The machine services the ops user runs on this host, and what each needs')
    .action(() => {
      for (const s of MACHINE_SERVERS) {
        console.log(`${serverLabel(s.id)}  ${s.description}`);
        for (const c of s.credentials) console.log(`    needs ${c.name}: ${c.what} (today: ${c.today})`);
        if (s.notes) console.log(`    note: ${s.notes}`);
      }
      console.log('\nStay with the normal user:');
      for (const s of NORMAL_USER_SERVICES) console.log(`  ${s.name}: ${s.why}`);
    });

  ops
    .command('plists <dir>')
    .description('Write the LaunchDaemon plists and systemd units into <dir> (installs nothing)')
    .option('--home <dir>', 'the ops home', defaultOpsHome())
    .action((dir: string, opts: { home: string }) => {
      fs.mkdirSync(dir, { recursive: true });
      for (const { file, content } of serverPlists(opts.home)) {
        fs.writeFileSync(path.join(dir, file), content);
      }
      for (const s of MACHINE_SERVERS) {
        fs.writeFileSync(path.join(dir, `factiii-ops-${s.id}.service`), renderSystemdUnit(s, opts.home));
      }
      console.log(`Wrote ${MACHINE_SERVERS.length} plists and units to ${dir}. Nothing was installed.`);
    });

  ops
    .command('setup-script')
    .description('Print the setup / repair script for the one admin prompt')
    .option('--home <dir>', 'the ops home', defaultOpsHome())
    .option('--run <dir>', 'the ops run dir', defaultRunDir())
    .option('--user <name>', 'the normal user, who joins group factiii', os.userInfo().username)
    .option('--app <path>', "macOS: run the service on this app's Electron and runner, and give the app to the ops user")
    .option('--stage <dir>', 'macOS: install what `ops stage` wrote and copy each board store (the migration)')
    .option('--account <name>', "macOS: also make the runner's own standard account, which joins group factiii in place of --user")
    .action((opts: { home: string; run: string; user: string; app?: string; stage?: string; account?: string }) => {
      if (process.platform === 'linux') {
        const program = serveProgram(opts.home, opts.run);
        process.stdout.write(linuxSetupScript({ user: opts.user, opsHome: opts.home, serveProgram: program }));
        return;
      }
      const fromApp = opts.app ? appServeProgram(path.resolve(opts.app), opts.home, opts.run) : null;
      let migrate: MacMigration | undefined;
      if (opts.stage) {
        const stage = path.resolve(opts.stage);
        const config = fs.readFileSync(path.join(stage, 'ops-config.json'), 'utf-8');
        const boards = (JSON.parse(config) as { boards: { slug: string }[] }).boards.map((b) => b.slug);
        migrate = {
          config,
          stageDir: stage,
          runnerDir: CONFIG_DIR,
          boards,
          app: opts.app ? path.resolve(opts.app) : undefined
        };
      }
      const account = opts.account ? { name: opts.account, fullName: 'Factiii' } : undefined;
      process.stdout.write(
        macSetupScript({
          user: account?.name ?? opts.user,
          account,
          opsHome: opts.home,
          runDir: opts.run,
          serveProgram: fromApp?.program ?? serveProgram(opts.home, opts.run),
          serveEnv: fromApp?.env,
          migrate
        })
      );
    });

  ops
    .command('teardown-script')
    .description('Print the teardown script for the one admin prompt: undoes setup (a nuke)')
    .option('--home <dir>', 'the ops home', defaultOpsHome())
    .option('--run <dir>', 'the ops run dir', defaultRunDir())
    .option('--user <name>', 'the normal user, who leaves group factiii', os.userInfo().username)
    .option('--app <path>', 'macOS: give this app bundle back to the user')
    .action((opts: { home: string; run: string; user: string; app?: string }) => {
      const args = { user: opts.user, opsHome: opts.home, runDir: opts.run };
      process.stdout.write(
        process.platform === 'linux'
          ? linuxTeardownScript(args)
          : macTeardownScript({ ...args, app: opts.app ? path.resolve(opts.app) : undefined })
      );
    });

  ops
    .command('verify-update <app>')
    .description('Run the update checks on a macOS app bundle (signature, team, notarization)')
    .requiredOption('--team <id>', 'the Apple team id the release must be signed by')
    .action(async (app: string, opts: { team: string }) => {
      const verdict = await verifyMacApp(app, { teamId: opts.team });
      console.log(verdict.ok ? 'OK: signed by the team and notarized.' : `REFUSED: ${verdict.reason}`);
      process.exit(verdict.ok ? 0 : 1);
    });

  registerOpsDesktopCommands(ops);
}
