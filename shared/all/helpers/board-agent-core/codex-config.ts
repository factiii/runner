import { randomUUID } from 'crypto';
import path from 'path';

import type { ExecTarget } from './exec';

// What the runner sets in its own Codex home (`$CODEX_HOME`, agent-homes.ts),
// so Codex gets what Claude gets without a prompt (card 4a282e13,
// .specs/codex-permissions.md):
//
// - `project_doc_fallback_filenames = ["CLAUDE.md"]`: Codex reads AGENTS.md
//   and the board repos have CLAUDE.md. With the fallback, one file serves
//   both CLIs and nothing in the repo needs keeping in sync.
// - `[projects."<repo>"] trust_level = "trusted"` for each board's clone (and
//   its plain workspace). An untrusted folder starts Codex read-only, asking
//   for everything. Checked against codex 0.167: trusting the clone also
//   trusts every `git worktree` of it (Codex resolves a worktree to its main
//   repo), while trusting the parent `worktrees/` folder trusts nothing.
// - The one-off "always allow" answers in `rules/default.rules` are pruned,
//   once per Codex home (Jon 2026-11-09: "once to disable"): exact commands
//   (one per DB name, port, file or PID) that never match again, which the
//   Standard sandbox now covers. A marker file in the home records that it
//   ran; after that, the person's new approvals are theirs to keep.
//
// config.toml is Codex's own file too (it records hook trust there), so it is
// edited line by line, never rewritten from a model of it, and a key or table
// the person set is left as it is.

/** The key Codex reads for its project-doc fallbacks. */
const FALLBACK_KEY = 'project_doc_fallback_filenames';

/** The doc Codex should read where a repo has no AGENTS.md. */
export const CODEX_FALLBACK_DOC = 'CLAUDE.md';

