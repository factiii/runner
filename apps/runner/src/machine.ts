import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  hostTarget,
  installTool,
  planTools
} from '@shared/all/helpers/board-agent-core';
import {
  freshPath,
  TOOLS_DIR_ENV
} from '@shared/all/helpers/board-agent-core/host-env';
import { defaultRunnerDir } from '@shared/all/helpers/board-agent-core/runner-dir';

import { prompt } from './auth';
import { configExists } from './config';
import { buildChecks, type DoctorHost, type DoctorUi, runDoctor } from './doctor';
import { localAiService } from './localAi';
import {
  type LocalAiModelIo,
  modelCheck,
  ollamaModelsDir,
  readMachine
} from './localAiModel';
import { machineHealth } from './machineHealthIo';
import type { PartService } from './partsManager';
import { CONFIG_DIR } from './paths';
import { storeStatus } from './secureStore';
import { embedderState } from './vault/embedder';
import { engineInstalled, vaultPaths } from './vault/engine';
import {
  type Guide,
  installService,
  loginGuide,
  powerGuide,
  resolveProgram,
  type ServiceIo,
  type ServiceOutcome,
  servicePath,
  type ServiceSpec,
  serviceStatus
} from './service';

// The real machine behind doctor.ts and service.ts: the probes, the prompts
// and the file writes they are handed. Nothing here is decided; it is done.

const MAX_OUTPUT = 8 * 1024 * 1024;
const UTF16_BOM = '﻿';

/** Run a command, no shell. Resolves with the code and both streams. With
 *  `timeoutMs`, a command still running then is killed and fails. */
export function run(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {}
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        encoding: 'utf-8',
        windowsHide: true,
        maxBuffer: MAX_OUTPUT,
        timeout: opts.timeoutMs ?? 0,
        ...(opts.cwd ? { cwd: opts.cwd } : {})
      },
      (err, stdout, stderr) => {
        // A missing binary has a string code (ENOENT); any failure is non-zero.
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, output: `${stdout}${stderr}` });
      }
    );
  });
}

/** A progress line repeats many times a second (`ollama pull`): the same
 *  line before its numbers shows at most this often. */
const PROGRESS_EVERY_MS = 2000;

/** Run a command, no shell, each output line to `onLine` (a progress line
 *  that only moves its numbers at most every PROGRESS_EVERY_MS). Resolves
 *  the exit code; never throws. */
