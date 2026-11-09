import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AI_NO_CLI_SIGNED_IN } from '@shared/all/validators';

import { type AiPromptEngines, answerAiPrompt, NO_AI_ON_RUNNER } from './aiPrompt';

// Factiii's AI features on a runner (.specs/oakbox.md "Backend" → AI
// features): which engine answers, and with what.

type Call = { engine: string; prompt: string; settings?: unknown };

function engines(over: Partial<AiPromptEngines> = {}, calls: Call[] = []): AiPromptEngines {
  return {
    clis: async () => ['claude', 'codex'],
    signedIn: async () => true,
    ollamaModels: async () => ['llama3.2:3b'],
    ollama: async (model, messages) => {
      calls.push({ engine: `ollama:${model}`, prompt: messages[0]?.content ?? '' });
      return ' From Ollama \n';
    },
    cliPlain: async (engine, prompt, settings) => {
      calls.push({ engine, prompt, settings });
      return `From ${engine}`;
    },
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
