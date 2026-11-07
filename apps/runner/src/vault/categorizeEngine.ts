import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assertAgentSignedIn, spawnAgent } from '@shared/all/helpers/board-agent-core/agent';
import { hostTarget } from '@shared/all/helpers/board-agent-core/exec';

import { localAiMachine } from '../machine';
import { CONFIG_DIR } from '../paths';
import type { AskEngines } from './ask';
import { CLI_DISALLOWED_TOOLS, ollamaBaseUrl } from './askEngines';
import { modelTitle } from './askChats';
import type { CategorizeEngines } from './categorize';

// The real models behind Categorize on a runner (categorize.ts): the ones Ask
// offers (askEngines.ts), each asked one tagging question with no tools. The
// file's text is in the prompt, so the model needs nothing else.

/** A local model's window for one tagging call: the rule list and a piece of
 *  the file (categorize.ts BUDGET) with room for the answer. Ollama's default
 *  is smaller and cuts the prompt silently. */
const OLLAMA_CONTEXT_TOKENS = 8192;

/** One question to Ollama, answered as JSON (`format`), whole. */
async function ollamaJson(
  baseUrl: string,
  model: string,
  system: string,
  prompt: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const res = await fetchImpl(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      stream: false,
      format: 'json',
      options: { num_ctx: OLLAMA_CONTEXT_TOKENS, temperature: 0 }
    }),
    signal
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Ollama did not answer (${res.status}). ${detail}`.trim());
  }
  const body = (await res.json()) as { message?: { content?: string }; error?: string };
  if (body.error) throw new Error(`Ollama: ${body.error}`);
  return body.message?.content ?? '';
}

/** Claude or Codex with no tools at all: Claude in `plan`, every built-in
 *  tool disallowed and no MCP server (an empty `--strict-mcp-config`);
 *  Codex in its read-only sandbox. In an empty folder, as Ask runs them.
 *  A stop kills the process. */
async function cliJson(
  engine: 'claude' | 'codex',
  system: string,
  prompt: string,
  signal: AbortSignal
): Promise<string> {
  const target = hostTarget(CONFIG_DIR);
  await assertAgentSignedIn(engine, target);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'factiii-categorize-'));
  try {
    const { proc, result } = await spawnAgent(engine, target, {
      cwd,
      prompt: `${system}\n\n${prompt}`,
      allowedTools: '',
      disallowedTools: CLI_DISALLOWED_TOOLS,
      permissionMode: 'plan',
      mcpConfig: JSON.stringify({ mcpServers: {} }),
      callbacks: {}
    });
    const stop = () => proc.kill();
    // A stop during the sign-in check or the spawn fires no event later.
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop, { once: true });
    try {
      return (await result).text;
    } finally {
      signal.removeEventListener('abort', stop);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** The machine's engines, for the daemon: Ask's model list, and the runner's
 *  own `ollama serve` started when none is up. */
export function machineCategorizeEngines(ask: AskEngines): CategorizeEngines {
  const localAi = localAiMachine(hostTarget(CONFIG_DIR)).service;
  return {
    models: async () => {
      const [ollama, cli] = await Promise.all([ask.ollamaModels(), ask.clis()]);
      return { ollama: ollama.map((id) => ({ id, title: modelTitle('ollama', id) })), cli };
    },
    ask: async (engine, model, system, prompt, signal) => {
      if (engine !== 'ollama') return cliJson(engine, system, prompt, signal);
      if (!model) throw new Error('Pick a model.');
      if (!(await localAi.status()).running) await localAi.start(() => {});
      return ollamaJson(ollamaBaseUrl(), model, system, prompt, signal);
    }
  };
}
