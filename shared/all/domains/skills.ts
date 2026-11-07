// Skills (.specs/skills.md) — instructions anyone can write once and any
// research turn can follow.
//
// A skill is a Post in the `skills` space tagged with the `skill` factiii. That
// factiii carries POSTFACTIII_MODERATION_REQUIRED: the post is public like any
// other, and only once a moderator approves the tag is it listed as a skill or
// offered to the research agent. A research post that followed a skill is tagged with
// `used-skill` (POST_REFERENCE_REQUIRED), whose references are the skill posts.

/** The space every skill lives in. */
export const SKILLS_SPACE_SLUG = 'skills';

/** Marks a post as a skill. Moderated: the post is public from the start, and
 *  only this tag waits; the post is listed as a skill once it is approved. */
export const SKILL_FACTIII_SLUG = 'skill';

/** Carries the references from research to the skills it followed. */
export const USED_SKILL_FACTIII_SLUG = 'used-skill';

// skills.submit's bounds, shared so a form arms its button only for what the
// server will accept.
// The title is also the skill's description: what a list shows and what the
// agent chooses by, so a lookup never has to carry any skill's instructions.
export const SKILL_TITLE_MIN = 3;
export const SKILL_TITLE_MAX = 80;
export const SKILL_DESCRIPTION_MIN = 20;
export const SKILL_DESCRIPTION_MAX = 4000;

/** How many skills one research message may pick: the ask that starts a
 *  session, and each reply, is checked on its own. Each one rides on every
 *  round of that turn, so the cap bounds what they cost. */
export const MAX_SKILLS_PER_SESSION = 5;

/**
 * How far the review queue's size is counted. The queue can grow without bound
 * and its size is read on every list load for a reviewer; past this the exact
 * number changes nothing about what they do next.
 */
export const PENDING_COUNT_CAP = 100;

/** The queue's size as its button says it: "99+" once the count is capped. */
export const pendingCountLabel = (count: number): string =>
  count >= PENDING_COUNT_CAP ? `${PENDING_COUNT_CAP - 1}+` : String(count);

// The GitHub mirror (.specs/skills.md → GitHub mirror): approved skills are
// copied to a public repo as SKILL.md folders, so any agent that reads that
// format can install them. The repo pulls from skills.export on a schedule;
// nothing here pushes.
export const SKILLS_REPO = 'factiii/skills';
export const SKILLS_REPO_URL = `https://github.com/${SKILLS_REPO}`;

/** What a skill form says before its button, on every client: writing a skill
 *  publishes it, and approval copies it somewhere anyone can install it from. */
export const SKILL_PUBLIC_NOTE = `Skills are public. Anyone can read yours, and once a moderator approves it, it is copied to github.com/${SKILLS_REPO} for anyone to install.`;

/** How often the mirror copies, on the clock: :00, :15, :30 and :45. Must
 *  match the cron in scripts/skills-mirror/.github/workflows/sync.yml. */
export const SKILLS_SYNC_MINUTES = 15;

/** GitHub starts a scheduled run late more often than on time, so a wait is
 *  quoted this much past the clock. */
const SKILLS_SYNC_LAG_MINUTES = 5;

/** Minutes from `now` until the next copy has most likely landed. */
export const minutesToSkillsSync = (now: Date): number =>
  SKILLS_SYNC_MINUTES -
  (now.getUTCMinutes() % SKILLS_SYNC_MINUTES) +
  SKILLS_SYNC_LAG_MINUTES;

/** When to look for a change on GitHub, as every client says it. */
export const skillsSyncNote = (now: Date): string =>
  `Approved skills are copied to github.com/${SKILLS_REPO} every ${SKILLS_SYNC_MINUTES} minutes. Check there in about ${minutesToSkillsSync(now)} minutes.`;

/** A submitted skill's place in review, as its author sees it. */
export type SkillReviewStatus = 'pending' | 'approved' | 'rejected';

/** A skill a research turn used, as a result names it. */
export type UsedSkill = { uuid: string; title: string };

/**
 * A skill's stored description (the escaped <p>/<br> HTML skills.submit
 * writes) back as plain text, paragraphs kept: what the model reads. Entities
 * are decoded `&amp;` last, so a typed "&lt;" stays literal text rather than
 * turning into "<".
 */
export const skillPlainText = (html: string): string =>
  html
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/p>\s*<p>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();

// The manual trigger in a research input: a "/" that starts a word opens the
// skill menu instead of being typed. Only one starting a word counts, so
// "and/or" or a URL never opens it; and only one just typed, so deleting back
// to a slash does not reopen it.
const WORD_SLASH = /(^|\s)\/$/;

/** Whether this edit (previous → next) typed a "/" that should open the menu. */
export const opensSkillMenu = (previous: string, next: string): boolean =>
  next.length > previous.length && WORD_SLASH.test(next);
