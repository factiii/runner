import type { ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import path from 'path';

import type { ExecTarget } from './exec';
import { killTree } from './host-env';

// tmux on a real pty from `script(1)`: stdout is the screen, stdin the keyboard.

/** What the image kept in `~/.tmux.conf`, passed with `-f` from the space dir.
 *  Exported so the terminal digest hashes exactly the text that gets written -
 *  a copy kept in step by hand would drift on the first edit. */
export const TMUX_CONF = [
  // Wheel scrolls, drag selects in copy mode.
  'set -g mouse on',
  'set -g history-limit 50000',
  // These three are copy-on-select: tmux emits OSC 52, the client clips it.
  'set -g set-clipboard on',
  'set -ga terminal-features ,*:clipboard',
  'bind -T copy-mode MouseDragEnd1Pane send -X copy-selection-and-cancel',
  'bind -T copy-mode-vi MouseDragEnd1Pane send -X copy-selection-and-cancel',
  // A pane whose process exits stays as a dead pane instead of taking the
  // session — and the tab — with it. `respawnTmuxPane` brings it back. Without
  // this a stray `exit` or Ctrl-D destroys the tab the user was working in.
  'set -g remain-on-exit on',
  ''
].join('\n');

/** Size for a client whose caller didn't ask for one. */
const DEFAULT_SIZE = { cols: 80, rows: 24 };

// Our own server: tmux reads its config once at server start, so a server
// someone else started would ignore `-f`.
const SOCKET = 'factiii';

/** tmux session names must be filesystem-safe. */
export function safeTmuxName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

function tmuxConfPath(target: ExecTarget): string {
  return `${target.paths.root}/tmux.conf`;
}

/** Prefix for any tmux command that has to reach OUR server. */
export function tmuxCli(target: ExecTarget): string {
  return `tmux -L ${SOCKET} -f ${tmuxConfPath(target)}`;
}

function shellQuote(argv: string[]): string {
  return argv.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
}

/** Run argv on a controlling terminal, sized up front since `script` can't. */
function ptyArgv(
  argv: string[],
  size: { cols: number; rows: number }
): string[] {
  const sized = [
    'sh',
    '-c',
    `stty rows ${size.rows} cols ${size.cols} 2>/dev/null; exec ${shellQuote(argv)}`
  ];
  // BSD takes the command after the file; util-linux wants one -c string.
  const script =
    process.platform === 'darwin'
      ? ['script', '-q', '/dev/null', ...sized]
      : ['script', '-qec', shellQuote(sized), '/dev/null'];
  // `< <(cat)` gives script a real pipe: its tcgetattr takes only ENOTTY, and
  // Node's socketpair stdin answers ENOTSUP. `exec` so its exit is ours.
  return ['bash', '-c', 'exec "$@" < <(cat)', 'bash', ...script];
}

/**
 * Restart a pane's process in place: `-k` kills what runs and starts `argv` in
 * the SAME session, window and pane, so the tab never leaves `list-panes` and
 * an attached client stays attached.
 *
 * `argv` is required, not optional: told no command, tmux re-runs the one the
 * pane was created with — the old init script, with the old bin dir and env
 * baked in, which is the staleness a restart exists to clear.
 */
export async function respawnTmuxPane(opts: {
  target: ExecTarget;
  session: string;
  argv: string[];
  /** Where the new process starts. Defaults to the pane's current dir. */
  cwd?: string;
  /** Environment for the new process: how a session created with a stale
   *  `-e` picks up the current one without being re-created. */
  env?: Record<string, string>;
}): Promise<void> {
  const { target, session, argv } = opts;
  const cmd = ['respawn-pane', '-k'];
  if (opts.cwd) cmd.push('-c', opts.cwd);
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    cmd.push('-e', `${k}=${v}`);
  }
  cmd.push('-t', session, '--', ...argv);
  await target.sh(`${tmuxCli(target)} ${shellQuote(cmd)}`);
}

/** Tells a create from an attach: `new-session -A` does both and reports
 *  neither, and only a create should be stamped. */
