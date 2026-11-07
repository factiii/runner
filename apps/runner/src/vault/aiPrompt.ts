import { aiPromptPayloadSchema, type CliAskSettings } from '@shared/all/validators';

import type { AskEngines } from './ask';

// Factiii's AI features on the owner's runner (.specs/oakbox.md "Backend" →
// AI features): a recording's title, asked of the person's own Claude, Codex
// or Ollama instead of Factiii's model on Trons. A prompt in, the answer's
// text out, no tools and no Vault. The daemon answers it before any board,
// for the owner only, and never on the relay (RUNNER_AI_ACTIONS).

type Engine = 'claude' | 'codex' | 'ollama';

/** What answering one needs of the machine's engines (askEngines.ts). */
export type AiPromptEngines = Pick<
  AskEngines,
  'clis' | 'signedIn' | 'ollamaModels' | 'ollama'
> & {
  /** Claude or Codex with no tools; resolves the whole answer. */
  cliPlain(
    engine: 'claude' | 'codex',
    prompt: string,
    settings?: CliAskSettings,
    signal?: AbortSignal
  ): Promise<string>;
};

export const NO_AI_ON_RUNNER =
  'This runner has no AI to use: sign Claude or Codex in, or add a model, under Account > Backend.';

/** The engine that answers: the one asked for, else a signed-in Claude, then
 *  Codex, then the Ollama model asked for or the first on the machine. */
async function pickEngine(
  engines: AiPromptEngines,
  asked: Engine | undefined,
  model: string | null | undefined
): Promise<{ engine: Engine; model: string | null }> {
  const ollamaModel = async () => {
    const held = await engines.ollamaModels();
    return model && held.includes(model) ? model : (held[0] ?? null);
  };
  if (asked === 'ollama') {
    const tag = await ollamaModel();
    if (!tag) throw new Error(NO_AI_ON_RUNNER);
    return { engine: 'ollama', model: tag };
  }
  if (asked) return { engine: asked, model: null };
  for (const cli of await engines.clis()) {
    if (!engines.signedIn || (await engines.signedIn(cli))) {
      return { engine: cli, model: null };
    }
  }
  const tag = await ollamaModel();
  if (!tag) throw new Error(NO_AI_ON_RUNNER);
  return { engine: 'ollama', model: tag };
}

/** Answer one `aiPrompt`. Throws a refusal the client shows (a bad payload,
 *  no engine) or the engine's own error. */
export async function answerAiPrompt(
  engines: AiPromptEngines,
  payload: unknown,
  signal?: AbortSignal
): Promise<{ text: string; engine: Engine }> {
  const parsed = aiPromptPayloadSchema.safeParse(payload ?? {});
  if (!parsed.success) throw new Error('An AI request needs a prompt.');
  const { prompt, engine: asked, model, claude, codex } = parsed.data;
  const { engine, model: tag } = await pickEngine(engines, asked, model);
  if (engine === 'ollama') {
    const text = await engines.ollama(
      tag ?? '',
      [{ role: 'user', content: prompt }],
      () => {},
      undefined,
      signal
    );
    return { text: text.trim(), engine };
  }
  const settings = engine === 'claude' ? claude : codex;
  const text = await engines.cliPlain(engine, prompt, settings, signal);
  return { text: text.trim(), engine };
}
