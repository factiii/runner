// A terminal's worktree dir and branch are named after the terminal itself, so
// its name has to be legal in both. The launcher slugs what the user types to
// show the name it will get and to refuse one that is taken; the runner slugs
// the same title again when it creates the tree. Keep this file dependency-free
// - it is imported by the web and native launchers, not just the runner.

/** Longest slug kept: well inside every filesystem's name limit. */
const WORK_NAME_MAX = 48;

/** A human name as a stem legal for both a dir and a branch. Empty when the
 *  name holds nothing usable (emoji, punctuation). */
export function slugifyWorkName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, WORK_NAME_MAX)
    .replace(/^-+|-+$/g, '');
}
