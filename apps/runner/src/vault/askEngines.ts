import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isSignedIn,
  spawnAgent,
  type SpawnAgentOptions
} from '@shared/all/helpers/board-agent-core/agent';
import { type ExecTarget, hostTarget } from '@shared/all/helpers/board-agent-core/exec';
import { killTree } from '@shared/all/helpers/board-agent-core/host-env';
import { PROVIDERS } from '@shared/all/helpers/board-agent-core/providers';
import {
  claudeAskSettingsSchema,
  type CliAskSettings,
  codexAskSettingsSchema
} from '@shared/all/validators';

import { ollamaModelsDir } from '../localAiModel';
import { localAiMachine } from '../machine';
import { CONFIG_DIR } from '../paths';
import type { AiPromptEngines } from './aiPrompt';
import type { AskEngines, AskMessage, AskTools } from './ask';
import { VAULT_MCP_NAME, type VaultMcp, vaultMcpAllowedTools } from './askMcp';

// The real models behind Ask on a runner (vault/ask.ts): Ollama over its local
// HTTP API, with the turn's research tools (askTools.ts) as function tools
// where the model takes tools, and Claude and Codex through `spawnAgent`, the
// call card AI makes, with the same tools served by the turn's Vault MCP
// server (askMcp.ts) as their only ones.

const OLLAMA_REGISTRY = 'registry.ollama.ai';
const OLLAMA_DEFAULT_HOST = 'http://127.0.0.1:11434';

/** Ollama's address: OLLAMA_HOST as Ollama reads it ("0.0.0.0:11434",
 *  "http://host:port"), else its default. A listen-on-all address is asked
 *  on loopback. */
export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OLLAMA_HOST?.trim();
  if (!raw) return OLLAMA_DEFAULT_HOST;
  const url = new URL(/^https?:\/\//.test(raw) ? raw : `http://${raw}`);
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  if (!url.port && !/^https?:\/\/[^/]+:\d+/.test(raw)) url.port = '11434';
  return url.origin;
}

/**
 * The models Ollama holds, read off its folder (no server needed): each
 * manifest at `manifests/<registry>/<namespace>/<name>/<tag>`. Ollama's own
 * library drops its namespace, as `ollama list` does.
 */
export function ollamaModelsOnDisk(modelsDir: string): string[] {
  const root = path.join(modelsDir, 'manifests', OLLAMA_REGISTRY);
  const ids: string[] = [];
  const dirs = (dir: string) =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
      : [];
  for (const namespace of dirs(root)) {
    for (const name of dirs(path.join(root, namespace.name))) {
      const tags = fs
        .readdirSync(path.join(root, namespace.name, name.name), { withFileTypes: true })
        .filter((e) => e.isFile());
      for (const tag of tags) {
        const model = namespace.name === 'library' ? name.name : `${namespace.name}/${name.name}`;
        ids.push(`${model}:${tag.name}`);
      }
    }
  }
  return ids.sort();
}

/**
 * Does Ollama say `model` takes tools? Its `/api/show` lists the model's
 * capabilities ("completion", "tools", ...), read off the model itself, so a
 * model pulled from anywhere is answered for. An Ollama too old to list them,
 * or one that does not answer, reads as no.
 */
export async function ollamaTakesTools(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model })
    });
    if (!res.ok) return false;
    const { capabilities } = (await res.json()) as { capabilities?: unknown };
    return Array.isArray(capabilities) && capabilities.includes('tools');
  } catch {
    return false;
  }
}

/** A tool call as Ollama writes it: `arguments` an object (a JSON string
 *  from some models). */
type OllamaToolCall = { function: { name: string; arguments?: unknown } };
type OllamaMessage =
  | AskMessage
  | { role: 'assistant'; content: string; tool_calls: OllamaToolCall[] }
  | { role: 'tool'; content: string; tool_name: string };

