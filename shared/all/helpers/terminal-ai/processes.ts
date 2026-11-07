import type { ExecTarget } from '../board-agent-core/exec';

// What a card's terminals are actually running, what it costs, and what it
// serves.
//
// Most of what a user starts in a tab is a descendant of that pane's shell, so
// the tree walk below is the fast path: tmux hands us the pane pid, `ps` hands
// us parentage. Anything that detached from its parent is picked up afterwards
// by the `TMUX_PANE` it inherited — see panesByPid.

/** One row of the process table, before it is attributed to a tab. */
export type ProcRow = {
  pid: number;
  ppid: number;
  /** Percent of one core, as ps reports it. */
  cpu: number;
  /** Resident set size in KB - the memory actually held, not reserved. */
  rssKb: number;
  /** ps `etime`: [[dd-]hh:]mm:ss. */
  elapsed: string;
  /** Full command line. */
  args: string;
};

/** What a process is doing on the network. */
type SocketUse = {
  /** TCP ports it accepts connections on. */
  ports: number[];
  /** Connections currently established, in either direction. */
  connections: number;
};

/** The ps fields this module reads, in order. args is last because it is the
 *  one field that can contain spaces. */
export const PS_FORMAT = 'pid=,ppid=,pcpu=,rss=,etime=,args=';

const PS_FIELDS = 5;

/** Parse `ps -axo <PS_FORMAT>`. */
export function parsePsTable(raw: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length <= PS_FIELDS) continue;
    const [pid, ppid, cpu, rss, elapsed] = parts;
    const pidNum = Number(pid);
    const ppidNum = Number(ppid);
    if (!Number.isInteger(pidNum) || !Number.isInteger(ppidNum)) continue;
    rows.push({
      pid: pidNum,
      ppid: ppidNum,
      cpu: Number(cpu) || 0,
      rssKb: Number(rss) || 0,
      elapsed: elapsed ?? '',
      args: parts.slice(PS_FIELDS).join(' ')
    });
  }
  return rows;
}

/**
 * Every descendant of `roots`, excluding the roots themselves - a pane's root
 * is its own shell, which is not something the user started.
 *
 * Walks children rather than climbing parents: a process whose parent died is
 * reparented to init, and climbing would then attribute it to the wrong card.
 * Such a process is recovered from its `TMUX_PANE` instead — see panesByPid,
 * whose result is then walked down from here.
 */
export function descendantsOf(rows: ProcRow[], roots: number[]): ProcRow[] {
  const children = new Map<number, ProcRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const found: ProcRow[] = [];
  const seen = new Set<number>(roots);
  const stack = [...roots];
  while (stack.length) {
    const pid = stack.pop()!;
    for (const child of children.get(pid) ?? []) {
      // A pid cannot be its own ancestor, but a recycled pid in a stale table
      // could still close a loop. The guard costs nothing.
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      stack.push(child.pid);
    }
  }
  return found.sort((a, b) => a.pid - b.pid);
}

/**
 * `TMUX_PANE` per pid, from `ps eww -o pid=,command= -p <pids>`. It survives
 * the reparenting that breaks the walk above, where climbing parents would
 * credit an orphan to whatever adopted it.
 *
 * Three limits, all measured rather than assumed:
 * - macOS prints environments only for pids named with `-p`. `ps -axeww` still
 *   returns a row per process and silently omits the environment, so folding
 *   the scoped call into one unscoped call breaks this quietly.
 * - It never shows the environment of an Apple-signed system binary. Dev
 *   servers are user-installed, which is the case that matters.
 * - Command line and environment arrive concatenated with no delimiter, so an
 *   argv carrying the literal `TMUX_PANE=%0` is read as the variable. Takes a
 *   contrived command line; the fix would be to diff against `ps -o command=`
 *   and search only what is not argv.
 */
export function panesByPid(raw: string): Map<number, string> {
  const found = new Map<number, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    const pid = Number(trimmed.split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const match = /(?:^|\s)TMUX_PANE=(%\d+)(?:\s|$)/.exec(trimmed);
    if (match) found.set(pid, match[1]!);
  }
  return found;
}

/** One of a card's tmux panes. */
export type PaneRef = { tabId: string; pid: number; paneId: string };

/**
 * Every process a card is running, by pid.
 *
 * Pass 1 is the tree under each pane and covers anything started normally.
 * Pass 2 asks `lookupPanes` for the `TMUX_PANE` of everything left, which
 * recovers processes that detached from their pane. Pass 3 walks down from
 * whatever pass 2 adopted, because a program can re-exec without the variable
 * — `next-server` does, so the process actually holding the port is reachable
 * only through its parent.
 *
 * `lookupPanes` is injected so the passes can be tested without a `ps`.
 */
