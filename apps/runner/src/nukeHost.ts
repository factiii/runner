import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RunnerAck } from '@shared/all/domains/socket';
import { hostTarget } from '@shared/all/helpers/board-agent-core/exec';
import { worktreeWorkState } from '@shared/all/helpers/board-agent-core/git';
import { keychainAccount } from '@shared/all/helpers/board-agent-core/runner-dir';
import { LID_GRANT_FILE, lidPmsetArgs, SUDO_BIN } from '@shared/all/helpers/lidGrant';
import { io as connectSocket } from 'socket.io-client';

import { readRunnerConfig } from './config';
import { defaultOpsHome, readOpsSettings } from './ops/settings';
import { appBundleOf, opsTeardownLeftBehind } from './ops/teardown';
import { serviceIo, serviceSpec } from './machine';
import type { NukeHost } from './nuke';
import { removeService, serviceStatus } from './service';

// The machine's half of a nuke (nuke.ts): what lives outside the runner
// folder. The CLI and the daemon each build one; the daemon adds what only
// it holds (its live socket, its engines, keep-awake).

/** A command, no shell. Never throws: a missing binary is a non-zero code. */
export type NukeExec = (bin: string, args: string[]) => Promise<{ code: number; output: string }>;

/** What the server answers to `runner:unpair`. */
type UnpairAck = RunnerAck<{ removed: boolean }>;

/** The handshake refusals that mean the server no longer takes this token
 *  (apps/server/src/clients/socket.ts): the runner is unpaired already. */
const TOKEN_REFUSED = /runner revoked or invalid|invalid runner token/;

const UNPAIR_TIMEOUT_MS = 15_000;

/** Ask the server to unpair: one socket with the runner's token, one
 *  `runner:unpair`, then off. Resolves when the server said yes, or refused
 *  the token itself (already unpaired); rejects when it could not be asked. */
export function unpairOverSocket(
  serverUrl: string,
  token: string,
  connect: typeof connectSocket = connectSocket
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(serverUrl, {
      auth: { runnerToken: token },
      reconnection: false,
      timeout: UNPAIR_TIMEOUT_MS
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(
        new Error(
          `${serverUrl} did not answer the unpair. Nothing was erased. Remove this runner in Factiii's Runner Settings, then run the nuke again.`
        )
      );
    }, UNPAIR_TIMEOUT_MS);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      socket.disconnect();
      fn();
    };
    socket.on('connect_error', (err: Error) => {
      if (TOKEN_REFUSED.test(err.message)) {
        done(() => resolve(['The server no longer takes this runner’s token: already unpaired.']));
      } else {
        done(() =>
          reject(new Error(`Could not reach ${serverUrl} (${err.message}). Nothing was erased.`))
        );
      }
    });
    socket.on('connect', () => {
      socket.emit('runner:unpair', {}, (res: UnpairAck) => {
        if ('error' in res) {
          done(() => reject(new Error(`The server refused the unpair: ${res.error}`)));
        } else {
          done(() => resolve([res.removed ? 'Unpaired and removed from Factiii.' : 'Already unpaired.']));
        }
      });
    });
  });
}

const inside = (dir: string, target: string) =>
  target === dir || target.startsWith(`${dir}${path.sep}`);

/** Every session on the runner's tmux server (tmux.ts, `-L factiii`) whose
 *  folder is in `dir`, its panes' process trees first. The socket is shared
 *  by every runner of this user, so a session of another runner folder is
 *  left alone. */
export async function stopTmuxSessionsIn(dir: string, exec: NukeExec): Promise<string[]> {
  const list = await exec('tmux', [
    '-L',
    'factiii',
    'list-sessions',
    '-F',
    '#{session_name}\t#{session_path}'
  ]);
  if (list.code !== 0) return ['No runner tmux sessions were running.'];
  const names = list.output
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([name, at]) => name && at && inside(dir, path.resolve(at.trim())))
    .map(([name]) => name);
  for (const name of names) {
    const panes = await exec('tmux', ['-L', 'factiii', 'list-panes', '-s', '-t', name, '-F', '#{pane_pid}']);
    for (const pid of panes.output.split('\n').map((p) => p.trim()).filter((p) => /^\d+$/.test(p))) {
      // -P walks children; the pane pid itself dies with the session.
      await exec('pkill', ['-TERM', '-P', pid]);
    }
    await exec('tmux', ['-L', 'factiii', 'kill-session', '-t', name]);
  }
  return [names.length ? `Stopped ${names.length} tmux sessions.` : 'No runner tmux sessions were running.'];
}

/** `security` exits 44 for an absent item. */
const SEC_ITEM_NOT_FOUND = 44;

/** The runner's at-rest key (keychain.ts): service `factiii-runner`, this
 *  runner folder's account. Windows keeps it in the folder (config-key.dpapi),
 *  which the secrets step erases. An absent item is done already. */