export async function tmuxSessionExists(
  target: ExecTarget,
  session: string
): Promise<boolean> {
  return await target
    .sh(
      `${tmuxCli(target)} has-session -t ${shellQuote([session])} 2>/dev/null`
    )
    .then(() => true)
    .catch(() => false);
}

/** A session's pane as its screen shows now, with up to `lines` lines of
 *  scrollback above it (`capture-pane -p -J`: wrapped lines joined, no
 *  escapes). '' when the session is gone. */
export async function captureTmuxPane(
  target: ExecTarget,
  session: string,
  lines: number
): Promise<string> {
  const history = Math.max(1, Math.floor(lines));
  return await target
    .sh(
      `${tmuxCli(target)} capture-pane -p -J -S -${history} -t ${shellQuote([session])} 2>/dev/null`
    )
    .catch(() => '');
}

/** Set a user option (`@name`) on a session. Read back in bulk by the
 *  `list-panes -a` sweep, and dies with the session. */
export async function setTmuxSessionOption(
  target: ExecTarget,
  session: string,
  name: string,
  value: string
): Promise<void> {
  await target
    .sh(
      `${tmuxCli(target)} set-option -t ${shellQuote([session])} ${shellQuote([name, value])}`
    )
    .catch(() => {
      // The session can go between the caller's check and this - best effort.
    });
}

/** Re-read the config into the RUNNING server: tmux applies `-f` only at
 *  server start, so this is how a config change reaches live sessions. */
export async function sourceTmuxConf(target: ExecTarget): Promise<void> {
  const conf = tmuxConfPath(target);
  await target.writeFile(conf, TMUX_CONF);
  await target
    .sh(`${tmuxCli(target)} source-file ${shellQuote([conf])}`)
    .catch(() => {
      // No server running means no session to update - nothing to do, and the
      // next `new-session` reads the file itself.
    });
}

// tmux holds every session in memory and has no save/restore of its own, so a
// reboot loses the tab layout. tmux-resurrect provides it, driven from here
// rather than by tmux-continuum so the runner decides when.
//
// Its scripts call bare `tmux`, which would find the DEFAULT socket, not ours.
// `run-shell` fixes that: a command tmux runs for us inherits the right TMUX.

/** The vendored copy to install from, nearest first, or null when it is
 *  missing — a source checkout that never ran `fetch-tmux-resurrect.sh`. Null
 *  means "skip": tabs do not survive a reboot, everything else still works.
 *
 *  Candidates are the shape `pluginRoot` uses. The published runner is one
 *  bundled `dist/cli.js` with `vendor/` beside it at the package root, so
 *  `__dirname/../vendor` is the shipped case; the rest are source layouts,
 *  where this file still sits at its own path under `shared/`. */
function resurrectSource(): string | null {
  const rel = ['vendor', 'tmux-resurrect'];
  const candidates = [
    path.join(__dirname, '..', ...rel),
    path.join(__dirname, '..', '..', '..', '..', 'apps', 'runner', ...rel),
    path.join(process.cwd(), 'apps', 'runner', ...rel)
  ];
  return (
    candidates.find((dir) =>
      existsSync(path.join(dir, 'scripts', 'save.sh'))
    ) ?? null
  );
}

/** Host-level: one tmux server serves every space, so one install and one save
 *  file. Derived from the space dir because `shared/` cannot import the runner's
 *  own path module. */
function hostRoot(target: ExecTarget): string {
  return path.dirname(target.paths.root);
}

function resurrectRoot(target: ExecTarget): string {
  return `${hostRoot(target)}/tmux-plugins/tmux-resurrect`;
}

function resurrectStateDir(target: ExecTarget): string {
  return `${hostRoot(target)}/tmux-resurrect-state`;
}

/** Stage the vendored copy into the config root.
 *
 *  A copy of what the runner shipped, not a `git clone`: the host needs no
 *  network and no git, the version is the one this release was tested against
 *  rather than whatever upstream's default branch says today, and nothing
 *  fetches code at provision time. `VERSION` is the staleness check, so a
 *  runner update re-stages and an unchanged one costs a single `cat`.
 *
 *  Best effort throughout: without it, tabs just do not survive a reboot. */
