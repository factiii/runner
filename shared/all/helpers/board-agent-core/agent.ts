import { type ChildProcess } from 'child_process';
import { z } from 'zod';

import {
  ASK_IMAGE_MAX_BYTES,
  ASK_IMAGE_MAX_COUNT,
  ASK_IMAGE_TYPES,
  type AskImage
} from '../../domains/electron';
import { claudeJsonPath } from './agent-homes';
import { type ClaudeStreamCallbacks, pipeClaudeStream } from './claude-stream';
import { pipeCodexStream } from './codex-stream';
import type { ExecTarget } from './exec';
import prompts from './prompts.json';
import { type AgentProvider, PROVIDERS } from './providers';

/** Assert the space is signed in before an agent pass. One-click sign-in and
 *  an in-terminal login both land in the runner's CLI home (agent-homes.ts). */
export async function assertAgentSignedIn(
  provider: AgentProvider,
  target: ExecTarget
): Promise<void> {
  const info = PROVIDERS[provider];
  if (!(await isSignedIn(target, provider))) {
    throw new Error(
      `Not signed in to ${info.label}. Use "Sign in with ${info.label}" in Board AI settings, then retry.`
    );
  }
}

const statusSchema = z.record(z.string(), z.unknown());

/** Whether the CLI is signed in here. Asks the CLI, since on macOS the token
 *  is in the keychain. The env var is explicit: `sh()` skips `agentEnv()`. */
export async function isSignedIn(
  target: ExecTarget,
  provider: AgentProvider
): Promise<boolean> {
  const { status } = PROVIDERS[provider];
  try {
    const out = await target.sh(status.command);
    // No field means the command signals by exit code, and sh() already threw
    // if it was non-zero.
    if (!status.field) return true;
    // Shell init can print ahead of the JSON; take the last object.
    const parsed = statusSchema.safeParse(
      JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
    );
    return parsed.success && parsed.data[status.field] === true;
  } catch {
    return false;
  }
}

/** Sign the provider CLI out of this space. */
export async function signOut(
  target: ExecTarget,
  provider: AgentProvider
): Promise<void> {
  await target.sh(PROVIDERS[provider].logoutCommand);
}

/** The CLI's first-run wizard is separate from auth: `claude -p` skips it, but
 *  an interactive `claude` replays it and asks to pick a login method even when
 *  signed in. Skips the write when already set, and resolves the same file on
 *  macOS and Linux.
 *
 *  The file is the one claude reads: `$CLAUDE_CONFIG_DIR/.claude.json` when the
 *  var is set (the runner's home, agent-homes.ts; checked against claude
 *  2.1.300), else `~/.claude.json`. */
export async function markOnboardingComplete(
  target: ExecTarget
): Promise<void> {
  // Resolved here and handed over in the env: no path inside the quoted
  // script, and the rule lives in one tested place (claudeJsonPath).
  const script = [
    `const fs=require('fs')`,
    `const f=process.env.FACTIII_CLAUDE_JSON`,
    `let c={}`,
    `try{c=JSON.parse(fs.readFileSync(f,'utf8'))}catch{}`,
    `if(!c.hasCompletedOnboarding){c.hasCompletedOnboarding=true;fs.writeFileSync(f,JSON.stringify(c,null,2))}`
  ].join('; ');
  await target.sh(`node -e "${script}"`, {
    env: { FACTIII_CLAUDE_JSON: claudeJsonPath() }
  });
}

