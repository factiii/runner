import { execFile, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execExitCode } from '@shared/all/helpers/execExitCode';
import type { AgentHomes } from '@shared/all/helpers/board-agent-core/agent-homes';
import type { ExecTarget } from '@shared/all/helpers/board-agent-core/exec';
import { hostSpacePaths } from '@shared/all/helpers/board-agent-core/spacePaths';

import { bootScript, type GuestLayout, isolationTestScript } from './guest';
import { type NarrowPath, type SimctlRunner, startNarrowPath } from './narrowPath';
import type { DevVmSettings } from './settings';
import {
  masterArgv,
  masterCheckArgv,
  shQuote,
  sshArgv,
  type VmHandle,
  vmHandle,
  type VmUser
} from './ssh';
import { type CodexSyncState, pushSpaceTokens, syncCodexAuth, type VmExec } from './tokens';
import { type Forward, NarrowTunnel } from './tunnel';
import { type SpawnFn, vmTarget } from './vmTarget';

// The dev VM, as the daemon holds it (.specs/dev-vm.md): brings it to the
// state sessions need (boot script, Claude home copy, narrow path, tokens),
// re-does that when the VM restarted, and hands each board an ExecTarget that
// runs in it. It never starts, stops or reconfigures the VM itself: that is
// the owner's (`factiii-runner devvm ...`), so a runner bug cannot take the
// VM, or what else runs in it, down.

export type DevVmSpace = {
  /** The safe slug (paths.ts safeSlug): the token file's name in the VM. */
  slug: string;
  spaceDir: string;
  /** The board's GitHub token now, '' for none: the VM's GH_TOKEN. */
  githubToken: () => string;
  /** The token every session of the space carries (FACTIII_SECRETS_TOKEN):
   *  the only one the narrow path takes. */
  spaceToken: () => string;
};

