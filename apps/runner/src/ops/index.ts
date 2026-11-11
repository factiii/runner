import type { OpsLinkFactory } from '@shared/all/helpers/board-agent-core/ops-link';

import { CONFIG_DIR } from '../paths';
import { opsClient } from './client';
import { createOpsLink } from './link';
import { readBoardToken } from './serve';
import { opsRunPaths, readOpsSettings } from './settings';

// The session half's ops user, as the daemon sets it up (.specs/ops-user.md).

let enabledAtStart: boolean | null = null;

/** The setting as this process started with it (it takes a restart). */
export function opsEnabled(): boolean {
  enabledAtStart ??= readOpsSettings(CONFIG_DIR).enabled;
  return enabledAtStart;
}

/** The daemon's link factory per board, or null when the setting is off
 *  (the default, and always off Windows). */
export function daemonOps(
  log: (line: string) => void = (line) => console.log(`[ops] ${line}`)
): { linkFor: (slug: string) => OpsLinkFactory } | null {
  if (!opsEnabled()) return null;
  const settings = readOpsSettings(CONFIG_DIR);
  const run = opsRunPaths(settings.runDir);
  return {
    linkFor: (slug) => (hooks) =>
      createOpsLink({
        client: opsClient({
          socketPath: run.socket,
          peerDir: run.peerDir,
          board: slug,
          // Read at each call: the ops service mints new ones at its start.
          token: () => readBoardToken(settings.runDir, slug)
        }),
        hooks,
        log: (line) => log(`${slug}: ${line}`)
      })
  };
}
