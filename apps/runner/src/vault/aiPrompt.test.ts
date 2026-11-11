import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AI_MODEL_NO_VISION,
  AI_NO_CLI_SIGNED_IN,
  AI_PROMPT_IMAGE_MAX_COUNT
} from '@shared/all/validators';

import {
  type AiPromptEngines,
  aiPromptInfo,
  answerAiPrompt,
  NO_AI_ON_RUNNER
} from './aiPrompt';
import { ollamaSeesImages } from './askEngines';

// Factiii's AI features on a runner (.specs/oakbox.md "Backend" → AI
// features): which engine answers, and with what.

type Call = { engine: string; prompt: string; settings?: unknown; images?: unknown };

function engines(over: Partial<AiPromptEngines> = {}, calls: Call[] = []): AiPromptEngines {
  return {
    clis: async () => ['claude', 'codex'],
    signedIn: async () => true,
    ollamaModels: async () => ['llama3.2:3b'],
    ollama: async (model, messages) => {
      calls.push({
        engine: `ollama:${model}`,
        prompt: messages[0]?.content ?? '',
        ...(messages[0]?.images ? { images: messages[0].images } : {})
      });
      return ' From Ollama \n';
    },
    cliPlain: async (engine, prompt, settings, _signal, images) => {
      calls.push({ engine, prompt, settings, ...(images ? { images } : {}) });
      return `From ${engine}`;
    },
    ollamaSeesImages: async (model) => model.startsWith('llava'),
    ...over
  };
}

describe('aiPrompt', () => {
  it('asks a signed-in Claude first, with its own settings', async () => {
    const calls: Call[] = [];
    const answer = await answerAiPrompt(engines({}, calls), {
      prompt: 'Title this',
      claude: { model: 'haiku', effort: null },
      codex: { model: 'gpt-6-luna', effort: null }
    });
    assert.deepEqual(answer, { text: 'From claude', engine: 'claude' });
    assert.deepEqual(calls, [
      { engine: 'claude', prompt: 'Title this', settings: { model: 'haiku', effort: null } }
    ]);
  });

  it('falls to Codex, then Ollama, as sign-ins go', async () => {
    const codexOnly = engines({ signedIn: async (cli) => cli === 'codex' });
    assert.equal((await answerAiPrompt(codexOnly, { prompt: 'x' })).engine, 'codex');
    const calls: Call[] = [];
    const none = engines({ signedIn: async () => false }, calls);
    assert.deepEqual(await answerAiPrompt(none, { prompt: 'x' }), {
      text: 'From Ollama',
      engine: 'ollama'
    });
    assert.equal(calls[0]?.engine, 'ollama:llama3.2:3b');
  });

  it('refuses rather than falling to Ollama when only a CLI was asked for', async () => {
    const calls: Call[] = [];
    const none = engines({ signedIn: async () => false }, calls);
    await assert.rejects(answerAiPrompt(none, { prompt: 'x', cliOnly: true }), {
      message: AI_NO_CLI_SIGNED_IN
    });
    assert.deepEqual(calls, []);
    const signed = engines({ signedIn: async (cli) => cli === 'codex' });
    assert.equal((await answerAiPrompt(signed, { prompt: 'x', cliOnly: true })).engine, 'codex');
  });

  it('uses the Ollama model asked for only if the runner holds it', async () => {
    const calls: Call[] = [];
    const e = engines({ ollamaModels: async () => ['a:1', 'b:2'] }, calls);
    await answerAiPrompt(e, { prompt: 'x', engine: 'ollama', model: 'b:2' });
    await answerAiPrompt(e, { prompt: 'x', engine: 'ollama', model: 'gone:9' });
    assert.deepEqual(
      calls.map((c) => c.engine),
      ['ollama:b:2', 'ollama:a:1']
    );
  });

  it('with no model asked for, uses the largest table model it holds', async () => {
    const calls: Call[] = [];
    const e = engines(
      { ollamaModels: async () => ['llama3.2:3b', 'qwen2.5:14b', 'zzz:1'] },
      calls
    );
    await answerAiPrompt(e, { prompt: 'x', engine: 'ollama' });
    assert.equal(calls[0]?.engine, 'ollama:qwen2.5:14b');
  });

  it('says so when the runner has nothing to answer with', async () => {
    const bare = engines({
      clis: async () => [],
      ollamaModels: async () => []
    });
    await assert.rejects(answerAiPrompt(bare, { prompt: 'x' }), { message: NO_AI_ON_RUNNER });
  });

  it('refuses a request with no prompt or with extra fields', async () => {
    await assert.rejects(answerAiPrompt(engines(), {}), /needs a prompt/);
    await assert.rejects(
      answerAiPrompt(engines(), { prompt: 'x', tools: ['Bash'] }),
      /needs a prompt/
    );
  });
});

