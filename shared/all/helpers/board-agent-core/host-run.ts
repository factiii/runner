import type { ChildProcess } from 'child_process';
import path from 'path';

import type { CardAITodo } from '../../domains/electron';
import { spawnAgent } from './agent';
import { hostTarget } from './exec';
import {
  checkDeployStatus,
  ensureClaudeSkillLink,
  hostGit,
  spaceEnv
} from './host-deploy';
import prompts from './prompts.json';
import { type AgentProvider, SECRETS_TOKEN_ENV } from './providers';
import { DEPLOY_ORIGIN, type SecretsGate } from './secrets-gate';

// The deploy run executor (see .specs/deploy.md "Run"). The merged skill is
// the program; the harness owns the protocol: TodoWrite = timeline,
// AWAITING_INPUT = human gate, and `factiii-secrets run` = owner authorizes
// and the runner injects/executes/redacts. The password never enters the
// session.

const HUMAN_MARKER = 'AWAITING_INPUT:';
const COMPLETE_MARKER = 'DEPLOY_COMPLETE:';
const FAILED_MARKER = 'DEPLOY_FAILED:';
// A turn ending with no marker is NOT success - the agent may have stalled
// (e.g. backgrounded a task and ended its turn). Nudge it to continue, and
// only give up after several markerless turns.
const MAX_MARKERLESS_TURNS = 3;

// Only honor markers in the message tail (last 2000 chars), and the one
// appearing LAST wins: a quoted earlier AWAITING_INPUT must never outrank the
// DEPLOY_COMPLETE the message actually ends with.
function tailMarker(text: string): { marker: string; value: string } | null {
  const zone = text.slice(-2000);
  let best: { marker: string; at: number } | null = null;
  for (const marker of [HUMAN_MARKER, COMPLETE_MARKER, FAILED_MARKER]) {
    const at = zone.lastIndexOf(marker);
    if (at !== -1 && (!best || at > best.at)) best = { marker, at };
  }
  if (!best) return null;
  const value = zone.slice(best.at + best.marker.length).trim();
  return value ? { marker: best.marker, value } : null;
}

export type DeployRunHooks = {
  sendLog: (entry: { type: string; content: string }) => void;
  onTodos: (todos: CardAITodo[]) => void;
  /** Pause on a human gate; resolves with the owner's answer. */
  requestHuman: (question: string) => Promise<string>;
  isCancelled: () => boolean;
  /** ChildProcess (not a kill-shaped structural type): cancelling must reap
   *  the whole process group via killTree, which needs the real pid. */
  registerProc: (proc: ChildProcess | null) => void;
};

