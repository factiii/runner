import { z } from 'zod';

import { LOCAL_AI_MODEL_IDS } from '../helpers/localAiModels';

// The runner's installable parts (.specs/runner-setup.md "Parts and modules"). One
// list for the runner's registry (apps/runner/src/parts.ts), its CLI and the
// app, so a part one side names is never unknown to another.

const RUNNER_PART_IDS = [
  'connector',
  'terminals',
  'claude',
  'codex',
  'secrets',
  'simulator',
  'local-ai',
  // Vault storage and Vault search together, for apps from before modules.
  'vault',
  // Sent only inside `modules`: a shipped app looks up an icon per part id.
  'vault-storage',
  'vault-search',
  // The Local AI module's model, pulled into Ollama.
  'local-ai-model'
] as const;

const RUNNER_PART_ACTIONS = ['add', 'remove', 'start', 'stop'] as const;

/** The groups the parts are installed in ("Runner modules" in the spec). */
const RUNNER_MODULE_IDS = [
  'bare',
  'coding',
  'private-vault',
  'local-ai'
] as const;

export const RUNNER_MODULE_ACTIONS = ['add', 'remove'] as const;

export const runnerPartIdSchema = z.enum(RUNNER_PART_IDS);
export const runnerModuleIdSchema = z.enum(RUNNER_MODULE_IDS);
export const localAiModelIdSchema = z.enum(LOCAL_AI_MODEL_IDS);
/** One part's action, or a whole module's: every sub-part in order. */
export const runnerPartActionSchema = z.union([
  z.object({
    partId: runnerPartIdSchema,
    action: z.enum(RUNNER_PART_ACTIONS)
  }),
  z.object({
    moduleId: runnerModuleIdSchema,
    action: z.enum(RUNNER_MODULE_ACTIONS)
  })
]);

/** Nuke a runner (.specs/runner-setup.md "Nuke a runner"). The phrase is kept
 *  as typed, never trimmed or case-folded, so the runner can refuse it as
 *  typed (nukePhraseMatches compares it exactly). */
export const runnerNukeSchema = z
  .object({
    confirm: z.boolean().optional(),
    phrase: z.string().max(200).optional()
  })
  .strict();
export type RunnerNukePayload = z.infer<typeof runnerNukeSchema>;

/** Free up space (.specs/runner-setup.md "Machine health and Free up space"): without `confirm`
 *  a dry run that lists what would go; with it, only the listed `ids` the
 *  owner saw are removed. */
export const machineCleanupSchema = z.object({
  confirm: z.boolean().optional(),
  /** A dry run of the biggest folders only (diskCaches.ts): slow, so asked
   *  for apart from the plan. */
  usage: z.boolean().optional(),
  ids: z.array(z.string().max(300)).max(200).optional()
});

/** An Ollama model as `ollama pull` takes it, from Ollama's own library:
 *  `name`, `name:tag` or `namespace/name:tag` (Oakbox > Account > Backend,
 *  .specs/runner-vault-ask.md "Oakbox's backend: setup, sign-ins, models"). Every part starts with a letter
 *  or a digit, so a name can never read as a flag, and the runner spawns
 *  Ollama without a shell. A namespace is an ollama.com user name, which may
 *  have capitals ("RizwanMalik/…"); a model's own name may not. */
export const OLLAMA_TAG_PATTERN =
  /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}(?::[a-zA-Z0-9][a-zA-Z0-9._-]{0,63})?$/;
export const ollamaTagSchema = z
  .string()
  .trim()
  .regex(OLLAMA_TAG_PATTERN, 'That is not an Ollama model name.');

/** A model on ollama.com without a tag: `name` or `namespace/name`. The
 *  runner puts it in an ollama.com path, so the same rule keeps out `..`,
 *  slashes beyond the one, and anything but a name. */
export const OLLAMA_NAME_PATTERN =
  /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/;
export const ollamaNameSchema = z
  .string()
  .trim()
  .regex(OLLAMA_NAME_PATTERN, 'That is not an Ollama model name.');

/** Pull any Ollama model onto a runner, or remove one it holds. */
export const localAiActSchema = z.object({
  action: z.enum(['pull', 'remove']),
  tag: ollamaTagSchema
});

