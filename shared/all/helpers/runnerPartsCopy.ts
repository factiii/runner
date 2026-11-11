import type {
  RunnerLocalAi,
  RunnerPart,
  RunnerPartsModule,
  RunnerPartsState,
  RunnerVaultIngest,
  RunnerVaultStatus
} from '../domains/electron';
import type {
  RunnerModuleAction,
  RunnerPartAction
} from '../validators/runnerParts';
import { LOCAL_AI_MODELS } from './localAiModels';

// How a runner part reads, in one place for the runner's CLI
// (`factiii-runner parts list`) and the runner's Status > Features on web and mobile.

const MB_PER_GB = 1000;

export const PART_ACTION_LABELS: Record<RunnerPartAction, string> = {
  add: 'Add',
  remove: 'Remove',
  start: 'Start',
  stop: 'Stop'
};

const BUSY_LABELS: Record<RunnerPartAction, string> = {
  add: 'Installing…',
  remove: 'Removing…',
  start: 'Starting…',
  stop: 'Stopping…'
};

/** Installing… while a job runs, then Running, Installed or Not added. */
export function partStatusLabel(part: RunnerPart): string {
  if (part.job?.state === 'running') return BUSY_LABELS[part.job.action];
  if (part.installed && part.outside) return 'Installed outside Factiii';
  if (part.running) return 'Running';
  if (part.installed) return 'Installed';
  return 'Not added';
}

const size = (mb: number) =>
  mb >= MB_PER_GB ? `${Math.round(mb / MB_PER_GB)} GB` : `${mb} MB`;

const costLine = (diskMb: number, memoryMb: number) =>
  `About ${size(diskMb)} on disk · ${size(memoryMb)} memory in use`;

/** "About 60 MB on disk · 150 MB memory in use", plus what it uses now. */
export function partCost(part: RunnerPart): string {
  const line = costLine(part.diskMb, part.memoryMb);
  return part.memoryNowMb === null
    ? line
    : `${line} · ${size(part.memoryNowMb)} now`;
}

/** What a Remove deletes, said in its confirmation: only what the runner
 *  installed, and the disk it frees. A model's weights are most of it. */
export function removeConfirmText(what: {
  title: string;
  diskMb: number;
  models: boolean;
}): string {
  const models = what.models
    ? ' Its downloaded models go too, with their disk space.'
    : '';
  return `Removes what Factiii installed for ${what.title}, about ${size(what.diskMb)} on disk.${models} Anything you installed yourself stays.`;
}

/** The last job failed: its last line says why. Empty otherwise. */
export function partError(part: RunnerPart): string {
  return part.job?.state === 'failed' ? (part.job.lines.at(-1) ?? '') : '';
}

export const MODULE_ACTION_LABELS: Record<RunnerModuleAction, string> = {
  add: 'Install all',
  remove: 'Remove all'
};

/** Every part the runner offers: the modules' sub-parts, or the flat list
 *  from a runner from before modules. */
const allParts = (state: RunnerPartsState): RunnerPart[] =>
  state.modules?.flatMap((m) => m.parts) ?? state.parts;

const running = (part: RunnerPart) => part.job?.state === 'running';

/** The module's sub-parts summed: "About 1 GB on disk · 800 MB memory in use". */
export function moduleCost(mod: RunnerPartsModule): string {
  return costLine(
    mod.parts.reduce((sum, p) => sum + p.diskMb, 0),
    mod.parts.reduce((sum, p) => sum + p.memoryMb, 0)
  );
}

/** "Installing Vault search…" while a sub-part is busy, else "3 of 5
 *  installed". */
export function moduleStatusLabel(mod: RunnerPartsModule): string {
  const busy = mod.parts.find(running);
  if (busy) return `${partStatusLabel(busy).replace(/…$/, '')} ${busy.title}…`;
  const installed = mod.parts.filter((p) => p.installed).length;
  return `${installed} of ${mod.parts.length} installed`;
}

/** Every sub-part is installed. */
export const moduleInstalled = (mod: RunnerPartsModule): boolean =>
  mod.parts.every((p) => p.installed);

/** Install all or Remove all stopped: the sub-part it stopped at, and why.
 *  Empty otherwise. */
export function moduleError(mod: RunnerPartsModule): string {
  if (mod.job?.state !== 'failed') return '';
  const part = mod.parts.find((p) => p.id === mod.job?.partId);
  if (!part) return 'It stopped before it finished.';
  const reason = partError(part);
  return reason
    ? `Stopped at ${part.title}: ${reason}`
    : `Stopped at ${part.title}.`;
}

/** A module or one of its sub-parts is mid-action. */
export const moduleBusy = (mod: RunnerPartsModule): boolean =>
  mod.job?.state === 'running' || mod.parts.some(running);

/** Status > Features: what this runner has (a status row) or could add (the
 *  "Add to this runner" group). A module is on once any of its sub-parts is
 *  in place or one is installing, so a module being added moves up at once
 *  and its log shows there; the connector's module is always on. */
export const moduleOn = (mod: RunnerPartsModule): boolean =>
  mod.core ||
  moduleBusy(mod) ||
  mod.parts.some((p) => p.installed || p.running === true);

/** A flat-list part (a runner from before modules), as moduleOn. */
export const partOn = (part: RunnerPart): boolean =>
  part.core || part.installed || part.running === true || running(part);

/** The modules (or, from a runner before modules, the parts) on one side of
 *  Features: on, or still to add. */
