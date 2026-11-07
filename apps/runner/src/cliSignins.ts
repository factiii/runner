import type { RunnerCliSignin, RunnerCliSignins } from '@shared/all/domains/electron';
import { isSignedIn, signOut } from '@shared/all/helpers/board-agent-core/agent';
import {
  type AgentAuthResult,
  ClaudeLoginFlow
} from '@shared/all/helpers/board-agent-core/claude-login';
import { CodexLoginFlow } from '@shared/all/helpers/board-agent-core/codex-login';
import type { ExecTarget } from '@shared/all/helpers/board-agent-core/exec';
import { PROVIDERS } from '@shared/all/helpers/board-agent-core/providers';
import { z } from 'zod';

// Claude's and Codex's sign-ins with no board, for Oakbox > Account > Backend
// (.specs/runner-vault-ask.md "Oakbox's backend: setup, sign-ins, models"): factiii.com's one-click flows
// (claude-login.ts, codex-login.ts) on the host target Oakbox's Ask runs the
// CLIs on. The sign-in lands in the runner's one pair of CLI homes
// (agent-homes.ts), the boards' too, so each board's cached state is told
// (`changed`). A runner-wide link gets no events: the app reads `status`.

type Cli = 'claude' | 'codex';

/** In the login sessions' tmux name with no board, where a board's has its
 *  slug (login-exec.ts). */
const RUNNER_SIGNIN_SLUG = '_runner';

type ClaudeFlow = {
  readonly active: boolean;
  start(): Promise<{ url: string }>;
  submitCode(code: string): { success: boolean };
  cancel(): Promise<void>;
};

type CodexFlow = {
  readonly active: boolean;
  start(): Promise<{ url: string; code: string }>;
  cancel(): Promise<void>;
};

export type CliSigninDeps = {
  installed(cli: Cli): Promise<boolean>;
  signedIn(cli: Cli): Promise<boolean>;
  signOut(cli: Cli): Promise<void>;
  claudeFlow(onDone: (result: AgentAuthResult) => void): ClaudeFlow;
  codexFlow(onDone: (result: AgentAuthResult) => void): CodexFlow;
  /** Signed in or out: every board's cached state follows. */
  changed(cli: Cli, signedIn: boolean): void;
};

/** What Claude's prompt is typed: the code from claude.ai, one line. A
 *  newline would type a second line into the CLI. */
const loginCodeSchema = z
  .string()
  .trim()
  .min(1, 'Paste the code first.')
  .max(2000)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f\x7f]+$/, 'That does not look like the code.');

export type CliSignins = ReturnType<typeof createCliSignins>;

export function createCliSignins(deps: CliSigninDeps) {
  const flows: Record<Cli, RunnerCliSignin['flow']> = { claude: null, codex: null };
  let claude: ClaudeFlow | null = null;
  let codex: CodexFlow | null = null;

  const settle = (cli: Cli) => (result: AgentAuthResult) => {
    flows[cli] = { state: result.status, message: result.message ?? null };
    if (result.status === 'complete') deps.changed(cli, true);
  };

  const needInstalled = async (cli: Cli) => {
    if (!(await deps.installed(cli))) {
      throw new Error(`Add ${PROVIDERS[cli].label} on this runner first.`);
    }
  };

  /** Mark the flow running for the length of `start`; a start that fails
   *  leaves no flow behind, as its error is the answer. */
  const starting = async <T>(cli: Cli, start: () => Promise<T>): Promise<T> => {
    flows[cli] = { state: 'running', message: null };
    try {
      return await start();
    } catch (err) {
      flows[cli] = null;
      throw err;
    }
  };

  const one = async (cli: Cli): Promise<RunnerCliSignin> => {
    const installed = await deps.installed(cli);
    return {
      installed,
      signedIn: installed && (await deps.signedIn(cli)),
      flow: flows[cli]
    };
  };

  return {
    async status(): Promise<RunnerCliSignins> {
      const [claudeState, codexState] = await Promise.all([one('claude'), one('codex')]);
      return { claude: claudeState, codex: codexState };
    },

    async claudeStart(): Promise<{ url: string }> {
      await needInstalled('claude');
      claude ??= deps.claudeFlow(settle('claude'));
      const flow = claude;
      // Start again means a new link: a stranded one is let go first.
      if (flow.active) await flow.cancel();
      return starting('claude', () => flow.start());
    },

    claudeCode(payload: unknown): { success: boolean } {
      const raw = (payload as { code?: unknown } | null)?.code;
      if (!claude || flows.claude?.state !== 'running') {
        throw new Error('No Claude sign-in in progress.');
      }
      const code = loginCodeSchema.safeParse(raw);
      if (!code.success) {
        throw new Error(code.error.issues[0]?.message ?? 'Paste the code first.');
      }
      return claude.submitCode(code.data);
    },

    async codexStart(): Promise<{ url: string; code: string }> {
      await needInstalled('codex');
      codex ??= deps.codexFlow(settle('codex'));
      const flow = codex;
      if (flow.active) await flow.cancel();
      return starting('codex', () => flow.start());
    },

    async cancel(cli: Cli): Promise<{ success: boolean }> {
      await (cli === 'claude' ? claude : codex)?.cancel();
      flows[cli] = null;
      return { success: true };
    },

    async signOut(cli: Cli): Promise<{ success: boolean }> {
      await needInstalled(cli);
      await (cli === 'claude' ? claude : codex)?.cancel();
      await deps.signOut(cli);
      flows[cli] = null;
      deps.changed(cli, false);
      return { success: true };
    }
  };
}

/** The daemon's: on `target`, the host target Ask runs the CLIs on. */
export function machineCliSignins(
  target: ExecTarget,
  changed: (cli: Cli, signedIn: boolean) => void
): CliSignins {
  return createCliSignins({
    installed: (cli) =>
      target.sh(`command -v ${PROVIDERS[cli].bin}`).then(
        () => true,
        () => false
      ),
    signedIn: (cli) => isSignedIn(target, cli),
    signOut: (cli) => signOut(target, cli),
    claudeFlow: (onDone) => new ClaudeLoginFlow(RUNNER_SIGNIN_SLUG, target, onDone),
    codexFlow: (onDone) => new CodexLoginFlow(RUNNER_SIGNIN_SLUG, target, onDone),
    changed
  });
}
