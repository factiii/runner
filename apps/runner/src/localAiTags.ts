import type {
  BoardAgentActionMap,
  OllamaLibraryTag,
  RunnerLocalAiJob,
  RunnerLocalAiModels,
  RunnerLocalAiSearch,
  RunnerMachineHealth
} from '@shared/all/domains/electron';
import { fitModelSize, type LocalAiMachine } from '@shared/all/helpers/localAiModels';
import { ollamaTagKey, ollamaTitle } from '@shared/all/helpers/oakboxBackend';
import { localAiActSchema, localAiSearchSchema } from '@shared/all/validators';

import { forgetPulledModel, type LocalAiModelIo, localAiState } from './localAiModel';
import { checkRoom, DISK_CRITICAL_GB } from './machineHealth';
import { isCloudTag, type ParsedOllamaTag } from './ollamaLibrary';
import type { OllamaLibrary } from './ollamaLibraryFetch';

// Oakbox > Account > Backend's models (.specs/runner-vault-ask.md "Oakbox's
// backend: setup, sign-ins, models"): the owner lists what Ollama holds beside the fixed table, and
// pulls any Ollama model by name or removes one. Unlike the Local AI module's
// own pull (localAiModel.ts `pullModel`), a model added here is the owner's
// and stays: nothing else is removed, and it is not added to the list of
// models the runner pulled, which Setup's remove and Free up space go by. A
// remove here does take a model off that list (`forgetPulledModel`).
//
// One pull or remove at a time, in the background; the list carries it as
// `job`, which the app reads again while it runs. The name is checked by
// `ollamaTagSchema` and Ollama is spawned without a shell (`io.model.stream`).
//
// Search reads ollama.com from here (ollamaLibraryFetch.ts), and each tag of
// a model says whether it fits this machine: its size against the memory
// (`fitModelSize`) and the disk (`checkRoom`). A pull goes by the same fit.

export type LocalAiTagsIo = {
  model: LocalAiModelIo;
  /** The models Ollama holds, read off its folder (askEngines.ts). */
  installed(): string[];
  health(): Promise<RunnerMachineHealth>;
  /** Free GB where Ollama keeps its models. */
  freeDiskGb(): number;
  library: OllamaLibrary;
};

const CLOUD_BLOCKER = 'Runs on Ollama’s cloud, not on this machine.';
// A tag's row already shows its name and size, so its disk line does not
// repeat them as `checkRoom`'s does. A low-disk warning is not repeated per
// row either: the panel's health line above the list already says it.
const DISK_BLOCKER = `It would leave under ${DISK_CRITICAL_GB} GB of disk. Free up space on the runner first.`;

const KEPT_LINES = 40;
const SHOWN_LINES = 12;

type ActResult = BoardAgentActionMap['localAiAct']['result'];

/** The tags that fit first, then the rest, each smallest first; a tag with
 *  no size (a cloud one) last in its group. */
const byFit = (a: OllamaLibraryTag, b: OllamaLibraryTag) =>
  Number(b.fits) - Number(a.fits) || (a.sizeGb ?? Infinity) - (b.sizeGb ?? Infinity);

export class LocalAiTags {
  private job: RunnerLocalAiJob | null = null;

  constructor(
    private readonly io: LocalAiTagsIo,
    private readonly now: () => number = Date.now
  ) {}

  async list(): Promise<RunnerLocalAiModels> {
    const [state, health, bin] = await Promise.all([
      localAiState(this.io.model).catch(() => null),
      this.io.health().catch(() => null),
      this.io.model.resolveBin().catch(() => null)
    ]);
    return {
      ollama: bin !== null,
      installed: this.io.installed(),
      machine: state?.machine ?? null,
      recommended: state?.recommended ?? null,
      models: state?.models ?? [],
      health,
      job: this.job ? { ...this.job, lines: this.job.lines.slice(-SHOWN_LINES) } : null
    };
  }

  /** A query's models on ollama.com, or one model's tags with their fit. */
  async search(payload: unknown): Promise<RunnerLocalAiSearch> {
    const parsed = localAiSearchSchema.parse(payload);
    if ('query' in parsed) {
      return { kind: 'models', query: parsed.query, models: await this.io.library.search(parsed.query) };
    }
    const [tags, machine] = await Promise.all([
      this.io.library.tags(parsed.name),
      this.io.model.machine().catch(() => null)
    ]);
    const freeGb = this.io.freeDiskGb();
    const fitted = tags.map((t) => this.fit(t, machine, freeGb));
    return { kind: 'tags', name: parsed.name, tags: fitted.sort(byFit) };
  }

