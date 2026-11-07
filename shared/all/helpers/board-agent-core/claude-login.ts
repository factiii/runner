import { markOnboardingComplete } from './agent';
import { createAnsiStripper } from './ansi';
import type { ExecTarget } from './exec';
import {
  loginCredentialsExist,
  startLoginExec,
  stopLoginExec
} from './login-exec';
import type { TmuxSession } from './tmux';

// One-click Claude sign-in: `claude auth login` in its own tmux session (the
// CLI rejects piped stdin). No timers; every wait is bounded by real events.

export type AgentAuthResult = {
  status: 'complete' | 'error';
  message?: string;
};

export class ClaudeLoginFlow {
  private session: TmuxSession | null = null;
  private output = '';
  private strip = createAnsiStripper();
  private urlResolver: ((url: string) => void) | null = null;
  private urlRejecter: ((err: Error) => void) | null = null;
  private settled = false;
  // Set before start()'s first await so overlapping starts can't race.
  private inFlight = false;
  // Output offset at code submission; the exchange outcome is scanned after it.
  private submitMark = -1;

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

  /** Start the login and resolve with the OAuth URL to open. Completion
   *  arrives later via onDone. */
  async start(): Promise<{ url: string }> {
    if (this.active) throw new Error('A Claude sign-in is already running.');
    this.reset();
    this.inFlight = true;

    // Created before any await so cancel()/fail() can always release start();
    // the noop catch avoids an unhandled rejection mid-setup.
    const urlPromise = new Promise<string>((resolve, reject) => {
      this.urlResolver = resolve;
      this.urlRejecter = reject;
    });
    urlPromise.catch(() => {});

    try {
      const { session } = await startLoginExec({
        provider: 'claude',
        spaceSlug: this.spaceSlug,
        target: this.target,
        cmd: ['claude', 'auth', 'login', '--claudeai']
      });
      this.session = session;

      session.onData((chunk: Buffer) => this.onData(chunk));
      session.onError(() => this.fail('Claude sign-in connection dropped.'));
      session.onClose(() => void this.onClose());
    } catch (err) {
      // Cancelled mid-setup: report the cancel, not the induced error.
      if (this.settled) throw new Error('Claude sign-in cancelled.');
      this.settled = true;
      this.urlResolver = null;
      this.urlRejecter = null;
      await this.cleanup();
      throw err;
    }

    // Resolves when the CLI prints the URL; fail()/cancel() reject it.
    const url = await urlPromise;
    return { url };
  }

  /** Forward the code the user pasted from the browser to the CLI prompt. */
  submitCode(code: string): { success: boolean } {
    if (!this.session || this.settled) {
      throw new Error('No Claude sign-in in progress.');
    }
    this.submitMark = this.output.length;
    this.session.write(`${code.trim()}\r`);
    return { success: true };
  }

  async cancel(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    // A cancel while start() is still awaiting the URL must release it.
    if (this.urlRejecter) {
      const reject = this.urlRejecter;
      this.urlResolver = null;
      this.urlRejecter = null;
      reject(new Error('Claude sign-in cancelled.'));
    }
    await this.cleanup();
  }

  private onData(chunk: Buffer): void {
    this.output += this.strip(chunk.toString('utf-8'));
    if (this.output.length > 200_000) {
      const removed = this.output.length - 100_000;
      this.output = this.output.slice(-100_000);
      // submitMark is an absolute offset; shift it with the trim.
      if (this.submitMark >= 0) {
        this.submitMark = Math.max(0, this.submitMark - removed);
      }
    }

    if (this.urlResolver) {
      // The CLI prints the authorize URL for environments where it can't
      // open a browser itself (always true on a headless runner).
      const url = this.output.match(
        /https:\/\/[^\s\x00-\x1f]*oauth[^\s\x00-\x1f]*/
      )?.[0];
      if (url) {
        const resolve = this.urlResolver;
        this.urlResolver = null;
        this.urlRejecter = null;
        resolve(url.replace(/[.,;)\]]+$/, ''));
      }
    }

    if (this.submitMark < 0 || this.settled) return;
    const afterSubmit = this.output.slice(this.submitMark);

    // Success message can arrive without the process exiting right away;
    // settle as soon as either signal shows, verifying the credentials file.
    if (/logged in|login successful/i.test(afterSubmit)) {
      this.settled = true;
      void this.verifyAndComplete('');
      return;
    }

    // A retry regenerates the PKCE state, so the URL the user signed in with
    // is already dead. Fail fast with the CLI's own message.
    const err = afterSubmit.match(/(?:Login failed|OAuth error):[^\r\n]+/)?.[0];
    if (err) this.fail(`${err.trim()} Try signing in again.`);
  }

  // Process ended (or success was printed): the CLI's own auth status is the
  // ground truth for whether the sign-in worked.
  private async verifyAndComplete(failTail: string): Promise<void> {
    const ok = await loginCredentialsExist('claude', this.target);
    if (ok) {
      try {
        await markOnboardingComplete(this.target);
      } catch {
        // best-effort: without the marker the wizard just shows once
      }
    }
    await this.cleanup();
    this.onDone(
      ok
        ? { status: 'complete' }
        : {
            status: 'error',
            message: failTail || 'Claude sign-in ended without signing in.'
          }
    );
  }

  private async onClose(): Promise<void> {
    if (this.settled) return;
    // Prefer the CLI's own error line over a raw output tail.
    const errLine = this.output
      .slice(Math.max(this.submitMark, 0))
      .match(/(?:Login failed|OAuth error):[^\r\n]+/)?.[0];
    const tail = errLine
      ? `${errLine.trim()} Try signing in again.`
      : this.output.trim().slice(-300);
    // CLI exited before printing the URL: release start()'s await.
    if (this.urlRejecter) {
      this.fail(tail || 'Claude sign-in ended unexpectedly.');
      return;
    }
    this.settled = true;
    await this.verifyAndComplete(tail);
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.settled = true;
    if (this.urlRejecter) {
      const reject = this.urlRejecter;
      this.urlResolver = null;
      this.urlRejecter = null;
      reject(new Error(message));
      void this.cleanup();
      return;
    }
    void this.cleanup();
    this.onDone({ status: 'error', message });
  }

  private async cleanup(): Promise<void> {
    this.session = null;
    await stopLoginExec(this.target, 'claude', this.spaceSlug);
  }

  private reset(): void {
    this.output = '';
    this.strip = createAnsiStripper();
    this.settled = false;
    this.urlResolver = null;
    this.urlRejecter = null;
    this.submitMark = -1;
  }
}
