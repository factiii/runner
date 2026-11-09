import dns from 'node:dns';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Command } from 'commander';

import { applyAgentHomes } from '@shared/all/helpers/board-agent-core/agent-homes';
import { addToolDirs } from '@shared/all/helpers/board-agent-core/host-env';
import { runnerIdFromRunnerToken } from '@shared/all/helpers/board-agent-core/runner-access';
import {
  exportSecretsBackup,
  restoreSecretsBackup
} from '@shared/all/helpers/board-agent-core/secrets-backup';

import { credentialStoreStatus, listConfiguredSlugs } from './agent-adapter';
import { describeBoard } from './boardRegistry';
import { pairWithBrowser } from './auth';
import { configExists, readRunnerConfig, writeRunnerConfig } from './config';
import {
  doctor,
  installThisService,
  printAlwaysOnNotes,
  serviceIo,
  serviceSpec
} from './machine';
import { registerMigrateCommands } from './migrate';
import { registerNukeCommand } from './nukeCli';
import { registerPartsCommands } from './partsCli';
import { CONFIG_DIR, safeSlug, spaceDirPath } from './paths';
import { promptPassword } from './promptPassword';
import { registerRemoteCommands } from './remote';
import { convertVaultFilesAndReport } from './secureActions';
import { passwordEnabled, SecureStoreError, unlock } from './secureStore';
import { setup, setupTools } from './setup';
import { currentVersion } from './selfUpdate';
import {
  heartbeatUrl,
  readStatusPage,
  sendBeat,
  writeStatusPage
} from './statusPage';
import {
  removeService,
  SECRETS_AFTER_RESTART,
  type ServiceSpec,
  serviceStatus
} from './service';
import { runSupervised } from './supervisor';

