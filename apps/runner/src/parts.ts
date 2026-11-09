import type {
  RunnerModuleAction,
  RunnerModuleId,
  RunnerModuleJob,
  RunnerPart,
  RunnerPartAction,
  RunnerPartId,
  RunnerPartJob,
  RunnerPartsModule
} from '@shared/all/domains/electron';

import type { DoctorResult } from './doctor';

// The runner's parts: the connector, which `setup` installs and pairs, and
// everything else, which the owner adds one at a time or a module at a time
// (`factiii-runner parts`, the runner's Status > Features). A part is a
// set of doctor checks plus, for a part that runs something, a service.
// Whether a part is installed is read off the machine each time, never
// stored, so a runner from before parts shows what it already has as
// installed.

export type PartDef = {
  id: RunnerPartId;
  title: string;
  description: string;
  /** Doctor check ids (doctor.ts): a tool's check id is its binary. */
  requires: string[];
  /** Estimates in MB: on disk once installed, in memory while in use. */
  diskMb: number;
  memoryMb: number;
  /** The disk `add` needs while it builds, when that is more than `diskMb`:
   *  the room check uses it, the list still shows `diskMb`. */
  buildDiskMb?: number;
  /** Only on these platforms. */
  platforms?: NodeJS.Platform[];
  /** The connector: always installed, never removed. */
  core?: boolean;
  /** Runs a process the runner starts and stops. */
  service?: boolean;
  /** Sub-parts that must be installed first: `add` adds them before it, and
   *  `remove` of one of them removes this part first. */
  needs?: RunnerPartId[];
  /** Sent only inside `modules`: a shipped app looks up an icon per part id
   *  and fails on one it does not know. */
  moduleOnly?: boolean;
  /** Sent only in the flat list, for apps from before modules: the
   *  sub-parts it stands for, installed and removed together. */
  covers?: RunnerPartId[];
};

/** Vault search's cost here. A Mac: 748 MB measured (Python 3.12, its
 *  packages, the two Core ML models); its build peaks near 2.6 GB on disk and
 *  2.5 GB in memory, and serving maps the models (about 350 MB). Linux, on an
 *  arm64 VM: 1.45 GB (the ONNX models in fp32, 1.04 GB, and a 322 MB venv);
 *  its build peaks near 3.2 GB on disk, and serving holds the weights (about
 *  1.5 GB, 2.1 GB while a scan is read). */
const VAULT_SEARCH_SIZE =
  process.platform === 'linux'
    ? { diskMb: 1_460, buildDiskMb: 3_200, memoryMb: 1_500 }
    : { diskMb: 750, buildDiskMb: 2_600, memoryMb: 350 };

export const PARTS: PartDef[] = [
  {
    id: 'connector',
    title: 'Connector',
    description:
      'Pairs this machine with your account and keeps the encrypted link to your devices.',
    requires: ['node-version', 'folder', 'keychain', 'pairing'],
    diskMb: 60,
    memoryMb: 150,
    core: true
  },
  {
    id: 'terminals',
    title: 'Terminals and boards',
    description:
      'Shells on this machine, and a clone of each board’s repository for its cards.',
    // Redis is an extra (live agent status), added from the Environment list.
    requires: ['git', 'tmux', 'script'],
    diskMb: 60,
    memoryMb: 50
  },
  {
    id: 'claude',
    title: 'Claude',
    description: 'Claude Code, for card AI and terminals.',
    requires: ['node', 'claude'],
    diskMb: 250,
    memoryMb: 400
  },
  {
    id: 'codex',
    title: 'Codex',
    description: 'OpenAI Codex, for card AI and terminals.',
    requires: ['node', 'codex'],
    diskMb: 150,
    memoryMb: 300
  },
  {
    id: 'secrets',
    title: 'Secrets',
    description: 'An encrypted store for deploy keys, used by jobs.',
    requires: ['sops', 'age-keygen'],
    diskMb: 40,
    memoryMb: 10
  },
  {
    id: 'simulator',
    title: 'Simulator',
    description: 'An iOS simulator you can watch and drive from the app.',
    requires: ['xcode', 'simulator'],
    diskMb: 40_000,
    memoryMb: 2_000,
    platforms: ['darwin']
  },
  {
    id: 'local-ai',
    title: 'Local AI',
    description: 'Ollama, to run AI models on this machine.',
    requires: ['ollama'],
    diskMb: 1_500,
    memoryMb: 200,
    service: true
  },
  {
    id: 'local-ai-model',
    title: 'Model',
    description:
      'The model Ollama runs, picked to fit this machine’s memory and disk.',
    requires: ['local-ai-model'],
    // The table's 8B; the list shows the picked model's own size.
    diskMb: 4_900,
    memoryMb: 6_000,
    needs: ['local-ai'],
    moduleOnly: true
  },
  {
    id: 'vault',
    title: 'Vault',
    description:
      'Keeps your files on this machine, searchable from your devices. They reach your devices over the direct link only, never through Factiii’s servers.',
    requires: ['vault-engine', 'vault-embedder'],
    // Vault storage and Vault search together (below).
    diskMb: 70 + VAULT_SEARCH_SIZE.diskMb,
    buildDiskMb: 70 + VAULT_SEARCH_SIZE.buildDiskMb,
    memoryMb: 110 + VAULT_SEARCH_SIZE.memoryMb,
    covers: ['vault-storage', 'vault-search']
  },
  {
    id: 'vault-storage',
    title: 'Vault storage',
    description:
      'Keeps your files on this machine, for your devices. They reach your devices over the direct link only, never through Factiii’s servers.',
    requires: ['vault-engine'],
    // The engine (23 MB) and an empty database (39 MB), before any file.
    diskMb: 65,
    // The database runs only while the vault is in use (vault/db.ts).
    memoryMb: 110,
    moduleOnly: true
  },
  {
    id: 'vault-search',
    title: 'Vault search',
    description:
      'Reads your vault’s files on this machine, so you can search them by what they say.',
    requires: ['vault-embedder'],
    diskMb: VAULT_SEARCH_SIZE.diskMb,
    buildDiskMb: VAULT_SEARCH_SIZE.buildDiskMb,
    // Only while files are read or embedded (vault/embedder.ts).
    memoryMb: VAULT_SEARCH_SIZE.memoryMb,
    // Core ML on a Mac, ONNX on Linux (vault/embedderInstall.ts). On an
    // Intel Mac its check answers unknown and files are found by name.
    platforms: ['darwin', 'linux'],
    needs: ['vault-storage'],
    moduleOnly: true
  }
];

