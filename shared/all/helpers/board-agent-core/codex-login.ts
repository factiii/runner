import { createAnsiStripper } from './ansi';
import type { AgentAuthResult } from './claude-login';
import type { ExecTarget } from './exec';
import {
  loginCredentialsExist,
  startLoginExec,
  stopLoginExec
} from './login-exec';

// One-click Codex sign-in: `codex login --device-auth` in its own tmux session.
// The CLI polls OpenAI itself, so nothing is pasted back, unlike Claude.

// The printed one-time code, like "XX31-72R43". Scoped to the "code" mention
// first; the bare-token fallback needs 4+ chars a side so "GPT-5" can't match.
const CODE_LINE_RE = /code[^\n]*\n\s*([A-Z0-9]{4,10}(?:-[A-Z0-9]{4,10})+)/i;
const CODE_TOKEN_RE = /\b([A-Z0-9]{4,10}-[A-Z0-9]{4,10})\b/;

export class CodexLoginFlow {
  private output = '';
  private strip = createAnsiStripper();
  private startResolver: ((r: { url: string; code: string }) => void) | null =
    null;
  private startRejecter: ((err: Error) => void) | null = null;
  private settled = false;
  // Set before start()'s first await so overlapping starts can't race.
  private inFlight = false;
  // Which start() this flow is on. The flow is reused, and the login session's
  // name is the same every time: an earlier run's late close, error or
  // verification checks it and leaves a newer run alone.
  private attempt = 0;

  constructor(
    private spaceSlug: string,
    // Where this space runs commands; the CLI writes its credential into the
    // target's provider state dir, which every other mode reads.
    private target: ExecTarget,
    private onDone: (result: AgentAuthResult) => void
  ) {}

  get active(): boolean {
    return this.inFlight && !this.settled;
  }

  /** Start the login and resolve with the URL and one-time code to show.
   *  Completion arrives later via onDone, once the CLI's polling settles. */
  async start(): Promise<{ url: string; code: string }> {
    if (this.active) throw new Error('A Codex sign-in is already running.');
    this.reset();
    this.inFlight = true;
    const attempt = ++this.attempt;
    const current = () => attempt === this.attempt;

    // Created before any await so cancel()/fail() can always release start();
    // the noop catch avoids an unhandled rejection mid-setup.
    const startPromise = new Promise<{ url: string; code: string }>(
      (resolve, reject) => {
        this.startResolver = resolve;
        this.startRejecter = reject;
      }
    );
    startPromise.catch(() => {});

    try {
      const { session } = await startLoginExec({
        provider: 'codex',
        spaceSlug: this.spaceSlug,
        target: this.target,
        cmd: ['codex', 'login', '--device-auth']
      });
      // Cancelled and started again meanwhile: the newer start owns the
      // login session now, and this one touches nothing of it.
      if (!current()) throw new Error('Codex sign-in cancelled.');

      session.onData((chunk: Buffer) => {
        if (current()) this.onData(chunk, attempt);
      });
      session.onError(() => {
        if (current()) this.fail('Codex sign-in connection dropped.');
      });
      session.onClose(() => {
        if (current()) void this.onClose(attempt);
      });
    } catch (err) {
      // Cancelled mid-setup (or cancelled and started again): report the
      // cancel, not the induced error.
      if (this.settled || !current()) throw new Error('Codex sign-in cancelled.');
      this.settled = true;
      this.startResolver = null;
      this.startRejecter = null;
      await this.cleanup();
      throw err;
    }

    return startPromise;
  }

  async cancel(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    // A cancel while start() is still awaiting the URL/code must release it.
    if (this.startRejecter) {
      const reject = this.startRejecter;
      this.startResolver = null;
      this.startRejecter = null;
      reject(new Error('Codex sign-in cancelled.'));
    }
    await this.cleanup();
  }

  private onData(chunk: Buffer, attempt: number): void {
    this.output += this.strip(chunk.toString('utf-8'));
    if (this.output.length > 200_000) {
      this.output = this.output.slice(-100_000);
    }

    if (this.startResolver) {
      // The CLI prints the verification URL and the one-time code together;
      // resolve start() once both are visible.
      const url = this.output.match(/https:\/\/[^\s\x00-\x1f]+/)?.[0];
      const code =
        this.output.match(CODE_LINE_RE)?.[1] ??
        this.output.match(CODE_TOKEN_RE)?.[1];
      if (url && code) {
        const resolve = this.startResolver;
        this.startResolver = null;
        this.startRejecter = null;
        resolve({ url: url.replace(/[.,;)\]]+$/, ''), code });
      }
      return;
    }

    if (this.settled) return;

    // The CLI polls OpenAI itself and prints the outcome; the credential
    // file check in verifyAndComplete stays the ground truth.
    if (/success|logged in/i.test(this.output)) {
      this.settled = true;
      void this.verifyAndComplete('', attempt);
    }
  }

  // Process ended (or success was printed): the auth.json on the cache volume
  // is the ground truth for whether the sign-in worked.
  private async verifyAndComplete(failTail: string, attempt: number): Promise<void> {
    const ok = await loginCredentialsExist('codex', this.target);
    // Started again while this was checked: the cleanup would kill the new
    // run's session (same name), and this answer is no longer the one asked.
    if (attempt !== this.attempt) return;
    await this.cleanup();
    this.onDone(
      ok
        ? { status: 'complete' }
        : {
            status: 'error',
            message: failTail || 'Codex sign-in ended without signing in.'
          }
    );
  }

  private async onClose(attempt: number): Promise<void> {
    if (this.settled) return;
    const tail = this.output.trim().slice(-300);
    // CLI exited before printing the URL/code: release start()'s await.
    if (this.startRejecter) {
      this.fail(tail || 'Codex sign-in ended unexpectedly.');
      return;
    }
    this.settled = true;
    await this.verifyAndComplete(tail, attempt);
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.settled = true;
    if (this.startRejecter) {
      const reject = this.startRejecter;
      this.startResolver = null;
      this.startRejecter = null;
      reject(new Error(message));
      void this.cleanup();
      return;
    }
    void this.cleanup();
    this.onDone({ status: 'error', message });
  }

  private async cleanup(): Promise<void> {
    // Killed by session name; codex's flow completes in the browser, so
    // nothing is ever typed back and the handle is not worth keeping.
    await stopLoginExec(this.target, 'codex', this.spaceSlug);
  }

  private reset(): void {
    this.output = '';
    this.strip = createAnsiStripper();
    this.settled = false;
    this.startResolver = null;
    this.startRejecter = null;
  }
}
