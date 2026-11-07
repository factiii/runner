import type {
  RunnerCleanup,
  RunnerCleanupItem,
  RunnerDiskUse,
  RunnerLocalAi,
  RunnerMachineHealth,
  RunnerModuleAction,
  RunnerModuleId,
  RunnerModuleJob,
  RunnerPart,
  RunnerPartAction,
  RunnerPartId,
  RunnerPartJob,
  RunnerPartsState
} from '@shared/all/domains/electron';
import { LOCAL_AI_MODELS, type LocalAiModelId } from '@shared/all/helpers/localAiModels';
import { machineCleanupSchema, runnerPartActionSchema } from '@shared/all/validators';

import type { DoctorResult } from './doctor';
import {
  dependentsOf,
  describeModule,
  describePart,
  findModule,
  findPart,
  modulesFor,
  type PartDef,
  partsFor,
  removableTools,
  resolveRequirements,
  type ServiceState
} from './parts';

// Runs the part and module actions for the CLI (awaited, lines printed) and
// for the app (in the background; the list carries each part's and module's
// job). One manager per runner process: the daemon passes the same one to
// every board's engine.

export type PartService = {
  status(): Promise<ServiceState>;
  start(onLine: (line: string) => void): Promise<void>;
  stop(onLine: (line: string) => void): Promise<void>;
};

/** The machine behind the manager. runnerParts.ts is the real one; the tests
 *  hand it a fake. */
export type PartsMachine = {
  platform: NodeJS.Platform;
  /** One doctor pass over every check. `fresh` probes the tools again. */
  results(fresh: boolean): Promise<DoctorResult[]>;
  /** Run one `install` or `folder` fix. */
  fix(result: DoctorResult, onLine: (line: string) => void): Promise<void>;
  uninstall(bin: string, onLine: (line: string) => void): Promise<void>;
  /** The tools the runner itself installed through `parts add`. */
  readLedger(): string[];
  writeLedger(tools: string[]): void;
  service(id: RunnerPartId): PartService | null;
  /** The Local AI model: what fits and what is picked (localAiModel.ts). */
  localAi?: {
    state(): Promise<RunnerLocalAi>;
    /** Refused when the model does not fit. */
    pick(id: LocalAiModelId): Promise<void>;
  };
  /** Free disk and memory pressure (machineHealth.ts). */
  health?(): Promise<RunnerMachineHealth>;
  /** Before an add: is there room for `diskMb` (checkRoom)? */
  room?(diskMb: number, what: string): { refuse: string | null; warn: string | null };
  /** Free up space (cleanup.ts): the dry run, and a run of chosen ids. */
  cleanup?: {
    plan(): Promise<RunnerCleanupItem[]>;
    run(ids: readonly string[], onLine: (line: string) => void): Promise<number>;
    /** The biggest folders (diskCaches.ts), for a dry run. */
    usage?(): Promise<RunnerDiskUse[]>;
  };
};

/** A model in use holds its weights plus its context. */
const MODEL_CONTEXT_MB = 1_000;
const MB_PER_GB = 1_000;

const KEPT_LINES = 40;
const SHOWN_LINES = 12;
/** A doctor pass costs a login shell per tool: reuse one this young. */
const RESULTS_TTL_MS = 30_000;

export class PartsManager {
  private jobs = new Map<RunnerPartId, RunnerPartJob>();
  private moduleJobs = new Map<RunnerModuleId, RunnerModuleJob>();
  private pass: { at: number; results: Promise<DoctorResult[]> } | null = null;
  /** A pass has run, so the next one probes the tools again. */
  private probed = false;
  private cleaning = false;

  constructor(
    private machine: PartsMachine,
    private now: () => number = Date.now
  ) {}

  private results(): Promise<DoctorResult[]> {
    if (!this.pass || this.now() - this.pass.at > RESULTS_TTL_MS) {
      const results = this.machine.results(this.probed);
      this.probed = true;
      this.pass = { at: this.now(), results };
      // A failed pass is not kept.
      results.catch(() => {
        this.pass = null;
      });
    }
    return this.pass.results;
  }

  /** The machine changed: the next read probes it again. */
  private forget(): void {
    this.pass = null;
  }

