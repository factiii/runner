import type {
  RunnerServiceOutcome,
  RunnerServiceState
} from '@shared/all/domains/electron';
import type { RunnerServiceHost } from '@shared/all/helpers/board-agent-core/engine';

import { serviceIo, serviceSpec } from './machine';
import {
  removeService,
  type ServiceOutcome,
  type ServiceSpec,
  type ServiceStatus,
  serviceStatus
} from './service';

// The always-on service, from the app (Runner Settings > Setup): status and
// remove, the same as `factiii-runner service`, run by the worker the app is
// talking to. Never install. Starting at login is set up at the machine, in
// its own terminal, by the person sitting there (setup's prompt or
// `factiii-runner service install`); a runner that a remote page could make
// start itself at boot is what malware looks like (DISCLOSURE item 4). Apps
// from before this still send serviceInstall, and get the refusal below. The worker's parent is the supervisor, which is what a
// service runs, so `process.ppid` tells whether the service runs this runner.

function stateOf(status: ServiceStatus): RunnerServiceState {
  return {
    supported: true,
    name: status.name,
    installed: status.installed,
    loaded: status.loaded,
    // Windows reports no pid: a running task is this runner, since install
    // never starts a second one beside it.
    thisRunner:
      status.running && (status.pid === null || status.pid === process.ppid)
  };
}

async function outcomeOf(
  spec: ServiceSpec,
  outcome: ServiceOutcome
): Promise<RunnerServiceOutcome> {
  return {
    ok: outcome.ok,
    lines: outcome.lines,
    state: stateOf(await serviceStatus(spec, serviceIo))
  };
}

/** Undefined where `service install` would refuse: a runner run from
 *  source (tsx), or an unsupported platform. The engine then answers that
 *  only the installed runner can start by itself. */
export function runnerServiceHost(): RunnerServiceHost | undefined {
  const spec = serviceSpec();
  if (!spec) return undefined;
  return {
    status: async () => stateOf(await serviceStatus(spec, serviceIo)),
    install: async () =>
      outcomeOf(spec, {
        ok: false,
        lines: [
          'The app cannot turn this on. To start the runner at login, run factiii-runner service install in a terminal on this machine.'
        ]
      }),
    remove: async () => {
      const before = stateOf(await serviceStatus(spec, serviceIo));
      // Stopping the service would stop the runner answering this call.
      const outcome = await removeService(spec, serviceIo, {
        keepRunning: before.thisRunner
      });
      return outcomeOf(spec, outcome);
    }
  };
}