export function featureRows(
  state: RunnerPartsState,
  group: 'on' | 'add'
):
  | { kind: 'modules'; modules: RunnerPartsModule[] }
  | { kind: 'parts'; parts: RunnerPart[] } {
  const wanted = group === 'on';
  if (state.modules) {
    return {
      kind: 'modules',
      modules: state.modules.filter((m) => moduleOn(m) === wanted)
    };
  }
  return {
    kind: 'parts',
    parts: state.parts.filter((p) => partOn(p) === wanted)
  };
}

/** How many rows a Features group has, to leave out an empty one. */
export function featureCount(
  state: RunnerPartsState,
  group: 'on' | 'add'
): number {
  const rows = featureRows(state, group);
  return rows.kind === 'modules' ? rows.modules.length : rows.parts.length;
}

/** The button that adds a whole module from the Add group: one word, as a
 *  part's own Add. On a module already partly on it stays "Install all". */
export const moduleActionLabel = (
  action: RunnerModuleAction,
  group: 'on' | 'add'
): string =>
  group === 'add' && action === 'add'
    ? PART_ACTION_LABELS.add
    : MODULE_ACTION_LABELS[action];

/** Any part is mid-action, so the list is worth reading again soon. */
export function partsBusy(state: RunnerPartsState | null): boolean {
  if (!state) return false;
  return (
    allParts(state).some(running) ||
    Boolean(state.modules?.some((m) => m.job?.state === 'running'))
  );
}

/** A few words for machine health on the fold's line, or null when it is
 *  fine (runnerHealthCopy.ts has the full lines). */
function healthWords(state: RunnerPartsState): string | null {
  const health = state.health;
  if (!health || health.level === 'ok') return null;
  if (health.disks.some((d) => d.level === 'critical'))
    return 'Disk almost full';
  if (health.disks.some((d) => d.level === 'warn')) return 'Disk space low';
  // Memory is the machine card's to say: removing a part is not the fix for
  // a busy machine, so the parts list stays shut for it.
  return null;
}

/** The Setup step's one line over the parts, and whether it starts open:
 *  open on a runner that has only its connector, while a part is busy, and
 *  while disk runs low. */
export function partsSummary(state: RunnerPartsState): {
  text: string;
  open: boolean;
} {
  const parts = allParts(state);
  const installed = parts.filter((p) => p.installed).length;
  const busy = parts.find(running);
  const health = healthWords(state);
  const text = [
    `${installed} of ${parts.length} parts installed`,
    busy ? `${busy.title}: ${partStatusLabel(busy)}` : null,
    health
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    text,
    open: partsBusy(state) || installed <= 1 || health !== null
  };
}

export const bytesLabel = (bytes: number) => {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} bytes`;
};

/** The part that carries the Vault's detail (size, reading line, sharing):
 *  Vault storage, or the flat list's Vault from a runner before modules. */
export const isVaultStoragePart = (part: RunnerPart): boolean =>
  part.id === 'vault-storage' || part.id === 'vault';

/** The Vault part's line once added: "12 files · 40 MB on this machine". */
export function vaultSummary(status: RunnerVaultStatus): string {
  const files = status.files === 1 ? '1 file' : `${status.files} files`;
  return `${files} · ${bytesLabel(status.bytes)} on this machine`;
}

const filesLabel = (count: number) =>
  count === 1 ? '1 file' : `${count} files`;

/** The Vault's reading line, under its summary: what is being made
 *  searchable on this machine, or what is. Null with no files. */
export function vaultIngestLine(ingest: RunnerVaultIngest): string | null {
  const { pending, embedded, failed } = ingest;
  if (pending + embedded + failed === 0) return null;
  if (ingest.embedder === 'unsupported') {
    return 'Search needs a Mac with Apple silicon, or Linux. Files are found by name.';
  }
  if (ingest.running && pending > 0) {
    return `Reading ${filesLabel(pending)} on this machine…`;
  }
  if (pending > 0) {
    return ingest.embedder === 'missing'
      ? `${filesLabel(pending)} ${pending === 1 ? 'waits' : 'wait'} for search to be installed.`
      : `${filesLabel(pending)} waiting to be read.`;
  }
  const line = `${filesLabel(embedded)} searchable`;
  return failed > 0 ? `${line} · ${failed} could not be read` : line;
}

/** The Vault reads files now: its row asks again until it is done. */
export const vaultReading = (status: RunnerVaultStatus | null): boolean =>
  status?.ingest?.running === true;

/** Under the Vault part when the owner shares no vault on Factiii. */
export const VAULT_SHARE_NONE =
  'Only you can open it. To share it, add someone to your shared vault in Oakbox, Account.';

/** The switch beside a shared-vault peer. */
export const vaultShareLabel = (name: string) => `${name} can open it`;

/** Under the Local AI module's Model: the model it pulled for this
 *  machine, "Llama 3.1 8B · about 4.9 GB", or null when none fits. */
export function localAiModelLine(localAi: RunnerLocalAi): string | null {
  const model = LOCAL_AI_MODELS.find((m) => m.id === localAi.picked);
  if (!model) return null;
  const label = `${model.title} · about ${model.diskGb} GB`;
  return localAi.pulled ? label : `${label}, not pulled yet`;
}

/** Where another model is picked: Oakbox Ask, not Setup. */
export const LOCAL_AI_ASK_LINE =
  'Ask with it, or with another model on this machine, from the model menu in Oakbox Ask.';
