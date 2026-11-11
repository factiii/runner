import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RunnerLocalAi } from '@shared/all/domains/electron';
import {
  fitModels,
  LOCAL_AI_MODELS,
  type LocalAiMachine,
  type LocalAiModelId,
  modelReason,
  recommendModel
} from '@shared/all/helpers/localAiModels';
import { ollamaTagKey } from '@shared/all/helpers/oakboxBackend';
import { localAiModelIdSchema } from '@shared/all/validators';
import { missingPartMessage } from '@shared/all/helpers/runnerMissingPart';

import { DISK_WARN_GB } from './machineHealth';
import type { PartService } from './partsManager';

// The Local AI module's model (.specs/runner-setup.md "Local AI that fits the
// machine"): read the machine, pick the largest model in the fixed table that
// fits (or the owner's pick), and pull it into Ollama. The pick and the
// models the runner pulled live in `<runner dir>/parts/local-ai-model.json`;
// whether the picked model is there is read off Ollama's own folder each
// time, so a model the owner pulled themselves counts and is never removed.

export type LocalAiModelIo = {
  runnerDir: string;
  /** What the machine has (readMachine on the real one). */
  machine(): Promise<LocalAiMachine>;
  /** Ollama's models folder. */
  modelsDir: string;
  resolveBin(): Promise<string | null>;
  /** Run a command, each output line to `onLine`; resolves the exit code. */
  stream(bin: string, args: string[], onLine: (line: string) => void): Promise<number>;
  /** The Local AI part's service: a pull needs Ollama's server up. */
  service: PartService;
};

type PickFile = { picked: LocalAiModelId | null; pulled: LocalAiModelId[] };

const GIB = 1024 ** 3;
const MIB_PER_GIB = 1024;

const pickFile = (runnerDir: string) =>
  path.join(runnerDir, 'parts', 'local-ai-model.json');