export async function ensureTmuxResurrect(target: ExecTarget): Promise<void> {
  const source = resurrectSource();
  if (!source) return;
  const root = resurrectRoot(target);
  try {
    // An unreadable or empty VERSION re-stages rather than skipping: staging
    // twice costs 13 small writes, never staging costs the feature.
    const want = await readFile(path.join(source, 'VERSION'), 'utf-8')
      .then((v) => v.trim())
      .catch(() => '');
    const have = await target
      .sh(`cat ${shellQuote([`${root}/VERSION`])} 2>/dev/null || true`)
      .catch(() => '');
    if (want && have.trim() === want) return;

    // Written through the target rather than copied with `fs`, so this stays
    // correct for any ExecTarget rather than only a local one.
    const files = (await resurrectFiles(source)).filter((f) => f !== 'VERSION');
    for (const rel of files) {
      await target.writeFile(
        `${root}/${rel}`,
        await readFile(path.join(source, rel), 'utf-8')
      );
    }
    // writeFile carries no mode, and tmux execs these rather than sourcing.
    await target.sh(
      `chmod +x ${shellQuote([`${root}/scripts`])}/*.sh ` +
        `${shellQuote([`${root}/save_command_strategies`])}/*.sh`
    );
    // VERSION last, so it means "staged AND executable". Written with the rest,
    // a chmod that failed would leave the copy looking current forever, and the
    // scripts would stay unexecutable with nothing to trigger a retry.
    await target.writeFile(`${root}/VERSION`, want);
  } catch {
    // Missing vendor copy, unwritable root, no reboot survival. Everything
    // else still works.
  }
}

/** Every file in the vendored copy, relative to its root. Walked rather than
 *  listed, so the subset `fetch-tmux-resurrect.sh` picks stays the one place
 *  that decides what ships. */
async function resurrectFiles(source: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(path.join(source, rel), {
      withFileTypes: true
    });
    for (const entry of entries) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else out.push(next);
    }
  };
  await walk('');
  return out;
}

/** Set at call time, not in TMUX_CONF, so the config stays a constant and the
 *  state dir stays host-derived. `@resurrect-processes 'false'` is what keeps
 *  the contract: tabs come back, processes do not. */
async function setResurrectOptions(target: ExecTarget): Promise<void> {
  const opts: [string, string][] = [
    ['@resurrect-processes', 'false'],
    ['@resurrect-capture-pane-contents', 'on'],
    ['@resurrect-dir', resurrectStateDir(target)]
  ];
  for (const [name, value] of opts) {
    await target
      .sh(`${tmuxCli(target)} set-option -g ${shellQuote([name, value])}`)
      .catch(() => {});
  }
}

/** Whether OUR server is up. Asking a dead server fails rather than starting
 *  one, which is the question. */
async function tmuxServerRunning(target: ExecTarget): Promise<boolean> {
  return await target
    .sh(`${tmuxCli(target)} list-sessions -F '#{session_name}' 2>/dev/null`)
    .then(() => true)
    .catch(() => false);
}

/** Write the layout to disk. On tab add/close rather than a timer: those are
 *  the only moments it changes, and a timer loses whatever came after it. */
export async function resurrectSave(target: ExecTarget): Promise<void> {
  if (!(await tmuxServerRunning(target))) return;
  await setResurrectOptions(target);
  await target
    .sh(
      `${tmuxCli(target)} run-shell ${shellQuote([`${resurrectRoot(target)}/scripts/save.sh`])}`
    )
    .catch(() => {
      // Layout not saved this round; the next add or close writes it again.
    });
}

/**
 * Rebuild the saved sessions. Returns the session names that came back, so the
 * caller can respawn each one on a current init command — resurrect restores
 * panes running the DEFAULT shell, with none of our PATH or prompt, so a
 * restored tab is not usable until that second step runs.
 *
 * `run-shell` needs a server to run in, and after a reboot there is none. The
 * throwaway session is how one gets started without creating something the tab
 * strip would list: its name is outside the `terminal-` prefix the strip reads.
 */