export type SpawnAgentOptions = {
  /** Working dir for this run. Defaults to the target's workspace; card runs
   *  pass their per-card worktree path. */
  cwd?: string;
  prompt: string;
  // Claude-only knobs: Codex has no tool allowlist or permission modes; its
  // enforcement is the sandbox (see codexArgs).
  allowedTools: string;
  disallowedTools?: string;
  /** Claude only: the built-in tools that exist at all (`--tools`); "" is
   *  none. Oakbox Ask on a runner passes "" so its MCP tools are the only
   *  ones. */
  tools?: string;
  permissionMode?: string;
  appendSystemPrompt?: string;
  effort?: string;
  resumeSessionId?: string;
  /** Claude only: the id a NEW conversation takes (`--session-id`), so the
   *  caller knows where its transcript will be before the CLI says. */
  sessionId?: string;
  // Claude model id. Codex runs its configured default model - the call
  // sites pin Claude ids, which mean nothing to the Codex CLI.
  model?: string;
  includePartialMessages?: boolean;
  /** Claude only: the MCP servers for this run alone (`--mcp-config`, with
   *  `--strict-mcp-config` so the space's own are left out). Oakbox Ask on a
   *  runner hands in its Vault's (vault/askMcp.ts). */
  mcpConfig?: string;
  /** Codex only: `-c key=value` overrides for this run (its MCP servers). */
  codexConfig?: string[];
  /** Images for this turn (see `checkAskImages`). Claude takes them inline on
   *  stdin; Codex only takes files, so they sit in the space's drops dir for
   *  the length of the run. */
  images?: AskImage[];
  // Extra env vars for the spawn. Only ever carries SHORT-LIVED,
  // harness-minted creds (see deploy-creds.ts) - never the user's raw keys.
  env?: Record<string, string>;
  callbacks: ClaudeStreamCallbacks;
};

export type SpawnAgentResult = {
  proc: ChildProcess;
  result: Promise<{ text: string; sessionId: string }>;
};

type ArgOptions = Omit<SpawnAgentOptions, 'cwd' | 'callbacks' | 'env'>;

const BASE64_SLICE_CHARS = 32_768;
const BASE64_BODY = /^[A-Za-z0-9+/]+$/;

/** Base64 text with up to two `=` at the end. Checked a slice at a time: one
 *  regex over several megabytes ends in "Maximum call stack size exceeded" on
 *  some Node builds, and an image of the allowed size is that long. */
function isBase64(data: string): boolean {
  let end = data.length;
  if (data.endsWith('==')) end -= 2;
  else if (data.endsWith('=')) end -= 1;
  if (end === 0) return false;
  for (let at = 0; at < end; at += BASE64_SLICE_CHARS) {
    const slice = data.slice(at, Math.min(at + BASE64_SLICE_CHARS, end));
    if (!BASE64_BODY.test(slice)) return false;
  }
  return true;
}

/** Refuse anything that is not a small set of well-formed images. The payload
 *  comes off the wire, and its type decides a file extension below. */
export function checkAskImages(images: AskImage[] | undefined): AskImage[] {
  if (!images || images.length === 0) return [];
  if (images.length > ASK_IMAGE_MAX_COUNT) {
    throw new Error(`At most ${ASK_IMAGE_MAX_COUNT} images per question.`);
  }
  for (const image of images) {
    if (!ASK_IMAGE_TYPES.includes(image.mediaType)) {
      throw new Error('Images must be PNG, JPEG, WEBP or GIF.');
    }
    if (typeof image.data !== 'string') {
      throw new Error('Invalid image data.');
    }
    // Four base64 characters carry three bytes. The size is checked before
    // the content, so an oversized payload is never scanned.
    if ((image.data.length * 3) / 4 > ASK_IMAGE_MAX_BYTES) {
      throw new Error('An image is too large to send.');
    }
    if (!isBase64(image.data)) {
      throw new Error('Invalid image data.');
    }
  }
  return images;
}

// Claude's stream-json input: one user message whose content carries the
// images as base64 blocks ahead of the prompt.
function claudeImageInput(prompt: string, images: AskImage[]): string {
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...images.map((image) => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mediaType,
            data: image.data
          }
        })),
        { type: 'text', text: prompt }
      ]
    }
  };
  return `${JSON.stringify(message)}\n`;
}

let imageRunCounter = 0;

/** Decode the images into the space's drops dir (outside every worktree) and
 *  return their paths. The base64 goes over stdin: megabytes of it would
 *  overflow an argument list. */
