import { spawnSync } from 'node:child_process';

import { readRunnerConfig } from './config';
import { startDaemon } from './daemon';
import {
  isWorker,
  markWorkerEnv,
  RESTART_FOR_UPDATE,
  supervisorExitCode
} from './selfUpdate';

/**
 * Run the daemon under a thin supervisor so an approved self-update can take
 * effect without anyone logging in to the box.
 *
 * The supervisor is a stable, long-lived parent: it launches the daemon as a
 * child and relaunches it whenever the child exits with RESTART_FOR_UPDATE
 * (which the daemon does right after `npm install -g` replaces its code on
 * disk). Because the supervisor loops rather than nesting, there's always
 * exactly one daemon process — and systemd/pm2 or a plain terminal keep
 * tracking the same supervisor PID across updates; only the child cycles.
 *
 * `workerArgs` is the argv used to re-invoke this same CLI (`[cliPath, 'start']`).
 */
export async function runSupervised(workerArgs: string[]): Promise<never> {
  // Worker mode: launched by the supervisor with the worker env set. Run the
  // daemon in-process instead of recursing into another supervisor.
  if (isWorker()) {
    const config = readRunnerConfig();
    if (!config) {
      console.error('Failed to read config. Run "factiii-runner setup" again.');
      process.exit(1);
    }
    await startDaemon(config);
    process.exit(0);
  }

  // Supervisor loop. `afterUpdate` marks every launch but the first, which is
  // the only one a person started.
  let afterUpdate = false;
  for (;;) {
    // Carry the parent interpreter's flags into the worker. In prod this is
    // empty (`node dist/cli.js`), but in dev under tsx (`pnpm dev`) execArgv
    // holds the tsx loader import — without it the worker re-spawns as bare
    // `node src/cli.ts` and dies on the extensionless `./auth` import.
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, ...workerArgs],
      {
        stdio: 'inherit',
        env: markWorkerEnv(process.env, afterUpdate)
      }
    );

    if (child.status === RESTART_FOR_UPDATE) {
      console.log('[update] relaunching the runner on the new version...');
      afterUpdate = true;
      continue;
    }

    process.exit(supervisorExitCode(child.status, child.signal));
  }
}