  /** Whether one tag fits: not a cloud tag, its size in memory, and the disk
   *  after it. A tag with no size is let through, as a pull by name was. */
  private fit(tag: ParsedOllamaTag, machine: LocalAiMachine | null, freeGb: number): OllamaLibraryTag {
    const out = { ...tag, fits: true, blocker: null as string | null };
    if (tag.cloud) return { ...out, fits: false, blocker: CLOUD_BLOCKER };
    if (tag.sizeGb === null) return out;
    const memory = machine ? fitModelSize(machine, tag.sizeGb) : null;
    if (memory && !memory.fits) return { ...out, fits: false, blocker: memory.blocker };
    const room = checkRoom(freeGb, tag.sizeGb, tag.tag);
    if (room.refuse) return { ...out, fits: false, blocker: DISK_BLOCKER };
    return out;
  }

  /** Check the request, start it, and answer at once with the list. A
   *  refusal throws before anything runs. */
  async act(payload: unknown): Promise<ActResult> {
    const { action, tag } = localAiActSchema.parse(payload);
    const busy = () => {
      if (this.job?.state === 'running') {
        throw new Error(`${ollamaTitle(this.job.tag)} is still going. Wait for it to finish.`);
      }
    };
    busy();
    const bin = await this.io.model.resolveBin();
    if (!bin) throw new Error('Ollama is not installed. Add Local AI first.');
    const held = this.io.installed().map(ollamaTagKey).includes(ollamaTagKey(tag));
    if (action === 'remove' && !held) throw new Error(`${ollamaTitle(tag)} is not on this runner.`);
    if (action === 'pull') {
      if (held) throw new Error(`${ollamaTitle(tag)} is already on this runner.`);
      await this.assertFits(tag);
    }
    // Again after the awaits: a second request may have begun a job meanwhile.
    busy();
    const job: RunnerLocalAiJob = {
      action,
      tag,
      state: 'running',
      lines: [],
      startedAt: this.now()
    };
    this.job = job;
    void this.run(job, bin);
    return this.list();
  }

  /** A table model must fit the machine; any other goes by its size on
   *  ollama.com's tags page, as search showed it. Every model needs the disk
   *  above the critical line. Only a tag ollama.com does not list (or cannot
   *  be read) has no size until it is pulled. */
  private async assertFits(tag: string): Promise<void> {
    const state = await localAiState(this.io.model).catch(() => null);
    const fit = state?.models.find((m) => ollamaTagKey(m.id) === ollamaTagKey(tag));
    if (fit && !fit.fits) {
      throw new Error(`${fit.title} does not fit this machine. ${fit.blocker ?? ''}`.trim());
    }
    if (fit) {
      const { refuse } = checkRoom(this.io.freeDiskGb(), fit.diskGb, ollamaTitle(tag));
      if (refuse) throw new Error(refuse);
      return;
    }
    if (isCloudTag(tag)) throw new Error(CLOUD_BLOCKER);
    const known = await this.io.library.lookup(tag);
    const checked = this.fit(
      known ? { ...known, tag } : { tag, aliases: [], sizeGb: 0, context: null, input: null, cloud: false },
      state?.machine ?? null,
      this.io.freeDiskGb()
    );
    if (!checked.fits) {
      throw new Error(`${tag} does not fit this machine. ${checked.blocker ?? ''}`.trim());
    }
  }

  private async run(job: RunnerLocalAiJob, bin: string): Promise<void> {
    const onLine = (line: string) => {
      job.lines = [...job.lines, line].slice(-KEPT_LINES);
    };
    const title = ollamaTitle(job.tag);
    try {
      const service = this.io.model.service;
      if (!(await service.status()).running) await service.start(onLine);
      onLine(job.action === 'pull' ? `Pulling ${title}…` : `Removing ${title}…`);
      const args = job.action === 'pull' ? ['pull', job.tag] : ['rm', job.tag];
      const code = await this.io.model.stream(bin, args, onLine);
      const held = this.io.installed().map(ollamaTagKey).includes(ollamaTagKey(job.tag));
      const done = job.action === 'pull' ? code === 0 && held : code === 0 && !held;
      if (!done) {
        throw new Error(
          job.action === 'pull' ? `${title} did not finish pulling.` : `${title} was not removed.`
        );
      }
      // A model the Local AI module pulled is off its list now too.
      if (job.action === 'remove') forgetPulledModel(this.io.model.runnerDir, job.tag);
      onLine(job.action === 'pull' ? `${title} is ready.` : `Removed ${title}.`);
      job.state = 'done';
    } catch (err) {
      onLine(err instanceof Error ? err.message : String(err));
      job.state = 'failed';
    }
  }
}