/** Print a failure with its remedy, then exit non-zero. */
function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n${message}`);
  if (err instanceof SecureStoreError && err.fix) console.error(`\n${err.fix}`);
  console.error('');
  process.exit(1);
}

// Node 25+ used to abort startup here. It must not: refusing to boot turned
// a survivable degradation into a dead runner — an approved self-update
// relaunched into the check and pm2 restarted the corpse 101,882 times, with
// cards, terminals, deploys and secrets all working fine underneath. The one
// part bound to a Node version was the runner OneDrive index (it compiled
// better-sqlite3 from source); it was removed, and with it the warning that
// replaced the check. Nothing here is bound to a Node version now.

// Prefer IPv4 for all outbound requests. Many runner hosts (Tailscale, etc.)
// advertise IPv6 routes that black-hole to Microsoft/Graph, making Node's
// IPv6-first fetch throw "fetch failed" intermittently. Runs at module load,
// before program.parse() makes any request.
dns.setDefaultResultOrder('ipv4first');

// The runner's own Claude Code and Codex homes (agent-homes.ts), before any
// command can spawn a CLI, a tmux server or the supervised daemon: every one
// of them inherits this env, so the factiii plugin and the sign-ins live in
// the runner's homes and never in the person's own ~/.claude and ~/.codex.
// A value already set in this env is overridden on purpose (see there).
applyAgentHomes();

// Homebrew's dirs (and Factiii Desktop's tools folder) on this process's own
// PATH, behind what is there, for the few spawns that read it rather than a
// login shell's (host-env.ts toolDirs). A Mac whose Homebrew is on no PATH
// crash-looped on a missing redis-cli on 2026-10-25.
addToolDirs();

const program = new Command();

program
  .name('factiii-runner')
  .description('Factiii Runner - run Board AI agents on remote servers')
  .version(currentVersion());

program
  .command('setup')
  .description('Pair this runner; --tools installs the host toolchain instead')
  .option('-s, --server <url>', 'API server URL', 'https://api.factiii.com')
  .option('--tools', 'Install the host toolchain from this terminal')
  .action(async (opts: { server: string; tools?: boolean }) => {
    try {
      if (opts.tools) await setupTools();
      else await setup(opts.server);
    } catch (err) {
      console.error(
        'Setup failed:',
        err instanceof Error ? err.message : err
      );
      process.exit(1);
    }
  });

program
  .command('connect')
  .description('Pair this runner with a Factiii account via browser approval')
  .option('-s, --server <url>', 'API server URL', 'https://api.factiii.com')
  .action(async (opts: { server: string }) => {
    try {
      const { token, refreshToken, runnerName } = await pairWithBrowser(
        opts.server
      );
      writeRunnerConfig({
        serverUrl: opts.server,
        authToken: token,
        runnerName,
        ...(refreshToken ? { refreshToken } : {})
      });
      console.log(`\nConnected. Config saved to ${CONFIG_DIR}/config.json`);
      console.log('Run "factiii-runner start" to begin accepting jobs.\n');
    } catch (err) {
      console.error(
        'Connect failed:',
        err instanceof Error ? err.message : err
      );
      process.exit(1);
    }
  });

program
  .command('start')
  .description('Start the runner daemon')
  .action(async () => {
    if (!configExists()) {
      console.error('No config found. Run "factiii-runner setup" first.');
      process.exit(1);
    }

    // runSupervised launches the daemon under a thin supervisor that can
    // relaunch it after an approved self-update. It reads the config itself
    // in worker mode.
    await runSupervised(process.argv.slice(1));
  });

program
  .command('set-server')
  .description(
    'Repoint this runner at a different API server URL, keeping its pairing ' +
      '(only valid when the new URL reaches the SAME server, e.g. a tunnel vs localhost).'
  )
  .argument('<url>', 'API server URL, e.g. http://localhost:5001')
  .action((url: string) => {
    const config = readRunnerConfig();
    if (!config) {
      console.error('No config found. Run "factiii-runner connect" first.');
      process.exit(1);
    }
    writeRunnerConfig({ ...config, serverUrl: url });
    console.log(`\nServer set to ${url}. Restart the runner to apply.\n`);
  });

program
  .command('status')
  .description('Show current runner configuration')
  .action(() => {
    const store = credentialStoreStatus();
    console.log(
      `Storage: ${store.ready ? `encrypted (${store.keyStore})` : 'UNAVAILABLE'}`
    );
    if (!store.ready) {
      console.log(`\n  ${store.problem}\n`);
      if (store.fix) console.log(`${store.fix}\n`);
    }

    if (!configExists()) {
      console.log('Not configured. Run "factiii-runner setup" first.');
      return;
    }

    const config = readRunnerConfig();
    if (!config) {
      console.log('Failed to read config.');
      return;
    }

    console.log(`Server:  ${config.serverUrl}`);
    console.log(`Runner:  ${config.runnerName}`);
    // Read by Factiii Desktop (server-mode.ts runnerState), which cannot open
    // the keychain-wrapped config itself: keep the label as it is.
    const runnerId = runnerIdFromRunnerToken(config.authToken);
    if (runnerId !== null) console.log(`Runner id: ${runnerId}`);
    console.log(`Token:   ····${config.authToken.slice(-4)}`);
    // Each board by its space's name (spaces.json), its slug beside it: the
    // slug is what a command takes and what its folder is called.
    const boards = listConfiguredSlugs();
    if (boards.length) {
      console.log(`Boards:  ${boards.map((slug) => describeBoard(CONFIG_DIR, slug)).join(', ')}`);
    }
  });

program
  .command('doctor')
  .description(
    'Check what this machine needs, and fix what the runner may fix'
  )
  .option('--no-fix', 'report only: ask nothing, change nothing')
  .option('--json', 'print the report as JSON (asks nothing)')
  .action(async (opts: { fix: boolean; json?: boolean }) => {
    try {
      // Non-zero while a required item is unmet, so a script can gate on it.
      process.exit(await doctor(opts));
    } catch (err) {
      fail(err);
    }
  });

/** The service this runner would install, or exit saying why there is none. */
function requireServiceSpec(): ServiceSpec {
  const spec = serviceSpec();
  if (spec) return spec;
  console.error(
    'The service needs the installed package (curl -fsSL https://factiii.com/runner.sh | sh) on macOS, Linux or Windows.'
  );
  process.exit(1);
}

// What this runner does beyond the connector (parts.ts).
registerPartsCommands(program);

// Erase the whole runner, secrets included, behind a typed phrase (nuke.ts).
registerNukeCommand(program);

// Heartbeats to a status page outside Factiii (statusPage.ts).
const statusPage = program
  .command('status-page')
  .description(
    'Send heartbeats to status.factiii.com (or your own), which watches Factiii from outside it'
  );

statusPage
  .command('set <url>')
  .description(
    'Turn heartbeats on. The token is read from FACTIII_STATUS_TOKEN, or asked for.'
  )
  .action(async (url: string) => {
    try {
      heartbeatUrl(url);
      const token =
        process.env.FACTIII_STATUS_TOKEN?.trim() ||
        (await promptPassword('Status page heartbeat token: ')).trim();
      if (!token) throw new Error('A token is needed.');
      const config = readRunnerConfig();
      const status = await sendBeat(
        { url, token },
        { runner: config?.runnerName ?? 'runner', version: currentVersion(), level: 'ok' }
      );
      if (status !== 200) {
        throw new Error(`${url} answered ${status}: check the token. Nothing saved.`);
      }
      writeStatusPage({ url, token });
      console.log(`Heartbeats on: this runner now shows on ${url}, every 2 minutes.`);
    } catch (err) {
      fail(err);
    }
  });

statusPage
  .command('off')
  .description('Stop sending heartbeats')
  .action(() => {
    writeStatusPage(null);
    console.log('Heartbeats off. The status page will show this runner as down after 6 minutes.');
  });

statusPage
  .command('show')
  .description('Where heartbeats go, if anywhere')
  .action(() => {
    const config = readStatusPage();
    console.log(config ? `Heartbeats go to ${config.url}.` : 'Heartbeats are off.');
  });

// Start at login and restart after a crash, under the operating system's own
// service manager (service.ts).
const service = program
  .command('service')
  .description('Keep this runner running: start at login, restart after a crash');

service
  .command('install')
  .description('Install the service for the current user, and start it')
  .action(async () => {
    try {
      const spec = requireServiceSpec();
      if (!configExists()) {
        console.error('No config found. Run "factiii-runner setup" first.');
        process.exit(1);
      }
      const outcome = await installThisService(spec);
      for (const line of outcome.lines) console.log(line);
      if (!outcome.ok) process.exit(1);
      printAlwaysOnNotes(spec);
      console.log(`\n${SECRETS_AFTER_RESTART}\n`);
    } catch (err) {
      fail(err);
    }
  });

service
  .command('status')
  .description('Show whether the service is installed and running')
  .action(async () => {
    try {
      const status = await serviceStatus(requireServiceSpec(), serviceIo);
      const installed = {
        yes: `yes (${status.file})`,
        no: 'no',
        foreign: `no: ${status.file} was not written by the runner`
      }[status.installed];
      console.log(`Service:   ${status.name}`);
      console.log(`Installed: ${installed}`);
      console.log(`Loaded:    ${status.loaded ? 'yes' : 'no'}`);
      console.log(
        `Running:   ${status.running ? `yes${status.pid ? ` (pid ${status.pid})` : ''}` : 'no'}`
      );
      if (status.command) console.log(`Runs:      ${status.command}`);
      console.log(`Log:       ${status.log}`);
    } catch (err) {
      fail(err);
    }
  });

service
  .command('remove')
  .description('Stop the service and delete what "service install" wrote')
  .action(async () => {
    try {
      const outcome = await removeService(requireServiceSpec(), serviceIo);
      for (const line of outcome.lines) console.log(line);
      if (!outcome.ok) process.exit(1);
    } catch (err) {
      fail(err);
    }
  });

// The connection password can no longer be set or changed; this command is
// what is left of it. It does the one unlock an updated runner needs, for a
// host with no TTY at `start` and no app to hand: the files are rewritten on
// disk under the keychain key, so the running daemon reads them without a
// restart, and the vault is retired.

program
  .command('password')
  .description(
    'Enter the old connection password once, to release connections it still locks and remove it'
  )
  .action(async () => {
    try {
      // Without a password this needs nothing typed.
      convertVaultFilesAndReport();
      if (!passwordEnabled()) {
        console.log(
          '\nThis runner has no connection password. GitHub connections no longer need one.\n'
        );
        return;
      }
      unlock(await promptPassword('Connection password: '));
      convertVaultFilesAndReport();
      const status = credentialStoreStatus();
      console.log(
        status.passwordEnabled
          ? '\nUnlocked, but the password is still needed by the files listed above.\n'
          : '\nDone. The connection password is removed and will not be asked for again.\n'
      );
    } catch (err) {
      fail(err);
    }
  });

// An offline backup of one board's secrets, made and restored on the runner's
// own machine: being able to run this at all is being the owner. The file is
// the board's secrets, read out of its store with the board password and
// sealed under a passphrase asked for here (secrets-backup.ts). The
// passphrase alone opens it.
const backup = program
  .command('backup')
  .description("Back up or restore one board's secrets, on this machine");

backup
  .command('export <board>')
  .description('Write an encrypted backup of the board\'s secrets to a file')
  .option('-o, --out <file>', 'where to write it (default: the current folder)')
  .action(async (board: string, opts: { out?: string }) => {
    try {
      const password = await promptPassword(`${describeBoard(CONFIG_DIR, board)} board password: `);
      const passphrase = await promptPassword('New backup passphrase: ');
      const again = await promptPassword('Backup passphrase again: ');
      if (!password || !passphrase) {
        throw new Error('A backup needs a terminal to type the passwords into.');
      }
      if (passphrase !== again) throw new Error('The passphrases differ.');
      const bundle = await exportSecretsBackup({
        spaceDir: spaceDirPath(board),
        board: safeSlug(board),
        password,
        passphrase
      });
      const file = path.resolve(
        opts.out ??
          `${safeSlug(board)}-secrets-${new Date().toISOString().slice(0, 10)}.factiii-backup`
      );
      // `wx`: never over a file that is already there.
      await fs.writeFile(file, bundle, { mode: 0o600, flag: 'wx' });
      console.log(
        `\nBackup written to ${file}\nKeep it and its passphrase apart: together they open every secret in it.\n`
      );
    } catch (err) {
      fail(err);
    }
  });

backup
  .command('restore <board> <file>')
  .description('Restore a backup into a board that has no secrets')
  .action(async (board: string, file: string) => {
    try {
      const bundle = await fs.readFile(path.resolve(file), 'utf-8');
      const passphrase = await promptPassword('Backup passphrase: ');
      // The board gets a new store, under a password chosen now.
      const password = await promptPassword(`New ${describeBoard(CONFIG_DIR, board)} board password: `);
      const again = await promptPassword('Board password again: ');
      if (!passphrase || !password) {
        throw new Error('A restore needs a terminal to type the passwords into.');
      }
      if (password !== again) throw new Error('The passwords differ.');
      const res = await restoreSecretsBackup({
        spaceDir: spaceDirPath(board),
        bundle,
        passphrase,
        password
      });
      console.log(
        `\nRestored ${res.secrets.length} keys and ${res.files.length} files from the ${res.board} backup of ${res.createdAt.slice(0, 10)}.\nThe board unlocks with the password you just set.\n`
      );
    } catch (err) {
      fail(err);
    }
  });

// Moving this runner to a new machine (migrate.ts).
registerMigrateCommands(program);

// Laptop CLI for a shared runner: login/logout, job, secret set, audit.
registerRemoteCommands(program);

program.parse(process.argv);
