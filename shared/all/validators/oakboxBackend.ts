import { z } from 'zod';

import { ASK_IMAGE_TYPES } from '../domains/electron';
import { aiCliSchema, aiSourceSchema } from './aiSource';
import { ollamaTagSchema } from './runnerParts';

// The settings Factiii and Oakbox share (.specs/vault.md "Shared settings"):
// one record per account, each setting stored once, so every app and device
// follows it. Ids and choices only, never content. The record is still named
// for Oakbox's Backend, where it began.

/** Where NEW items go (.specs/vault.md "The default location"): Factiii
 *  Cloud, the runner's Runner Cloud, or its Vault. A new account is on
 *  Cloud. Replaced the backend mode (FACTIII/RUNNER) on 2026-11-11. */
export const DATA_LOCATIONS = ['CLOUD', 'RUNNER', 'VAULT'] as const;

export const dataLocationSchema = z.enum(DATA_LOCATIONS);

export type DataLocation = z.infer<typeof dataLocationSchema>;

/** The backend mode, as an app from before the default location sends and
 *  reads it: FACTIII is a Cloud default, RUNNER a runner one. HYBRID
 *  ("Both", older still) became Factiii with its computer. */
export const legacyBackendModeSchema = z
  .enum(['FACTIII', 'RUNNER', 'HYBRID'])
  .transform((mode) => (mode === 'HYBRID' ? 'FACTIII' : mode));

export type LegacyBackendMode = 'FACTIII' | 'RUNNER';

/** The mode an older app reads for a default location. */
export const legacyBackendMode = (location: DataLocation): LegacyBackendMode =>
  location === 'CLOUD' ? 'FACTIII' : 'RUNNER';

/** The default an older app's mode saves: FACTIII is Cloud; RUNNER keeps a
 *  runner default already saved (it cannot tell Runner Cloud from the
 *  Vault), else the Vault, which the old Runner mode is (Jon, 2026-11-11,
 *  q21). */
export const locationFromLegacyMode = (
  mode: LegacyBackendMode,
  saved: DataLocation
): DataLocation => {
  if (mode === 'FACTIII') return 'CLOUD';
  return saved === 'CLOUD' ? 'VAULT' : saved;
};

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

/** A runner's refusal of a `cliOnly` prompt: no Claude or Codex signed in.
 *  The client asks before using the runner's Ollama model instead. */
export const AI_NO_CLI_SIGNED_IN =
  'No Claude or Codex is signed in on this runner.';

/** The longest prompt a Factiii AI feature sends a runner (`aiPrompt`). */
export const AI_PROMPT_MAX_CHARS = 40_000;

/** At most this many images go with one `aiPrompt`. */
export const AI_PROMPT_IMAGE_MAX_COUNT = 2;
/** Per image, decoded. The client shrinks a screenshot to 1568 px first, so
 *  a real one is far smaller. */
export const AI_PROMPT_IMAGE_MAX_BYTES = 5_000_000;
const AI_PROMPT_IMAGE_MAX_CHARS = Math.ceil(
  (AI_PROMPT_IMAGE_MAX_BYTES * 4) / 3
);

const BASE64_SLICE_CHARS = 32_768;
const BASE64_BODY = /^[A-Za-z0-9+/]+$/;

/** Base64 with up to two `=` at the end, checked a slice at a time: one
 *  regex over megabytes overflows the stack on some Node builds (the same
 *  check as `checkAskImages`). */
const isBase64 = (data: string): boolean => {
  let end = data.length;
  if (data.endsWith('==')) end -= 2;
  else if (data.endsWith('=')) end -= 1;
  if (end === 0) return false;
  for (let at = 0; at < end; at += BASE64_SLICE_CHARS) {
    if (
      !BASE64_BODY.test(data.slice(at, Math.min(at + BASE64_SLICE_CHARS, end)))
    )
      return false;
  }
  return true;
};