function streamLines(
  bin: string,
  args: string[],
  onLine: (line: string) => void
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let last = { key: '', at: 0 };
    const take = (chunk: Buffer) => {
      for (const raw of chunk.toString().split(/[\r\n]+/)) {
        // Drop terminal escapes (spinners, cursor moves).
        const line = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim();
        if (!line) continue;
        const key = line.replace(/[\d.]+/g, '#');
        const now = Date.now();
        if (key === last.key && now - last.at < PROGRESS_EVERY_MS) continue;
        last = { key, at: now };
        onLine(line);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** The Local AI part's service and its model, on this machine. */
export function localAiMachine(target: ReturnType<typeof hostTarget>): {
  service: PartService;
  model: LocalAiModelIo;
} {
  const resolveBin = () =>
    target.sh('command -v ollama').then(
      (out) => out.trim().split('\n').pop()?.trim() || null,
      () => null
    );
  const service = localAiService({
    runnerDir: CONFIG_DIR,
    resolveBin,
    run,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  });
  return {
    service,
    model: {
      runnerDir: CONFIG_DIR,
      machine: () => readMachine(run, ollamaModelsDir()),
      // Read each time: on Linux, Ollama installed after the runner started
      // keeps its models in the service's folder (ollamaModelsDir).
      get modelsDir() {
        return ollamaModelsDir();
      },
      resolveBin,
      stream: streamLines,
      service
    }
  };
}

/** schtasks reads its XML as UTF-16; everything else here is UTF-8. */
const isUtf16 = (content: string) => content.includes('encoding="UTF-16"');

export const serviceIo: ServiceIo = {
  run,
  read(file) {
    try {
      const raw = fs.readFileSync(file);
      return raw[0] === 0xff && raw[1] === 0xfe
        ? raw.toString('utf16le').slice(UTF16_BOM.length)
        : raw.toString('utf-8');
    } catch {
      return null;
    }
  },
  write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (isUtf16(content)) {
      fs.writeFileSync(file, Buffer.from(UTF16_BOM + content, 'utf16le'));
    } else {
      fs.writeFileSync(file, content);
    }
  },
  remove(file) {
    fs.rmSync(file, { force: true });
  }
};

/** What a service for this runner would run. Null where there is none to
 *  install: an unsupported platform, or a source checkout under a loader
 *  (tsx), which has no installed binary to point a service at. */
export function serviceSpec(): ServiceSpec | null {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    return null;
  }
  if (process.execArgv.length) return null;
  const { node, entry } = resolveProgram({
    execPath: process.execPath,
    invoked: process.argv[1],
    platform,
    realpath(file) {
      try {
        return fs.realpathSync(file);
      } catch {
        return null;
      }
    }
  });
  const info = os.userInfo();
  const domain = process.env.USERDOMAIN;
  return {
    platform,
    home: os.homedir(),
    user:
      platform === 'win32' && domain
        ? `${domain}\\${info.username}`
        : info.username,
    uid: info.uid,
    node,
    entry,
    runnerDir: CONFIG_DIR,
    customDir: CONFIG_DIR !== defaultRunnerDir(),
    path: servicePath(node, process.env.PATH ?? '', platform, process.argv[1]),
    shell: process.env.SHELL,
    lang: process.env.LANG,
    toolsDir: process.env[TOOLS_DIR_ENV]?.trim() || undefined
  };
}

/** Install the service for this runner, as `service install` and setup do. */
export async function installThisService(
  spec: ServiceSpec
): Promise<ServiceOutcome> {
  // The service writes its log here before the runner has made anything.
  fs.mkdirSync(path.join(CONFIG_DIR, 'logs'), { recursive: true });
  return installService(spec, serviceIo, {
    invoked: process.argv[1],
    selfPid: process.pid
  });
}

function printGuide(guide: Guide): void {
  for (const note of guide.note) console.log(note);
  for (const command of guide.commands) console.log(`    ${command}`);
}

/** What only the owner may do for an unattended machine. Printed, never run. */
export function printAlwaysOnNotes(spec: ServiceSpec): void {
  console.log('\nAfter a restart with nobody at the machine:');
  printGuide(loginGuide(spec));
  console.log('');
  printGuide(powerGuide(spec.platform));
  console.log('Run those yourself. The runner never runs them.');
}

function isTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** `[Y/n]`: a bare Enter is yes. */
export async function confirm(question: string): Promise<boolean> {
  const answer = (await prompt(question)).toLowerCase();
  return answer === '' || answer === 'y' || answer === 'yes';
}

export function doctorHost(target: ReturnType<typeof hostTarget>): DoctorHost {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    runnerDir: CONFIG_DIR,
    user: os.userInfo().username,
    tools: () => planTools(target),
    vaultEngine: () => engineInstalled(vaultPaths(CONFIG_DIR).engine),
    vaultEmbedder: () => embedderState(CONFIG_DIR),
    localAiModel: () => modelCheck(localAiMachine(target).model),
    health: () => machineHealth(run),
    dirWritable(dir) {
      try {
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    fileExists: fs.existsSync,
    async loginPath() {
      // A clean env: this process's PATH already carries the tool dirs, and
      // macOS path_helper keeps what a login shell inherits.
      const shell = process.env.SHELL || '/bin/zsh';
      const res = await run('/usr/bin/env', [
        '-i',
        `HOME=${os.homedir()}`,
        `USER=${os.userInfo().username}`,
        `SHELL=${shell}`,
        shell,
        '-lc',
        'printf %s "$PATH"'
      ]);
      // Shell-init noise can precede the PATH; take the last line.
      const last = res.output.trim().split('\n').pop() ?? '';
      return res.code === 0 && last.includes('/') ? last : null;
    },
    keychain: storeStatus,
    paired: configExists,
    run,
    async service() {
      const spec = serviceSpec();
      return spec ? serviceStatus(spec, serviceIo) : null;
    }
  };
}

/** Run the checklist on this machine and answer with the exit code. Asks
 *  nothing without a terminal, with `fix: false`, or for JSON. */
export async function doctor(opts: {
  fix: boolean;
  json?: boolean;
}): Promise<number> {
  const target = hostTarget(CONFIG_DIR);
  const ui: DoctorUi = {
    print: opts.json ? () => {} : (line) => console.log(line),
    confirm: isTerminal() && !opts.json ? confirm : null,
    installTool: (bin, onStatus) => installTool(target, bin, onStatus),
    makeDir: (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
    // The pane opens; the switch in it is the owner's to flip.
    openSettings: (url) => void execFile('open', [url], () => {})
  };
  const { results, exitCode } = await runDoctor(
    buildChecks(doctorHost(target)),
    ui,
    { fix: opts.fix }
  );
  if (opts.json) {
    console.log(JSON.stringify({ ready: exitCode === 0, results }, null, 2));
    return exitCode;
  }
  // What separates a tool that is absent from one installed where the runner
  // cannot see it.
  const loginPath = await freshPath();
  console.log(`\nLogin PATH\n  ${loginPath.split(path.delimiter).join('\n  ')}\n`);
  return exitCode;
}