  async list(): Promise<RunnerPartsState> {
    const results = await this.results();
    const parts = partsFor(this.machine.platform);
    const resolved = parts.map((part) => ({
      part,
      res: resolveRequirements(part, results)
    }));
    const installed = resolved.filter((r) => r.res.installed).map((r) => r.part);
    const ledger = this.machine.readLedger();
    const described = await Promise.all(
      resolved.map(async ({ part, res }) => {
        const service = part.service
          ? await serviceState(this.machine.service(part.id))
          : null;
        const job = this.jobs.get(part.id);
        return describePart(
          part,
          res,
          removableTools(part, ledger, installed),
          service,
          job ? { ...job, lines: job.lines.slice(-SHOWN_LINES) } : null
        );
      })
    );
    const localAi = await this.localAi(parts);
    const health = await this.machine.health?.().catch(() => null);
    const byId = new Map(described.map((p) => [p.id, withModelCost(p, localAi)]));
    return {
      ...(localAi ? { localAi } : {}),
      ...(health ? { health } : {}),
      supported: true,
      parts: described.filter((p) => !findPart(p.id).moduleOnly),
      modules: modulesFor(this.machine.platform).map(({ def, parts: subs }) =>
        describeModule(
          def,
          subs.flatMap((sub) => byId.get(sub.id) ?? []),
          this.moduleJobs.get(def.id) ?? null
        )
      )
    };
  }

  /** The Local AI model's state, where the model is offered here. A
   *  machine that cannot be read leaves it out. */
  private async localAi(offered: readonly PartDef[]): Promise<RunnerLocalAi | null> {
    if (!this.machine.localAi || !offered.some((p) => p.id === 'local-ai-model')) return null;
    return this.machine.localAi.state().catch(() => null);
  }

  /** Pick the Local AI model an add will pull (the CLI's `--model`): only
   *  on Local AI's add, its model's, or its module's. The machine refuses one
   *  that does not fit. The apps pick no model here: another model is picked
   *  in Oakbox Ask. */
  async pickModel(
    target: { partId?: RunnerPartId; moduleId?: RunnerModuleId; action: string },
    modelId: LocalAiModelId
  ): Promise<void> {
    const forLocalAi =
      target.action === 'add' &&
      (target.moduleId === 'local-ai' ||
        target.partId === 'local-ai' ||
        target.partId === 'local-ai-model');
    if (!forLocalAi || !this.machine.localAi) {
      throw new Error('A model is picked only when adding Local AI.');
    }
    await this.machine.localAi.pick(modelId);
    this.forget();
  }

  /** The app's entry: check the payload, start the action, answer at once. */
  async act(payload: unknown): Promise<RunnerPartsState> {
    const parsed = runnerPartActionSchema.parse(payload);
    const state = await this.list();
    if ('moduleId' in parsed) {
      const current = state.modules?.find((m) => m.id === parsed.moduleId);
      if (!current) throw new Error(`${parsed.moduleId} is not offered on this machine.`);
      if (!current.actions.includes(parsed.action)) {
        throw new Error(`${current.title} cannot ${parsed.action} now.`);
      }
      // Claimed before anything else awaits: a second request that read the
      // same list is refused here, not left to reject in the background.
      const job = this.claimModule(parsed.moduleId, parsed.action);
      void this.runModuleJob(parsed.moduleId, job, parsed.action);
      return this.list();
    }
    const { partId, action } = parsed;
    // A module's copy first: while the module runs, its parts offer nothing.
    const current =
      state.modules?.flatMap((m) => m.parts).find((p) => p.id === partId) ??
      state.parts.find((p) => p.id === partId);
    if (!current) throw new Error(`${partId} is not offered on this machine.`);
    if (!current.actions.includes(action)) {
      throw new Error(`${current.title} cannot ${action} now.`);
    }
    // As the module's above: claimed now, run in the background, which
    // never rejects (runJob catches what the action throws).
    const job = this.claim(partId, action);
    void this.runJob(partId, job, action);
    return this.list();
  }

  /** Free up space: the dry run, or with `confirm` a run of the `ids` the
   *  owner saw, and only those still in a fresh plan (cleanup.ts). With
   *  `usage`, the biggest folders instead of the plan. */
  async cleanup(
    payload: unknown,
    onLine: (line: string) => void = () => {}
  ): Promise<RunnerCleanup> {
    const { confirm, ids, usage } = machineCleanupSchema.parse(payload ?? {});
    const cleanup = this.machine.cleanup;
    if (!cleanup) {
      return { items: [], bytes: 0, ran: false, lines: ['This runner cannot free up space.'] };
    }
    // The biggest folders alone: `du` walks every file, so a minute on a
    // full home folder, and the plan does not wait for it.
    if (usage && !confirm) {
      return { items: [], bytes: 0, ran: false, lines: [], usage: (await cleanup.usage?.()) ?? [] };
    }
    const lines: string[] = [];
    if (confirm) {
      if (this.cleaning) throw new Error('Free up space is already running.');
      this.cleaning = true;
      try {
        await cleanup.run(ids ?? [], (line) => {
          lines.push(line);
          onLine(line);
        });
      } finally {
        this.cleaning = false;
        this.forget();
      }
    }
    const items = await cleanup.plan();
    return {
      items,
      bytes: items.reduce((sum, i) => sum + i.bytes, 0),
      ran: Boolean(confirm),
      lines
    };
  }

