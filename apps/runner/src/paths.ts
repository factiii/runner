import { runnerDir } from '@shared/all/helpers/board-agent-core/runner-dir';
import path from 'path';

/** Everything the runner persists lives here: ~/.factiii-runner, or
 *  FACTIII_RUNNER_DIR for a second runner on the same machine (runner-dir.ts). */
export const CONFIG_DIR = runnerDir();

/** Board slugs become directory names, so keep them boring. */
export function safeSlug(spaceSlug: string): string {
  return spaceSlug.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/** Per-space environment root. No mkdir - see localConfigProvider.spaceDir,
 *  which owns creating the schema (workspace/backups/builds/secrets/...). */
export function spaceDirPath(spaceSlug: string): string {
  return path.join(CONFIG_DIR, safeSlug(spaceSlug));
}
