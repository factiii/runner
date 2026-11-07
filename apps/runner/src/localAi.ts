import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { PartService } from './partsManager';
import type { ServiceState } from './parts';

// The Local AI part's service: `ollama serve`, started by the runner in its
// own process group so it outlives a runner restart. The pid file is how both
// the CLI and the daemon know it is theirs; a server the runner did not start
// (the Ollama app, say) is reported as running and never stopped.

export type LocalAiIo = {
  runnerDir: string;
  /** Where `ollama` resolves on the login PATH, or null. */
  resolveBin(): Promise<string | null>;
  /** Run a read-only command, no shell. Never throws. */
  run(bin: string, args: string[]): Promise<{ code: number; output: string }>;
  sleep(ms: number): Promise<void>;
};

const START_WAIT_MS = 15_000;
const STOP_WAIT_MS = 5_000;
const POLL_MS = 250;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function localAiService(io: LocalAiIo): PartService {
  const pidFile = path.join(io.runnerDir, 'parts', 'local-ai.pid');
  const logFile = path.join(io.runnerDir, 'logs', 'local-ai.log');

  /** The pid the runner wrote, if that process is still an ollama. A pid
   *  reused by something else after a reboot is not ours. */
  const ourPid = async (): Promise<number | null> => {
    const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return null;
    const res = await io.run('ps', ['-o', 'comm=', '-p', String(pid)]);
    return res.output.includes('ollama') ? pid : null;
  };
  const readOurPid = () => ourPid().catch(() => null);

  /** `ollama ps` answers only while a server is up. */
  const serverUp = async (bin: string) => (await io.run(bin, ['ps'])).code === 0;

  const status = async (): Promise<ServiceState> => {
    const pid = await readOurPid();
    if (pid) {
      const rss = await io.run('ps', ['-o', 'rss=', '-p', String(pid)]);
      const kb = Number(rss.output.trim());
      return {
        running: true,
        ours: true,
        memoryMb: Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : null
      };
    }
    const bin = await io.resolveBin();
    return { running: Boolean(bin && (await serverUp(bin))), ours: false, memoryMb: null };
  };

  return {
    status,
    async start(onLine) {
      const bin = await io.resolveBin();
      if (!bin) throw new Error('Ollama is not installed. Add the Local AI part first.');
      if ((await status()).running) {
        throw new Error('Ollama is already running on this machine.');
      }
      fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const log = fs.openSync(logFile, 'a');
      onLine('Starting Ollama…');
      const child = spawn(bin, ['serve'], {
        detached: true,
        stdio: ['ignore', log, log]
      });
      fs.closeSync(log);
      // A failed spawn is an 'error' event; unheard, it would kill the runner.
      // No pid says the same thing just below.
      child.on('error', () => {});
      if (!child.pid) throw new Error('Ollama did not start.');
      child.unref();
      fs.writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
      for (let waited = 0; waited < START_WAIT_MS; waited += POLL_MS) {
        if (await serverUp(bin)) {
          onLine('Ollama is running.');
          return;
        }
        if (!alive(child.pid)) break;
        await io.sleep(POLL_MS);
      }
      throw new Error(
        'Ollama did not come up. Its log is logs/local-ai.log in the runner folder.'
      );
    },
    async stop(onLine) {
      const pid = await readOurPid();
      if (!pid) {
        throw new Error(
          'The runner did not start this Ollama, so it leaves it running.'
        );
      }
      onLine('Stopping Ollama…');
      // Its own process group: the server and any model runner it started.
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
      for (let waited = 0; waited < STOP_WAIT_MS && alive(pid); waited += POLL_MS) {
        await io.sleep(POLL_MS);
      }
      fs.rmSync(pidFile, { force: true });
      onLine(alive(pid) ? 'Ollama is still stopping.' : 'Ollama stopped.');
    }
  };
}