export async function startDeployRun(opts: {
  spaceDir: string;
  repoUrl: string;
  mainBranch?: string;
  githubToken: string;
  provider: AgentProvider;
  /** The branch this release ships, picked in the Deploy modal. Empty means
   *  the owner did not choose one and the skill asks during the run. */
  releaseBranch?: string;
  /** The space's authorization gate. The run only issues its own token on it:
   *  `factiii-secrets run` goes straight to the bridge the engine serves,
   *  which is why a release does not own the socket. */
  gate: SecretsGate;
  hooks: DeployRunHooks;
}): Promise<{ shipped: boolean; summary: string }> {
  const { hooks } = opts;
  const workspace = path.join(opts.spaceDir, 'workspace');

  const status = await checkDeployStatus(opts);
  if (!status.hasSkill || !status.hasVariables || !status.hasChecker) {
    throw new Error(
      'The deploy contract is not on the default branch. Generate and merge the deploy skill first.'
    );
  }

  hooks.sendLog({
    type: 'system',
    content: `Resetting workspace to origin/${status.branch}...`
  });
  await hostGit(
    workspace,
    'checkout',
    '-B',
    status.branch,
    `origin/${status.branch}`
  );
  await hostGit(workspace, 'clean', '-fd');
  // Contracts created before the symlink was committed still resolve for
  // Claude; created after `git clean` so it survives until the spawn.
  await ensureClaudeSkillLink(workspace);

  // The skill checks the branch out itself, AFTER the CLI has loaded the
  // runbook off the default branch - a release branch that predates the skill
  // does not carry it, so checking out here would leave nothing to load.
  const release = (opts.releaseBranch || '').replace(/[^\w./-]/g, '');
  const releaseNote =
    release && release !== status.branch
      ? `The release branch for this run is \`${release}\` - it was chosen in the Deploy modal, so do not ask which branch to ship. Check it out as your first step.`
      : '';
  if (releaseNote) {
    hooks.sendLog({
      type: 'system',
      content: `Release branch: ${release}`
    });
  }

  const contract = prompts.deployRun.join('\n');
  // Each provider loads the skill through its own native discovery: Claude
  // Code expands the /deploy slash skill (via the .claude/skills symlink),
  // Codex picks the skill up from .agents/skills by name.
  const reminder =
    'Reminder: every declared deploy variable is intentionally unset in your shell. Never check for them or abort over them - prefix any command that needs one with `factiii-secrets run --` and the runner injects the values.';
  const opening =
    opts.provider === 'codex'
      ? 'Use the "deploy" skill: load it and execute it step by step.'
      : '/deploy';
  let prompt = [opening, releaseNote, reminder].filter(Boolean).join('\n\n');
  let sessionId = '';
  let markerless = 0;
  // The release timeline outlives any single turn (every gate ends one); seed
  // each resumed turn's parser with it so later TaskUpdates land.
  let todos: CardAITodo[] = [];

  // The bridge behind `factiii-secrets run` belongs to the space, not to this
  // run (engine.ts owns it), so a release is not the only thing that can
  // reach the store.
  // Its own token, so a command this run authorizes says "Deploy run" on the
  // prompt instead of the space's generic session label. Revoked when the run
  // ends: the release is the only thing that should ever wear it.
  const deployToken = opts.gate.issueToken(DEPLOY_ORIGIN);

  try {
    for (;;) {
      if (hooks.isCancelled()) throw new Error('Cancelled by user.');

      const { proc, result } = await spawnAgent(
        opts.provider,
        hostTarget(opts.spaceDir),
        {
          cwd: workspace,
          prompt,
          allowedTools:
            'Bash,Read,Grep,Glob,TodoWrite,WebSearch,WebFetch,Skill',
          // The run's guardrails are structural (merge-gated skill, per-command
          // authorization, runner-side injection); the auto classifier fights
          // legitimate infrastructure commands, so the session itself runs open.
          permissionMode: 'bypassPermissions',
          includePartialMessages: true,
          resumeSessionId: sessionId || undefined,
          appendSystemPrompt: sessionId ? undefined : contract,
          env: {
            ...spaceEnv(opts.spaceDir),
            [SECRETS_TOKEN_ENV]: deployToken
          },
          callbacks: {
            initialTodos: todos,
            onLog: (entry) => hooks.sendLog(entry),
            onTodos: (updated) => {
              todos = updated;
              hooks.onTodos(updated);
            }
          }
        }
      );
      hooks.registerProc(proc);
      const { text, sessionId: sid } = await result;
      hooks.registerProc(null);
      sessionId = sid || sessionId;
      if (hooks.isCancelled()) throw new Error('Cancelled by user.');

      const found = tailMarker(text);

      if (found?.marker === HUMAN_MARKER) {
        markerless = 0;
        prompt = await hooks.requestHuman(found.value);
        continue;
      }

      if (found?.marker === COMPLETE_MARKER) {
        // Explicitly declared shipped - the only path to success. The text
        // after the marker is the agent's run report, kept for the owner.
        return { shipped: true, summary: found.value };
      }

      if (found?.marker === FAILED_MARKER) {
        // The agent stopped without shipping; the report explains where the
        // release stands instead of letting an aborted run present as success.
        return { shipped: false, summary: found.value };
      }

      markerless += 1;
      if (markerless >= MAX_MARKERLESS_TURNS) {
        throw new Error(
          'The run ended without declaring completion (no DEPLOY_COMPLETE after repeated turns).'
        );
      }
      hooks.sendLog({
        type: 'system',
        content: 'Turn ended without a protocol marker - resuming the run...'
      });
      prompt =
        'Your turn ended with no protocol marker. If the release fully shipped, end your message with DEPLOY_COMPLETE: followed by your run report; if you are stopping without shipping, end with DEPLOY_FAILED: followed by the report. Otherwise CONTINUE executing the skill from where you left off. If you had background tasks running, they were killed when your turn ended - rerun them, and reap every background task before ending a turn.';
    }
  } finally {
    // The label is the run, so it must not outlive it: a stale token would
    // let a later session wear the release's name on the owner's prompt.
    opts.gate.revokeToken(deployToken);
  }
}
