// The Local AI module's models (.specs/runner-setup.md "Local AI that fits the
// machine"): a small fixed table, and the rule that picks the largest one
// this machine can run. One table for the runner (which picks and pulls),
// its CLI and the app (which shows the pick and the others).
//
// Every row is Ollama's default tag, a 4-bit (Q4_K_M) build. `minMemoryGb`
// leaves room for the context and for everything else the machine runs: on
// Apple silicon the GPU shares the memory, and macOS lets it wire about two
// thirds of it.

export const LOCAL_AI_MODELS = [
  {
    id: 'llama3.2:1b',
    title: 'Llama 3.2 1B',
    params: '1B',
    diskGb: 1.3,
    minMemoryGb: 4
  },
  {
    id: 'llama3.2:3b',
    title: 'Llama 3.2 3B',
    params: '3B',
    diskGb: 2.0,
    minMemoryGb: 8
  },
  {
    id: 'llama3.1:8b',
    title: 'Llama 3.1 8B',
    params: '8B',
    diskGb: 4.9,
    minMemoryGb: 16
  },
  {
    id: 'qwen2.5:14b',
    title: 'Qwen 2.5 14B',
    params: '14B',
    diskGb: 9.0,
    minMemoryGb: 24
  },
  {
    id: 'qwen2.5:32b',
    title: 'Qwen 2.5 32B',
    params: '32B',
    diskGb: 20,
    minMemoryGb: 48
  },
  {
    id: 'llama3.3:70b',
    title: 'Llama 3.3 70B',
    params: '70B',
    diskGb: 43,
    minMemoryGb: 96
  }
] as const;

type LocalAiModel = (typeof LOCAL_AI_MODELS)[number];
export type LocalAiModelId = LocalAiModel['id'];

export const LOCAL_AI_MODEL_IDS = LOCAL_AI_MODELS.map((m) => m.id) as [
  LocalAiModelId,
  ...LocalAiModelId[]
];

/** Disk a pull must leave free, so a model never fills the machine. */
const LOCAL_AI_DISK_HEADROOM_GB = 5;

/** What the runner reads off the machine. Sizes in GB, rounded down. */
export type LocalAiMachine = {
  memoryGb: number;
  /** The GPU shares the memory (an Apple silicon Mac). */
  unifiedMemory: boolean;
  /** "Apple M3 Pro", "Intel Core i7"; null when it cannot be read. */
  cpu: string | null;
  /** A discrete GPU Ollama can use, or null. */
  gpu: { name: string; memoryGb: number } | null;
  /** Free where Ollama keeps its models. */
  freeDiskGb: number;
};

export type LocalAiModelFit = LocalAiModel & {
  fits: boolean;
  /** Why it does not fit, or null. */
  blocker: string | null;
};

const gb = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} GB`;

/** The memory a model may use: the unified memory, or the larger of the
 *  system memory and the GPU's own (Ollama splits a model across both). */
const usableMemoryGb = (machine: LocalAiMachine) =>
  machine.unifiedMemory
    ? machine.memoryGb
    : Math.max(machine.memoryGb, machine.gpu?.memoryGb ?? 0);

/** Every row, with whether this machine can run it and why not. */
export function fitModels(machine: LocalAiMachine): LocalAiModelFit[] {
  const memory = usableMemoryGb(machine);
  return LOCAL_AI_MODELS.map((model) => {
    let blocker: string | null = null;
    if (model.minMemoryGb > memory) {
      blocker = `Needs ${gb(model.minMemoryGb)} memory; this machine has ${gb(memory)}.`;
    } else if (model.diskGb + LOCAL_AI_DISK_HEADROOM_GB > machine.freeDiskGb) {
      blocker = `Needs ${gb(model.diskGb + LOCAL_AI_DISK_HEADROOM_GB)} free disk; ${gb(machine.freeDiskGb)} is free.`;
    }
    return { ...model, fits: blocker === null, blocker };
  });
}

/** Memory a model takes over its file's size: the context's cache and the
 *  runtime. With MODEL_MEMORY_SHARE it agrees with the table's
 *  `minMemoryGb` (an 8B at 4.9 GB needs a 16 GB machine). */
const MODEL_MEMORY_OVERHEAD = 1.2;
/** The share of the memory a model may take: macOS lets the GPU wire about
 *  two thirds of unified memory, and elsewhere the rest of the machine needs
 *  room too. */
const MODEL_MEMORY_SHARE = 2 / 3;

/** Whether a model of `sizeGb` on disk (an ollama.com tag's size) runs in
 *  this machine's memory, and why not. Disk is the runner's to check. */
export function fitModelSize(
  machine: LocalAiMachine,
  sizeGb: number
): { fits: boolean; blocker: string | null } {
  const needGb = Math.ceil(sizeGb * MODEL_MEMORY_OVERHEAD * 10) / 10;
  const usable =
    Math.floor(usableMemoryGb(machine) * MODEL_MEMORY_SHARE * 10) / 10;
  if (needGb <= usable) return { fits: true, blocker: null };
  return {
    fits: false,
    blocker: `Needs about ${gb(needGb)} of memory; this machine can give a model ${gb(usable)}.`
  };
}

/** The largest model that fits, or null when none does. */
export function recommendModel(machine: LocalAiMachine): LocalAiModel | null {
  return (
    fitModels(machine)
      .filter((m) => m.fits)
      .pop() ?? null
  );
}

/** "16 GB unified memory (Apple M3 Pro)", "32 GB memory and an NVIDIA RTX
 *  4090 with 24 GB", "16 GB memory, no GPU it can use". */
function machineLine(machine: LocalAiMachine): string {
  const memory = `${gb(machine.memoryGb)} ${machine.unifiedMemory ? 'unified memory' : 'memory'}`;
  if (machine.unifiedMemory)
    return machine.cpu ? `${memory} (${machine.cpu})` : memory;
  if (machine.gpu)
    return `${memory} and ${machine.gpu.name} with ${gb(machine.gpu.memoryGb)}`;
  return `${memory}, no GPU it can use`;
}

const modelLine = (model: LocalAiModel) =>
  `${model.params.startsWith('8') ? 'an' : 'a'} ${model.params} model at 4-bit, about ${gb(model.diskGb)}`;

/** Why the runner picked what it picked, or that nothing fits. */
export function modelReason(machine: LocalAiMachine): string {
  const pick = recommendModel(machine);
  const line = machineLine(machine);
  if (!pick) {
    return `${line} and ${gb(machine.freeDiskGb)} free disk: too small for a local model. Use Claude or Codex instead (the Coding module).`;
  }
  // Memory would allow more, and disk is what holds it back.
  const byMemory = recommendModel({ ...machine, freeDiskGb: Infinity });
  const slow =
    !machine.unifiedMemory && !machine.gpu
      ? ' It runs on the CPU, so answers are slower.'
      : '';
  if (byMemory && byMemory.id !== pick.id) {
    return `${line} fits ${modelLine(byMemory)}, but only ${gb(machine.freeDiskGb)} is free on disk, so ${modelLine(pick)}.${slow}`;
  }
  return `${line}, so ${modelLine(pick)}.${slow}`;
}
