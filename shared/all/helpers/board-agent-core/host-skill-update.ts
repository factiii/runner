import fs from 'fs/promises';
import path from 'path';

import { libraryOriginOf } from '../librarySkill';
import type { RunSkill } from './host-run';
import { globalAgentsRoot } from './host-skills';
import prompts from './prompts.json';
import { parseSkill, resolveSkillDir } from './skill-format';

// Updating a copy of a library skill (.specs/skills-tab.md "Library
// versions"). It is a skill run with its own task: the agent reads the copy
// and the library's current text, reports what each side changed, waits for
// the owner, and writes the merge to a scratch file. It never touches the
// skill or git itself. The engine saves the merge the way the Skills tab
// saves any edit (straight to this machine, or a branch to merge for the
// repo), once checkMergedSkill has passed it.

/** What the web hands the runner: the library's current SKILL.md, built by
 *  librarySkillFile under the copy's name, and the version it records. */
export type SkillLibraryUpdate = { latest: string; version: string };

/** A run's task in place of executing the skill. */
export type SkillRunTask = { contract: string; opening: string };

/** Where the update's scratch files live: in the space, outside the
 *  workspace checkout, which every run resets and cleans. */
const updateDir = (spaceDir: string, name: string) =>
  path.join(spaceDir, 'skill-updates', name);

/** The copy as it is now: the machine's skill, or the repo's on the default
 *  branch, which the run has just checked out. */
const currentPath = (skill: RunSkill, workspace: string) =>
  path.join(
    resolveSkillDir(
      skill.scope === 'global'
        ? globalAgentsRoot()
        : path.join(workspace, '.agents', 'skills'),
      skill.name
    ),
    'SKILL.md'
  );

/**
 * Lay out the update and build its task. Checks the copy really came from
 * the library skill being offered, so an update can never be pointed at an
 * unrelated skill.
 */
export async function prepareSkillUpdate(opts: {
  skill: RunSkill;
  spaceDir: string;
  workspace: string;
  update: SkillLibraryUpdate;
}): Promise<{ task: SkillRunTask; mergedPath: string; uuid: string }> {
  const { skill, update } = opts;
  const current = currentPath(skill, opts.workspace);
  const copy = await fs.readFile(current, 'utf-8');
  const origin = libraryOriginOf(copy);
  const latestOrigin = libraryOriginOf(update.latest);
  if (!origin || latestOrigin?.uuid !== origin.uuid) {
    throw new Error(`${skill.name} is not a copy of this library skill.`);
  }
  if (latestOrigin.version !== update.version || !update.version) {
    throw new Error('The library text does not match its version.');
  }

  const dir = updateDir(opts.spaceDir, skill.name);
  await fs.mkdir(dir, { recursive: true });
  const latestPath = path.join(dir, 'latest.md');
  const mergedPath = path.join(dir, 'merged.md');
  await fs.writeFile(latestPath, update.latest, 'utf-8');
  // A merge left by an earlier run must never be saved as this one's.
  await fs.rm(mergedPath, { force: true });

  const contract = prompts.skillLibraryUpdate
    .join('\n')
    .replaceAll('{{skill}}', skill.name)
    .replaceAll('{{current}}', current)
    .replaceAll('{{latest}}', latestPath)
    .replaceAll('{{merged}}', mergedPath)
    .replaceAll('{{uuid}}', origin.uuid)
    .replaceAll('{{version}}', update.version);
  return {
    task: {
      contract,
      opening: `Update the "${skill.name}" skill from the Factiii library, following the library update protocol.`
    },
    mergedPath,
    uuid: origin.uuid
  };
}

/** The merge the agent wrote, checked before it is saved: it parses, keeps
 *  the skill's name and library uuid, and records the new version. */
export async function checkMergedSkill(opts: {
  mergedPath: string;
  name: string;
  uuid: string;
  version: string;
}): Promise<string> {
  const content = await fs.readFile(opts.mergedPath, 'utf-8').catch(() => null);
  if (content === null) throw new Error('The update wrote no merged skill.');
  const { frontmatter, errors } = parseSkill(content);
  if (errors.length) {
    throw new Error(`The merged skill does not parse: ${errors.join(' ')}`);
  }
  if (frontmatter.name !== opts.name) {
    throw new Error(`The merged skill renamed itself to ${frontmatter.name}.`);
  }
  const origin = libraryOriginOf(content);
  if (origin?.uuid !== opts.uuid || origin.version !== opts.version) {
    throw new Error(
      'The merged skill lost its library uuid or version, so it was not saved.'
    );
  }
  return content;
}