export type ModuleDef = {
  id: RunnerModuleId;
  title: string;
  description: string;
  /** Install order. A part offered on no platform here is left out. */
  parts: RunnerPartId[];
  /** Bare: never removed. */
  core?: boolean;
};

/** The modules, as the app and `parts list` group the parts. Every part but
 *  the flat list's Vault is in exactly one. */
export const MODULES: ModuleDef[] = [
  {
    id: 'bare',
    title: 'Bare',
    description: 'The connector alone: this machine, paired and linked to your devices.',
    parts: ['connector'],
    core: true
  },
  {
    id: 'coding',
    title: 'Coding',
    description: 'Terminals, boards and coding agents, with the tools their jobs use.',
    parts: ['terminals', 'claude', 'codex', 'secrets', 'simulator']
  },
  {
    id: 'private-vault',
    title: 'Private vault for Oakbox',
    description:
      'Your files, kept and searched on this machine, never on Factiii’s servers.',
    parts: ['vault-storage', 'vault-search']
  },
  {
    id: 'local-ai',
    title: 'Local AI',
    description: 'AI models that run on this machine, picked to fit it.',
    parts: ['local-ai', 'local-ai-model']
  }
];

/** Tools `parts remove` never uninstalls: the runner itself runs on node,
 *  and macOS and Linux lean on git and script. */
export const KEEP_TOOLS: ReadonlySet<string> = new Set(['node', 'git', 'script']);

/** The parts this platform can have. On Windows the tools only exist inside
 *  WSL, where the runner is installed again, so only the connector is here. */
export function partsFor(platform: NodeJS.Platform): PartDef[] {
  if (platform === 'win32') return PARTS.filter((p) => p.core);
  return PARTS.filter((p) => !p.platforms || p.platforms.includes(platform));
}

/** The modules this platform offers, each with only its offered parts. */
export function modulesFor(
  platform: NodeJS.Platform
): { def: ModuleDef; parts: PartDef[] }[] {
  const offered = partsFor(platform);
  return MODULES.map((def) => ({
    def,
    parts: def.parts.flatMap((id) => offered.filter((p) => p.id === id))
  })).filter((m) => m.parts.length > 0);
}

export function findModule(id: RunnerModuleId): ModuleDef {
  const def = MODULES.find((m) => m.id === id);
  if (!def) throw new Error(`Unknown module: ${id}`);
  return def;
}

/** The parts that need `id` installed first (`needs`). */
export const dependentsOf = (id: RunnerPartId): PartDef[] =>
  PARTS.filter((p) => p.needs?.includes(id));

export function findPart(id: RunnerPartId): PartDef {
  const part = PARTS.find((p) => p.id === id);
  if (!part) throw new Error(`Unknown part: ${id}`);
  return part;
}

/** What `parts add` can do, and what is left for a person, for one part. */
export type Resolution = {
  installed: boolean;
  missing: DoctorResult[];
  /** Fixes the runner may run itself (no root): tools and folders. */
  fixes: DoctorResult[];
  /** One line per missing requirement only a person can meet. */
  manual: string[];
};

