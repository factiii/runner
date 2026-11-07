import { mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

import { runnerDir } from './runner-dir';

// The runner's own Claude Code and Codex homes (CLAUDE_CONFIG_DIR, CODEX_HOME).
//
// Why the runner has its own: the factiii plugin installs at USER scope, and
// in the default homes (~/.claude, ~/.codex) that loaded it into every session
// the person started on the machine, outside the runner too. In homes of the
// runner's own it loads only in runner sessions. The cost is one sign-in per
// machine inside the runner: the default homes' logins are not shared or
// linked, so the person's own sessions and the runner's stay separate.
//
// One pair per runner dir, shared by every board on it (and by the desktop
// app, which uses the same runner dir). A dev runner (FACTIII_RUNNER_DIR) gets
// its own pair, like its own Keychain key.

export const CLAUDE_HOME_ENV = 'CLAUDE_CONFIG_DIR';
export const CODEX_HOME_ENV = 'CODEX_HOME';

/** The runner-dir subfolder that holds both homes. */
const AGENT_HOME_DIR = 'agent-home';

export type AgentHomes = { claude: string; codex: string };

/** The runner's own homes: `<runnerDir>/agent-home/{claude,codex}`. */
export function agentHomes(env: NodeJS.ProcessEnv = process.env): AgentHomes {
  const base = path.join(runnerDir(env), AGENT_HOME_DIR);
  return { claude: path.join(base, 'claude'), codex: path.join(base, 'codex') };
}

/** The CLIs' own defaults, used when neither var is set: `~/.claude` and
 *  `~/.codex`. */
export function defaultAgentHomes(home: string = os.homedir()): AgentHomes {
  return {
    claude: path.join(home, '.claude'),
    codex: path.join(home, '.codex')
  };
}

/** The homes a CLI spawned from this env would use. After `applyAgentHomes`
 *  that is the runner's pair; the default pair is the fallback for a process
 *  that never applied them (a test, a script). Every path that names a CLI's
 *  config dir reads it from here, never from os.homedir(). */
export function cliHomes(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): AgentHomes {
  const fallback = defaultAgentHomes(home);
  return {
    claude: env[CLAUDE_HOME_ENV]?.trim() || fallback.claude,
    codex: env[CODEX_HOME_ENV]?.trim() || fallback.codex
  };
}

/** claude's global state file, which holds the first-run (onboarding) flag:
 *  `$CLAUDE_CONFIG_DIR/.claude.json` when the var is set, else
 *  `~/.claude.json` beside (not inside) `~/.claude`. Checked against claude
 *  2.1.300, which writes it there with the var set. */
export function claudeJsonPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string {
  const dir = env[CLAUDE_HOME_ENV]?.trim();
  return dir ? path.join(dir, '.claude.json') : path.join(home, '.claude.json');
}

/** Both vars, for an env a session gets (`stateEnv`), from this process's
 *  env. Empty when they were never applied, so a test or a script that did
 *  not call `applyAgentHomes` hands its children nothing new. */
export function agentHomeEnv(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const out: Record<string, string> = {};
  const claude = env[CLAUDE_HOME_ENV]?.trim();
  const codex = env[CODEX_HOME_ENV]?.trim();
  if (claude) out[CLAUDE_HOME_ENV] = claude;
  if (codex) out[CODEX_HOME_ENV] = codex;
  return out;
}

/**
 * Create the runner's homes (0700) and point this process's env at them.
 *
 * Called once, first thing, by the runner CLI and the desktop main process:
 * every path to a CLI (`target.sh`, `target.spawn`, the tmux server, sign-in,
 * sign-in checks, the plugin and rules lanes) inherits process.env, so setting
 * it here, before anything spawns, covers all of them.
 *
 * A value the person already set in the runner's own environment is
 * OVERRIDDEN, not kept: the runner's home must be its own. Kept, a
 * CLAUDE_CONFIG_DIR exported for the person's own sessions would bring the
 * plugin back into them, which is what this exists to stop.
 */
export function applyAgentHomes(
  env: NodeJS.ProcessEnv = process.env
): AgentHomes {
  const homes = agentHomes(env);
  for (const dir of [homes.claude, homes.codex]) {
    // Best effort: a home that cannot be made fails at the CLI's first use
    // with its own message, which beats a runner that will not start.
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // See above.
    }
  }
  env[CLAUDE_HOME_ENV] = homes.claude;
  env[CODEX_HOME_ENV] = homes.codex;
  return homes;
}
