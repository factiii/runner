import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

import type { ExtractedPage } from '@shared/all/domains/vaultText';
import { killTree } from '@shared/all/helpers/board-agent-core/host-env';
import type { EmbedRequest } from '@shared/all/validators';

import { embedderInstalled, embedderPaths, embedderSupported } from './embedderInstall';

// The Vault's embedder process (apps/runner/embedder/serve.py), started on
// the first call and stopped after a quiet spell, as the vault database is:
// an idle runner holds no model in memory. It listens on 127.0.0.1 on a port
// picked at each start, behind a key made at each start.

export type EmbedderState = 'ready' | 'missing' | 'unsupported';

/** `transient`: the embedder could not be reached or broke, so the file is
 *  tried again later. Otherwise the file itself is the problem. */
export class EmbedderError extends Error {
  constructor(
    message: string,
    readonly transient: boolean
  ) {
    super(message);
  }
}

export type Embedder = {
  state(): EmbedderState;
  /** The server's `/embed` contract: one of text, clipText, clipImage. */
  embed(body: EmbedRequest): Promise<number[]>;
  read(bytes: Uint8Array, ext: 'pdf' | 'docx'): Promise<ExtractedPage[]>;
  stop(): void;
};

type EmbedderCommand = { bin: string; args: string[]; cwd: string };

type LocalEmbedderOptions = {
  state: () => EmbedderState;
  command: () => EmbedderCommand;
  idleMs: number;
  startTimeoutMs?: number;
};

const START_TIMEOUT_MS = 180_000;
/** OCR of a long scan takes minutes, as the cloud's EXTRACT_TIMEOUT_MS. */
const CALL_TIMEOUT_MS = 300_000;
const MAX_DETAIL = 200;
/** What the embedder printed, kept for the runner owner's log view
 *  (runnerLogs): the last this many lines, across its starts. */
const LOG_LINES = 2000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

type Running = { proc: ChildProcess; url: string; key: string; port: number };

/** The last `max` lines written to it, oldest first. A line still being
 *  written (no newline yet) is held until it ends. */
export class LineRing {
  private lines: string[] = [];
  private partial = '';

  constructor(private readonly max: number) {}

  write(chunk: string): void {
    const parts = (this.partial + chunk).split('\n');
    this.partial = parts.pop() ?? '';
    this.lines.push(...parts);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  /** One whole line of the runner's own, after whatever was being written. */
  note(line: string): void {
    this.write(`${this.partial ? '\n' : ''}${line}\n`);
  }

  /** The last `count` lines, the unfinished one included. */
  tail(count: number): string[] {
    const all = this.partial ? [...this.lines, this.partial] : this.lines;
    return all.slice(-Math.max(0, count));
  }
}

export class LocalEmbedder implements Embedder {
  private running: Promise<Running> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = 0;
  /** The process that is up and answering now; null while it starts. */
  private up: Running | null = null;
  private readonly log = new LineRing(LOG_LINES);

  constructor(private readonly options: LocalEmbedderOptions) {}

  state(): EmbedderState {
    return this.options.state();
  }

  /** The process is up now. For the tests. */
  isRunning(): boolean {
    return this.running !== null;
  }

  /** Whether its process is up and answering now, and on which port. */
  process(): { running: boolean; port: number | null } {
    return { running: this.up !== null, port: this.up?.port ?? null };
  }

  /** The last `lines` lines it printed (stdout and stderr), oldest first. */
  logTail(lines: number): string[] {
    return this.log.tail(lines);
  }