/** One image with an `aiPrompt`: its type and bare base64 (no `data:`). */
export const aiPromptImageSchema = z
  .object({
    mediaType: z.enum(ASK_IMAGE_TYPES),
    data: z.string().min(1).max(AI_PROMPT_IMAGE_MAX_CHARS).refine(isBase64, {
      message: 'Invalid image data.'
    })
  })
  .strict();
export type AiPromptImage = z.infer<typeof aiPromptImageSchema>;

/** A runner's refusal of images for an Ollama model that cannot see. */
export const AI_MODEL_NO_VISION =
  'This Ollama model cannot read images. Pick a vision model (such as qwen2.5vl or llama3.2-vision) in Settings > AI.';

/** What a runner answers `aiPromptInfo` with: which of its engines read
 *  images with an `aiPrompt`. A runner from before it answers with an error,
 *  which the client reads as none. `ollama` is for the model asked about
 *  (Backend's), else the one it would use. */
export type AiPromptInfo = {
  images: { claude: boolean; codex: boolean; ollama: boolean };
};

export const aiPromptInfoPayloadSchema = z
  .object({ model: ollamaTagSchema.nullable().optional() })
  .strict();
export type AiPromptInfoPayload = z.infer<typeof aiPromptInfoPayloadSchema>;

/** Factiii's AI features on the person's own runner (.specs/oakbox.md
 *  "Backend" → AI features): a prompt in, text out, no tools. `engine`
 *  picks one; none lets the runner choose (a signed-in Claude, then Codex,
 *  then an Ollama model). The CLIs' settings are Account > Backend's. */
export const aiPromptPayloadSchema = z
  .object({
    prompt: z.string().trim().min(1).max(AI_PROMPT_MAX_CHARS),
    engine: z.enum(['claude', 'codex', 'ollama']).optional(),
    /** With no `engine`: a signed-in Claude or Codex only. With neither
     *  signed in the runner refuses with `AI_NO_CLI_SIGNED_IN` instead of
     *  answering with its Ollama model, so the client can ask the person
     *  first (Jon 2026-11-09, card c37 q2). */
    cliOnly: z.boolean().optional(),
    /** The Ollama model to use; none is Account > Backend's, else the
     *  first on the runner. */
    model: ollamaTagSchema.nullable().optional(),
    claude: claudeAskSettingsSchema.optional(),
    codex: codexAskSettingsSchema.optional(),
    /** Images the model reads with the prompt (a screenshot for the Dark
     *  Patterns suggestion). A runner from before it refuses the field
     *  (strict), so the client sends it only to a runner whose
     *  `aiPromptInfo` says it reads images (.specs/ai-source.md). */
    images: z
      .array(aiPromptImageSchema)
      .min(1)
      .max(AI_PROMPT_IMAGE_MAX_COUNT)
      .optional()
  })
  .strict();

export type AiPromptPayload = z.infer<typeof aiPromptPayloadSchema>;

export const oakboxBackendSetSchema = z.object({
  /** Where new items go. Absent from an app from before it, which sends
   *  `mode`; with neither, the saved one is kept. */
  defaultLocation: dataLocationSchema.optional(),
  /** An older app's backend mode (`locationFromLegacyMode`). Ignored when
   *  `defaultLocation` is sent. */
  mode: legacyBackendModeSchema.optional(),
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
  aiOnRunner: z.boolean().optional(),
  /** Where Factiii's AI features run by default (.specs/ai-source.md).
   *  Absent from an app from before it: `aiOnRunner` sets it. */
  aiSource: aiSourceSchema.optional(),
  /** On RUNNER, the CLI it uses ("Runner · Codex"); null lets the runner
   *  pick. Absent from an app from before it: the saved one is kept. */
  aiCli: aiCliSchema.nullable().optional(),
  /** The runner a RUNNER or OLLAMA default runs on ("Runner · Mac Mini 2 ·
   *  Claude Code"); one of the account's own. Null is Oakbox's runner, else
   *  the first online. Absent from an app from before it: the saved one is
   *  kept. */
  aiRunnerId: z.number().int().positive().nullable().optional()
});