export async function resurrectRestore(target: ExecTarget): Promise<string[]> {
  const scripts = resurrectRoot(target);
  const hasSave = await target
    .sh(`test -f ${shellQuote([`${resurrectStateDir(target)}/last`])}`)
    .then(() => true)
    .catch(() => false);
  if (!hasSave) return [];

  const placeholder = 'factiii-restore';
  try {
    await target.sh(
      `${tmuxCli(target)} new-session -d -s ${placeholder} 'sleep 60' 2>/dev/null || true`
    );
    await setResurrectOptions(target);
    await target.sh(
      `${tmuxCli(target)} run-shell ${shellQuote([`${scripts}/scripts/restore.sh`])}`
    );
    const stdout = await target.sh(
      `${tmuxCli(target)} list-sessions -F '#{session_name}' 2>/dev/null || true`
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name.startsWith('terminal-'));
  } catch {
    return [];
  } finally {
    await target
      .sh(
        `${tmuxCli(target)} kill-session -t ${placeholder} 2>/dev/null || true`
      )
      .catch(() => {});
  }
}

// One tmux server serves every space on a host, and every space restores on
// its own start. Two restores at once each believe they are rebuilding from
// nothing, and a tab both of them reach comes back with a pane from each: the
// extra one replays the saved screen, drops to a default shell, and once that
// shell exits it sits there as "Pane is dead" with nothing in the app to
// close it. So restores take turns, per process.
let restoreTurn: Promise<unknown> = Promise.resolve();

/** Run `work` once every restore queued before it has finished. */
export function withTmuxRestoreTurn<T>(work: () => Promise<T>): Promise<T> {
  const mine = restoreTurn.then(work, work);
  restoreTurn = mine.catch(() => {});
  return mine;
}

/** Sessions a restore rebuilt that no space has respawned yet, by host. The
 *  first space to restore rebuilds every space's tabs, but may only respawn
 *  its own; the rest wait here for the space that owns them. In memory on
 *  purpose: it only ever names sessions this process just rebuilt, which is
 *  what makes respawning them safe. */
const unclaimedRestores = new Map<string, Set<string>>();

export function unclaimedTmuxRestores(target: ExecTarget): Set<string> {
  const host = hostRoot(target);
  let names = unclaimedRestores.get(host);
  if (!names) {
    names = new Set();
    unclaimedRestores.set(host, names);
  }
  return names;
}

/** Reduce a session to the one pane a tab is. A save taken while a tab had a
 *  stray pane restores the stray too, so this is also what heals a save that
 *  already has them. Only for a session a restore just rebuilt: every pane in
 *  it is a fresh shell with nothing running. */
export async function keepOneTmuxPane(
  target: ExecTarget,
  session: string
): Promise<void> {
  await target
    .sh(
      `${tmuxCli(target)} kill-pane -a -t ${shellQuote([session])} 2>/dev/null || true`
    )
    .catch(() => {});
}

/** Where each pane sits, so a respawn lands in the same directory. Resurrect
 *  restores cwd even with process restore off. */
export async function tmuxPanePaths(
  target: ExecTarget
): Promise<Map<string, string>> {
  const stdout = await target
    .sh(
      `${tmuxCli(target)} list-panes -a -F '#{session_name}|#{pane_current_path}' 2>/dev/null || true`
    )
    .catch(() => '');
  const byName = new Map<string, string>();
  for (const raw of stdout.split('\n')) {
    const [name, dir] = raw.trim().split('|');
    if (name && dir && !byName.has(name)) byName.set(name, dir);
  }
  return byName;
}

/** Every tmux session a post owns, by the `terminal-<postId>-<tab>` name
 *  `tmuxName()` builds. */
async function terminalSessionNames(
  target: ExecTarget,
  postId: string
): Promise<string[]> {
  const prefix = `terminal-${safeTmuxName(postId)}-`;
  const stdout = await target
    .sh(
      `${tmuxCli(target)} list-sessions -F '#{session_name}' 2>/dev/null || true`
    )
    .catch(() => '');
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name.startsWith(prefix));
}

/** Kill a post's terminals and everything running inside them. Each pane's
 *  process tree goes first, because killing the session alone leaves a process
 *  that reparented away from the shell still running.
 *
 *  Every session in ONE shell: `sh` spawns a login shell per call, so a card
 *  with three tabs otherwise paid for three of them. */
