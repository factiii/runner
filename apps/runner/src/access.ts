import fs from 'fs';
import path from 'path';

import type { RunnerAccessLevel, RunnerGrants } from '@shared/all/domains/electron';
import {
  levelAtLeast,
  parseRunnerGrants,
  rawUseAllowed
} from '@shared/all/helpers/board-agent-core/runner-access';

// The level the owner gave each board member (.specs/runner-member-access.md),
// stored runner-wide in `access.json` as
// `{ owner, grants: { <board>: { <userId>: level } } }`. Plain JSON, 0600 -
// they are settings, not secrets.
//
// Upgrade from the four levels (before 2026-11): a stored api reads as jobs,
// terminals and screens as shell (parseRunnerGrants), and the `dangerous: {
// <board>: [userId] }` lists beside them are not read: the Shell level is
// what runs a dangerous job at once now. The file takes the new shape the
// next time the owner changes a level; until then it reads the same way.
//
// Upgrade: a runner from before the levels has `access.json` with the two old
// switches, or `shared.json`, or nothing. None of them is converted: each
// reads as no grants, and the owner grants again (decided with the levels).
// `shared.json` is left on disk and no longer read.
//
// The file names the owner it was written for. A runner paired again to
// another account keeps the file, and its grants must not carry over to the
// new owner's boards, so a file for anyone else reads as no grants.

const ACCESS_FILE = 'access.json';

/** Never throws: a missing, unreadable or malformed file is no grants, and so
 *  is one written for another owner or read with no owner known. */
export function readRunnerGrants(
  configDir: string,
  ownerUserId: string | null
): RunnerGrants {
  if (!ownerUserId) return {};
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(configDir, ACCESS_FILE), 'utf-8')
    ) as { owner?: unknown } | null;
    if (raw?.owner !== ownerUserId) return {};
    return parseRunnerGrants(raw);
  } catch {
    return {};
  }
}

export function writeRunnerGrants(
  configDir: string,
  ownerUserId: string,
  grants: RunnerGrants
): void {
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, ACCESS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ owner: ownerUserId, grants })}\n`, {
    mode: 0o600
  });
  fs.renameSync(tmp, file);
}

/** What a member loses at once when the owner moves them from `before` to
 *  `after` on one board (.specs/runner-member-access.md, "Changing a level"):
 *  below Shell, their terminals and every AI session they started there;
 *  below Jobs, the simulator's video stream too. */
export function levelChangeCuts(
  before: RunnerAccessLevel,
  after: RunnerAccessLevel
): { shells: boolean; stream: boolean } {
  return {
    shells: levelAtLeast(before, 'shell') && !levelAtLeast(after, 'shell'),
    stream: rawUseAllowed(before, 'video') && !rawUseAllowed(after, 'video')
  };
}