export type HostExec = (
  bin: string,
  args: string[]
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type DevVmDeps = {
  configDir: string;
  settings: DevVmSettings;
  homes: AgentHomes;
  claudeToken: () => string;
  spaces: () => DevVmSpace[];
  spawn?: SpawnFn;
  hostExec?: HostExec;
  limaHome?: string;
  log?: (line: string) => void;
  now?: () => number;
};

/** How long a good check is trusted before the boot id is read again. */
const CHECK_TTL_MS = 30_000;
/** Tokens are re-pushed on a session start at most this often per board. */
const PUSH_TTL_MS = 60_000;
/** How often the Codex sign-in is compared and copied back. */
const CODEX_SYNC_MS = 5 * 60_000;

/** The Mac paths that are mounted into the VM for one space, and how. */
export function spaceMounts(spaceDir: string): { path: string; writable: boolean }[] {
  const p = hostSpacePaths(spaceDir);
  return [
    { path: p.repo, writable: true },
    { path: p.worktrees, writable: true },
    { path: p.scratchpad, writable: true },
    { path: p.drops, writable: false },
    { path: p.bin, writable: false }
  ];
}

/** `colima start` for the dev VM, as the owner runs it (rollout, rebuild).
 *  Every mount is listed, which is what turns off Colima's default mount of
 *  the whole home; `--ssh-config=false` keeps ~/.ssh/config untouched. */
export function colimaStartArgv(
  profile: string,
  spaceDirs: string[],
  size: { cpus: number; memoryGiB: number; diskGiB: number },
  opts: { activate: boolean }
): string[] {
  const mounts = spaceDirs.flatMap((dir) =>
    spaceMounts(dir).flatMap((m) => ['--mount', m.writable ? `${m.path}:w` : m.path])
  );
  return [
    'colima',
    'start',
    profile,
    '--vm-type',
    'vz',
    '--mount-type',
    'virtiofs',
    '--cpu',
    String(size.cpus),
    '--memory',
    String(size.memoryGiB),
    '--disk',
    String(size.diskGiB),
    '--ssh-config=false',
    `--activate=${opts.activate}`,
    ...mounts
  ];
}

/** Ports listening on this Mac, from `lsof -nP -iTCP -sTCP:LISTEN`. */
export function parseLsofPorts(text: string): number[] {
  const ports = new Set<number>();
  for (const line of text.split('\n')) {
    const match = /:(\d+)\s+\(LISTEN\)/.exec(line);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports].filter((p) => p > 0 && p < 65536).sort((a, b) => a - b);
}

const defaultHostExec: HostExec = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = execExitCode(err);
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** simctl on this Mac, for the narrow path's simulator op. */
export function hostSimctl(hostExec: HostExec): SimctlRunner {
  return async (args) => {
    if (args[0] === 'io' && args[2] === 'screenshot') {
      const file = path.join(os.tmpdir(), `factiii-sim-${process.pid}-${Date.now()}.png`);
      const res = await hostExec('xcrun', ['simctl', ...args, file]);
      const png = await fs.readFile(file).catch(() => undefined);
      await fs.rm(file, { force: true });
      return { code: res.code, output: res.stderr, png };
    }
    const res = await hostExec('xcrun', ['simctl', ...args]);
    return { code: res.code, output: res.stdout + res.stderr };
  };
}

export class DevVm {
  readonly vm: VmHandle;
  private readonly spawnFn: SpawnFn;
  private readonly hostExec: HostExec;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly tunnel: NarrowTunnel;
  private readonly narrow = new Map<string, NarrowPath>();
  private readonly pushedAt = new Map<string, number>();
  private readonly codexState: CodexSyncState = { lastHash: null };
  private bootId: string | null = null;
  private bootedSpaces = 0;
  private checkedAt = 0;
  private pending: Promise<void> | null = null;
  private problem: string | null = null;
  private codexTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DevVmDeps) {
    this.vm = vmHandle(deps.settings.profile, {
      limaHome: deps.limaHome,
      controlDir: path.join(deps.configDir, 'devvm', 'ctl')
    });
    this.spawnFn =
      deps.spawn ??
      ((command, args, opts) => nodeSpawn(command, args, { ...opts, stdio: 'pipe' }));
    this.hostExec = deps.hostExec ?? defaultHostExec;
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? Date.now;
    this.tunnel = new NarrowTunnel(this.vm, this.spawnFn, this.log);
  }

  /** Why sessions cannot start in the VM right now, or null. */
  status(): string | null {
    return this.problem;
  }

  /** A command line in the VM as `user`, `input` on stdin. Admin commands
   *  log in as the Lima user and use sudo themselves. */
  readonly exec: VmExec = (user, command, input) =>
    new Promise((resolve) => {
      const [bin, ...args] = [...sshArgv(this.vm, user), command];
      const proc = this.spawnFn(bin, args, { env: process.env, detached: true });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
      proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
      proc.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + err.message }));
      proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      proc.stdin?.on('error', () => {});
      if (input !== undefined) proc.stdin?.write(input);
      proc.stdin?.end();
    });

  private layout(): GuestLayout {
    return {
      runnerDir: this.deps.configDir,
      spaceDirs: this.deps.spaces().map((s) => s.spaceDir),
      claudeHome: this.deps.homes.claude,
      codexHome: this.deps.homes.codex
    };
  }

  /** The VM is up, isolated, and set up for `slug`. Throws (fail closed)
   *  with the reason otherwise. */
  async ready(slug?: string): Promise<void> {
    const fresh = this.now() - this.checkedAt < CHECK_TTL_MS;
    if (fresh && !this.problem && (!slug || this.narrow.has(slug))) return;
    this.pending ??= this.check().finally(() => {
      this.pending = null;
    });
    await this.pending;
    if (this.problem) throw new Error(this.problem);
    if (slug && !this.narrow.has(slug)) {
      throw new Error(
        `This board is not set up in the dev VM. Run "factiii-runner devvm rebuild" to add its folders, then restart the runner.`
      );
    }
  }

  private async check(): Promise<void> {
    try {
      await this.ensureMasters();
      const boot = await this.exec('session', 'cat /proc/sys/kernel/random/boot_id');
      if (boot.code !== 0) {
        throw new Error(
          `The dev VM (Colima profile "${this.vm.profile}") is not reachable: ${boot.stderr.trim() || `exit ${boot.code}`}. Start it with "colima start ${this.vm.profile}"; sessions do not fall back to this Mac.`
        );
      }
      const id = boot.stdout.trim();
      const spaceCount = this.deps.spaces().length;
      if (id !== this.bootId || spaceCount !== this.bootedSpaces) {
        await this.boot();
        this.bootId = id;
        this.bootedSpaces = spaceCount;
      }
      // The firewall is what keeps the Mac out of reach: never trust that it
      // is there because it was there 30 seconds ago.
      const fw = await this.exec('admin', 'sudo -n iptables -C OUTPUT -j FACTIII-OUT');
      if (fw.code !== 0) {
        this.bootId = null;
        throw new Error('The dev VM firewall is not in place; sessions do not start without it.');
      }
      this.problem = null;
      this.checkedAt = this.now();
    } catch (err) {
      this.problem = err instanceof Error ? err.message : String(err);
      this.checkedAt = 0;
    }
  }

  private async ensureMasters(): Promise<void> {
    await fs.mkdir(this.vm.controlDir, { recursive: true, mode: 0o700 });
    for (const user of ['session', 'admin'] as VmUser[]) {
      const [cbin, ...cargs] = masterCheckArgv(this.vm, user);
      if ((await this.hostExec(cbin, cargs)).code === 0) continue;
      const [bin, ...args] = masterArgv(this.vm, user);
      // Best effort: with no master every command just opens its own
      // connection, which is slower and otherwise the same.
      await this.hostExec(bin, args);
    }
  }

  /** Everything a restarted (or first-seen) VM lacks: /run, the firewall,
   *  the Claude home copy, the narrow path, the tokens. */
  private async boot(): Promise<void> {
    const layout = this.layout();
    const res = await this.exec('admin', 'sudo -n bash -s', bootScript(layout));
    if (res.code !== 0) {
      throw new Error(`Setting up the dev VM failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    // A board whose folders are not mounted gets no narrow path, so ready()
    // refuses its sessions, and every other board still works.
    const spaces = await this.mountedSpaces(this.deps.spaces());
    await this.copyClaudeHome();
    await this.openNarrowPaths(spaces);
    for (const space of spaces) await this.pushTokens(space);
    await this.syncCodex();
    this.codexTimer ??= setInterval(() => void this.syncCodex(), CODEX_SYNC_MS);
    this.codexTimer.unref?.();
    this.log(`dev VM ready (profile ${this.vm.profile}, ${spaces.length} boards)`);
  }

  /** The spaces whose folders are the Mac's (mounted). Any other would have
   *  its sessions work in an empty directory of the VM's own, lost on a
   *  rebuild. */
  private async mountedSpaces(spaces: DevVmSpace[]): Promise<DevVmSpace[]> {
    const res = await this.exec('session', 'findmnt -rn -t virtiofs -o TARGET');
    const mounted = new Set(res.stdout.split('\n').map((l) => l.trim().replace(/\/$/, '')));
    return spaces.filter((s) => {
      const missing = spaceMounts(s.spaceDir)
        .map((m) => m.path)
        .filter((p) => !mounted.has(p));
      if (missing.length) {
        this.log(`dev VM: ${s.slug} is not mounted (${missing.join(', ')}); its sessions will not start`);
      }
      return missing.length === 0;
    });
  }

  /** The runner's Claude home, minus anything that is a sign-in or a
   *  history: settings and the plugins (whose recorded paths are the same
   *  in the VM). The token comes from env (tokens.ts). Codex's config too. */
  private async copyClaudeHome(): Promise<void> {
    const base = path.dirname(path.dirname(this.deps.homes.claude));
    const rel = path.relative(base, this.deps.homes.claude);
    const parts = ['settings.json', 'plugins']
      .map((p) => path.join(rel, p));
    const present: string[] = [];
    for (const p of parts) {
      if (await fs.stat(path.join(base, p)).then(() => true, () => false)) present.push(p);
    }
    if (present.length) {
      const tar = await new Promise<Buffer>((resolve, reject) => {
        // No macOS metadata: GNU tar in the VM would warn on every entry.
        const args = ['--no-mac-metadata', '--no-xattrs', '-C', base, '-cf', '-', ...present];
        const env = { ...process.env, COPYFILE_DISABLE: '1' };
        execFile('tar', args, { encoding: 'buffer', env, maxBuffer: 512 * 1024 * 1024 }, (err, out) =>
          err ? reject(err) : resolve(out)
        );
      });
      const res = await this.execBinary(`tar -xf - -C ${shQuote(base)}`, tar);
      if (res.code !== 0) throw new Error(`Copying the Claude settings into the dev VM failed: ${res.stderr.trim()}`);
    }
    // First-run flag only: the Mac's .claude.json carries account details.
    const json = path.join(this.deps.homes.claude, '.claude.json');
    await this.exec(
      'session',
      `test -f ${shQuote(json)} || printf '%s' '{"hasCompletedOnboarding":true}' > ${shQuote(json)}`
    );
    // Codex's config (the board MCP entry, the runner's rules: names, never a
    // value), onto its tmpfs home beside the auth.json syncCodex keeps.
    const toml = path.join(this.deps.homes.codex, 'config.toml');
    const config = await fs.readFile(toml, 'utf-8').catch(() => null);
    if (config !== null) {
      await this.exec('session', `umask 077 && cat > ${shQuote(toml)}`, config);
    }
  }

  private execBinary(command: string, input: Buffer) {
    return new Promise<{ code: number; stderr: string }>((resolve) => {
      const [bin, ...args] = [...sshArgv(this.vm, 'session'), command];
      const proc = this.spawnFn(bin, args, { env: process.env, detached: true });
      let stderr = '';
      proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
      proc.on('error', (err) => resolve({ code: 127, stderr: err.message }));
      proc.on('close', (code) => resolve({ code: code ?? 1, stderr }));
      proc.stdin?.on('error', () => {});
      proc.stdin?.end(input);
    });
  }

  private narrowHostPath(slug: string): string {
    return path.join(this.deps.configDir, 'devvm', `${slug}.sock`);
  }

  private async openNarrowPaths(spaces: DevVmSpace[]): Promise<void> {
    const simctl = hostSimctl(this.hostExec);
    for (const space of spaces) {
      if (this.narrow.has(space.slug)) continue;
      const paths = hostSpacePaths(space.spaceDir);
      this.narrow.set(
        space.slug,
        await startNarrowPath({
          listenPath: this.narrowHostPath(space.slug),
          upstreamPath: path.join(paths.state, 'secrets.sock'),
          spaceToken: space.spaceToken,
          simctl
        })
      );
    }
    const forwards: Forward[] = spaces.map((space) => ({
      vmPath: path.join(hostSpacePaths(space.spaceDir).state, 'secrets.sock'),
      hostPath: this.narrowHostPath(space.slug)
    }));
    this.tunnel.start(forwards);
  }

  private async pushTokens(space: DevVmSpace): Promise<void> {
    await pushSpaceTokens(this.exec, space.slug, {
      GH_TOKEN: space.githubToken(),
      CLAUDE_CODE_OAUTH_TOKEN: this.deps.claudeToken()
    });
    this.pushedAt.set(space.slug, this.now());
  }

  private async syncCodex(): Promise<void> {
    try {
      const result = await syncCodexAuth({
        exec: this.exec,
        hostPath: path.join(this.deps.homes.codex, 'auth.json'),
        vmPath: path.join(this.deps.homes.codex, 'auth.json'),
        state: this.codexState
      });
      if (result === 'pulled') this.log('dev VM: Codex refreshed its sign-in; copied back to this Mac');
    } catch (err) {
      this.log(`dev VM: Codex sign-in sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A session is starting on `slug`: its tokens as they are now. */
  async sessionStart(slug: string): Promise<void> {
    if (this.now() - (this.pushedAt.get(slug) ?? 0) < PUSH_TTL_MS) return;
    const space = this.deps.spaces().find((s) => s.slug === slug);
    if (!space) return;
    await this.pushTokens(space);
    await this.syncCodex();
  }

  /** The board's session target: SpaceCoreOptions.sessionTarget. */
  sessionTarget(slug: string): (host: ExecTarget) => ExecTarget {
    return (host) =>
      vmTarget(host, {
        vm: this.vm,
        slug,
        ready: () => this.ready(slug),
        onSessionStart: () => this.sessionStart(slug),
        spawn: this.spawnFn
      });
  }

  /** The isolation test (guest.ts), in the VM as the session user. */
  async isolationTest(): Promise<{ code: number; output: string }> {
    const spaces = this.deps.spaces();
    const lsof = await this.hostExec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
    const lanIp = (await this.hostExec('ipconfig', ['getifaddr', 'en0'])).stdout.trim();
    const route = (await this.hostExec('route', ['-n', 'get', 'default'])).stdout;
    const router = /gateway:\s*(\S+)/.exec(route)?.[1] ?? '';
    const script = isolationTestScript({
      hostHome: os.homedir(),
      runnerDir: this.deps.configDir,
      spaceDirs: spaces.map((s) => s.spaceDir),
      allowedMounts: spaces.flatMap((s) => spaceMounts(s.spaceDir).map((m) => m.path)),
      hostPorts: parseLsofPorts(lsof.stdout),
      lanHosts: [lanIp, router].filter(Boolean),
      narrowSockets: spaces.map((s) => path.join(hostSpacePaths(s.spaceDir).state, 'secrets.sock'))
    });
    // The token rides in on stdin with the script, never on a command line.
    const token = spaces[0]?.spaceToken() ?? '';
    const res = await this.exec(
      'session',
      'bash -s',
      `export FACTIII_SECRETS_TOKEN=${shQuote(token)}\n${script}`
    );
    return { code: res.code, output: res.stdout + res.stderr };
  }

  async stop(): Promise<void> {
    if (this.codexTimer) clearInterval(this.codexTimer);
    this.codexTimer = null;
    await this.syncCodex();
    this.tunnel.stop();
    for (const narrow of this.narrow.values()) await narrow.close();
    this.narrow.clear();
  }
}
