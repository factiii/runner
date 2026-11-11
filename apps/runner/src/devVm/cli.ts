import { spawnSync } from 'node:child_process';

import type { Command } from 'commander';

import { agentHomes } from '@shared/all/helpers/board-agent-core/agent-homes';

import { CONFIG_DIR } from '../paths';
import { promptPassword } from '../promptPassword';
import { colimaStartArgv } from './devVm';
import { provisionScript } from './guest';
import { buildDevVm, devVmSpaces } from './index';
import {
  type DevVmSettings,
  readClaudeVmToken,
  readDevVmSettings,
  writeClaudeVmToken,
  writeDevVmSettings
} from './settings';
import { shJoin } from './ssh';

// `factiii-runner devvm ...` (.specs/dev-vm.md): the owner's controls for the
// dev VM. Everything that starts, stops, rebuilds or turns the VM on is here,
// run by a person, never by the daemon on its own.

const DEFAULT_SIZE = { cpus: 6, memoryGiB: 16, diskGiB: 100 };

function settingsFor(profile?: string): DevVmSettings {
  const current = readDevVmSettings(CONFIG_DIR);
  return profile ? { ...current, profile } : current;
}

function startArgv(settings: DevVmSettings): string[] {
  return colimaStartArgv(
    settings.profile,
    devVmSpaces().map((s) => s.spaceDir),
    DEFAULT_SIZE,
    // The default profile is the docker context everyone uses; a second one
    // must not take it over.
    { activate: settings.profile === 'default' }
  );
}

function run(argv: string[]): number {
  console.log(`$ ${shJoin(argv)}`);
  const res = spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit' });
  return res.status ?? 1;
}

async function provision(settings: DevVmSettings): Promise<number> {
  const vm = buildDevVm(settings);
  const homes = agentHomes();
  const script = provisionScript({
    runnerDir: CONFIG_DIR,
    spaceDirs: devVmSpaces().map((s) => s.spaceDir),
    claudeHome: homes.claude,
    codexHome: homes.codex
  });
  console.log(`Provisioning the dev VM (Colima profile "${settings.profile}")...`);
  const res = await vm.exec('admin', 'sudo -n bash -s', script);
  process.stdout.write(res.stdout);
  process.stderr.write(res.stderr);
  return res.code;
}

export function registerDevVmCommands(program: Command): void {
  const devvm = program
    .command('devvm')
    .description('The dev VM: where sessions run when it is on (Mac only, off by default)');

  devvm
    .command('status')
    .description('Whether the dev VM is on, and whether sessions can start in it')
    .option('--profile <name>', 'Colima profile (default: the setting)')
    .action(async (opts: { profile?: string }) => {
      const settings = settingsFor(opts.profile);
      console.log(`Setting: ${settings.enabled ? 'ON' : 'off'} (profile "${settings.profile}")`);
      console.log(`Claude token stored: ${readClaudeVmToken(CONFIG_DIR) ? 'yes' : 'no'}`);
      const vm = buildDevVm(settings);
      const res = await vm.exec('session', 'cat /proc/sys/kernel/random/boot_id');
      console.log(
        res.code === 0
          ? `VM reachable as the session user (boot ${res.stdout.trim()})`
          : `VM not reachable as the session user: ${res.stderr.trim() || `exit ${res.code}`}`
      );
    });

  devvm
    .command('on')
    .description('Run sessions in the dev VM from the next runner start')
    .option('--profile <name>', 'Colima profile', 'default')
    .action((opts: { profile: string }) => {
      writeDevVmSettings(CONFIG_DIR, { enabled: true, profile: opts.profile });
      console.log(`Dev VM on (profile "${opts.profile}"). Restart the runner for it to take effect.`);
    });

  devvm
    .command('off')
    .description('Run sessions on this Mac again, from the next runner start')
    .action(() => {
      writeDevVmSettings(CONFIG_DIR, { ...readDevVmSettings(CONFIG_DIR), enabled: false });
      console.log('Dev VM off. Restart the runner for it to take effect.');
    });

  devvm
    .command('mounts')
    .description('Print the colima start command with this runner’s mounts (and no home mount)')
    .option('--profile <name>', 'Colima profile (default: the setting)')
    .action((opts: { profile?: string }) => {
      console.log(shJoin(startArgv(settingsFor(opts.profile))));
    });

  devvm
    .command('provision')
    .description('Install the session user, CLIs, wrappers and firewall in the VM')
    .option('--profile <name>', 'Colima profile (default: the setting)')
    .action(async (opts: { profile?: string }) => {
      process.exitCode = await provision(settingsFor(opts.profile));
    });

  devvm
    .command('rebuild')
    .description('Delete the dev VM and build it again from a clean image (asks first)')
    .option('--profile <name>', 'Colima profile (default: the setting)')
    .option('--yes', 'Do not ask')
    .action(async (opts: { profile?: string; yes?: boolean }) => {
      const settings = settingsFor(opts.profile);
      const del = ['colima', 'delete', settings.profile, '--force'];
      const start = startArgv(settings);
      console.log('This deletes the VM (its disk, its containers and dev databases) and builds it again:');
      console.log(`  ${shJoin(del)}\n  ${shJoin(start)}\n  factiii-runner devvm provision`);
      if (!opts.yes) {
        const answer = await promptPassword(`Type the profile name (${settings.profile}) to go ahead: `);
        if (answer.trim() !== settings.profile) {
          console.log('Not rebuilt.');
          return;
        }
      }
      if (run(del) !== 0 || run(start) !== 0) {
        process.exitCode = 1;
        return;
      }
      process.exitCode = await provision(settings);
      if (process.exitCode === 0) {
        console.log('Rebuilt. Restart the runner so it sets the VM up for its sessions.');
      }
    });

  devvm
    .command('claude-token')
    .description('Store the `claude setup-token` token the VM’s sessions use (read from stdin or asked for)')
    .action(async () => {
      const piped = !process.stdin.isTTY;
      const token = piped
        ? await new Promise<string>((resolve) => {
            let text = '';
            process.stdin.on('data', (d) => (text += d));
            process.stdin.on('end', () => resolve(text));
          })
        : await promptPassword('claude setup-token token: ');
      if (!token.trim()) {
        console.error('No token given; nothing saved.');
        process.exitCode = 1;
        return;
      }
      writeClaudeVmToken(CONFIG_DIR, token);
      console.log('Saved, keychain-encrypted. Sessions get it from their next start.');
    });

  devvm
    .command('isolation-test')
    .description('In the VM, as the session user, try every way out to this Mac; all must fail')
    .option('--profile <name>', 'Colima profile (default: the setting)')
    .action(async (opts: { profile?: string }) => {
      const result = await buildDevVm(settingsFor(opts.profile)).isolationTest();
      process.stdout.write(result.output);
      process.exitCode = result.code;
    });
}
