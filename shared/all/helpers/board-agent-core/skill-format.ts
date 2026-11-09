import type { SkillFrontmatter } from '../../validators';
import {
  SKILL_DIR_NAME_REGEX,
  SKILL_MD_NAME_MAX,
  skillFrontmatterSchema
} from '../../validators';

/** Repo skills no CLI lists at start, so they cost no context in a session
 *  (card 39b89977): an AI reads one only when told to, and the Skills tab runs
 *  one by pointing the agent at its SKILL.md (host-run.ts). Never linked into a
 *  CLI root. */
export const ON_REQUEST_ROOT = '.agents/skills-on-request';

// SKILL.md format handling. Deliberately free of node builtins as well as of
// filesystem and git: the Skills modal parses and re-serialises in the browser,
// and host-skills.ts owns everything that touches a disk.
//
// Both CLIs settled on the same format, the Agent Skills standard
// (agentskills.io/specification): Codex (0.144) allows exactly
// {name, description, license, allowed-tools, metadata} and Claude Code also
// honours `model`, so the union round-trips through either. The standard
// adds `compatibility`, read and written here so a skill from skills.sh opens;
// Codex's bundled skill validator does not list it yet, so none of ours uses
// it.

export type ParsedSkill = {
  frontmatter: SkillFrontmatter;
  body: string;
  /** Non-fatal problems. A broken skill still renders so it can be fixed. */
  errors: string[];
};

const EMPTY_FRONTMATTER: SkillFrontmatter = { name: '', description: '' };

/** Split `key: value` at the FIRST colon only: descriptions routinely contain
 *  colons, and every real frontmatter value here is a scalar or a list. */
function splitKey(line: string): { key: string; value: string } | null {
  const at = line.indexOf(':');
  if (at < 1) return null;
  return { key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
}

function stripQuotes(value: string): string {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  return quoted && value.length > 1 ? value.slice(1, -1) : value;
}

/** Minimal YAML frontmatter reader: scalars, `- item` lists and one level of
 *  nested map (`metadata:`). That is the whole surface both CLIs accept, and it
 *  avoids a YAML dependency in a package that has none. Anything it cannot read
 *  becomes an error string rather than an exception, so a malformed skill still
 *  opens in the editor. */
export function parseSkill(raw: string): ParsedSkill {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---')) {
    return {
      frontmatter: EMPTY_FRONTMATTER,
      body: text,
      errors: ['Must start with YAML frontmatter (---).']
    };
  }
  const lines = text.split('\n');
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) {
    return {
      frontmatter: EMPTY_FRONTMATTER,
      body: text,
      errors: ['Frontmatter is never closed (missing the second ---).']
    };
  }

  const errors: string[] = [];
  const fields: Record<string, unknown> = {};
  let pendingKey = '';
  let list: string[] = [];
  let map: Record<string, string> = {};

  // A bare `key:` opens either a list or a nested map; whichever the following
  // indented lines fill in is the one that gets kept.
  const flush = () => {
    if (pendingKey) {
      if (list.length) fields[pendingKey] = list;
      else if (Object.keys(map).length) fields[pendingKey] = map;
    }
    pendingKey = '';
    list = [];
    map = {};
  };

  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indented = /^\s/.test(line);

    if (indented && pendingKey) {
      if (line.trim().startsWith('- ')) {
        list.push(stripQuotes(line.trim().slice(2).trim()));
      } else {
        const nested = splitKey(line);
        if (nested) map[nested.key] = stripQuotes(nested.value);
        else errors.push(`Cannot read indented line: ${line.trim()}`);
      }
      continue;
    }
    if (indented) {
      errors.push(`Cannot read indented line: ${line.trim()}`);
      continue;
    }

    flush();
    const pair = splitKey(line);
    if (!pair) {
      errors.push(`Cannot read line: ${line.trim()}`);
      continue;
    }
    if (pair.value === '') {
      pendingKey = pair.key;
      continue;
    }
    fields[pair.key] = stripQuotes(pair.value);
  }
  flush();

  // We always write a list, but hand-authored files often use the CLI's
  // comma-separated string form.
  const tools = fields['allowed-tools'];
  if (typeof tools === 'string') {
    fields['allowed-tools'] = tools
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean);
  }
  if (fields['disable-model-invocation'] === 'true') {
    errors.push('disable-model-invocation must be false.');
    delete fields['disable-model-invocation'];
  }
  if (fields['disable-model-invocation'] === 'false') {
    fields['disable-model-invocation'] = false;
  }

  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n/, '');
  const parsed = skillFrontmatterSchema.safeParse(fields);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join('.') || 'frontmatter'}: ${issue.message}`);
    }
    // Keep whatever is readable so the editor can show and fix it.
    return {
      frontmatter: {
        name: typeof fields.name === 'string' ? fields.name : '',
        description:
          typeof fields.description === 'string' ? fields.description : ''
      },
      body,
      errors
    };
  }
  return { frontmatter: parsed.data, body, errors };
}

/** Canonical SKILL.md text. The editor always round-trips through this, so a
 *  hand-written file is normalised the first time it is saved. */
export function serializeSkill(
  frontmatter: SkillFrontmatter,
  body: string
): string {
  const lines = ['---', `name: ${frontmatter.name}`];
  // One line: both CLIs read the description as a single scalar, and every
  // skill in this repo keeps it unwrapped.
  lines.push(
    `description: ${frontmatter.description.replace(/\s*\n\s*/g, ' ').trim()}`
  );
  const tools = frontmatter['allowed-tools'];
  if (tools?.length) {
    lines.push('allowed-tools:');
    for (const tool of tools) lines.push(`  - ${tool}`);
  }
  if (frontmatter.model) lines.push(`model: ${frontmatter.model}`);
  if (frontmatter.license) lines.push(`license: ${frontmatter.license}`);
  if (frontmatter.compatibility) {
    lines.push(`compatibility: ${frontmatter.compatibility}`);
  }
  const metadata = frontmatter.metadata;
  if (metadata && Object.keys(metadata).length) {
    lines.push('metadata:');
    for (const [key, value] of Object.entries(metadata)) {
      lines.push(`  ${key}: ${value}`);
    }
  }
  if (frontmatter['disable-model-invocation'] === false) {
    lines.push('disable-model-invocation: false');
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n${body.replace(/^\n+/, '')}`;
}

