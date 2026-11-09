// How the skills on a board connect: which runner jobs a skill calls, which
// other skills it hands off to, and which secrets those jobs read. The runner
// reads each SKILL.md once while listing (`skillMentions`, host-skills.ts) and
// the Skills tab joins the lists (`skillLinks`) for its list and its graph
// (.specs/skills-tab.md).

/** `factiii-runner job <name>`, the one way a skill calls a job (runner-jobs
 *  skill). Flags such as `--list` are not job names. */
const JOB_CALL = /factiii-runner\s+job\s+([a-z0-9][a-z0-9-]*)/g;

/** The ways a skill names another one: a slash command (`/deploy`), a
 *  backticked name (`` `audit` ``), or "<name> skill". A slash inside a path
 *  (`docs/deploy.md`, `apps/server`) is not a command, so the slash must
 *  follow a space, a bracket or a quote, and the name must end there (a
 *  full stop ends a sentence, `.md` ends a file). */
const SKILL_NAME_PATTERNS = [
  /(?:^|[\s("'])\/([a-z][a-z0-9-]*)(?![\w/-]|\.\w)/g,
  /`([a-z][a-z0-9-]*)`/g,
  /\b([a-z][a-z0-9-]*)\s+skill\b/g
];

/** Words the "<name> skill" form catches that are never a skill's name. */
const NOT_A_SKILL = new Set(['this', 'that', 'the', 'a', 'each', 'any', 'one']);

export type SkillMentions = {
  /** Job names, as written. A job the board does not define stays listed so
   *  the tab can flag it. */
  jobs: string[];
  /** Names that may be skills. Only the ones a board has count; the tab
   *  matches them against its lists (`skillLinks`). */
  skills: string[];
};

const allMatches = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map((m) => m[1]);

/** What one SKILL.md calls and names, sorted and without repeats. */
export function skillMentions(content: string): SkillMentions {
  const jobs = new Set(allMatches(content, JOB_CALL));
  const skills = new Set(
    SKILL_NAME_PATTERNS.flatMap((p) => allMatches(content, p)).filter(
      (name) => !NOT_A_SKILL.has(name)
    )
  );
  return { jobs: [...jobs].sort(), skills: [...skills].sort() };
}

/** Where a skill comes from. `machine` and `repo` are on the runner (the
 *  runner calls them `global` and `repo`); `factiii` is the public library. */
export type SkillSource = 'machine' | 'repo' | 'factiii';

export type LinkedSkill = {
  name: string;
  source: SkillSource;
  /** From the runner's list. Absent from a runner older than connections. */
  uses?: SkillMentions;
};

export type JobRef = {
  name: string;
  /** False when no job of that name is defined on this board. */
  known: boolean;
  /** The secret keys the job reads. */
  keys: string[];
};

export type SkillLinks = {
  jobs: JobRef[];
  /** Skills this one hands off to, by name, that the board has. */
  skills: string[];
  /** Skills that hand off to this one. */
  usedBy: string[];
  /** Another source holds a skill of the same name. */
  shadowedBy: SkillSource[];
};

/** Each skill's connections, by `source/name`. A skill's own name never
 *  counts as a hand-off to itself. */
export function skillLinks(
  skills: readonly LinkedSkill[],
  jobs: readonly { name: string; keys: readonly string[] }[]
): Map<string, SkillLinks> {
  const names = new Set(skills.map((s) => s.name));
  const jobKeys = new Map(jobs.map((j) => [j.name, [...j.keys]]));
  const usedBy = new Map<string, Set<string>>();
  const sourcesOf = new Map<string, SkillSource[]>();
  for (const skill of skills) {
    sourcesOf.set(skill.name, [
      ...(sourcesOf.get(skill.name) ?? []),
      skill.source
    ]);
  }

  const handOffs = (skill: LinkedSkill) =>
    (skill.uses?.skills ?? []).filter(
      (name) => name !== skill.name && names.has(name)
    );
  for (const skill of skills) {
    for (const name of handOffs(skill)) {
      usedBy.set(name, (usedBy.get(name) ?? new Set()).add(skill.name));
    }
  }

  const out = new Map<string, SkillLinks>();
  for (const skill of skills) {
    out.set(skillKey(skill), {
      jobs: (skill.uses?.jobs ?? []).map((name) => ({
        name,
        known: jobKeys.has(name),
        keys: jobKeys.get(name) ?? []
      })),
      skills: handOffs(skill),
      usedBy: [...(usedBy.get(skill.name) ?? [])].sort(),
      shadowedBy: (sourcesOf.get(skill.name) ?? []).filter(
        (source) => source !== skill.source
      )
    });
  }
  return out;
}

/** One skill's id across sources: two sources may hold the same name. */
export const skillKey = (skill: { source: SkillSource; name: string }) =>
  `${skill.source}/${skill.name}`;