  private async start(): Promise<Running> {
    const { bin, args, cwd } = this.options.command();
    const port = await freePort();
    const key = randomBytes(32).toString('hex');
    const proc = spawn(bin, [...args, '--port', String(port)], {
      cwd,
      env: {
        ...process.env,
        VAULT_EMBEDDER_KEY: key,
        // app.py warns when its own key is unset; its routes are not served.
        EMBEDDER_API_KEY: key,
        VAULT_EMBEDDER_WATCH_STDIN: '1',
        PYTHONNOUSERSITE: '1'
      },
      // stdin stays open: serve.py exits when it closes (the runner is gone).
      // stdout is read for the owner's log view (logTail).
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });
    let stderr = '';
    let gone = false;
    this.log.note(`--- started on port ${port} at ${new Date().toISOString()}`);
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.log.write(chunk.toString());
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
      this.log.write(chunk.toString());
    });
    const exited = new Promise<never>((_, reject) => {
      proc.once('exit', (code, signal) => {
        gone = true;
        if (this.up?.proc === proc) this.up = null;
        this.log.note(`--- stopped (${signal ?? `exit ${code}`})`);
        // A process that died is started again on the next call.
        const running = this.running;
        void running
          ?.then((r) => {
            if (r.proc === proc && this.running === running) this.running = null;
          })
          .catch(() => undefined);
        reject(
          new EmbedderError(
            `The vault’s embedder stopped (${signal ?? `exit ${code}`}). ${stderr.trim().split('\n').pop() ?? ''}`.trim(),
            true
          )
        );
      });
      // `on`, not `once`: a later 'error' (a kill that fails) with no
      // listener left would throw out of the event loop and end the runner.
      proc.on('error', (err) =>
        reject(new EmbedderError(`The vault’s embedder did not start: ${err.message}`, true))
      );
    });
    exited.catch(() => undefined);
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + (this.options.startTimeoutMs ?? START_TIMEOUT_MS);
    const ready = async (): Promise<void> => {
      while (!gone && Date.now() < deadline) {
        try {
          const res = await fetch(`${url}/health`);
          if (res.ok && ((await res.json()) as { loaded?: unknown }).loaded === true) return;
        } catch {
          // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      killTree(proc);
      throw new EmbedderError('The vault’s embedder did not start in time.', true);
    };
    await Promise.race([ready(), exited]);
    const running = { proc, url, key, port };
    this.up = running;
    return running;
  }

  private idle(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.busy === 0) this.stop();
    }, this.options.idleMs);
    this.timer.unref();
  }

  private async call<T>(route: string, body: unknown): Promise<T> {
    if (this.state() !== 'ready') {
      throw new EmbedderError('The vault’s embedder is not installed.', true);
    }
    this.busy += 1;
    try {
      if (!this.running) {
        const starting = this.start();
        this.running = starting;
        // A failed start is not kept: the next call tries again.
        starting.catch(() => {
          if (this.running === starting) this.running = null;
        });
      }
      const { url, key } = await this.running;
      let res: Response;
      try {
        res = await fetch(`${url}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
        });
      } catch (err) {
        throw new EmbedderError(
          `The vault’s embedder did not answer: ${err instanceof Error ? err.message : String(err)}`,
          true
        );
      }
      if (!res.ok) {
        const detail = ((await res.json().catch(() => null)) as { detail?: unknown } | null)?.detail;
        const reason = typeof detail === 'string' ? detail.slice(0, MAX_DETAIL) : `status ${res.status}`;
        // A 4xx is the file (cannot read it); a 5xx, or a key it refused,
        // is the embedder.
        throw new EmbedderError(reason, res.status >= 500 || res.status === 401);
      }
      return (await res.json()) as T;
    } finally {
      this.busy -= 1;
      this.idle();
    }
  }

  async embed(body: EmbedRequest): Promise<number[]> {
    const { vector } = await this.call<{ vector: number[] }>('/embed', body);
    return vector;
  }

  async read(bytes: Uint8Array, ext: 'pdf' | 'docx'): Promise<ExtractedPage[]> {
    const { pages } = await this.call<{ pages: ExtractedPage[] }>('/read', {
      file_b64: Buffer.from(bytes).toString('base64'),
      ext
    });
    return pages;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const running = this.running;
    this.running = null;
    this.up = null;
    void running?.then(({ proc }) => killTree(proc, 'SIGTERM')).catch(() => undefined);
  }
}

/** Whether the Vault part's embedder can run here, read off the disk. */
export function embedderState(runnerDir: string): EmbedderState {
  if (!embedderSupported()) return 'unsupported';
  return embedderInstalled(embedderPaths(runnerDir)) ? 'ready' : 'missing';
}

/** The embedder the Vault part installs, under `runnerDir`. */
export function vaultEmbedder(runnerDir: string, idleMs: number): LocalEmbedder {
  const paths = embedderPaths(runnerDir);
  return new LocalEmbedder({
    idleMs,
    state: () => embedderState(runnerDir),
    command: () => ({
      bin: paths.python,
      args: ['-m', 'uvicorn', 'serve:api', '--host', '127.0.0.1', '--no-access-log'],
      cwd: paths.root
    })
  });
}