async function writeImageFiles(
  target: ExecTarget,
  images: AskImage[]
): Promise<string[]> {
  const dir = target.paths.drops;
  const run = `ask-${Date.now()}-${++imageRunCounter}`;
  const files: string[] = [];
  for (const [i, image] of images.entries()) {
    // The type passed `checkAskImages`, so the extension is one of four words.
    const file = `${dir}/${run}-${i}.${image.mediaType.slice('image/'.length)}`;
    await target.runWithStdin(
      ['bash', '-c', `mkdir -p '${dir}' && base64 -d > '${file}'`],
      image.data,
      'Write image'
    );
    files.push(file);
  }
  return files;
}

// Write the prompt, parse the provider's stream output, settle on close.
function runAgentProc(
  proc: ChildProcess,
  prompt: string,
  stream: {
    fullText: () => string;
    sessionId: () => string;
    isError: () => boolean;
  },
  label: string,
  errorPrefix: string
): Promise<{ text: string; sessionId: string }> {
  return new Promise((resolve, reject) => {
    let errorOutput = '';

    proc.stderr?.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });

    proc.on('close', (code) => {
      const text = stream.fullText();
      const sessionId = stream.sessionId();
      if (stream.isError()) {
        reject(
          new Error(text || errorOutput || `${label} exited with code ${code}`)
        );
      } else if (code !== 0 && !text) {
        reject(new Error(errorOutput || `${label} exited with code ${code}`));
      } else {
        resolve({ text, sessionId });
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`${errorPrefix}: ${err.message}`));
    });

    proc.stdin?.on('error', () => {});
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  });
}

// Claude argv (everything after the binary name). The board's MCP comes from
// the factiii plugin (see provisionPluginLane), so there is no per-run flag.
function claudeArgs(opts: ArgOptions): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    opts.allowedTools,
    '--permission-mode',
    // Default to `auto` (per-action classifier) rather than bypassing every
    // prompt. Callers that need a stricter mode (research = `plan`) pass it.
    opts.permissionMode || 'auto'
  ];
  if (opts.disallowedTools)
    args.push('--disallowedTools', opts.disallowedTools);
  if (opts.tools !== undefined) args.push('--tools', opts.tools);
  if (opts.appendSystemPrompt)
    args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.model) args.push('--model', opts.model);
  if (opts.includePartialMessages) args.push('--include-partial-messages');
  if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig, '--strict-mcp-config');
  // Images only fit in a structured message, so stdin switches format.
  if (opts.images?.length) args.push('--input-format', 'stream-json');
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  else if (opts.sessionId) args.push('--session-id', opts.sessionId);
  return args;
}

// Claude effort → codex model_reasoning_effort. 'max' is claude-specific;
// xhigh is not supported by every codex model, so it clamps to high.
const CODEX_EFFORT: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high'
};