/** Turn what a user typed into a usable skill name. Both CLIs key a skill on
 *  its directory, and `SKILL_NAME_REGEX` (the standard's rule: lowercase,
 *  digits, single dashes) allows one plain segment, so a typed "Test skill"
 *  has to become "test-skill" before it reaches disk. Rejecting it instead
 *  would only make the user do this substitution by hand. */
export function toSkillName(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      // Dots and underscores were allowed before the standard; they fold into
      // dashes with everything else.
      .replace(/[^a-z0-9]+/g, '-')
      // Collapse runs and trim the separators off the ends, so " a  b " and
      // "a---b" both land on "a-b".
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      // The standard caps a name at 64; cutting can leave a dash at the end.
      .slice(0, SKILL_MD_NAME_MAX)
      .replace(/-+$/, '')
  );
}

/** What a typed new-skill name will be created as, when that differs from
 *  what was typed; null when there is nothing to warn about. The name becomes
 *  a directory, so both clients show this before the user commits to it. An
 *  empty string means nothing usable survives, which the UI shows as a dash. */
export function skillNameRewrite(raw: string): string | null {
  const typed = raw.trim();
  if (!typed) return null;
  const name = toSkillName(raw);
  return name === typed ? null : name;
}

/** Join a skill name onto a root, refusing anything that is not one plain
 *  segment. The name arrives from the wire and the roots sit in the host user's
 *  home, so `..`, absolute paths and separators must never resolve. Done with
 *  string checks rather than `path` so this module stays browser-safe:
 *  SKILL_DIR_NAME_REGEX already excludes every separator. It is the legacy
 *  rule, not the standard's, so a skill named before the standard still opens
 *  and deletes; creating one checks SKILL_NAME_REGEX on its own. */
export function resolveSkillDir(root: string, name: string): string {
  if (!SKILL_DIR_NAME_REGEX.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return `${root.replace(/[/\\]+$/, '')}/${name}`;
}