function readPick(runnerDir: string): PickFile {
  try {
    const raw = JSON.parse(fs.readFileSync(pickFile(runnerDir), 'utf-8')) as {
      picked?: unknown;
      pulled?: unknown;
    };
    const picked = localAiModelIdSchema.safeParse(raw.picked);
    const pulled = Array.isArray(raw.pulled)
      ? raw.pulled.flatMap((id) => {
          const parsed = localAiModelIdSchema.safeParse(id);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    return { picked: picked.success ? picked.data : null, pulled };
  } catch {
    return { picked: null, pulled: [] };
  }
}

function writePick(runnerDir: string, pick: PickFile): void {
  const file = pickFile(runnerDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(pick, null, 2)}\n`, { mode: 0o600 });
}

/** Ollama keeps a model's manifest at library/<name>/<tag>. */
export function modelPresent(modelsDir: string, id: LocalAiModelId): boolean {
  const [name, tag] = id.split(':');
  return fs.existsSync(
    path.join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', name, tag)
  );
}

const titleOf = (id: LocalAiModelId) =>
  LOCAL_AI_MODELS.find((m) => m.id === id)?.title ?? id;

/** The machine, the pick and why, and every model with whether it fits. */
export async function localAiState(io: LocalAiModelIo): Promise<RunnerLocalAi> {
  const machine = await io.machine();
  const recommended = recommendModel(machine)?.id ?? null;
  const picked = readPick(io.runnerDir).picked ?? recommended;
  return {
    machine,
    recommended,
    picked,
    reason: modelReason(machine),
    pulled: picked !== null && modelPresent(io.modelsDir, picked),
    models: fitModels(machine)
  };
}

/** The owner picks another model. Refused when it does not fit; the next
 *  add pulls it. */
export async function pickModel(io: LocalAiModelIo, id: LocalAiModelId): Promise<void> {
  const fit = fitModels(await io.machine()).find((m) => m.id === id);
  if (!fit) throw new Error(`Unknown model: ${id}`);
  if (!fit.fits) throw new Error(`${fit.title} does not fit this machine. ${fit.blocker ?? ''}`.trim());
  writePick(io.runnerDir, { ...readPick(io.runnerDir), picked: id });
}

/** Start Ollama's server for a pull or a remove, unless it is up. */
async function ensureServer(io: LocalAiModelIo, onLine: (line: string) => void) {
  if (!(await io.service.status()).running) await io.service.start(onLine);
}

/** The doctor's line for the model: there, missing (pull it), or a machine
 *  too small for any (a person's call: Claude or Codex). */
export async function modelCheck(io: LocalAiModelIo): Promise<
  | { state: 'ready'; detail: string }
  | { state: 'missing'; model: LocalAiModelId; detail: string }
  | { state: 'too-small'; detail: string }
> {
  const state = await localAiState(io);
  if (!state.picked) return { state: 'too-small', detail: state.reason };
  if (state.pulled) return { state: 'ready', detail: `${titleOf(state.picked)} in Ollama` };
  return { state: 'missing', model: state.picked, detail: state.reason };
}

/** Pull the picked model, then remove the ones the runner pulled before it. */
export async function pullModel(
  io: LocalAiModelIo,
  onLine: (line: string) => void
): Promise<void> {
  const bin = await io.resolveBin();
  if (!bin) throw new Error(missingPartMessage('local-ai', 'Ollama is not installed on the runner.'));
  const state = await localAiState(io);
  if (!state.picked) throw new Error(state.reason);
  const id = state.picked;
  // The same fit as the pick: a disk that filled up since refuses the pull
  // (its size plus the headroom), and a pull that leaves it low warns.
  const fit = state.models.find((m) => m.id === id);
  if (fit && !fit.fits) throw new Error(`${fit.title} does not fit now. ${fit.blocker ?? ''}`.trim());
  if (fit && state.machine.freeDiskGb - fit.diskGb < DISK_WARN_GB) {
    onLine(`Disk space will be low after ${fit.title}: ${state.machine.freeDiskGb} GB is free.`);
  }
  onLine(state.reason);
  await ensureServer(io, onLine);
  onLine(`Pulling ${titleOf(id)}…`);
  const code = await io.stream(bin, ['pull', id], onLine);
  if (code !== 0 || !modelPresent(io.modelsDir, id)) {
    throw new Error(`${titleOf(id)} did not finish pulling.`);
  }
  const before = readPick(io.runnerDir).pulled.filter((old) => old !== id);
  // One that would not go stays on the list, so a later remove tries again.
  const kept: LocalAiModelId[] = [];
  for (const old of before) {
    if ((await io.stream(bin, ['rm', old], () => {})) === 0) {
      onLine(`Removed ${titleOf(old)}, the model picked before.`);
    } else kept.push(old);
  }
  writePick(io.runnerDir, { picked: id, pulled: [id, ...kept] });
  onLine(`${titleOf(id)} is ready.`);
}

/** Remove the models the runner pulled, and only those. */
export async function removeModels(
  io: LocalAiModelIo,
  onLine: (line: string) => void
): Promise<void> {
  const bin = await io.resolveBin();
  const pick = readPick(io.runnerDir);
  if (!bin || pick.pulled.length === 0) {
    writePick(io.runnerDir, { ...pick, pulled: [] });
    return;
  }
  await ensureServer(io, onLine);
  const kept: LocalAiModelId[] = [];
  for (const id of pick.pulled) {
    if ((await io.stream(bin, ['rm', id], onLine)) === 0) onLine(`Removed ${titleOf(id)}.`);
    else kept.push(id);
  }
  writePick(io.runnerDir, { ...pick, pulled: kept });
  if (kept.length) throw new Error(`Could not remove ${kept.map(titleOf).join(', ')}.`);
}

/** The models the runner pulled and no longer picks, still in Ollama: one
 *  whose `ollama rm` failed after a newer pull. Free up space offers them. */
export function unusedModels(io: Pick<LocalAiModelIo, 'runnerDir' | 'modelsDir'>): {
  id: LocalAiModelId;
  bytes: number;
}[] {
  const pick = readPick(io.runnerDir);
  return pick.pulled
    .filter((id) => id !== pick.picked && modelPresent(io.modelsDir, id))
    .map((id) => ({
      id,
      bytes: Math.round((LOCAL_AI_MODELS.find((m) => m.id === id)?.diskGb ?? 0) * GIB)
    }));
}

/** `ollama rm` one model the runner pulled, never the picked one or one it
 *  did not pull. Resolves whether it went. */
export async function removeUnusedModel(
  io: LocalAiModelIo,
  id: string,
  onLine: (line: string) => void
): Promise<boolean> {
  const model = unusedModels(io).find((m) => m.id === id);
  const bin = await io.resolveBin();
  if (!model || !bin) return false;
  await ensureServer(io, onLine);
  if ((await io.stream(bin, ['rm', model.id], onLine)) !== 0) return false;
  const pick = readPick(io.runnerDir);
  writePick(io.runnerDir, { ...pick, pulled: pick.pulled.filter((p) => p !== model.id) });
  onLine(`Removed ${titleOf(model.id)}.`);
  return true;
}

/** A model removed outside this module (Oakbox > Account > Backend,
 *  localAiTags.ts) leaves the runner's `pulled` list, so Setup's remove does
 *  not fail on one that is already gone. The pick is kept. */
export function forgetPulledModel(runnerDir: string, tag: string): void {
  const pick = readPick(runnerDir);
  const pulled = pick.pulled.filter((id) => ollamaTagKey(id) !== ollamaTagKey(tag));
  if (pulled.length !== pick.pulled.length) writePick(runnerDir, { ...pick, pulled });
}

/** Where Linux's install script keeps models: it runs Ollama as a system
 *  service under its own `ollama` user. */
const LINUX_SERVICE_MODELS = '/usr/share/ollama/.ollama/models';

/** Ollama's models folder: OLLAMA_MODELS, else ~/.ollama/models, else (on
 *  Linux, when only it exists) the system service's folder. */
export function ollamaModelsDir(
  platform: NodeJS.Platform = process.platform,
  exists: (dir: string) => boolean = fs.existsSync
): string {
  if (process.env.OLLAMA_MODELS) return process.env.OLLAMA_MODELS;
  const own = path.join(os.homedir(), '.ollama', 'models');
  if (platform === 'linux' && !exists(own) && exists(LINUX_SERVICE_MODELS)) {
    return LINUX_SERVICE_MODELS;
  }
  return own;
}

/** The disk that holds `dir` (or its nearest existing parent): its device,
 *  and its free and total bytes. Machine health reads it too. */
export function diskOf(dir: string): { id: number; freeBytes: number; totalBytes: number } {
  let at = dir;
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  const stats = fs.statfsSync(at);
  return {
    id: fs.statSync(at).dev,
    freeBytes: stats.bavail * stats.bsize,
    totalBytes: stats.blocks * stats.bsize
  };
}

/** Free GB on the disk that holds `dir`. */
export const freeDiskGb = (dir: string): number =>
  Math.floor((diskOf(dir).freeBytes / GIB) * 10) / 10;

/** The real machine: memory, Apple silicon or a discrete NVIDIA GPU, and
 *  free disk where Ollama keeps models. Read-only commands, no shell. */
export async function readMachine(
  run: (bin: string, args: string[]) => Promise<{ code: number; output: string }>,
  modelsDir: string
): Promise<LocalAiMachine> {
  const memoryGb = Math.round(os.totalmem() / GIB);
  const freeDisk = freeDiskGb(modelsDir);
  if (process.platform === 'darwin') {
    const arm = await run('sysctl', ['-n', 'hw.optional.arm64']);
    const brand = await run('sysctl', ['-n', 'machdep.cpu.brand_string']);
    return {
      memoryGb,
      unifiedMemory: arm.code === 0 && arm.output.trim() === '1',
      cpu: brand.code === 0 ? brand.output.trim() || null : null,
      gpu: null,
      freeDiskGb: freeDisk
    };
  }
  const smi = await run('nvidia-smi', [
    '--query-gpu=name,memory.total',
    '--format=csv,noheader,nounits'
  ]);
  const [name, mib] = smi.code === 0 ? (smi.output.trim().split('\n')[0]?.split(',') ?? []) : [];
  const gpuGb = Math.floor(Number(mib) / MIB_PER_GIB);
  return {
    memoryGb,
    unifiedMemory: false,
    cpu: os.cpus()[0]?.model.trim() || null,
    gpu: name && gpuGb > 0 ? { name: name.trim(), memoryGb: gpuGb } : null,
    freeDiskGb: freeDisk
  };
}