  /** Run a module's action on each of its sub-parts in order (remove: last
   *  first), and stop at the first that fails; its job says why. */
  async runModule(
    moduleId: RunnerModuleId,
    action: RunnerModuleAction,
    onLine: (line: string) => void = () => {}
  ): Promise<boolean> {
    const job = this.claimModule(moduleId, action);
    return this.runModuleJob(moduleId, job, action, onLine);
  }

  /** Mark the module running, synchronously, or refuse it: one busy check
   *  and its mark with no await between them. */
  private claimModule(moduleId: RunnerModuleId, action: RunnerModuleAction): RunnerModuleJob {
    if (this.moduleJobs.get(moduleId)?.state === 'running') {
      throw new Error('That module is already busy.');
    }
    const def = findModule(moduleId);
    if (def.core) throw new Error('Bare is part of every runner.');
    const job: RunnerModuleJob = {
      action,
      state: 'running',
      partId: null,
      startedAt: this.now()
    };
    this.moduleJobs.set(moduleId, job);
    return job;
  }

  /** The claimed module's run. Never rejects: a throw ends it failed. */
  private async runModuleJob(
    moduleId: RunnerModuleId,
    job: RunnerModuleJob,
    action: RunnerModuleAction,
    onLine: (line: string) => void = () => {}
  ): Promise<boolean> {
    let ok = true;
    try {
      const def = findModule(moduleId);
      const ids = action === 'add' ? def.parts : [...def.parts].reverse();
      const offered = partsFor(this.machine.platform);
      for (const part of ids.map(findPart)) {
        if (!offered.includes(part)) continue;
        // Read again each time: an earlier sub-part may have added or
        // removed this one as a dependency.
        const installed = await this.installedParts();
        const wanted =
          action === 'add'
            ? !installed.includes(part)
            : removableTools(part, this.machine.readLedger(), installed).length > 0;
        if (!wanted) continue;
        job.partId = part.id;
        onLine(`${part.title}:`);
        ok = await this.run(part.id, action, onLine);
        if (!ok) break;
      }
    } catch (err) {
      ok = false;
      onLine(err instanceof Error ? err.message : String(err));
    }
    job.state = ok ? 'done' : 'failed';
    if (ok) job.partId = null;
    return ok;
  }

  /** Every offered part (the flat list's Vault and its sub-parts too)
   *  whose requirements are met now. */
  private async installedParts(): Promise<PartDef[]> {
    const results = await this.results();
    return partsFor(this.machine.platform).filter(
      (part) => resolveRequirements(part, results).installed
    );
  }

  /** Run one action to its end. Resolves whether it worked; each line goes
   *  to `onLine` and into the part's job. */
  async run(
    partId: RunnerPartId,
    action: RunnerPartAction,
    onLine: (line: string) => void = () => {}
  ): Promise<boolean> {
    const job = this.claim(partId, action);
    return this.runJob(partId, job, action, onLine);
  }

  /** Mark the part running, synchronously, or refuse it: one busy check and
   *  its mark with no await between them. */
  private claim(partId: RunnerPartId, action: RunnerPartAction): RunnerPartJob {
    if (this.jobs.get(partId)?.state === 'running') {
      throw new Error('That part is already busy.');
    }
    const job: RunnerPartJob = {
      action,
      state: 'running',
      lines: [],
      startedAt: this.now()
    };
    this.jobs.set(partId, job);
    return job;
  }

  /** The claimed part's action to its end. Never rejects: a throw is a line
   *  and a failed job. */
  private async runJob(
    partId: RunnerPartId,
    job: RunnerPartJob,
    action: RunnerPartAction,
    onLine: (line: string) => void = () => {}
  ): Promise<boolean> {
    const line = (text: string) => {
      job.lines = [...job.lines, text].slice(-KEPT_LINES);
      onLine(text);
    };
    let ok = false;
    try {
      const part = findPart(partId);
      ok =
        (await this.prerequisites(part, action, line)) &&
        (await this.perform(part, action, line));
    } catch (err) {
      line(err instanceof Error ? err.message : String(err));
    }
    job.state = ok ? 'done' : 'failed';
    return ok;
  }

