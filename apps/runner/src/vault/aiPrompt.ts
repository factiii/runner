import type { AskImage } from '@shared/all/domains/electron';
import {
  AI_MODEL_NO_VISION,
  AI_NO_CLI_SIGNED_IN,
  type AiPromptInfo,
  aiPromptInfoPayloadSchema,
  aiPromptPayloadSchema,
  type CliAskSettings
} from '@shared/all/validators';
import { ollamaModelInUse } from '@shared/all/helpers/oakboxBackend';

import type { AskEngines } from './ask';

// Factiii's AI features on the owner's runner (.specs/oakbox.md "Backend" →
// AI features): a recording's title, asked of the person's own Claude, Codex
// or Ollama instead of Factiii's model on Trons. A prompt in, the answer's
// text out, no tools and no Vault. The daemon answers it before any board,
// for the owner only, and never on the relay (RUNNER_AI_ACTIONS).
//
// A prompt may carry images (a Dark Patterns screenshot): Claude reads them
// inline on stdin and Codex as `--image` files in the run's own private
// folder, removed after (cliPlainAnswer); Ollama in `/api/chat`'s `images`,
// only on a model that can see (`ollamaSeesImages`), else AI_MODEL_NO_VISION.
// `aiPromptInfo` tells the client which engines read them, so an older
// runner, which refuses that action, is never sent one.

type Engine = 'claude' | 'codex' | 'ollama';

/** What answering one needs of the machine's engines (askEngines.ts). */
export type AiPromptEngines = Pick<
  AskEngines,
  'clis' | 'signedIn' | 'ollamaModels' | 'ollama'
> & {
  /** Claude or Codex with no tools; resolves the whole answer. `images`
   *  go with the prompt. */
  cliPlain(
    engine: 'claude' | 'codex',
    prompt: string,
    settings?: CliAskSettings,
    signal?: AbortSignal,
    images?: AskImage[]
  ): Promise<string>;
  /** Whether the Ollama model reads images. */
  ollamaSeesImages(model: string): Promise<boolean>;
};

export const NO_AI_ON_RUNNER =
  'This runner has no AI to use: sign Claude or Codex in, or add a model, under Account > Backend.';

/** The engine that answers: the one asked for, else a signed-in Claude, then
 *  Codex, then the Ollama model asked for or the first on the machine. With
 *  `cliOnly` there is no Ollama step: the client asks the person first. */
async function pickEngine(
  engines: AiPromptEngines,
  asked: Engine | undefined,
  model: string | null | undefined,
  cliOnly = false
): Promise<{ engine: Engine; model: string | null }> {
  // The model asked for while held, else the table's largest held (the rule
  // the client's model list highlights: ollamaModelInUse).
  const ollamaModel = async () =>
    ollamaModelInUse(model ?? null, await engines.ollamaModels());
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
  if (cliOnly) throw new Error(AI_NO_CLI_SIGNED_IN);
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
  const { prompt, engine: asked, model, claude, codex, cliOnly, images } = parsed.data;
  const { engine, model: tag } = await pickEngine(engines, asked, model, cliOnly);
  if (engine === 'ollama') {
    if (images && !(await engines.ollamaSeesImages(tag ?? ''))) {
      throw new Error(AI_MODEL_NO_VISION);
    }
    const text = await engines.ollama(
      tag ?? '',
      [
        {
          role: 'user',
          content: prompt,
          ...(images ? { images: images.map((image) => image.data) } : {})
        }
      ],
      () => {},
      undefined,
      signal
    );
    return { text: text.trim(), engine };
  }
  const settings = engine === 'claude' ? claude : codex;
  const text = await engines.cliPlain(engine, prompt, settings, signal, images);
  return { text: text.trim(), engine };
}

/** Which engines read images with an `aiPrompt` (`aiPromptInfo`). Claude
 *  and Codex both take them; Ollama only on a model that can see: the one
 *  asked about while held, else the one it would use. */
export async function aiPromptInfo(
  engines: AiPromptEngines,
  payload: unknown
): Promise<AiPromptInfo> {
  const parsed = aiPromptInfoPayloadSchema.safeParse(payload ?? {});
  const model = parsed.success ? (parsed.data.model ?? null) : null;
  const tag = ollamaModelInUse(model, await engines.ollamaModels());
  return {
    images: {
      claude: true,
      codex: true,
      ollama: tag ? await engines.ollamaSeesImages(tag) : false
    }
  };
}