/** Match a part's requirements against one doctor pass. A check that
 *  answers `unknown` never counts against the part, as in the doctor. A
 *  requirement with no check on this machine is missing, with no fix. */
export function resolveRequirements(
  part: PartDef,
  results: DoctorResult[]
): Resolution {
  const missing: DoctorResult[] = [];
  const fixes: DoctorResult[] = [];
  const manual: string[] = [];
  for (const id of part.requires) {
    const result = results.find((r) => r.id === id);
    if (result?.state === 'met' || result?.state === 'unknown') continue;
    if (!result) {
      manual.push(`${id}: not available on this machine.`);
      continue;
    }
    missing.push(result);
    const fix = result.fix;
    if (fix?.kind === 'install' || fix?.kind === 'folder') {
      fixes.push(result);
    } else if (fix?.kind === 'command') {
      manual.push(
        `${result.title}: ${[...fix.note, ...fix.commands].join(' ')}`.trim()
      );
    } else if (fix?.kind === 'settings') {
      manual.push(`${result.title}: ${fix.path}`);
    } else {
      manual.push(`${result.title}: ${result.detail}`);
    }
  }
  return {
    installed: missing.length === 0 && manual.length === 0,
    missing,
    fixes,
    manual
  };
}

/** The tools `parts remove` would uninstall: the ones the runner installed
 *  for this part (`ledger`), less KEEP_TOOLS and anything another installed
 *  part still needs. Nothing the runner did not install is ever removed. */
export function removableTools(
  part: PartDef,
  ledger: readonly string[],
  installedParts: readonly PartDef[]
): string[] {
  // The flat list's Vault and its sub-parts read the same checks: neither
  // keeps the other's tools.
  const needed = new Set(
    installedParts
      .filter(
        (p) => p.id !== part.id && !p.covers && !part.covers?.includes(p.id)
      )
      .flatMap((p) => p.requires)
  );
  return part.requires.filter(
    (id) => ledger.includes(id) && !KEEP_TOOLS.has(id) && !needed.has(id)
  );
}

export type ServiceState = {
  running: boolean;
  /** The runner started it, so the runner may stop it. */
  ours: boolean;
  memoryMb: number | null;
};

/** The buttons a part offers now. */
export function partActions(
  part: PartDef,
  res: Resolution,
  removable: readonly string[],
  service: ServiceState | null
): RunnerPartAction[] {
  if (part.core) return [];
  const actions: RunnerPartAction[] = [];
  if (!res.installed && res.fixes.length > 0) actions.push('add');
  if (res.installed && part.service && service) {
    if (!service.running) actions.push('start');
    else if (service.ours) actions.push('stop');
  }
  if (removable.length > 0) actions.push('remove');
  return actions;
}

/** One part as the app and `parts list` show it. */
export function describePart(
  part: PartDef,
  res: Resolution,
  removable: readonly string[],
  service: ServiceState | null,
  job: RunnerPartJob | null
): RunnerPart {
  return {
    id: part.id,
    title: part.title,
    description: part.description,
    installed: res.installed,
    running: part.service ? Boolean(service?.running) : null,
    missing: res.missing.map((r) => r.title),
    manual: res.manual,
    diskMb: part.diskMb,
    memoryMb: part.memoryMb,
    memoryNowMb: service?.running ? service.memoryMb : null,
    core: Boolean(part.core),
    // Nothing else is offered while an action runs.
    actions:
      job?.state === 'running'
        ? []
        : partActions(part, res, removable, service),
    job
  };
}

/** The buttons a module offers now: Install all while a sub-part the runner
 *  can add is missing, Remove all while one can be removed. Nothing for Bare,
 *  and nothing while it or one of its sub-parts is busy. */
function moduleActions(
  def: ModuleDef,
  parts: readonly RunnerPart[],
  job: RunnerModuleJob | null
): RunnerModuleAction[] {
  if (def.core || job?.state === 'running') return [];
  if (parts.some((p) => p.job?.state === 'running')) return [];
  const actions: RunnerModuleAction[] = [];
  if (parts.some((p) => !p.installed && p.actions.includes('add'))) {
    actions.push('add');
  }
  if (parts.some((p) => p.actions.includes('remove'))) actions.push('remove');
  return actions;
}

/** One module as the app and `parts list` show it. While its own job runs,
 *  its sub-parts offer nothing either. */
export function describeModule(
  def: ModuleDef,
  parts: RunnerPart[],
  job: RunnerModuleJob | null
): RunnerPartsModule {
  const running = job?.state === 'running';
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    core: Boolean(def.core),
    parts: running ? parts.map((p) => ({ ...p, actions: [] })) : parts,
    actions: moduleActions(def, parts, job),
    job
  };
}
