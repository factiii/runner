import type { RunnerKeepAwake, RunnerLidHoldState } from "../domains/electron";
import { lidAwakeOffScript } from "./serverReadiness";

// Lid closed while keep-awake holds (.specs/runner-keep-awake.md "Lid
// closed"). caffeinate cannot hold a closed lid; `pmset -a disablesleep 1`
// can, and it needs root. Factiii Desktop sets up, once and behind macOS's
// own admin prompt, a sudoers drop-in that lets the installing user run
// exactly two commands without a password:
//   /usr/bin/pmset -a disablesleep 0
//   /usr/bin/pmset -a disablesleep 1
// The runner then calls them with `sudo -n` (never prompts; fails if the rule
// is gone) when Automatic or While plugged in takes and lets go of its hold
// (apps/runner/src/lidHold.ts). Nothing else runs as root, and no password
// passes through Factiii.

const PMSET_BIN = "/usr/bin/pmset";
export const SUDO_BIN = "/usr/bin/sudo";
/** The two commands the grant allows, as argv after `sudo -n`. */
export const lidPmsetArgs = (on: boolean): string[] => [
  PMSET_BIN,
  "-a",
  "disablesleep",
  on ? "1" : "0",
];

/** Where the grant lives, and the system tools the install script uses.
 *  Tests point them at a temp root and fakes. */
type LidGrantPaths = {
  /** The sudoers drop-in folder. */
  dir: string;
  /** The main sudoers file, to check it reads `dir`. */
  sudoers: string;
  visudo: string;
  chown: string;
};

const LID_GRANT_PATHS: LidGrantPaths = {
  dir: "/etc/sudoers.d",
  sudoers: "/etc/sudoers",
  visudo: "/usr/sbin/visudo",
  chown: "/usr/sbin/chown",
};

const LID_GRANT_NAME = "factiii-pmset";
export const LID_GRANT_FILE = `${LID_GRANT_PATHS.dir}/${LID_GRANT_NAME}`;

/** A macOS short name sudoers can take as is: letters, digits, `_`, `-` and
 *  `.`, not starting with `-`. Anything else is refused, never quoted. */
const USER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export const validLidGrantUser = (user: string): boolean =>
  USER_NAME.test(user) && user !== "root";

/** The drop-in, line by line. No line has a single quote: the install
 *  script writes each one single-quoted. No comment starts `#include`,
 *  which sudoers would read as a directive. */
function lidSudoersLines(user: string): string[] {
  if (!validLidGrantUser(user)) {
    throw new Error(`Refused: "${user}" is not a user name sudoers can take.`);
  }
  return [
    "# Factiii Desktop: lets this user turn lid-closed keep-awake on and off",
    "# without a password, for the runner (Automatic, While plugged in).",
    "# Only these two commands. Remove it from Factiii Desktop, or with",
    `# sudo rm ${LID_GRANT_FILE}`,
    `${user} ALL = (root) NOPASSWD: ${lidPmsetArgs(false).join(" ")}, ${lidPmsetArgs(true).join(" ")}`,
  ];
}

export const lidSudoersContent = (user: string): string =>
  `${lidSudoersLines(user).join("\n")}\n`;

/** Single-quoted for sh. The paths are ours; this only guards a space. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Root's script, run once behind the admin prompt: writes the drop-in to a
 *  temp file in the same folder (a name with a `.`, which sudoers skips),
 *  root:wheel 0440, has `visudo -cf` check it, and only then moves it into
 *  place (atomic: the same filesystem). Then the whole config is checked
 *  again, and the drop-in removed if that fails. Refuses, changing nothing,
 *  if the main sudoers file does not read the drop-in folder. Exit codes:
 *  3 not read, 4 visudo refused the file, 5 the whole config failed. */