/** A TOML basic string, for a path in a table header. */
const tomlString = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const isTableHeader = (line: string): boolean => /^\s*\[/.test(line);

/**
 * config.toml with the fallback doc and the trusted projects added, or null
 * when it already has them.
 *
 * - The fallback key is top level, so it goes before the first table. A key
 *   already there is kept when it names CLAUDE.md, and given CLAUDE.md
 *   otherwise (it is the runner's home; an empty list would mean Codex sees
 *   no project rules at all).
 * - A `[projects."<path>"]` table already there is left alone, whatever it
 *   says: an explicit "untrusted" is the person's call.
 */
export function withCodexConfig(
  text: string | null,
  trustedPaths: string[]
): string | null {
  const source = text ?? '';
  const lines = source === '' ? [] : source.replace(/\n$/, '').split('\n');
  let changed = false;

  const firstTable = lines.findIndex(isTableHeader);
  const topEnd = firstTable === -1 ? lines.length : firstTable;
  const keyAt = lines
    .slice(0, topEnd)
    .findIndex((line) => new RegExp(`^\\s*${FALLBACK_KEY}\\s*=`).test(line));
  const ours = `${FALLBACK_KEY} = [${tomlString(CODEX_FALLBACK_DOC)}]`;
  if (keyAt === -1) {
    lines.unshift(ours, ...(lines.length ? [''] : []));
    changed = true;
  } else if (!lines[keyAt].includes(tomlString(CODEX_FALLBACK_DOC))) {
    lines[keyAt] = ours;
    changed = true;
  }

  const unique = [...new Set(trustedPaths.filter(Boolean))];
  for (const dir of unique) {
    const header = `[projects.${tomlString(dir)}]`;
    if (lines.some((line) => line.trim() === header)) continue;
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(header, 'trust_level = "trusted"');
    changed = true;
  }

  return changed ? `${lines.join('\n')}\n` : null;
}

/** A single-line rule Codex wrote for an "always allow" answer. */
const ALLOW_RULE =
  /^prefix_rule\(\s*pattern\s*=\s*(\[.*\])\s*,\s*decision\s*=\s*"allow"\s*\)\s*$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this "always allow" pattern a one-off: an exact command that will not
 * run again? Any argument after the program that holds a space (a script, a
 * message, a format string), a path or URL, JSON, a bare number (a PID, a
 * port, a line count) or a device UUID. What is left is a general prefix
 * (`git status --short`, `pnpm install`), which stays.
 */
export function isOneOffPattern(pattern: string[]): boolean {
  return pattern
    .slice(1)
    .some(
      (arg) =>
        /\s/.test(arg) ||
        arg.includes('/') ||
        arg.includes('{') ||
        /^\d+$/.test(arg) ||
        UUID.test(arg)
    );
}

/**
 * default.rules without its one-off "always allow" rules, or null when it has
 * none. Only single-line `prefix_rule(..., decision="allow")` lines whose
 * pattern parses are judged; every other line (comments, a rule written by
 * hand over several lines, a prompt or forbidden rule) is kept as it is.
 */
export function withoutOneOffRules(text: string): string | null {
  let dropped = 0;
  const kept = text.split('\n').filter((line) => {
    const match = ALLOW_RULE.exec(line.trim());
    if (!match) return true;
    let pattern: unknown;
    try {
      pattern = JSON.parse(match[1]);
    } catch {
      return true;
    }
    if (
      !Array.isArray(pattern) ||
      !pattern.every((arg): arg is string => typeof arg === 'string')
    ) {
      return true;
    }
    if (!isOneOffPattern(pattern)) return true;
    dropped++;
    return false;
  });
  return dropped ? kept.join('\n') : null;
}

/** In the runner's Codex home, beside config.toml: written once the one-off
 *  rules have been pruned, so they are never pruned again. Codex ignores
 *  files it does not know. */
export const RULES_PRUNED_MARKER = '.factiii-one-off-rules-pruned';

/** Every space on a runner provisions at once and they share one Codex home,
 *  so its edits run one at a time, or two spaces' writes could each drop the
 *  other's trusted project. */
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(task: () => Promise<T>): Promise<T> => {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
};

/** Write beside the file, then rename over it, so Codex never reads half a
 *  config. Through a symlink to its target. */
async function replaceFile(
  target: ExecTarget,
  file: string,
  content: string
): Promise<void> {
  const real = await target.run(['realpath', file]).then(
    (out) => out.trim() || file,
    () => file
  );
  const tmp = `${real}.factiii-${process.pid}-${randomUUID()}.tmp`;
  await target.writeFile(tmp, content);
  await target.run(['mv', '-f', tmp, real]);
}

/**
 * Bring the runner's Codex home up to date: the fallback doc and these
 * trusted folders in config.toml on every call, and the one-off rules out of
 * default.rules the first time only (RULES_PRUNED_MARKER). Only when the home
 * exists, like the rules lane: a machine without Codex gets nothing written.
 */
export function writeCodexConfig(
  target: ExecTarget,
  codexDir: string,
  trustedPaths: string[]
): Promise<void> {
  return serial(async () => {
    if (!codexDir) return;
    const exists = await target.run(['test', '-d', codexDir]).then(
      () => true,
      () => false
    );
    if (!exists) return;

    const config = path.join(codexDir, 'config.toml');
    const current = await target.run(['cat', config]).catch(() => null);
    // There but unreadable: leave it, rather than replace it with ours.
    const readable =
      current !== null ||
      !(await target.run(['test', '-e', config]).then(
        () => true,
        () => false
      ));
    const next = readable ? withCodexConfig(current, trustedPaths) : null;
    if (next !== null) await replaceFile(target, config, next);

    const marker = path.join(codexDir, RULES_PRUNED_MARKER);
    const prunedBefore = await target.run(['test', '-e', marker]).then(
      () => true,
      () => false
    );
    if (prunedBefore) return;
    const rules = path.join(codexDir, 'rules', 'default.rules');
    const rulesText = await target.run(['cat', rules]).catch(() => null);
    const pruned = rulesText === null ? null : withoutOneOffRules(rulesText);
    if (pruned !== null) await replaceFile(target, rules, pruned);
    // Also when there was nothing to prune: a fresh home's later approvals
    // are the person's. Not reached when the prune's write threw, so a
    // failed attempt is tried again at the next setup.
    await target.writeFile(
      marker,
      `Pruned one-off "always allow" rules from rules/default.rules on ${new Date().toISOString()}. Delete this file to prune once more.\n`
    );
  });
}
