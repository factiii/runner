import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';


import {
  ensureToolchain,
  hostTarget
} from '@shared/all/helpers/board-agent-core';

import { pairWithBrowser } from './auth';
import { writeRunnerConfig } from './config';
import {
  confirm,
  installThisService,
  printAlwaysOnNotes,
  serviceIo,
  serviceSpec
} from './machine';
import { renderParts } from './partsCli';
import { CONFIG_DIR } from './paths';
import { createPartsManager } from './runnerParts';
import { storeStatus } from './secureStore';
import { SECRETS_AFTER_RESTART, serviceFiles, serviceStatus } from './service';

// All shell-out helpers below take an argv array (no shell), so paths with
// spaces and untrusted-looking strings can't break the command or inject.
function run(bin: string, args: string[], opts?: { silent?: boolean }): string {
  try {
    return execFileSync(bin, args, {
      encoding: 'utf-8',
      stdio: opts?.silent ? 'pipe' : 'inherit',
      // Avoids a cmd.exe window flash on Windows during silent checks.
      windowsHide: true
    });
  } catch {
    return '';
  }
}

export async function setup(serverUrl: string): Promise<void> {
  console.log('\n=== Factiii Runner — Setup ===\n');

  // Step 0: refuse before anything else. Setup ends by writing a bearer token,
  // and this runner never writes a credential it can't encrypt. Only the
  // keychain is asked: the pairing config never needed the owner password.
  const store = storeStatus();
  if (!store.ready) {
    console.error(`  ${store.problem}\n`);
    if (store.fix) console.error(`${store.fix}\n`);
    console.error(
      '  Setup stopped: the runner will not store credentials unencrypted.\n'
    );
    process.exit(1);
  }

  // Setup installs and pairs the connector and nothing else: every tool
  // belongs to a part the owner adds later (parts.ts), from the app or with
  // `factiii-runner parts add`. A source build of tmux can run for most of an
  // hour, and the board's Initialize installs the same table (space-core.ts)
  // with live progress and a Try Again. `setup --tools` is the terminal route
  // for that install.
  console.log('Pairing this runner with a Factiii account...');
  const { token, refreshToken, runnerName } = await pairWithBrowser(serverUrl);
  writeRunnerConfig({
    serverUrl,
    authToken: token,
    runnerName,
    ...(refreshToken ? { refreshToken } : {})
  });
  console.log('  Paired and config saved.');

  // What is already here reads as installed: nothing is torn down.
  console.log('\n=== Parts ===\n');
  for (const line of renderParts(await createPartsManager().list())) {
    console.log(line);
  }

  const started = await offerService();

  console.log('\n=== Setup complete ===\n');
  if (!started) console.log('Start the runner with: factiii-runner start');
  console.log(
    'Add parts from the app (Runner > Setup > Environment) or with: factiii-runner parts add <part>'
  );
  console.log(`${SECRETS_AFTER_RESTART}\n`);
}

/** Offer the always-on service. Resolves true when it started the runner.
 *  Off unless the person at this terminal types yes: it says exactly what it
 *  adds to the machine and how to take it out again, and Enter alone skips
 *  it. Only here and `service install` can turn it on (runnerService.ts). */
async function offerService(): Promise<boolean> {
  const spec = serviceSpec();
  if (!spec || !process.stdin.isTTY) return false;
  const status = await serviceStatus(spec, serviceIo);
  if (status.installed !== 'no') return status.running;
  const { definition } = serviceFiles(spec);
  console.log('\n=== Start at login (optional) ===\n');
  console.log(
    `  The runner can start when you log in and restart if it crashes. That adds a\n  login item for your user only (${definition}); no admin rights.\n  Remove it any time with: factiii-runner service remove\n`
  );
  if (!(await confirm('Start this runner at login? [y/N] ', true))) {
    console.log('Later: factiii-runner service install');
    return false;
  }
  const outcome = await installThisService(spec);
  for (const line of outcome.lines) console.log(`  ${line}`);
  if (!outcome.ok) return false;
  printAlwaysOnNotes(spec);
  return Boolean(outcome.started);
}

/** Install the host toolchain from the terminal. Same table Initialize checks,
 *  so the two can't drift. */
export async function setupTools(): Promise<void> {
  console.log('\n=== Factiii Runner — Host toolchain ===\n');
  try {
    await ensureToolchain(hostTarget(CONFIG_DIR), (line) =>
      console.log(`  ${line}`)
    );
  } catch (err) {
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log('  Toolchain is ready.\n');
}

