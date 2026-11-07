import { randomUUID } from 'crypto';
import path from 'path';

import type { ExecTarget } from './exec';
import { SECRETS_BIN } from './plugin';

// Letting `factiii-secrets` past the CLIs' own gates, in the user's own config,
// so it holds for every session on the machine: the ones a runner starts and
// the `claude` or `codex` someone types into a terminal.
//
// Every `factiii-secrets run` already waits for the owner's password, shown the
// exact command (space-core.ts: "a free command here always prompts"), and
// `list` prints key names only. Claude's auto-mode classifier refused a
// deploy skill's own `factiii-secrets run --file <ssh key> -- ssh ...` as a
// production read, so the owner was never asked.
//
// Both CLIs check each part of a chained command on its own, so whatever is
// chained around the wrapper still meets the CLI's own gate. `tunnel-token`
// stays gated: neither rule names it.

/** Claude allow rules (user settings, `permissions.allow`). An allow rule is
 *  what Claude Code documents as deciding before the classifier; a plugin
 *  cannot ship one. */
export const CLAUDE_SECRETS_RULES = [
  `Bash(${SECRETS_BIN} run *)`,
  `Bash(${SECRETS_BIN} list)`
];

/** The codex rules file, `$CODEX_HOME/rules/<this>`. Ours alone, so it is
 *  written whole rather than merged. */
export const CODEX_RULES_FILE = 'factiii.rules';

/** `allow` runs a match outside codex's sandbox without asking, which is also
 *  what lets the wrapper reach the runner's socket. A script with `$(...)`,
 *  a redirect or a variable is matched whole as `bash -lc <script>`, so it
 *  does not match these and codex asks as before. */
export const CODEX_SECRETS_RULES = `# Written by the factiii runner. factiii-secrets asks the owner for their
# password before it runs anything, so codex need not ask as well.
prefix_rule(
    pattern = ["${SECRETS_BIN}", "run"],
    decision = "allow",
    justification = "factiii-secrets asks the owner for their password before it runs anything",
)
prefix_rule(
    pattern = ["${SECRETS_BIN}", "list"],
    decision = "allow",
    justification = "factiii-secrets list prints key names, never values",
)
`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Claude's `settings.json` with the rules added, or null when nothing should
 * be written: they are all there already, or the file is not a JSON object
 * this can edit with certainty. A file it cannot read is left alone, never
 * "repaired". No file at all (null or blank) starts from `{}`.
 */
export function withClaudeSecretsRules(text: string | null): string | null {
  let settings: unknown = {};
  if (text?.trim()) {
    try {
      settings = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!isObject(settings)) return null;
  const permissions = settings.permissions ?? {};
  if (!isObject(permissions)) return null;
  const allow = permissions.allow ?? [];
  if (!Array.isArray(allow)) return null;
  const missing = CLAUDE_SECRETS_RULES.filter((rule) => !allow.includes(rule));
  if (!missing.length) return null;
  const next = {
    ...settings,
    permissions: { ...permissions, allow: [...allow, ...missing] }
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** What taking the rules back out of a `settings.json` comes to. */
export type ClaudeRulesRemoval =
  | { status: 'edited'; text: string }
  | { status: 'absent' }
  | { status: 'unparseable' };

/** The indentation a JSON file already uses, so a rewrite changes only the
 *  keys it means to. Two spaces when it shows none: what the writer above
 *  and claude itself use. */
const indentOf = (text: string): string =>
  /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ';

/**
 * Claude's `settings.json` without the rules `withClaudeSecretsRules` adds:
 * the exact strings in CLAUDE_SECRETS_RULES, nothing that merely resembles
 * them, so a rule the person wrote themselves stays.
 *
 * The `allow` array and `permissions` object stay even when this empties
 * them: the writer records nothing about whether it created them, and an
 * empty one is harmless where a person's own deleted one is not. Every other
 * key keeps its order and value.
 */
export function withoutClaudeSecretsRules(text: string): ClaudeRulesRemoval {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return { status: 'unparseable' };
  }
  if (!isObject(settings) || !isObject(settings.permissions)) {
    return { status: 'absent' };
  }
  const { permissions } = settings;
  const allow = permissions.allow;
  if (!Array.isArray(allow)) return { status: 'absent' };
  const kept = allow.filter(
    (rule: unknown) =>
      typeof rule !== 'string' || !CLAUDE_SECRETS_RULES.includes(rule)
  );
  if (kept.length === allow.length) return { status: 'absent' };
  const next = { ...settings, permissions: { ...permissions, allow: kept } };
  const tail = text.endsWith('\n') ? '\n' : '';
  return {
    status: 'edited',
    text: `${JSON.stringify(next, null, indentOf(text))}${tail}`
  };
}

/** Is this `factiii.rules` text the one `writeCodexSecretsRules` writes? The
 *  same comparison it makes before writing. There is one version so far; an
 *  older one, if the text ever changes, belongs in this check too. */
export const isRunnerCodexRules = (text: string): boolean =>
  text.trim() === CODEX_SECRETS_RULES.trim();

const passes = (target: ExecTarget, argv: string[]): Promise<boolean> =>
  target.run(argv).then(
    () => true,
    () => false
  );

/** Write beside the file, then rename over it, so a crash never leaves half a
 *  settings file for the CLI to choke on. Through a symlink to its target: a
 *  settings file kept in a dotfiles repo stays linked. The temp name is unique
 *  per write, because every space on a runner provisions at once. */
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

/** Merge the allow rules into `<claudeDir>/settings.json`. */
export async function writeClaudeSecretsRules(
  target: ExecTarget,
  claudeDir: string
): Promise<void> {
  if (!claudeDir || !(await passes(target, ['test', '-d', claudeDir]))) return;
  const file = path.join(claudeDir, 'settings.json');
  let text: string | null = null;
  try {
    text = await target.run(['cat', file]);
  } catch {
    // There but unreadable: leave it, rather than replace it with ours.
    if (await passes(target, ['test', '-e', file])) return;
  }
  const next = withClaudeSecretsRules(text);
  if (next !== null) await replaceFile(target, file, next);
}

/** Write `<codexDir>/rules/factiii.rules`, unless it already says this. */
export async function writeCodexSecretsRules(
  target: ExecTarget,
  codexDir: string
): Promise<void> {
  if (!codexDir || !(await passes(target, ['test', '-d', codexDir]))) return;
  const file = path.join(codexDir, 'rules', CODEX_RULES_FILE);
  const current = await target.run(['cat', file]).catch(() => null);
  if (current !== null && isRunnerCodexRules(current)) return;
  await replaceFile(target, file, CODEX_SECRETS_RULES);
}