export async function processesForCard(
  panes: PaneRef[],
  table: ProcRow[],
  lookupPanes: (pids: number[]) => Promise<Map<number, string>>
): Promise<Map<number, { tabId: string; row: ProcRow }>> {
  const mine = new Map<number, { tabId: string; row: ProcRow }>();
  for (const pane of panes) {
    for (const row of processesForPane(table, pane.pid)) {
      mine.set(row.pid, { tabId: pane.tabId, row });
    }
  }

  // A pane shell is the tab, not something run in it, and it carries
  // TMUX_PANE — so pass 2 would otherwise adopt it.
  const shells = new Set(panes.map((pane) => pane.pid));
  const rest = table
    .filter((row) => row.pid > 1 && !mine.has(row.pid) && !shells.has(row.pid))
    .map((row) => row.pid);
  if (rest.length === 0) return mine;

  const paneOf = await lookupPanes(rest);
  const tabByPane = new Map(panes.map((pane) => [pane.paneId, pane.tabId]));
  const adopted = new Map<string, number[]>();
  for (const row of table) {
    const tabId = tabByPane.get(paneOf.get(row.pid) ?? '');
    if (!tabId || mine.has(row.pid)) continue;
    mine.set(row.pid, { tabId, row });
    const roots = adopted.get(tabId);
    if (roots) roots.push(row.pid);
    else adopted.set(tabId, [row.pid]);
  }
  // Grouped by tab: descendantsOf indexes the whole table per call, so this is
  // one pass per tab rather than one per adopted process.
  for (const [tabId, roots] of adopted) {
    for (const row of descendantsOf(table, roots)) {
      if (!mine.has(row.pid)) mine.set(row.pid, { tabId, row });
    }
  }
  return mine;
}

/** The name to show for a command line: the binary, without its path. An
 *  interpreter is named by itself - `node`, not the 200-char script path. */
export function commandOf(args: string): string {
  const first = args.trim().split(/\s+/)[0] ?? '';
  const base = first.split('/').pop() ?? first;
  return base || 'process';
}

/** Interactive shells, which are the tab itself rather than something someone
 *  ran in it. A login shell wears a leading dash. */
const SHELLS = new Set([
  'bash',
  'zsh',
  'sh',
  'dash',
  'fish',
  'ksh',
  'tcsh',
  'csh',
  'login'
]);

function isShell(args: string): boolean {
  const name = commandOf(args);
  return SHELLS.has(name.startsWith('-') ? name.slice(1) : name);
}

/**
 * What one tab is running: everything under its pane, plus the pane process
 * itself when the tab runs a program directly instead of a shell.
 *
 * A pane is normally an interactive bash and is not worth a row of its own.
 * But `tmux new-session 'npm run dev'` makes the program the pane, and hiding
 * the root there would leave the tab looking idle while it serves traffic.
 */
export function processesForPane(rows: ProcRow[], panePid: number): ProcRow[] {
  const kids = descendantsOf(rows, [panePid]);
  const pane = rows.find((row) => row.pid === panePid);
  if (pane && !isShell(pane.args)) return [pane, ...kids];
  return kids;
}

/** The port out of an address: `*:5173`, `127.0.0.1:5173`, `[::1]:5173`. */
function portOf(address: string): number | null {
  const colon = address.lastIndexOf(':');
  if (colon === -1) return null;
  const port = Number(address.slice(colon + 1));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * `lsof -F pnT` output. A `p<pid>` line opens a process block; inside it each
 * file is an `f` line, then `n` (the address), then `TST=` (the TCP state).
 * Listening sockets give the ports a server is reachable on; established ones
 * are counted, which is the closest honest answer to "is anything using it".
 */
export function parseLsofSockets(raw: string): Map<number, SocketUse> {
  const use = new Map<number, SocketUse>();
  let pid = 0;
  let address = '';
  const entry = (): SocketUse => {
    let found = use.get(pid);
    if (!found) {
      found = { ports: [], connections: 0 };
      use.set(pid, found);
    }
    return found;
  };
  for (const line of raw.split('\n')) {
    const kind = line[0];
    if (kind === 'p') {
      pid = Number(line.slice(1)) || 0;
      address = '';
      continue;
    }
    if (!pid) continue;
    if (kind === 'n') {
      address = line.slice(1);
      continue;
    }
    if (!line.startsWith('TST=')) continue;
    const state = line.slice(4);
    if (state === 'LISTEN') {
      const port = portOf(address);
      if (port !== null && !entry().ports.includes(port)) {
        entry().ports.push(port);
      }
    } else if (state === 'ESTABLISHED') {
      entry().connections += 1;
    }
    address = '';
  }
  return use;
}

/** `ss -ltnpH`, for a Linux host with no lsof. Listening sockets only: the
 *  connection count is not worth a second command. */
export function parseSsListen(raw: string): Map<number, SocketUse> {
  const use = new Map<number, SocketUse>();
  for (const line of raw.split('\n')) {
    const address = line.trim().split(/\s+/)[3];
    if (!address) continue;
    const port = portOf(address);
    if (port === null) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(match[1]);
      if (!Number.isInteger(pid)) continue;
      const found = use.get(pid) ?? { ports: [], connections: 0 };
      if (!found.ports.includes(port)) found.ports.push(port);
      use.set(pid, found);
    }
  }
  return use;
}

/** Sockets held by exactly these pids, keyed by pid. Asks about our own
 *  processes only - never the rest of the machine. */
export async function socketsFor(
  target: ExecTarget,
  pids: number[]
): Promise<Map<number, SocketUse>> {
  if (pids.length === 0) return new Map();
  // -a ANDs the filters, so this is "these pids AND TCP".
  const lsof = await target
    .run(['lsof', '-a', '-p', pids.join(','), '-nP', '-iTCP', '-F', 'pnT'])
    // lsof exits 1 when nothing matches, which is the common case.
    .catch((err: unknown) => String((err as { stdout?: string }).stdout ?? ''));
  if (lsof.trim()) return parseLsofSockets(lsof);
  // No lsof on the host (a slim Linux image): ss carries the ports at least.
  const ss = await target.run(['ss', '-ltnpH']).catch(() => '');
  if (!ss.trim()) return new Map();
  const all = parseSsListen(ss);
  const wanted = new Set(pids);
  for (const pid of all.keys()) if (!wanted.has(pid)) all.delete(pid);
  return all;
}
