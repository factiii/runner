import fs from 'fs';
import path from 'path';

import type {
  RunnerGrants,
  RunnerDangerousGrants
} from '@shared/all/domains/electron';
import {
  parseRunnerGrants,
  parseRunnerDangerousGrants
} from '@shared/all/helpers/board-agent-core/runner-access';

// The level the owner gave each board member (.specs/runner-member-access.md),
// stored runner-wide in `access.json` as
// `{ grants: { <board>: { <userId>: level } } }`. Plain JSON, 0600 - they are
// settings, not secrets. Beside them, `dangerous: { <board>: [userId] }` lists who
// may run dangerous jobs; a file without it (every file from before the
// permission) gives it to nobody.
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

/** Who may run dangerous jobs, from the same file and by the same rules:
 *  missing, malformed or another owner's is nobody. */
export function readRunnerDangerousGrants(
  configDir: string,
  ownerUserId: string | null
): RunnerDangerousGrants {
  if (!ownerUserId) return {};
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(configDir, ACCESS_FILE), 'utf-8')
    ) as { owner?: unknown } | null;
    if (raw?.owner !== ownerUserId) return {};
    return parseRunnerDangerousGrants(raw) ?? {};
  } catch {
    return {};
  }
}

export function writeRunnerGrants(
  configDir: string,
  ownerUserId: string,
  grants: RunnerGrants,
  dangerous: RunnerDangerousGrants = {}
): void {
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, ACCESS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ owner: ownerUserId, grants, dangerous })}\n`,
    { mode: 0o600 }
  );
  fs.renameSync(tmp, file);
}
