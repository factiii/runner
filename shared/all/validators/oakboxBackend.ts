import { z } from 'zod';

import { ollamaTagSchema } from './runnerParts';

// How Oakbox works for an account (.specs/oakbox.md "Backend"): on Factiii's
// servers (with a computer of the person's own searched beside them, if one is
// chosen), or on that computer alone. Kept on the account, so every device the
// person signs in on works the same way. A mode and ids only, never content.

const OAKBOX_BACKEND_MODES = ['FACTIII', 'RUNNER'] as const;

const oakboxBackendModeSchema = z.enum(OAKBOX_BACKEND_MODES);

/** What `set` takes: an app from before the two modes may still send
 *  HYBRID ("Both"), which became Factiii with its computer. */
const oakboxBackendModeInputSchema = z
  .enum([...OAKBOX_BACKEND_MODES, 'HYBRID'])
  .transform((mode) => (mode === 'HYBRID' ? 'FACTIII' : mode));

// Claude and Codex in Ask on a runner (.specs/runner-vault-ask.md "Oakbox's
// backend: setup, sign-ins, models"): the model and effort each runs with, picked in Account >
// Backend. Fixed lists, so nothing typed ever reaches a CLI's command line.
// Null is the CLI's own default.

/** What `claude --model` takes as an alias for the latest of each. */
export const CLAUDE_ASK_MODELS = ['opus', 'sonnet', 'haiku'] as const;
/** `claude --effort`, as card AI offers it (cardAIModalReducer). */
export const CLAUDE_ASK_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
/** `codex -m`: the current models in Codex's own catalog
 *  (`codex debug models`). */
export const CODEX_ASK_MODELS = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-luna'
] as const;
/** Codex's `model_reasoning_effort`: the levels every model above takes. */
export const CODEX_ASK_EFFORTS = ['low', 'medium', 'high'] as const;

export const claudeAskSettingsSchema = z
  .object({
    model: z.enum(CLAUDE_ASK_MODELS).nullable(),
    effort: z.enum(CLAUDE_ASK_EFFORTS).nullable()
  })
  .strict();

export const codexAskSettingsSchema = z
  .object({
    model: z.enum(CODEX_ASK_MODELS).nullable(),
    effort: z.enum(CODEX_ASK_EFFORTS).nullable()
  })
  .strict();

/** One turn's settings, for the engine it runs on. */
export type CliAskSettings =
  | z.infer<typeof claudeAskSettingsSchema>
  | z.infer<typeof codexAskSettingsSchema>;

/** The longest prompt a Factiii AI feature sends a runner (`aiPrompt`). */
export const AI_PROMPT_MAX_CHARS = 40_000;

/** Factiii's AI features on the person's own runner (.specs/oakbox.md
 *  "Backend" → AI features): a prompt in, text out, no tools. `engine`
 *  picks one; none lets the runner choose (a signed-in Claude, then Codex,
 *  then an Ollama model). The CLIs' settings are Account > Backend's. */
export const aiPromptPayloadSchema = z
  .object({
    prompt: z.string().trim().min(1).max(AI_PROMPT_MAX_CHARS),
    engine: z.enum(['claude', 'codex', 'ollama']).optional(),
    /** The Ollama model to use; none is Account > Backend's, else the
     *  first on the runner. */
    model: ollamaTagSchema.nullable().optional(),
    claude: claudeAskSettingsSchema.optional(),
    codex: codexAskSettingsSchema.optional()
  })
  .strict();

export type AiPromptPayload = z.infer<typeof aiPromptPayloadSchema>;

export const oakboxBackendSetSchema = z.object({
  mode: oakboxBackendModeInputSchema,
  /** The runner Oakbox uses; one of the account's own. */
  runnerId: z.number().int().positive().nullable(),
  /** The Ollama model Ask starts on, on that runner. */
  model: ollamaTagSchema.nullable(),
  // Absent from an app from before them: the saved ones are kept.
  claudeModel: z.enum(CLAUDE_ASK_MODELS).nullable().optional(),
  claudeEffort: z.enum(CLAUDE_ASK_EFFORTS).nullable().optional(),
  codexModel: z.enum(CODEX_ASK_MODELS).nullable().optional(),
  codexEffort: z.enum(CODEX_ASK_EFFORTS).nullable().optional(),
  /** Factiii's AI features run on the runner by default, not on Trons.
   *  Absent from an app from before it: the saved one is kept. */
  aiOnRunner: z.boolean().optional()
});

export type OakboxBackendMode = z.infer<typeof oakboxBackendModeSchema>;
