import { z } from 'zod';

// Where one of Factiii's AI features runs (.specs/ai-source.md):
// - TRONS: Factiii's models on Factiii's server, charged in Trons.
// - RUNNER: the person's own runner, with its signed-in Claude or Codex CLI.
// - OLLAMA: the person's own runner, with its Ollama model.
// - OPENROUTER: Factiii's server, with the person's own OpenRouter key in
//   place of Factiii's provider keys. No Trons.

export const AI_SOURCES = ['TRONS', 'RUNNER', 'OLLAMA', 'OPENROUTER'] as const;
export const aiSourceSchema = z.enum(AI_SOURCES);
export type AiSource = z.infer<typeof aiSourceSchema>;

/** The CLIs a RUNNER source can name: the runner's signed-in Claude Code or
 *  Codex. None named lets the runner pick (Claude, then Codex). */
export const AI_CLIS = ['claude', 'codex'] as const;
export const aiCliSchema = z.enum(AI_CLIS);
export type AiCli = z.infer<typeof aiCliSchema>;

/** The sources whose model runs on the person's runner, reached from the
 *  client over the direct link, never by the server. */
export const RUNNER_AI_SOURCES = ['RUNNER', 'OLLAMA'] as const;
export const isRunnerAiSource = (
  source: AiSource
): source is (typeof RUNNER_AI_SOURCES)[number] =>
  source === 'RUNNER' || source === 'OLLAMA';

/** The longest answer a client hands back from its runner. */
export const AI_RUNNER_ANSWER_MAX_CHARS = 100_000;

/**
 * How a server AI route is asked to run (`ai` on its input). Absent is
 * TRONS, for apps from before it. On a runner source the route answers
 * `{ runnerPrompt }` first; the client asks its runner and calls again with
 * `answer`, which the route checks and saves exactly as it would a Trons
 * answer, charging nothing.
 */
export const aiRouteInputSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('TRONS') }),
  z.object({ source: z.literal('OPENROUTER') }),
  z.object({
    source: z.enum(RUNNER_AI_SOURCES),
    answer: z.string().max(AI_RUNNER_ANSWER_MAX_CHARS).optional()
  })
]);
export type AiRouteInput = z.infer<typeof aiRouteInputSchema>;

/** A route's first answer on a runner source: the prompt to run there. */
export type AiRunnerPrompt = { runnerPrompt: string };

/** Who answered an OpenRouter call and what OpenRouter billed for it
 *  (.specs/ai-source.md): the model that actually ran (the completion's
 *  `model`, so `openrouter/auto`'s pick), its display name when OpenRouter's
 *  model list is to hand, and the call's cost in USD (`usage.cost`), null
 *  when OpenRouter did not say. Null on every other source. */
export type AiAnsweredBy = {
  model: string;
  name: string | null;
  costUsd: number | null;
};

/** What one AI call cost, on every route's answer. */
export type AiSpend = {
  chargedTrons: number;
  answeredBy: AiAnsweredBy | null;
};

// ── OpenRouter on Connected Apps ──

/** An OpenRouter key as OpenRouter issues them ("sk-or-v1-…"). */
export const openRouterKeySchema = z
  .string()
  .trim()
  .regex(/^sk-or-[A-Za-z0-9_-]{10,200}$/, 'That is not an OpenRouter key.');

/** An OpenRouter model id ("anthropic/claude-sonnet-4.5"); null is
 *  OpenRouter's own router. */
export const openRouterModelSchema = z
  .string()
  .trim()
  .max(120)
  .regex(
    /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    'Use an OpenRouter model id, like anthropic/claude-sonnet-4.5.'
  );

export const openRouterConnectSchema = z.object({
  key: openRouterKeySchema,
  model: openRouterModelSchema.nullable().optional()
});

export const openRouterSetModelSchema = z.object({
  model: openRouterModelSchema.nullable()
});