// Codex argv. `exec --json` emits the JSONL codex-stream.ts parses; `-` reads
// the prompt from stdin. skip-git-repo-check: some cwds aren't git repos.
function codexArgs(opts: ArgOptions, imageFiles: string[]): string[] {
  const args = ['exec'];
  if (opts.resumeSessionId) args.push('resume', opts.resumeSessionId);
  // Ahead of the other flags: `--image` takes a list on a fresh exec, and the
  // next flag is what ends it.
  for (const file of imageFiles) args.push('--image', file);
  args.push('--json', '--skip-git-repo-check');
  // Codex's OS sandbox is the only enforcement: 'plan' and 'dontAsk' read,
  // 'auto' writes in the workspace, anything else runs open (deploy's
  // guardrails are structural).
  if (opts.permissionMode === 'plan' || opts.permissionMode === 'dontAsk') {
    args.push('--sandbox', 'read-only');
  } else if (opts.permissionMode === 'auto') {
    args.push('--sandbox', 'workspace-write');
  } else {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  const effort = opts.effort ? CODEX_EFFORT[opts.effort] : undefined;
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  for (const override of opts.codexConfig ?? []) args.push('-c', override);
  args.push('-');
  return args;
}

// Codex has no system-prompt flag; the phase instructions ride ahead of the
// task in the one prompt.
function codexPrompt(opts: ArgOptions): string {
  return opts.appendSystemPrompt
    ? `${opts.appendSystemPrompt}\n\n---\n\n${opts.prompt}`
    : opts.prompt;
}

/** Spawn the provider CLI on the space's exec target, which supplies the env
 *  the CLI needs to find its state. */
export async function spawnAgent(
  provider: AgentProvider,
  target: ExecTarget,
  opts: SpawnAgentOptions
): Promise<SpawnAgentResult> {
  const info = PROVIDERS[provider];
  const images = checkAskImages(opts.images);
  const imageFiles =
    provider === 'codex' && images.length > 0
      ? await writeImageFiles(target, images)
      : [];
  const args =
    provider === 'codex' ? codexArgs(opts, imageFiles) : claudeArgs(opts);
  const proc = await target.spawn([info.bin, ...args], {
    cwd: opts.cwd,
    env: { ...target.agentEnv(), ...opts.env }
  });
  if (imageFiles.length > 0) {
    // The images are context for this run only; nothing keeps them after it.
    const quoted = imageFiles.map((file) => `'${file}'`).join(' ');
    proc.once('close', () => {
      void target.sh(`rm -f ${quoted}`).catch(() => {});
    });
  }
  let stdin = opts.prompt;
  if (provider === 'codex') stdin = codexPrompt(opts);
  else if (images.length > 0) stdin = claudeImageInput(opts.prompt, images);
  const stream =
    provider === 'codex'
      ? pipeCodexStream(proc, opts.callbacks)
      : pipeClaudeStream(proc, opts.callbacks);
  return {
    proc,
    result: runAgentProc(
      proc,
      stdin,
      stream,
      info.label,
      `Failed to run ${info.label} (is the ${info.bin} CLI available?)`
    )
  };
}

/** Coerce model output into a valid git branch name. */
function sanitizeBranchName(raw: string): string {
  const cleaned = raw
    .trim()
    .split('\n')[0]
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9/_.-]/g, '')
    .replace(/-{2,}/g, '-')
    // git-invalid forms: consecutive dots, '.lock' suffix, and components
    // that start with '.' or end with '.lock' are all rejected by git.
    .replace(/\.{2,}/g, '.')
    .replace(/(^|\/)\./g, '$1')
    .replace(/\.lock(\/|$)/g, '$1')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .slice(0, 60);
  return cleaned || 'board-ai-changes';
}

/** One-shot agent run for the short text generations (commit message, branch
 *  name). Never rejects; falls back instead. */
async function agentOneShot(
  provider: AgentProvider,
  target: ExecTarget,
  prompt: string,
  fallback: string,
  finish: (output: string) => string,
  cwd?: string
): Promise<string> {
  try {
    const { result } = await spawnAgent(provider, target, {
      cwd,
      prompt,
      allowedTools: '',
      callbacks: {}
    });
    const { text } = await result;
    return finish(text) || fallback;
  } catch {
    return fallback;
  }
}

/** Suggest a branch name for the diff, for a card started without one. */
export function generateBranchName(
  provider: AgentProvider,
  target: ExecTarget,
  diff: string,
  taskTitle: string,
  cwd?: string
): Promise<string> {
  return agentOneShot(
    provider,
    target,
    `${prompts.branchName}\n\nTask: ${taskTitle}\n\n${diff.slice(0, 8000)}`,
    'board-ai-changes',
    sanitizeBranchName,
    cwd
  );
}

/** Generate a conventional commit message using the provider on the target. */
export function generateCommitMessage(
  provider: AgentProvider,
  target: ExecTarget,
  diff: string,
  cwd?: string
): Promise<string> {
  return agentOneShot(
    provider,
    target,
    `${prompts.commitMessage}\n\n${diff.slice(0, 8000)}`,
    'Board AI changes',
    (output) => output.trim(),
    cwd
  );
}
