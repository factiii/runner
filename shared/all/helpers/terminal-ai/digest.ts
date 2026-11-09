// Whether an open terminal still matches what the runner ships.
//
// A tmux session freezes the shell's environment when tmux creates it, and a
// running agent freezes the plugin it loaded at startup. Only a restart applies
// a change to either.
//
// Keyed on the inputs rather than the runner version, so a release that changes
// none of them prompts nobody. What belongs here is what a restart FIXES: the
// staged helpers in `paths.bin` are excluded because they sit at a path already
// on PATH, so a running shell resolves a re-staged file on its own.

import crypto from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';

import type { ExecTarget } from '../board-agent-core/exec';
import {
  fingerprint,
  pluginRoot,
  renderedPluginRoot
} from '../board-agent-core/plugin';
import { TMUX_CONF } from '../board-agent-core/tmux';
import { terminalPrelude } from './initScript';

/** tmux user option holding the digest a session was created under. Read in
 *  bulk by the `list-panes -a` sweep, and dies with the session — the right
 *  lifetime, since a dead session has nothing to be stale about. */
export const TERMINAL_FP_OPTION = '@factiii-fp';

/** Stands in for the per-tab cwd, so every tab in a space hashes alike. */
const CWD_PLACEHOLDER = '/__cwd__';

/** Ports, which are per session (port-blocks.ts) and move when a board's block
 *  is replaced — churn no restart would fix. */
const VOLATILE_ENV_KEYS = new Set(['FACTIII_PORTS']);

/** The digest is recomputed on the tab strip's 4s poll and this is its only
 *  disk read, so it is reused briefly. */
const PLUGIN_CACHE_MS = 30_000;

let pluginCache: { at: number; value: string } | null = null;

/** The SHIPPED plugin tree plus the rendered `.mcp.json`.
 *
 *  Not one hash of the rendered tree: `stampVersion` writes the runner version
 *  into its `plugin.json`, which would move the digest on every release even
 *  when the plugin behaves identically. `.mcp.json` is read separately because
 *  the board MCP URL is only filled in at render time.
 *
 *  Both paths are process-global, so one cache entry serves every space. */
async function pluginContribution(): Promise<string> {
  const now = Date.now();
  if (pluginCache && now - pluginCache.at < PLUGIN_CACHE_MS) {
    return pluginCache.value;
  }
  const source = pluginRoot();
  const shipped = source
    ? await fingerprint(source, '', '').catch(() => '')
    : '';
  const mcp = await readFile(
    path.join(renderedPluginRoot(), 'factiii', '.mcp.json'),
    'utf-8'
  ).catch(() => '');
  const value = `${shipped}|${mcp}`;
  pluginCache = { at: now, value };
  return value;
}

/** The prelude takes the real bin dir and a placeholder cwd: a layout change to
 *  the bin dir must register, while the cwd differs per tab. */
export async function terminalDigest(target: ExecTarget): Promise<string> {
  const hash = crypto
    .createHash('sha256')
    .update(TMUX_CONF)
    .update(terminalPrelude(CWD_PLACEHOLDER, target.paths.bin));

  const env = target.stateEnv();
  for (const key of Object.keys(env).sort()) {
    if (VOLATILE_ENV_KEYS.has(key)) continue;
    hash.update(`${key}=${env[key]}`);
  }

  // Hooks, skills, and the board MCP endpoint they carry.
  hash.update(await pluginContribution());
  return hash.digest('hex');
}
