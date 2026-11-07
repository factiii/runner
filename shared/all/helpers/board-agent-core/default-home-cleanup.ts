import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  agentHomeEnv,
  CLAUDE_HOME_ENV,
  claudeJsonPath,
  CODEX_HOME_ENV,
  defaultAgentHomes
} from './agent-homes';
import { defaultHomeCleanupCommand } from './plugin';
import {
  codexMcpName,
  legacyBoardMcpName,
  MCP_TOKEN_ENV,
  oneDriveMcpName
} from './providers';
import {
  CODEX_RULES_FILE,
  isRunnerCodexRules,
  withoutClaudeSecretsRules
} from './secrets-permission';

// The one-time cleanup of what an older runner wrote into the person's DEFAULT
// Claude Code and Codex homes (~/.claude, ~/.claude.json, ~/.codex), before
// the runner had homes of its own (agent-homes.ts). Each of these loaded into
// every session on the machine, the person's own too:
//
// - the factiii plugin and its marketplace (plugin.ts defaultHomeCleanupCommand);
// - the `factiii-secrets` allow rules in ~/.claude/settings.json;
// - ~/.codex/rules/factiii.rules;
// - each space's OneDrive MCP entry (and the pre-plugin board entry), in
//   ~/.claude.json with the bearer token inline, and in ~/.codex/config.toml
//   naming the token's env var.
//
// Only exactly what the runner wrote goes: the writers' own constants and
// naming functions decide, never a loose pattern. Anything else, or a file
// that does not parse, is left as it is and named in the report.

/** Marker beside the runner's homes: the default homes were cleaned up, so it
 *  is not tried again. Holds the time and the report. */
export const DEFAULT_HOME_CLEANUP_MARKER = '.default-home-plugin-removed';

/** The board lane's codex bearer var, before the lane moved into the plugin.
 *  Kept only to recognise the entries it wrote. */
const LEGACY_BOARD_MCP_TOKEN_ENV = 'FACTIII_BOARD_MCP_TOKEN';

/** The OneDrive bridge URL the removed runner OneDrive index built:
 *  `http://127.0.0.1:<port>/mcp/<encoded slug>`. Before the rename to per-space
 *  names (one fixed `factiii-onedrive` entry) it could also be the docker
 *  gateway host. */