export async function killTerminalSessions(
  target: ExecTarget,
  postId: string
): Promise<void> {
  await killTmuxSessions(target, await terminalSessionNames(target, postId));
}

/** Kill these tmux sessions on our server, process trees first (see
 *  killTerminalSessions). */
export async function killTmuxSessions(
  target: ExecTarget,
  names: string[]
): Promise<void> {
  if (names.length === 0) return;
  const cli = tmuxCli(target);
  const script = names
    .map(
      (name) =>
        // -P walks children; the pane pid itself dies with the session below.
        `for p in $(${cli} list-panes -t ${shellQuote([name])} -F '#{pane_pid}' 2>/dev/null); do ` +
        `pkill -TERM -P "$p" 2>/dev/null || true; done; ` +
        `${cli} kill-session -t ${shellQuote([name])} 2>/dev/null || true`
    )
    .join('; ');
  await target.sh(script).catch(() => {});
}

/** A tmux client: the screen on stdout, the keyboard on stdin. */
export type TmuxSession = {
  session: string;
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: (code: number | null) => void): void;
  onError(cb: (err: Error) => void): void;
  /** Type into the pane, mouse reports included: tmux reads them here. */
  write(data: Buffer | string): void;
  /** Re-attach at a new size, replacing the client. A pty can't be resized. */
  resize(cols: number, rows: number): Promise<void>;
  /** Detach. The server keeps the shell running for the next attach. */
  detach(): void;
};

/** Attach a client, creating the session with `argv` if absent. */
export async function startTmuxSession(opts: {
  target: ExecTarget;
  session: string;
  /** Command tmux runs when it CREATES the session. */
  argv: string[];
  /** Attach to an existing session of this name instead of failing. */
  attachExisting?: boolean;
  /** Window size, so long output (OAuth URLs) is not wrapped. */
  size?: { cols: number; rows: number };
  /** Set on the SESSION: the server may already be running with another env. */
  env?: Record<string, string>;
}): Promise<TmuxSession> {
  const { target, session } = opts;
  const conf = tmuxConfPath(target);
  await target.writeFile(conf, TMUX_CONF);

  let size = opts.size ?? DEFAULT_SIZE;
  const dataCbs: ((chunk: Buffer) => void)[] = [];
  const closeCbs: ((code: number | null) => void)[] = [];
  const errorCbs: ((err: Error) => void)[] = [];
  let proc: ChildProcess;

  const attach = async (): Promise<void> => {
    const argv = ['tmux', '-L', SOCKET, '-u', '-f', conf, 'new-session'];
    if (opts.attachExisting) argv.push('-A');
    argv.push('-s', session, '-x', String(size.cols), '-y', String(size.rows));
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      argv.push('-e', `${k}=${v}`);
    }
    argv.push('--', ...opts.argv);

    const mine = await target.spawn(ptyArgv(argv, size), {
      env: { TERM: 'xterm-256color' }
    });
    proc = mine;
    // EPIPE on a dead client is an event, not a throw, and would go uncaught.
    mine.stdin?.on('error', () => {});
    // Identity, not a flag: a replaced client's exit lands whenever it lands.
    const live = () => proc === mine;
    const emit = (chunk: Buffer) => {
      // stderr too: `script` reports its own failures there.
      if (live()) for (const cb of dataCbs) cb(chunk);
    };
    mine.stdout?.on('data', emit);
    mine.stderr?.on('data', emit);
    mine.on('error', (err) => {
      if (live()) for (const cb of errorCbs) cb(err);
    });
    mine.on('close', (code) => {
      if (live()) for (const cb of closeCbs) cb(code ?? null);
    });
  };

  await attach();

  return {
    session,
    onData: (cb) => dataCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    onError: (cb) => errorCbs.push(cb),
    write: (data) => proc.stdin?.write(data),
    resize: async (cols, rows) => {
      if (cols === size.cols && rows === size.rows) return;
      size = { cols, rows };
      const old = proc;
      // Attach before killing, so no keystroke lands in the gap.
      await attach();
      killTree(old);
    },
    detach: () => killTree(proc)
  };
}
