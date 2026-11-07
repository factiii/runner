import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  hostTarget,
  installTool,
  uninstallTool
} from '@shared/all/helpers/board-agent-core';

import { type CleanupIo, planCleanup, runCleanup } from './cleanup';
import { cacheItems, clearCache, type DiskIo, diskUse } from './diskCaches';
import { buildChecks, evaluate } from './doctor';
import {
  freeDiskGb,
  localAiState,
  pickModel,
  pullModel,
  removeModels
} from './localAiModel';
import { LocalAiTags } from './localAiTags';
import { createOllamaLibrary } from './ollamaLibraryFetch';
import { doctorHost, localAiMachine, run } from './machine';
import { checkRoom } from './machineHealth';
import { cleanupIo, diskSize, machineHealth } from './machineHealthIo';
import { type PartsMachine, PartsManager } from './partsManager';
import type { RunnerServerReadiness } from '@shared/all/domains/electron';
import { CONFIG_DIR } from './paths';
import { ollamaModelsOnDisk } from './vault/askEngines';
import { installEmbedder, removeEmbedder, runStep } from './vault/embedderInstall';
import { installEngine, removeEngine, vaultPaths } from './vault/engine';

// The real machine behind PartsManager: the doctor's own probes and fixes,
// the ledger of tools `parts add` installed, the Local AI service and its
// model, and machine health with Free up space.

const LEDGER = path.join(CONFIG_DIR, 'parts.json');
const MB_PER_GB = 1_000;

function readLedger(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER, 'utf-8')) as {
      tools?: unknown;
    };
    return Array.isArray(parsed.tools)
      ? parsed.tools.filter((t): t is string => typeof t === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeLedger(tools: string[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(LEDGER, `${JSON.stringify({ tools }, null, 2)}\n`, {
    mode: 0o600
  });
}

/** Reads "Ready to be a server" (serverReadinessIo.ts), carried with the
 *  machine's health. */
type ServerRead = () => Promise<RunnerServerReadiness | null>;

function partsMachine(server?: ServerRead): PartsMachine {
  const target = hostTarget(CONFIG_DIR);
  const session = buildChecks(doctorHost(target));
  const localAi = localAiMachine(target);
  const disk: DiskIo = {
    home: os.homedir(),
    runnerDir: CONFIG_DIR,
    platform: process.platform,
    run,
    size: diskSize(run),
    remove: (p) => fs.rmSync(p, { recursive: true, force: true })
  };
  const cleanup: CleanupIo = {
    ...cleanupIo(run, localAi.model),
    caches: () => cacheItems(disk),
    clearCache: (id, onLine) => clearCache(disk, id, onLine)
  };
  return {
    platform: process.platform,
    results(fresh) {
      if (fresh) session.refresh();
      return evaluate(session.checks);
    },
    async fix(result, onLine) {
      if (result.fix?.kind === 'install' && result.fix.tool === 'vault-engine') {
        await installEngine(vaultPaths(CONFIG_DIR).engine, onLine);
      } else if (result.fix?.kind === 'install' && result.fix.tool === 'vault-embedder') {
        await installEmbedder({ run: runStep, runnerDir: CONFIG_DIR }, onLine);
      } else if (result.fix?.kind === 'install' && result.fix.tool === 'local-ai-model') {
        await pullModel(localAi.model, onLine);
      } else if (result.fix?.kind === 'install') {
        await installTool(target, result.fix.tool, onLine);
      } else if (result.fix?.kind === 'folder') {
        fs.mkdirSync(result.fix.path, { recursive: true, mode: 0o700 });
      }
    },
    uninstall: async (bin, onLine) => {
      if (bin === 'vault-engine') removeEngine(vaultPaths(CONFIG_DIR).engine, onLine);
      else if (bin === 'vault-embedder') {
        removeEmbedder(CONFIG_DIR);
        onLine('Removed the vault’s search models. The vectors already made stay with the files.');
      } else if (bin === 'local-ai-model') await removeModels(localAi.model, onLine);
      else await uninstallTool(target, bin, onLine);
    },
    readLedger,
    writeLedger,
    service: (id) => (id === 'local-ai' ? localAi.service : null),
    localAi: {
      state: () => localAiState(localAi.model),
      pick: (id) => pickModel(localAi.model, id)
    },
    async health() {
      const health = await machineHealth(run);
      if (!server) return health;
      return { ...health, server: await server().catch(() => null) };
    },
    // Tools land under the runner folder or the package manager's prefix,
    // most often the same disk.
    room: (diskMb, what) => checkRoom(freeDiskGb(CONFIG_DIR), diskMb / MB_PER_GB, what),
    cleanup: {
      plan: () => planCleanup(cleanup),
      run: (ids, onLine) => runCleanup(cleanup, ids, onLine),
      usage: () => diskUse(disk)
    }
  };
}

/** One manager per runner process. */
export function createPartsManager(server?: ServerRead): PartsManager {
  return new PartsManager(partsMachine(server));
}

/** Oakbox > Account > Backend's models on this machine (localAiTags.ts).
 *  One per runner process, so one pull or remove at a time. */
export function createLocalAiTags(): LocalAiTags {
  const localAi = localAiMachine(hostTarget(CONFIG_DIR));
  return new LocalAiTags({
    model: localAi.model,
    installed: () => ollamaModelsOnDisk(localAi.model.modelsDir),
    health: () => machineHealth(run),
    freeDiskGb: () => freeDiskGb(localAi.model.modelsDir),
    library: createOllamaLibrary()
  });
}
