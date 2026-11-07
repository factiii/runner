// How a card's terminal tabs get their labels.
//
// tmux is asked for one line per pane and this file turns those lines into the
// strip's labels, so the format string and the parser that reads it stay
// together - reorder one and the other stops making sense.

/** Columns of the `list-panes` read. `pane_title` comes last because it is the
 *  only field that can contain the separator. `host` rides along because tmux
 *  seeds an untouched `pane_title` with it.
 *
 *  `@factiii-fp` and `pane_dead` ride along too: this sweep already runs on
 *  every tab-strip read, so staleness and dead panes cost no extra round trip
 *  to learn. */
export const TAB_LIST_FORMAT =
  '#{session_name}|#{pane_current_command}|#{host}|#{@factiii-fp}|#{pane_dead}|#{pane_title}';

/** Foreground names that mean "nothing is running here". A shell never sets a
 *  title, so a title found on one is a leftover from the program that just
 *  exited - label the tab with the shell instead of a stale summary. Panes
 *  start on `bash`; the rest are what a user switches to by hand. */
const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'fish']);

/**
 * VSCode-style tab label. Programs publish what they are doing as the terminal
 * title (OSC 0/2), which tmux keeps as `pane_title` - claude writes its current
 * task there. Fall back to the process name when the pane has no title of its
 * own. The `.exe` strip is for claude, whose npm package ships its real binary
 * as `bin/claude.exe`, so tmux reports that name.
 */
const tabName = (cmd: string, host: string, title: string): string => {
  const command = cmd.replace(/\.exe$/, '') || 'bash';
  if (!title || title === host || SHELL_COMMANDS.has(command)) return command;
  return title;
};

type TerminalTabRow = {
  id: string;
  name: string;
  /** The digest this session was CREATED under, or '' for one that predates
   *  the stamp. Compared against the current digest by the caller, which is
   *  the only place that knows what current means. */
  fp: string;
  /** tmux keeps a pane whose process exited (`remain-on-exit`), so the tab
   *  survives a stray `exit`. Restarting it is what brings it back. */
  dead: boolean;
};

/**
 * Pull this card's tabs out of a `list-panes -a` dump. `prefix` is the card's
 * tmux session prefix; every other card's panes are in the same dump and are
 * skipped. Our sessions are single-pane, so the first line for an id wins.
 */
export const parseTerminalTabs = (
  stdout: string,
  prefix: string
): TerminalTabRow[] => {
  const byId = new Map<string, TerminalTabRow>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(prefix)) continue;
    const parts = line.slice(prefix.length).split('|');
    // The format emits five separators; fewer means a truncated line.
    if (parts.length < 6) continue;
    const id = parts[0]!.trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      name: tabName(
        parts[1]!.trim(),
        parts[2]!.trim(),
        parts.slice(5).join('|').trim()
      ),
      fp: parts[3]!.trim(),
      dead: parts[4]!.trim() === '1'
    });
  }
  return Array.from(byId.values()).sort(
    (a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0)
  );
};