  /** Before an add, the sub-parts this part needs; before a remove, the
   *  installed parts that need this one. Each runs as its own job, and its
   *  lines show in this one too. */
  private async prerequisites(
    part: PartDef,
    action: RunnerPartAction,
    line: (text: string) => void
  ): Promise<boolean> {
    if (action !== 'add' && action !== 'remove') return true;
    const offered = partsFor(this.machine.platform);
    const others =
      action === 'add'
        ? (part.needs ?? []).map(findPart)
        : dependentsOf(part.id);
    for (const other of others) {
      if (!offered.includes(other)) continue;
      const installed = resolveRequirements(other, await this.results()).installed;
      if (installed === (action === 'add')) continue;
      line(
        action === 'add'
          ? `${part.title} needs ${other.title}: adding it first.`
          : `${other.title} needs ${part.title}: removing it first.`
      );
      if (!(await this.run(other.id, action, line))) {
        const verb = action === 'add' ? 'install' : 'go';
        line(`${other.title} did not ${verb}, so ${part.title} was left as it was.`);
        return false;
      }
    }
    return true;
  }

  private async perform(
    part: PartDef,
    action: RunnerPartAction,
    line: (text: string) => void
  ): Promise<boolean> {
    if (part.core) throw new Error('The connector is part of every runner.');
    const service = this.machine.service(part.id);
    if (action === 'start' || action === 'stop') {
      if (!service) throw new Error(`${part.title} has nothing to ${action}.`);
      await (action === 'start' ? service.start(line) : service.stop(line));
      return true;
    }
    if (action === 'add') return this.add(part, line);
    return this.remove(part, service, line);
  }

  /** Run the doctor's own fixes for this part's requirements, and only
   *  those. What needs a person is said, never run. */
  private async add(part: PartDef, line: (text: string) => void): Promise<boolean> {
    const res = resolveRequirements(part, await this.results());
    if (res.installed) {
      line(`${part.title} is already installed.`);
      return true;
    }
    // The model's own fit (localAiModel.ts) checks its pull. A build that
    // peaks above its final size needs room for the peak.
    const room =
      part.id === 'local-ai-model' ? null : this.machine.room?.(part.buildDiskMb ?? part.diskMb, part.title);
    if (room?.refuse) {
      line(room.refuse);
      return false;
    }
    if (room?.warn) line(room.warn);
    for (const result of res.fixes) {
      line(`Installing ${result.title}…`);
      try {
        await this.machine.fix(result, line);
        if (result.fix?.kind === 'install') this.record(result.fix.tool);
      } catch (err) {
        line(err instanceof Error ? err.message : String(err));
      }
    }
    for (const step of res.manual) line(`Needs you: ${step}`);
    this.forget();
    const after = resolveRequirements(part, await this.results());
    if (after.installed) line(`${part.title} is installed.`);
    else line(`Still missing: ${after.missing.map((r) => r.title).join(', ')}.`);
    return after.installed;
  }

  private async remove(
    part: PartDef,
    service: PartService | null,
    line: (text: string) => void
  ): Promise<boolean> {
    const tools = removableTools(
      part,
      this.machine.readLedger(),
      await this.installedParts()
    );
    if (service) {
      const status = await service.status();
      if (status.running && status.ours) await service.stop(line);
    }
    let ok = true;
    for (const bin of tools) {
      try {
        await this.machine.uninstall(bin, line);
        this.machine.writeLedger(this.machine.readLedger().filter((t) => t !== bin));
      } catch (err) {
        ok = false;
        line(err instanceof Error ? err.message : String(err));
      }
    }
    this.forget();
    const kept = part.requires.filter((id) => !tools.includes(id));
    if (kept.length) {
      line(
        `Left in place: ${kept.join(', ')}. The runner did not install them, or another part uses them.`
      );
    }
    return ok;
  }

  private record(bin: string): void {
    const ledger = this.machine.readLedger();
    if (!ledger.includes(bin)) this.machine.writeLedger([...ledger, bin]);
  }
}

/** The model's row costs what the picked model does. */
function withModelCost(part: RunnerPart, localAi: RunnerLocalAi | null): RunnerPart {
  const model = LOCAL_AI_MODELS.find((m) => m.id === localAi?.picked);
  if (part.id !== 'local-ai-model' || !model) return part;
  const diskMb = Math.round(model.diskGb * MB_PER_GB);
  return { ...part, diskMb, memoryMb: diskMb + MODEL_CONTEXT_MB };
}

/** A service's state, or null when it cannot be read. */
async function serviceState(
  service: PartService | null
): Promise<ServiceState | null> {
  try {
    return service ? await service.status() : null;
  } catch {
    return null;
  }
}