describe('aiPrompt with images', () => {
  const shot = { mediaType: 'image/jpeg' as const, data: 'aGVsbG8=' };

  it('hands the images to the CLI that answers', async () => {
    const calls: Call[] = [];
    await answerAiPrompt(engines({}, calls), { prompt: 'x', engine: 'codex', images: [shot] });
    assert.deepEqual(calls[0]?.images, [shot]);
  });

  it('sends them to an Ollama model that sees, as its images field', async () => {
    const calls: Call[] = [];
    const e = engines({ ollamaModels: async () => ['llava:7b'] }, calls);
    await answerAiPrompt(e, { prompt: 'x', engine: 'ollama', images: [shot] });
    assert.deepEqual(calls[0], { engine: 'ollama:llava:7b', prompt: 'x', images: ['aGVsbG8='] });
  });

  it('refuses them for an Ollama model that cannot see, before asking it', async () => {
    const calls: Call[] = [];
    await assert.rejects(
      answerAiPrompt(engines({}, calls), { prompt: 'x', engine: 'ollama', images: [shot] }),
      { message: AI_MODEL_NO_VISION }
    );
    assert.deepEqual(calls, []);
  });

  it('refuses too many, the wrong type, or data that is not base64', async () => {
    const many = Array.from({ length: AI_PROMPT_IMAGE_MAX_COUNT + 1 }, () => shot);
    for (const images of [
      many,
      [{ mediaType: 'image/svg+xml', data: 'aGVsbG8=' }],
      [{ mediaType: 'image/png', data: 'not base64!' }],
      []
    ]) {
      await assert.rejects(answerAiPrompt(engines(), { prompt: 'x', images }), /needs a prompt/);
    }
  });

  it('says which engines read them', async () => {
    assert.deepEqual(await aiPromptInfo(engines(), {}), {
      images: { claude: true, codex: true, ollama: false }
    });
    const e = engines({ ollamaModels: async () => ['llama3.2:3b', 'llava:7b'] });
    assert.equal((await aiPromptInfo(e, { model: 'llava:7b' })).images.ollama, true);
    assert.equal((await aiPromptInfo(e, { model: 'llama3.2:3b' })).images.ollama, false);
  });
});

describe('ollamaSeesImages', () => {
  const answering = (body: unknown, ok = true) =>
    (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as typeof fetch;

  it('reads vision off the model’s capabilities', async () => {
    const url = 'http://x';
    assert.equal(
      await ollamaSeesImages(url, 'gemma3:4b', answering({ capabilities: ['completion', 'vision'] })),
      true
    );
    assert.equal(
      await ollamaSeesImages(url, 'llava:7b', answering({ capabilities: ['completion'] })),
      false
    );
  });

  it('falls back to known vision names on an Ollama that lists none', async () => {
    assert.equal(await ollamaSeesImages('http://x', 'qwen2.5vl:7b', answering({})), true);
    assert.equal(await ollamaSeesImages('http://x', 'qwen2.5:7b', answering({})), false);
    assert.equal(await ollamaSeesImages('http://x', 'llava:7b', answering({}, false)), false);
  });
});