export async function eraseRunnerKeychain(opts: {
  platform: NodeJS.Platform;
  account: string;
  exec: NukeExec;
}): Promise<string[]> {
  if (opts.platform === 'darwin') {
    // Delete until none is left: a second item of the same name would
    // otherwise survive the first delete.
    for (let i = 0; i < 5; i += 1) {
      const res = await opts.exec('security', [
        'delete-generic-password',
        '-s',
        'factiii-runner',
        '-a',
        opts.account
      ]);
      if (res.code === SEC_ITEM_NOT_FOUND) {
        return [i ? 'Erased the keychain entry.' : 'No keychain entry was left.'];
      }
      if (res.code !== 0) {
        throw new Error(`The login keychain refused the delete: ${res.output.trim()}`);
      }
    }
    return ['Erased the keychain entries.'];
  }
  if (opts.platform === 'linux') {
    const res = await opts.exec('secret-tool', [
      'clear',
      'service',
      'factiii-runner',
      'account',
      opts.account
    ]);
    // `clear` of an absent item exits 0 or 1 silently.
    if (res.code !== 0 && res.output.trim()) {
      throw new Error(`The keyring refused the delete: ${res.output.trim()}`);
    }
    return ['Erased the keyring entry.'];
  }
  return ['The key is kept in the runner folder here; it goes with the secrets.'];
}

/** The lid-closed grant stays after a nuke: it is root's file
 *  (/etc/sudoers.d/factiii-pmset), and the nuke never asks for an admin
 *  password. Factiii Desktop's Remove takes it away. */
export const LID_GRANT_LEFT_BEHIND = `${LID_GRANT_FILE} (the lid-closed grant) stays: it is root's file. Remove in Factiii Desktop (Lid closed → Remove).`;

type LidGrantIo = {
  platform: NodeJS.Platform;
  /** Whether a file is there; fs.existsSync unless a test plays one. */
  exists?: (file: string) => boolean;
  file?: string;
};

const lidGrantThere = ({ platform, exists = fs.existsSync, file = LID_GRANT_FILE }: LidGrantIo) =>
  platform === 'darwin' && exists(file);

/** What a nuke leaves for the person: the lid-closed grant, when it is there. */
export function lidGrantLeftBehind(io: LidGrantIo): string[] {
  return lidGrantThere(io) ? [LID_GRANT_LEFT_BEHIND] : [];
}

/** Let go of a closed lid before the runner goes: `sudo -n pmset -a
 *  disablesleep 0`, which the grant allows without a password, so the Mac
 *  sleeps with its lid shut again. Only when the grant is there. Never
 *  throws: a refused sudo is a line, and the nuke goes on. */
export async function releaseLidGrant(io: LidGrantIo & { exec: NukeExec }): Promise<string[]> {
  if (!lidGrantThere(io)) return [];
  const res = await io.exec(SUDO_BIN, ['-n', ...lidPmsetArgs(false)]).catch((err: unknown) => ({
    code: 1,
    output: err instanceof Error ? err.message : String(err)
  }));
  return res.code === 0
    ? ['Lid closed is off: the Mac sleeps with its lid shut again.']
    : [
        `Could not turn lid closed off (${res.output.trim() || `exit ${res.code}`}). Run \`sudo pmset -a disablesleep 0\`.`
      ];
}

/** The parts every host shares; `unpair` and `stopWork` are the caller's. */
export function machineNukeHost(opts: {
  dir: string;
  exec: NukeExec;
  unpair: NukeHost['unpair'];
  stopWork: NukeHost['stopWork'];
  /** True when the service runs this very process (the daemon answering
   *  the app): delete it without stopping it, then exit. */
  keepServiceRunning?: () => Promise<boolean>;
}): NukeHost {
  const spec = serviceSpec();
  return {
    pairing() {
      const config = fs.existsSync(path.join(opts.dir, 'config.json')) ? readRunnerConfig() : null;
      return { paired: Boolean(config?.authToken), runnerName: config?.runnerName ?? '' };
    },
    async serviceName() {
      if (!spec) return null;
      const status = await serviceStatus(spec, serviceIo);
      return status.installed === 'yes' ? status.name : null;
    },
    workState: (spaceDir, worktree) => worktreeWorkState(hostTarget(spaceDir), worktree),
    unpair: opts.unpair,
    async removeService() {
      if (!spec) return ['No service: this runner is not the installed package.'];
      const outcome = await removeService(spec, serviceIo, {
        keepRunning: (await opts.keepServiceRunning?.()) ?? false
      });
      if (!outcome.ok) throw new Error(outcome.lines.join(' '));
      return outcome.lines;
    },
    stopWork: opts.stopWork,
    eraseKeychain: () =>
      eraseRunnerKeychain({
        platform: process.platform,
        account: keychainAccount(),
        exec: opts.exec
      }),
    releaseLid: () => releaseLidGrant({ platform: process.platform, exec: opts.exec }),
    leftBehind: async () => [
      ...lidGrantLeftBehind({ platform: process.platform }),
      ...opsLeftBehind(opts.dir)
    ]
  };
}

/** With the ops user on: the root half setup made, for the teardown
 *  (ops/teardown.ts). Off, or off macOS and Linux: nothing. */
function opsLeftBehind(dir: string): string[] {
  const settings = readOpsSettings(dir);
  if (!settings.enabled) return [];
  const desktop = process.env.FACTIII_BUNDLED_RUNNER === '1';
  return opsTeardownLeftBehind({
    platform: process.platform,
    user: os.userInfo().username,
    opsHome: defaultOpsHome(),
    runDir: settings.runDir,
    app: process.platform === 'darwin' ? (appBundleOf(process.execPath) ?? undefined) : undefined,
    desktop
  });
}

/** Unpair with the runner's own config, read from the folder; nothing to do
 *  when it holds no pairing. */
export function unpairFromConfig(connect?: typeof connectSocket): () => Promise<string[]> {
  return async () => {
    const config = readRunnerConfig();
    if (!config?.authToken) return ['Not paired: nothing to unpair.'];
    return unpairOverSocket(config.serverUrl, config.authToken, connect);
  };
}
