import { agentHomes } from '@shared/all/helpers/board-agent-core/agent-homes';
import { spaceSecret } from '@shared/all/helpers/board-agent-core/exec';

import { listConfiguredSlugs, localConfigProvider } from '../agent-adapter';
import { CONFIG_DIR, safeSlug, spaceDirPath } from '../paths';
import { DevVm, type DevVmSpace } from './devVm';
import { type DevVmSettings, readClaudeVmToken, readDevVmSettings } from './settings';

// The dev VM as this runner sets it up: its boards, its homes, its stored
// Claude token. See devVm.ts and .specs/dev-vm.md.

/** This runner's boards, as the dev VM sees them. */
export function devVmSpaces(): DevVmSpace[] {
  return listConfiguredSlugs().map((slug) => {
    const spaceDir = spaceDirPath(slug);
    return {
      slug: safeSlug(slug),
      spaceDir,
      githubToken: () => {
        try {
          return localConfigProvider.readConfig(slug).githubToken || '';
        } catch {
          return '';
        }
      },
      spaceToken: () => spaceSecret(spaceDir)
    };
  });
}

export function buildDevVm(
  settings: DevVmSettings,
  log: (line: string) => void = (line) => console.log(`[devvm] ${line}`)
): DevVm {
  return new DevVm({
    configDir: CONFIG_DIR,
    settings,
    homes: agentHomes(),
    claudeToken: () => {
      try {
        return readClaudeVmToken(CONFIG_DIR);
      } catch {
        return '';
      }
    },
    spaces: devVmSpaces,
    log
  });
}

/** The daemon's dev VM, or null when the setting is off (the default, and
 *  always off a Mac). */
export function daemonDevVm(): DevVm | null {
  const settings = readDevVmSettings(CONFIG_DIR);
  return settings.enabled ? buildDevVm(settings) : null;
}