/** Search ollama.com through the runner: a query (empty for its popular
 *  list), or one model's tags. */
export const localAiSearchSchema = z.union([
  z.object({ query: z.string().trim().max(100) }).strict(),
  z.object({ name: ollamaNameSchema }).strict()
]);

export type RunnerPartId = z.infer<typeof runnerPartIdSchema>;
export type RunnerPartAction = (typeof RUNNER_PART_ACTIONS)[number];
export type RunnerModuleId = z.infer<typeof runnerModuleIdSchema>;
export type RunnerModuleAction = (typeof RUNNER_MODULE_ACTIONS)[number];
export type RunnerPartsActPayload = z.infer<typeof runnerPartActionSchema>;
export type MachineCleanupPayload = z.infer<typeof machineCleanupSchema>;

/** keepAwakeSet (apps/runner/src/keepAwake.ts): on or off, until a time
 *  (ms since epoch) or null for until turned off; `auto` holds only while
 *  work runs, `ac` only while the Mac is on power (until is then null). */
export const keepAwakeSetSchema = z.object({
  on: z.boolean(),
  until: z.number().finite().nullable(),
  display: z.boolean().optional(),
  auto: z.boolean().optional(),
  ac: z.boolean().optional()
});

/** runnerLogs (.specs/runner-window.md "Remote connections"): which log, and
 *  how many of its last lines. The runner clamps `lines` (1..2000, 200 when
 *  absent) and reads a service only by a name its own services list has. */
export const runnerLogsSchema = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('service'),
      service: z.enum(['docker', 'port', 'pm2', 'launchd']),
      name: z.string().min(1).max(256)
    }),
    z.object({ kind: z.literal('embedder') }),
    z.object({
      kind: z.literal('session'),
      spaceSlug: z.string().min(1).max(128),
      postId: z.string().min(1).max(128),
      tabId: z.string().min(1).max(64).optional()
    })
  ]),
  lines: z.number().finite().optional()
});

/** Why a runner let its Mac sleep: automatic found no work for its grace
 *  period, or "While plugged in" saw the Mac go on battery. */
const RUNNER_SLEEP_REASONS = ['idle', 'battery'] as const;

/** The most sessions a "going to sleep" snapshot carries. */
export const RUNNER_SLEEP_MAX_SESSIONS = 20;

/** `runner:going-to-sleep` (.specs/runner-keep-awake.md "Asleep, not Offline"):
 *  what the runner was doing as it let its Mac sleep. The server keeps it on
 *  the runner's row and shows it, with "Asleep", until the runner is back.
 *  Titles only, never a diff or a terminal's output. */
export const runnerSleepSnapshotSchema = z.object({
  reason: z.enum(RUNNER_SLEEP_REASONS),
  version: z.string().max(32),
  sessions: z
    .array(
      z.object({
        spaceSlug: z.string().max(128),
        postId: z.string().max(64),
        title: z.string().max(200),
        /** The pipeline phase, or '' for none. */
        phase: z.string().max(32),
        agentState: z.enum(['working', 'idle', 'blocked']).nullable(),
        /** When the runner last heard from it (ms since epoch). */
        at: z.number().finite()
      })
    )
    .max(RUNNER_SLEEP_MAX_SESSIONS),
  /** Jobs still running as it let go (a deploy, an install). */
  jobs: z.number().int().min(0).max(1000),
  /** When the runner last saw work (ms since epoch), or null for never. */
  lastWorkAt: z.number().finite().nullable(),
  /** The Mac's power, or null where it cannot tell. */
  battery: z
    .object({
      ac: z.boolean().nullable(),
      percent: z.number().min(0).max(100).nullable()
    })
    .nullable(),
  /** The keep-awake mode that let go. */
  keepAwake: z.enum(['auto', 'ac'])
});
export type RunnerSleepSnapshot = z.infer<typeof runnerSleepSnapshotSchema>;
export type LocalAiActPayload = z.infer<typeof localAiActSchema>;
export type LocalAiSearchPayload = z.infer<typeof localAiSearchSchema>;
