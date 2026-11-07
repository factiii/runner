import crypto from 'crypto';
import { existsSync } from 'fs';
import { chmod, cp, mkdir, readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

import { runnerDir } from './runner-dir';

// Where the factiii plugin lives and what it is called. The plugin is the one
// place we hand things to the CLIs: hooks that report what the agent is doing,
// the skills this workspace provides, and the executables those skills drive
// (`bin/factiii-secrets`, staged onto the agent's PATH by space-core).

/** The marketplace name, as declared in marketplace.json. */
export const MARKETPLACE_NAME = 'factiii-runner';

/** `<plugin>@<marketplace>`, as both CLIs address it. */
export const PLUGIN_ID = `factiii@${MARKETPLACE_NAME}`;

/** The plugin's one executable that belongs on the agent's PATH, staged there
 *  by space-core. `report-state.sh` is deliberately not: hooks address it by
 *  absolute path through CLAUDE_PLUGIN_ROOT, and nothing should be able to
 *  call it by name. */
export const SECRETS_BIN = 'factiii-secrets';

/** The plugin's other executable on the agent's PATH: the stdio MCP server
 *  behind the board tools (`bin/factiii-board-mcp`). Staged beside
 *  `factiii-secrets`, because the manifest names it bare: that is the one
 *  spelling both CLIs resolve, and it is the same on every machine. */
export const BOARD_MCP_BIN = 'factiii-board-mcp';

/** Candidate marketplace roots, nearest first.
 *
 *  The published runner is one bundled `dist/cli.js` with `plugin/` beside it
 *  at the package root, so `__dirname/../plugin` is the shipped case — the
 *  same shape `installFrpcBinary` uses for `vendor/`. The packaged desktop app
 *  has the same shape: `app/dist/main.js`, with electron-builder copying the
 *  runner's `plugin/` to `app/plugin` (extraResources). Next, the desktop app
 *  in dev (`apps/desktop/dist/main.js`, so `apps/runner/plugin` is two up).
 *  The rest are source layouts, where this file is still at its own path
 *  under `shared/`. */
function candidates(): string[] {
  return [
    path.join(__dirname, '..', 'plugin'),
    path.join(__dirname, '..', '..', 'runner', 'plugin'),
    path.join(__dirname, '..', '..', '..', '..', 'apps', 'runner', 'plugin'),
    path.join(process.cwd(), 'apps', 'runner', 'plugin')
  ];
}

/** The marketplace root to install from, or null when the copy is missing —
 *  a source checkout without the directory, or a build that dropped it. The
 *  caller treats null as "skip": the terminal still works, the status dot just
 *  falls back to "alive". */
export function pluginRoot(): string | null {
  for (const dir of candidates()) {
    if (existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'))) {
      return dir;
    }
  }
  return null;
}

/** Where the runner keeps the copy it actually installs from. Runner-level,
 *  not per space: the board endpoint is the same for every space on a host, so
 *  one rendered copy serves all of them and there is one marketplace root
 *  rather than one per space fighting over the same name. It lives in the
 *  runner dir (FACTIII_RUNNER_DIR), which keeps a dev runner's copy out of
 *  the prod runner's. */
export function renderedPluginRoot(): string {
  return path.join(runnerDir(), 'plugin');
}

/**
 * The runner's own package version, which becomes the plugin's.
 *
 * Both CLIs install a plugin by COPYING it into `cache/<marketplace>/<plugin>/
 * <version>/`, and that copy is what loads — the marketplace path is read at
 * install time and never again. So a hand-maintained version in plugin.json
 * silently pins every machine to whatever shipped first: re-rendering delivers
 * new files to a directory nothing reads. Keyed on the package version, the
 * cache moves whenever a release does.
 */
async function runnerVersion(source: string): Promise<string> {
  // `source` is `<package>/plugin`, in the published layout and in the repo.
  const pkg = path.join(source, '..', 'package.json');
  const raw = await readFile(pkg, 'utf8').catch(() => null);
  if (!raw) return FALLBACK_VERSION;
  try {
    const { version } = JSON.parse(raw) as { version?: string };
    return version || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

/** Only reached if the runner's package.json is unreadable, which would mean a
 *  broken install. Distinct from any real version so it cannot collide. */
const FALLBACK_VERSION = '0.0.0-unknown';

/** Every file under `dir`, absolute, sorted — a stable walk for hashing. */
async function treeFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await treeFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

/** What the rendered copy would have to match to be current: every shipped
 *  file's path and contents, plus the manifest that gets written into it
 *  (`url`: the name is from when that was the board URL).
 *
 *  Exported for its test: the staleness bug it fixes lives entirely in what
 *  this does and does not notice, and the render around it is pure IO. */
export async function fingerprint(
  source: string,
  url: string,
  version = ''
): Promise<string> {
  const hash = crypto.createHash('sha256').update(url).update(version);
  for (const file of await treeFiles(source)) {
    hash.update(path.relative(source, file));
    hash.update(await readFile(file));
  }
  return hash.digest('hex');
}

/** The rendered copy's fingerprint, written after a successful render.
 *
 *  A SIBLING of the rendered root, not a file inside it: that root is a plugin
 *  marketplace two CLIs scan, and it has no business holding bookkeeping of
 *  ours. It also puts the stamp out of reach of the `cp` that fills the root. */
function stampPath(dest: string): string {
  return `${dest}.stamp`;
}

// One render at a time. Every space on the host calls this on every
// ensure and they all target the SAME runner-level copy: without this, the
// first ensure after an upgrade has N of them running `cp` over each other.
// (A map from when a render was keyed by the board URL; there is one key now.)
const inFlight = new Map<string, Promise<string | null>>();
const RENDER_KEY = 'plugin';

/**
 * Copy the shipped plugin somewhere writable and add the board MCP entry.
 *
 * The entry is the same on every machine and in every render (boardMcpConfig):
 * a stdio server by bare command name. It used to hold a URL, which could not
 * ship as `${FACTIII_BOARD_MCP_URL}` because codex does not expand env vars in
 * a plugin's `.mcp.json` — it hands the literal string to the connection and
 * fails. Claude does expand it, so that was codex's constraint deciding the
 * shape for both. A bare command needs no expansion in either.
 *
 * The shipped plugin carries no `.mcp.json` at all — a board entry would be a
 * server that cannot start for anyone who installed the plugin directly, or
 * on a host that is not a paired runner (desktop never renders). This writes
 * it.
 *
 * Nothing secret and nothing per-host is rendered: no URL, no port, no token
 * and no token variable. What proves the session is in its environment
 * already (FACTIII_SECRETS_TOKEN), read by the command itself.
 */
export function renderPlugin(): Promise<string | null> {
  const running = inFlight.get(RENDER_KEY);
  if (running) return running;
  const started = renderPluginImpl().finally(() =>
    inFlight.delete(RENDER_KEY)
  );
  inFlight.set(RENDER_KEY, started);
  return started;
}

async function renderPluginImpl(): Promise<string | null> {
  const source = pluginRoot();
  if (!source) return null;
  const dest = renderedPluginRoot();

  // Freshness is the SOURCE's fingerprint, not the rendered manifest's.
  // Checking the manifest only compared the board URL, so a runner upgrade
  // that added a skill or a helper never reached the copy the CLIs actually
  // load — it stayed frozen at whatever shipped when the URL was last new.
  const version = await runnerVersion(source);
  const manifest = `${JSON.stringify(boardMcpConfig(), null, 2)}\n`;
  const want = await fingerprint(source, manifest, version);
  const have = await readFile(stampPath(dest), 'utf8').catch(() => null);
  if (have === want) return dest;

  await mkdir(path.dirname(dest), { recursive: true });
  await cp(source, dest, { recursive: true, force: true });
  await markBinsExecutable(dest);
  await writeFile(path.join(dest, 'factiii', '.mcp.json'), manifest);
  await stampVersion(dest, version);
  // Last: a crash mid-copy must leave a stamp that does NOT match, so the
  // next ensure renders again rather than trusting a half-written tree.
  await writeFile(stampPath(dest), want);
  return dest;
}

/** Owner rwx, group/other rx: what git ships these files as (100755). */
const EXECUTABLE_MODE = 0o755;

/** Make every file in the rendered `factiii/bin/` executable. `cp` keeps the
 *  source's mode, and an npm install does not keep the execute bit on these
 *  files (only `bin` entries in package.json get chmod'd), so a fresh install
 *  rendered hooks the shell refused to run: "report-state.sh: Permission
 *  denied" on every Stop hook. Setting the mode here doesn't depend on how
 *  the runner was packed or installed. */
export async function markBinsExecutable(pluginTree: string): Promise<void> {
  const binDir = path.join(pluginTree, 'factiii', 'bin');
  const entries = await readdir(binDir, { withFileTypes: true }).catch(
    () => []
  );
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => chmod(path.join(binDir, entry.name), EXECUTABLE_MODE))
  );
}

/** Write the runner's version into the rendered plugin.json. The shipped file
 *  keeps a placeholder so the repo has no version to forget to bump. */
async function stampVersion(dest: string, version: string): Promise<void> {
  const manifest = path.join(dest, 'factiii', '.claude-plugin', 'plugin.json');
  const raw = await readFile(manifest, 'utf8').catch(() => null);
  if (!raw) return;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  await writeFile(
    manifest,
    `${JSON.stringify({ ...parsed, version }, null, 2)}\n`
  );
}

/** Both dialects in one entry: a stdio server is `command` + `args` for
 *  claude and for codex alike. No `type`, no URL, no header, no variable:
 *  nothing here differs between two machines or two renders, so the terminal
 *  digest never moves because of it. The command is found on the session's
 *  PATH (space-core stages it); outside a runner session it is not there and
 *  the entry simply fails to start. */
export function boardMcpConfig() {
  return {
    mcpServers: {
      'factiii-board': {
        command: BOARD_MCP_BIN,
        args: [] as string[]
      }
    }
  };
}

/** The plugin step of the one-time default-home cleanup
 *  (default-home-cleanup.ts), as one shell line. Each CLI runs in a subshell with
 *  its home var UNSET, which is how it finds the person's default home
 *  (`~/.claude`, `~/.codex`) again. Every step may fail (nothing installed,
 *  CLI missing) and the line still exits 0. Codex's own `remove` commands
 *  edit its config.toml; nothing here touches that file by hand. */
export function defaultHomeCleanupCommand(): string {
  return [
    `(unset CLAUDE_CONFIG_DIR; claude plugin uninstall ${PLUGIN_ID} --scope user >/dev/null 2>&1; claude plugin marketplace remove ${MARKETPLACE_NAME} >/dev/null 2>&1)`,
    `(unset CODEX_HOME; codex plugin remove ${PLUGIN_ID} >/dev/null 2>&1; codex plugin marketplace remove ${MARKETPLACE_NAME} >/dev/null 2>&1)`,
    'true'
  ].join('; ');
}