/** Rounds of tool calls one answer may take before it must answer in words:
 *  a small model can call a tool again and again. Enough to search, read
 *  and keep a note. */
const OLLAMA_TOOL_ROUNDS = 4;

const toolArgs = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === 'string') {
    try {
      return toolArgs(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
};

/** One streamed `/api/chat` call: the text, written to `onText` as it
 *  comes, and any tool calls in it. `signal` aborts the request, which
 *  closes the connection, and Ollama stops generating. */
async function ollamaRound(
  baseUrl: string,
  body: { model: string; messages: OllamaMessage[]; tools?: unknown[] },
  onText: (text: string) => void,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<{ text: string; calls: OllamaToolCall[] }> {
  const res = await fetchImpl(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Ollama did not answer (${res.status}). ${detail}`.trim());
  }
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  const calls: OllamaToolCall[] = [];
  const take = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as {
      message?: { content?: string; tool_calls?: OllamaToolCall[] };
      error?: string;
    };
    if (event.error) throw new Error(`Ollama: ${event.error}`);
    const piece = event.message?.content ?? '';
    if (piece) {
      text += piece;
      onText(piece);
    }
    // A newer Ollama streams each call as it is made, an older one sends
    // them all on the last line: either way, every one is gathered.
    calls.push(...(event.message?.tool_calls ?? []));
  };
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    lines.forEach(take);
  }
  take(pending);
  return { text, calls };
}

/**
 * Ask Ollama, streaming: its `/api/chat` answers one JSON object per line,
 * each with the next piece of the message. With `tools` (a model that takes
 * them, `ollamaTakesTools`), each call the model makes is run and its result
 * handed back, and the model goes on until it answers without one, at most
 * OLLAMA_TOOL_ROUNDS times. Resolves the whole answer. `signal` stops it:
 * the request in flight is aborted and no further round or tool runs.
 */
export async function ollamaChat(
  baseUrl: string,
  model: string,
  messages: AskMessage[],
  onText: (text: string) => void,
  fetchImpl: typeof fetch = fetch,
  tools?: AskTools,
  signal?: AbortSignal
): Promise<string> {
  const thread: OllamaMessage[] = [...messages];
  const defs = (tools?.defs ?? []).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema }
  }));
  let answer = '';
  for (let round = 0; ; round += 1) {
    const offered = defs.length > 0 && round < OLLAMA_TOOL_ROUNDS;
    const { text, calls } = await ollamaRound(
      baseUrl,
      { model, messages: thread, ...(offered ? { tools: defs } : {}) },
      onText,
      fetchImpl,
      signal
    );
    answer += text;
    if (!offered || !tools || calls.length === 0) return answer;
    thread.push({ role: 'assistant', content: text, tool_calls: calls });
    for (const call of calls) {
      signal?.throwIfAborted();
      // A tool that fails, or one it made up, answers so in text.
      const result = await tools.call(call.function.name, toolArgs(call.function.arguments));
      thread.push({ role: 'tool', content: result, tool_name: call.function.name });
    }
  }
}

/** Claude's built-in tools, none of which Ask may use. Ask also runs with
 *  `--tools ""`, so none of them exists; this list is the second lock, and
 *  Categorize's only one (categorizeEngine.ts), with no tools allowed at
 *  all. */
export const CLI_DISALLOWED_TOOLS =
  'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task,TodoWrite';

/** Codex's own tools Ask turns off, so the Vault's MCP tools are all it has:
 *  no shell (its read-only sandbox still reads the whole disk), no browser,
 *  apps, plugins, images or sub-agents. A name a later Codex drops is
 *  ignored. */
const CODEX_FEATURES_OFF = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'multi_agent'
];

/** Where Codex finds the turn's MCP token: an env var, so it is never on the
 *  command line. */
const CODEX_TOKEN_ENV = 'FACTIII_VAULT_MCP_TOKEN';

/**
 * What one turn's model and effort (Account > Backend) add to the CLI's run:
 * `--model` and `--effort` for Claude; Codex's `model` override and its
 * reasoning effort (agent.ts maps `effort` to `model_reasoning_effort`).
 * Read against the engine's own list again, so a setting that is not one of
 * them, or one for the other engine, adds nothing: never free text on a
 * command line. Nothing set is the CLI's own default.
 */
export function cliRunSettings(
  engine: 'claude' | 'codex',
  settings: CliAskSettings | undefined
): Pick<SpawnAgentOptions, 'model' | 'effort'> & { codexConfig: string[] } {
  const schema = engine === 'claude' ? claudeAskSettingsSchema : codexAskSettingsSchema;
  const parsed = schema.safeParse(settings);
  if (!parsed.success) return { codexConfig: [] };
  const { model, effort } = parsed.data;
  return {
    ...(engine === 'claude' && model ? { model } : {}),
    ...(effort ? { effort } : {}),
    codexConfig: engine === 'codex' && model ? [`model="${model}"`] : []
  };
}

/**
 * Ask Claude or Codex in their non-interactive modes, as card AI does
 * (`spawnAgent`: `claude -p --output-format stream-json`, `codex exec
 * --json`), in an empty folder, with the turn's Vault MCP server as their
 * only tools. Claude: `dontAsk`, which runs the tools `--allowedTools` names
 * (the Vault's) and denies every other one, never prompting; `--tools ""`,
 * so it has no built-in tool to ask for; its built-ins disallowed too; no
 * other MCP server. (`plan` mode blocked the Vault's tools as well, so Ask
 * could not search.) Codex: `--sandbox read-only`, approvals `never`, the
 * Vault's tools approved and the only ones enabled, its shell and other
 * tools off (CODEX_FEATURES_OFF), no web search. No bypass flag either way.
 * Claude streams its pieces; Codex prints its answer once. `settings` are
 * the turn's model and effort (`cliRunSettings`). `signal` kills the CLI and
 * everything it started (`killTree`).
 */
export async function cliAnswer(
  target: ExecTarget,
  engine: 'claude' | 'codex',
  prompt: string,
  vault: VaultMcp,
  onText: (text: string) => void,
  settings?: CliAskSettings,
  signal?: AbortSignal
): Promise<string> {
  // Said in Oakbox's words: where it signs in is Account > Backend, not a
  // board's settings (cliSignins.ts).
  if (!(await isSignedIn(target, engine))) {
    const { label } = PROVIDERS[engine];
    throw new Error(
      `${label} is not signed in on this runner. Sign it in under Account > Backend.`
    );
  }
  const { codexConfig, ...run } = cliRunSettings(engine, settings);
  signal?.throwIfAborted();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'factiii-ask-'));
  try {
    const { proc, result } = await spawnAgent(engine, target, {
      cwd,
      prompt,
      allowedTools: vaultMcpAllowedTools(vault.tools),
      disallowedTools: CLI_DISALLOWED_TOOLS,
      tools: '',
      permissionMode: 'dontAsk',
      includePartialMessages: true,
      ...run,
      mcpConfig: JSON.stringify({
        mcpServers: {
          [VAULT_MCP_NAME]: {
            type: 'http',
            url: vault.url,
            headers: { Authorization: `Bearer ${vault.token}` }
          }
        }
      }),
      codexConfig: [
        `mcp_servers.${VAULT_MCP_NAME}.url="${vault.url}"`,
        `mcp_servers.${VAULT_MCP_NAME}.bearer_token_env_var="${CODEX_TOKEN_ENV}"`,
        // Approved up front: with approvals `never`, a tool that would ask
        // is refused instead.
        `mcp_servers.${VAULT_MCP_NAME}.default_tools_approval_mode="approve"`,
        `mcp_servers.${VAULT_MCP_NAME}.enabled_tools=${JSON.stringify(vault.tools)}`,
        'approval_policy="never"',
        'web_search="disabled"',
        ...CODEX_FEATURES_OFF.map((feature) => `features.${feature}=false`),
        ...codexConfig
      ],
      env: { [CODEX_TOKEN_ENV]: vault.token },
      callbacks: {
        onLog: (entry) => {
          if (entry.type === 'text-append') onText(entry.content);
        }
      }
    });
    const stop = () => killTree(proc);
    // A stop during the sign-in check or the spawn fires no event later.
    if (signal?.aborted) stop();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      return (await result).text;
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Claude or Codex with no tools at all, for a Factiii AI feature run on the
 * runner (aiPrompt.ts): the prompt in, the answer's text out. The same
 * locks as Ask's, with nothing allowed: Claude in `dontAsk` with `--tools ""`
 * and its built-ins disallowed, no MCP server; Codex with approvals `never`,
 * its own tools off, no web search and no MCP server. An empty folder, removed
 * after. `settings` are Account > Backend's model and effort.
 */
export async function cliPlainAnswer(
  target: ExecTarget,
  engine: 'claude' | 'codex',
  prompt: string,
  settings?: CliAskSettings,
  signal?: AbortSignal
): Promise<string> {
  if (!(await isSignedIn(target, engine))) {
    const { label } = PROVIDERS[engine];
    throw new Error(
      `${label} is not signed in on this runner. Sign it in under Account > Backend.`
    );
  }
  const { codexConfig, ...run } = cliRunSettings(engine, settings);
  signal?.throwIfAborted();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'factiii-ai-'));
  try {
    const { proc, result } = await spawnAgent(engine, target, {
      cwd,
      prompt,
      allowedTools: '',
      disallowedTools: CLI_DISALLOWED_TOOLS,
      tools: '',
      permissionMode: 'dontAsk',
      ...run,
      // None of the machine's own MCP servers either.
      mcpConfig: JSON.stringify({ mcpServers: {} }),
      codexConfig: [
        'approval_policy="never"',
        'web_search="disabled"',
        ...CODEX_FEATURES_OFF.map((feature) => `features.${feature}=false`),
        ...codexConfig
      ],
      callbacks: {}
    });
    const stop = () => killTree(proc);
    if (signal?.aborted) stop();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      return (await result).text;
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** The machine's engines, for the daemon. */
export function machineAskEngines(): AskEngines & AiPromptEngines {
  const target = hostTarget(CONFIG_DIR);
  const localAi = localAiMachine(target).service;
  // The runner's own `ollama serve`, as a pull starts it, unless one is up.
  const serve = async () => {
    if (!(await localAi.status()).running) await localAi.start(() => {});
  };
  const has = (bin: string) =>
    target.sh(`command -v ${bin}`).then(
      () => true,
      () => false
    );
  return {
    // Read each time, as Ollama may be installed after the runner started.
    ollamaModels: async () => ollamaModelsOnDisk(ollamaModelsDir()),
    ollamaTakesTools: async (model) => {
      await serve();
      return ollamaTakesTools(ollamaBaseUrl(), model);
    },
    clis: async () => {
      const [claude, codex] = await Promise.all([
        has(PROVIDERS.claude.bin),
        has(PROVIDERS.codex.bin)
      ]);
      return [...(claude ? (['claude'] as const) : []), ...(codex ? (['codex'] as const) : [])];
    },
    signedIn: (cli) => isSignedIn(target, cli),
    ollama: async (model, messages, onText, tools, signal) => {
      await serve();
      return ollamaChat(ollamaBaseUrl(), model, messages, onText, fetch, tools, signal);
    },
    cli: (engine, prompt, vault, onText, settings, signal) =>
      cliAnswer(target, engine, prompt, vault, onText, settings, signal),
    cliPlain: (engine, prompt, settings, signal) =>
      cliPlainAnswer(target, engine, prompt, settings, signal)
  };
}
