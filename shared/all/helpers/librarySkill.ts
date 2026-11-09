import { skillPlainText } from '../domains/skills';
import {
  parseSkill,
  serializeSkill,
  toSkillName
} from './board-agent-core/skill-format';

// A skill from the public library (s/skills) written as a SKILL.md the runner
// can load, the same file the GitHub mirror publishes
// (scripts/skills-mirror/scripts/sync.mjs): the title is the description, the
// uuid in metadata finds it again, and the version beside it says which
// library version the copy came from, so the Skills tab can offer an update
// (.specs/skills-tab.md "Library versions"). The Skills tab's "Add" uses it.

export type LibrarySkill = {
  uuid: string;
  title: string;
  author: string;
  /** The stored instructions: escaped <p>/<br> HTML. */
  description: string;
  /** skillVersion of the approved title and instructions. Absent from a
   *  server older than library versions; the copy then records none. */
  version?: string;
};

/** Where a copy came from: the library skill and the version it was added
 *  from or last updated to ('' when it predates versions). */
export type LibraryOrigin = { uuid: string; version: string };

/** Written above `metadata:` so an agent editing the copy keeps the two
 *  fields the update check depends on. The frontmatter reader skips it. */
export const LIBRARY_ORIGIN_NOTE =
  '# From the Factiii library. Keep metadata.uuid and metadata.version as they are: they are how updates are found. Only an update changes version.';

/** The folder name a library skill gets: its title's slug, numbered when a
 *  skill of that name is already where it is going. */
export function librarySkillName(
  skill: Pick<LibrarySkill, 'uuid' | 'title'>,
  taken: ReadonlySet<string>
): string {
  const base = toSkillName(skill.title) || `skill-${skill.uuid.slice(0, 8)}`;
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
}

/** The SKILL.md text for a library skill under `name`. */
export function librarySkillFile(skill: LibrarySkill, name: string): string {
  const description = skill.title.replace(/\s*\n\s*/g, ' ').trim();
  // A title often holds a colon ("Review a lease: what to check"), which ends a
  // plain YAML scalar early. JSON's string form is also a valid YAML
  // double-quoted scalar, as the mirror writes it.
  return serializeSkill(
    {
      name,
      description,
      metadata: {
        author: skill.author,
        uuid: skill.uuid,
        ...(skill.version ? { version: skill.version } : {})
      }
    },
    `# ${skill.title}\n\n${skillPlainText(skill.description)}\n`
  )
    .replace(
      `description: ${description}`,
      `description: ${JSON.stringify(description)}`
    )
    .replace('\nmetadata:\n', `\n${LIBRARY_ORIGIN_NOTE}\nmetadata:\n`);
}

/** The library uuid a runner skill was added from, if any. */
export const libraryUuidOf = (content: string): string | null =>
  content.match(/^\s+uuid:\s*"?([0-9a-f-]{36})"?\s*$/m)?.[1] ?? null;

/** A copy's library origin, or null when it was not added from the library.
 *  Read from the frontmatter's metadata, never the body, so a skill that
 *  merely mentions a version is not mistaken for one. A copy added before
 *  versions has a uuid only: its version is '' and so it never matches, which
 *  offers it an update that records one. */
export const libraryOriginOf = (content: string): LibraryOrigin | null => {
  const metadata = parseSkill(content).frontmatter.metadata;
  const uuid = metadata?.uuid ?? '';
  if (!/^[0-9a-f-]{36}$/.test(uuid)) return null;
  return { uuid, version: metadata?.version ?? '' };
};