export function lidGrantInstallScript(
  user: string,
  paths: LidGrantPaths = LID_GRANT_PATHS,
): string {
  const lines = lidSudoersLines(user).map(sq).join(" ");
  const target = sq(`${paths.dir}/${LID_GRANT_NAME}`);
  const dirPattern = paths.dir.replace(/^\/etc\//, "(/private)?/etc/");
  return [
    "set -e",
    "umask 077",
    `grep -Eq '^[#@]includedir[[:space:]]+${dirPattern.replace(/\./g, "\\.")}/?[[:space:]]*$' ${sq(paths.sudoers)} || { echo 'This Mac does not read ${paths.dir}: nothing was changed.' >&2; exit 3; }`,
    `tmp=$(mktemp ${sq(`${paths.dir}/.${LID_GRANT_NAME}.XXXXXX`)})`,
    `trap 'rm -f "$tmp"' EXIT`,
    `printf '%s\\n' ${lines} > "$tmp"`,
    `${sq(paths.chown)} root:wheel "$tmp"`,
    'chmod 0440 "$tmp"',
    `${sq(paths.visudo)} -cf "$tmp" >/dev/null || { echo 'visudo refused the rule: nothing was changed.' >&2; exit 4; }`,
    `mv -f "$tmp" ${target}`,
    "trap - EXIT",
    `${sq(paths.visudo)} -c >/dev/null || { rm -f ${target}; echo 'The sudoers config did not check out with it, so it was removed.' >&2; exit 5; }`,
  ].join("; ");
}

/** Root's script to take the grant away. Lid-closed keep-awake goes off
 *  first (and the desktop's own timer with it): with the grant gone the
 *  runner could no longer turn it off. */
export const lidGrantRemoveScript = (
  paths: LidGrantPaths = LID_GRANT_PATHS,
): string =>
  `${lidAwakeOffScript()}; rm -f ${sq(`${paths.dir}/${LID_GRANT_NAME}`)}`;

type Run = (
  bin: string,
  args: string[],
) => Promise<{ code: number; output: string }>;

/** Whether this user can run `pmset -a disablesleep 1` through sudo without
 *  a password: `sudo -n -l <command>`, which lists it when allowed and never
 *  prompts. True for the grant, and for a user whose sudoers already lets
 *  them run anything without a password. */
export async function readLidGrant(run: Run): Promise<boolean> {
  try {
    const res = await run(SUDO_BIN, ["-n", "-l", ...lidPmsetArgs(true)]);
    return res.code === 0;
  } catch {
    return false;
  }
}

/** `pmset -g therm`: thermal or performance pressure macOS has recorded.
 *  Intel Macs print `CPU_Speed_Limit = N` (100: none); Apple silicon prints
 *  a warning level when one is set, and "No thermal warning level has been
 *  recorded" otherwise. Null: nothing it can read. */
const THROTTLED_BELOW = 70;
export function parsePmsetTherm(output: string): boolean | null {
  const level = /(?:thermal|performance) warning level\s*[=:]\s*(\d+)/gi;
  let seen = false;
  for (const m of output.matchAll(level)) {
    seen = true;
    if (Number(m[1]) > 0) return true;
  }
  const speed = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(output);
  if (speed) return Number(speed[1]) < THROTTLED_BELOW;
  if (/No (?:thermal|performance) warning level/i.test(output)) return false;
  return seen ? false : null;
}

/** Lid-closed keep-awake's one line for the Keep awake card, or null where
 *  it does not apply (no laptop, or an older runner that says nothing).
 *  `grant` is the runner's reading (RunnerServerReadiness.lidGrant). */
export function lidHoldLine(
  keep: RunnerKeepAwake,
  grant: boolean | null | undefined,
): string | null {
  const state: RunnerLidHoldState | undefined = keep.lid;
  if (grant === true && state === "needs-setup") {
    // Set up since the runner last tried (it tries again every few min).
    return "Lid closed: set up. The runner picks it up within a few minutes.";
  }
  if (grant === false || state === "needs-setup") {
    return "Lid closed: not set up, so closing the lid sleeps the Mac. Set up in Factiii Desktop on this Mac.";
  }
  if (grant === undefined && state === undefined) return null;
  if (state === "holding")
    return "Lid closed too: stays awake with the lid shut while this holds.";
  if (state === "low-battery")
    return "Lid closed: let go, the battery is low. The Mac sleeps if the lid is shut.";
  if (state === "hot")
    return "Lid closed: let go, the Mac is running hot. It sleeps if the lid is shut.";
  if (state === "by-hand")
    return "Lid closed is on from Factiii Desktop; keep-awake leaves it as it is.";
  if (state === "failed")
    return "Lid closed: pmset refused, so closing the lid may sleep the Mac.";
  return "Lid closed: set up. Automatic and While plugged in hold it too.";
}