const ONEDRIVE_URL = /^http:\/\/127\.0\.0\.1:\d+\/mcp\/([^/?#]+)$/;
const LEGACY_ONEDRIVE_URL =
  /^http:\/\/(?:127\.0\.0\.1|host\.docker\.internal):\d+\/mcp\/[^/?#]+$/;
const LEGACY_ONEDRIVE_NAME = 'factiii-onedrive';
/** The board lane's URL: `<serverUrl>/mcp/board`. */
const BOARD_URL = /^https?:\/\/[^/?#]+\/mcp\/board$/;
/** Every name `legacyBoardMcpName` can produce (its slug part is what
 *  `mcpNameSlug` leaves), and the same in codex's form. */
const LEGACY_BOARD_NAME = new RegExp(
  `^${legacyBoardMcpName('')}[a-zA-Z0-9_-]+$`
);
const LEGACY_BOARD_CODEX_NAME = new RegExp(
  `^${codexMcpName(legacyBoardMcpName(''))}[a-zA-Z0-9_]+$`
);

export type CleanupReport = { removed: string[]; left: string[] };

type McpLane = 'onedrive' | 'board';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const decode = (part: string): string | null => {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
};

/** The slug in a OneDrive bridge URL, or null when it is not one. */
const oneDriveSlug = (url: string): string | null => {
  const part = ONEDRIVE_URL.exec(url)?.[1];
  return part === undefined ? null : decode(part);
};

/** Which runner lane wrote a claude entry with this name and URL, or null
 *  when the runner did not write it. */
function claudeMcpLane(name: string, url: string): McpLane | null {
  const slug = oneDriveSlug(url);
  if (slug !== null && name === oneDriveMcpName(slug)) return 'onedrive';
  if (name === LEGACY_ONEDRIVE_NAME && LEGACY_ONEDRIVE_URL.test(url)) {
    return 'onedrive';
  }
  if (LEGACY_BOARD_NAME.test(name) && BOARD_URL.test(url)) return 'board';
  return null;
}

/** The same for a codex entry, whose name is the claude one through
 *  `codexMcpName`. */
function codexMcpLane(name: string, url: string): McpLane | null {
  const slug = oneDriveSlug(url);
  if (slug !== null && name === codexMcpName(oneDriveMcpName(slug))) {
    return 'onedrive';
  }
  if (
    name === codexMcpName(LEGACY_ONEDRIVE_NAME) &&
    LEGACY_ONEDRIVE_URL.test(url)
  ) {
    return 'onedrive';
  }
  if (LEGACY_BOARD_CODEX_NAME.test(name) && BOARD_URL.test(url)) return 'board';
  return null;
}

/** The claude entry names (user scope, top-level `mcpServers`) the runner
 *  wrote: `claude mcp add-json <name> {type: http, url, headers:
 *  {Authorization: Bearer ...}} --scope user`. Matched on that whole shape,
 *  and the bearer is only checked for its prefix, never read out. */
export function runnerClaudeMcpNames(claudeJson: unknown): string[] {
  if (!isObject(claudeJson) || !isObject(claudeJson.mcpServers)) return [];
  return Object.entries(claudeJson.mcpServers)
    .filter(([name, entry]) => {
      if (!isObject(entry) || entry.type !== 'http') return false;
      if (typeof entry.url !== 'string') return false;
      const { headers } = entry;
      if (!isObject(headers)) return false;
      const keys = Object.keys(headers);
      const auth = headers.Authorization;
      if (keys.length !== 1 || typeof auth !== 'string') return false;
      if (!auth.startsWith('Bearer ')) return false;
      return claudeMcpLane(name, entry.url) !== null;
    })
    .map(([name]) => name);
}

/** The codex entry names the runner wrote, from `codex mcp list --json`:
 *  `codex mcp add <codexMcpName(name)> --url <url> --bearer-token-env-var
 *  <var>`, so the claude name it maps from must be one of ours, and the var
 *  the one that lane used. */
export function runnerCodexMcpNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.name !== 'string') continue;
    const { transport } = entry;
    if (!isObject(transport) || typeof transport.url !== 'string') continue;
    const lane = codexMcpLane(entry.name, transport.url);
    if (!lane) continue;
    const want = lane === 'board' ? LEGACY_BOARD_MCP_TOKEN_ENV : MCP_TOKEN_ENV;
    if (transport.bearer_token_env_var !== want) continue;
    if (transport.http_headers != null) continue;
    names.push(entry.name);
  }
  return names;
}

/** A name is safe in single quotes when it has only the characters
 *  `mcpNameSlug` leaves; every name above does. */
const quoted = (name: string): string | null =>
  /^[a-zA-Z0-9_-]+$/.test(name) ? `'${name}'` : null;

/** Write beside the file, then rename over it, keeping its mode: a crash never
 *  leaves half a file. Through a symlink to its target, like the writer. */
async function replaceKeepingMode(file: string, text: string): Promise<void> {
  const real = await realpath(file);
  const mode = (await stat(real)).mode & 0o777;
  const tmp = `${real}.factiii-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, { mode });
    await chmod(tmp, mode); // writeFile's mode is masked by the umask
    await rename(tmp, real);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Take the runner's allow rules out of `<claudeDir>/settings.json`. */
export async function removeClaudeSecretsRules(
  claudeDir: string,
  report: CleanupReport
): Promise<void> {
  const file = path.join(claudeDir, 'settings.json');
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return;
  const result = withoutClaudeSecretsRules(text);
  if (result.status === 'unparseable') {
    report.left.push(`${file}: not valid JSON, left as it is`);
    return;
  }
  if (result.status === 'absent') return;
  await replaceKeepingMode(file, result.text);
  report.removed.push(`${file}: factiii-secrets allow rules`);
}

/** Delete `<codexDir>/rules/factiii.rules` when it is the runner's file. */
export async function removeCodexSecretsRules(
  codexDir: string,
  report: CleanupReport
): Promise<void> {
  const file = path.join(codexDir, 'rules', CODEX_RULES_FILE);
  const info = await lstat(file).catch(() => null);
  if (!info) return;
  const text = info.isFile()
    ? await readFile(file, 'utf8').catch(() => null)
    : null;
  if (text === null || !isRunnerCodexRules(text)) {
    report.left.push(`${file}: not the runner's file, left as it is`);
    return;
  }
  await unlink(file);
  report.removed.push(file);
}

/** Remove the runner's MCP entries from the default homes, through each CLI
 *  with its home var unset. claude's file is only READ here, to find the
 *  names; `claude mcp remove` does the write, so no hand edit of
 *  ~/.claude.json races a live claude. Codex's config.toml is never touched
 *  by hand either. */
