import { isSignedIn } from './agent';
import { agentHomeEnv } from './agent-homes';
import type { ExecTarget } from './exec';
import type { AgentProvider } from './providers';
import {
  safeTmuxName,
  startTmuxSession,
  tmuxCli,
  type TmuxSession
} from './tmux';

// One-click sign-in plumbing. Both CLIs reject piped stdin for login, so each
// runs in its own tmux session on a real terminal (see tmux.ts).

export type LoginExec = {
  target: ExecTarget;
  session: TmuxSession;
};

/** Per-space, per-provider login session name. */
function loginSessionName(provider: AgentProvider, spaceSlug: string): string {
  return safeTmuxName(`factiii-login-${provider}-${spaceSlug}`);
}

/** Run the provider's login in a dedicated tmux session. It writes its
 *  credential to the runner's CLI home (agent-homes.ts), so one sign-in serves
 *  every mode and every board on the machine. */
export async function startLoginExec(opts: {
  provider: AgentProvider;
  spaceSlug: string;
  target: ExecTarget;
  cmd: string[];
}): Promise<LoginExec> {
  const { target, provider } = opts;
  const name = loginSessionName(provider, opts.spaceSlug);

  // A login is always a fresh attempt; never attach to a stale one.
  await target.sh(
    `${tmuxCli(target)} kill-session -t ${name} 2>/dev/null || true`
  );

  const session = await startTmuxSession({
    target,
    session: name,
    argv: opts.cmd,
    // Wide window so URLs and codes never line-wrap mid-token.
    size: { cols: 500, rows: 50 },
    // On the session, not left to the server's env: a tmux server started by
    // an older runner has none, and the login would land in the default home.
    env: agentHomeEnv()
  });

  return { target, session };
}

/** Kill a login session. Best-effort. */
export async function stopLoginExec(
  target: ExecTarget,
  provider: AgentProvider,
  spaceSlug: string
): Promise<void> {
  const name = loginSessionName(provider, spaceSlug);
  await target
    .sh(`${tmuxCli(target)} kill-session -t ${name} 2>/dev/null || true`)
    .catch(() => {
      // already gone
    });
}

/** Ground truth for whether a sign-in worked. */
export async function loginCredentialsExist(
  provider: AgentProvider,
  target: ExecTarget
): Promise<boolean> {
  return isSignedIn(target, provider);
}