export async function removeRunnerMcpEntries(
  sh: (cmd: string) => Promise<string>,
  home: string,
  report: CleanupReport
): Promise<void> {
  const claudeFile = claudeJsonPath({}, home);
  const readClaude = async (): Promise<unknown> => {
    const text = await readFile(claudeFile, 'utf8').catch(() => null);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const claudeJson = await readClaude();
  if (claudeJson === undefined) {
    report.left.push(`${claudeFile}: not valid JSON, MCP entries not checked`);
  }
  const claudeNames = runnerClaudeMcpNames(claudeJson);

  const readCodex = async (): Promise<unknown> => {
    const out = await sh(
      `(unset ${CODEX_HOME_ENV}; codex mcp list --json 2>/dev/null) || true`
    ).catch(() => '');
    if (!out.trim()) return [];
    try {
      return JSON.parse(out);
    } catch {
      return undefined;
    }
  };
  const codexList = await readCodex();
  if (codexList === undefined) {
    report.left.push('codex mcp list: unreadable output, entries not checked');
  }
  const codexNames = runnerCodexMcpNames(codexList);

  const steps = [
    ...claudeNames.map((name) => {
      const q = quoted(name);
      return q
        ? `(unset ${CLAUDE_HOME_ENV}; claude mcp remove ${q} --scope user >/dev/null 2>&1)`
        : null;
    }),
    ...codexNames.map((name) => {
      const q = quoted(name);
      return q
        ? `(unset ${CODEX_HOME_ENV}; codex mcp remove ${q} >/dev/null 2>&1)`
        : null;
    })
  ].filter((step): step is string => step !== null);
  if (!steps.length) return;
  await sh([...steps, 'true'].join('; ')).catch(() => '');

  // What the CLIs actually took out, from their own state afterwards.
  const tally = (
    cli: string,
    names: string[],
    after: unknown,
    found: string[]
  ) => {
    for (const name of names) {
      if (after === undefined)
        report.left.push(`${cli} MCP ${name}: result unknown`);
      else if (found.includes(name))
        report.left.push(`${cli} MCP ${name}: remove failed`);
      else report.removed.push(`${cli} MCP ${name}`);
    }
  };
  const claudeAfter = await readClaude();
  tally('claude', claudeNames, claudeAfter, runnerClaudeMcpNames(claudeAfter));
  const codexAfter = await readCodex();
  tally('codex', codexNames, codexAfter, runnerCodexMcpNames(codexAfter));
}

let cleanupInFlight: Promise<boolean> | null = null;

/**
 * Take what an older runner wrote out of the person's DEFAULT homes, once per
 * runner dir. Installing into the runner's homes removes none of it.
 *
 * Only when the runner's homes are applied (`agentHomeEnv` is set): otherwise
 * the default homes ARE this process's homes and there is nothing to migrate.
 * Each step is best effort and never fatal. The marker is written after one
 * attempt, failed or not, so a machine where a step fails is not retried on
 * every ensure; it holds the report. Returns whether it ran now.
 */
export function removeDefaultHomeLeftovers(
  sh: (cmd: string) => Promise<string>,
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME?.trim() || os.homedir()
): Promise<boolean> {
  cleanupInFlight ??= cleanup(sh, env, home).finally(() => {
    cleanupInFlight = null;
  });
  return cleanupInFlight;
}

async function cleanup(
  sh: (cmd: string) => Promise<string>,
  env: NodeJS.ProcessEnv,
  home: string
): Promise<boolean> {
  const set = agentHomeEnv(env);
  const claudeHome = set[CLAUDE_HOME_ENV];
  if (!claudeHome || !set[CODEX_HOME_ENV]) return false;
  // Beside the applied homes: `<runnerDir>/agent-home/<marker>`.
  const marker = path.join(
    path.dirname(claudeHome),
    DEFAULT_HOME_CLEANUP_MARKER
  );
  if (existsSync(marker)) return false;
  const defaults = defaultAgentHomes(home);
  const report: CleanupReport = { removed: [], left: [] };
  const steps: [string, () => Promise<unknown>][] = [
    ['plugin', () => sh(defaultHomeCleanupCommand())],
    ['claude rules', () => removeClaudeSecretsRules(defaults.claude, report)],
    ['codex rules', () => removeCodexSecretsRules(defaults.codex, report)],
    ['MCP entries', () => removeRunnerMcpEntries(sh, home, report)]
  ];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch {
      // Best effort: see above. The reason is dropped, since a CLI error can
      // quote a config line.
      report.left.push(`${label}: step failed`);
    }
  }
  const lines = [
    new Date().toISOString(),
    ...report.removed.map((line) => `removed ${line}`),
    ...report.left.map((line) => `left ${line}`)
  ];
  await mkdir(path.dirname(marker), { recursive: true }).catch(() => {});
  await writeFile(marker, `${lines.join('\n')}\n`).catch(() => {});
  return true;
}
