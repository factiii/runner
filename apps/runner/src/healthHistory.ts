import fs from 'node:fs';
import path from 'node:path';

import type {
  RunnerHealthLevel,
  RunnerHealthSample,
  RunnerMachineHealth
} from '@shared/all/domains/electron';

import { CONFIG_DIR } from './paths';

// Status's 24 h chart of memory pressure and disk free (card b78a269a,
// .specs/runner-setup.md "Low disk and memory alerts"): the alert watch's
// 30 s readings (healthWatch.ts) folded into one slot per 10 minutes, each
// the worst of its readings, the last 24 hours only. Kept in memory and in
// one small file in the runner folder (at most 145 slots, about 10 KB),
// written when a slot starts, so a restart keeps the day. Sent to the owner
// with the parts list's health (runnerParts.ts).

export const SLOT_MS = 10 * 60_000;
export const KEEP_MS = 24 * 60 * 60_000;
/** A day of slots, and the one being filled. */
const MAX_SLOTS = KEEP_MS / SLOT_MS + 1;

const FILE = path.join(CONFIG_DIR, 'health-history.json');

const RANK: Record<RunnerHealthLevel, number> = { ok: 0, warn: 1, critical: 2 };

const slotOf = (at: number) => Math.floor(at / SLOT_MS) * SLOT_MS;

const pick = (
  a: number | null,
  b: number | null,
  choose: (x: number, y: number) => number
): number | null => {
  if (a === null) return b;
  if (b === null) return a;
  return choose(a, b);
};

/** A reading as a sample of its slot: the disk with the least free, the
 *  memory pressure and the level. */
export function sampleOf(health: RunnerMachineHealth, at: number): RunnerHealthSample {
  const diskFreeGb = health.disks.reduce<number | null>(
    (low, disk) => pick(low, disk.freeGb, Math.min),
    null
  );
  return {
    at: slotOf(at),
    diskFreeGb,
    memoryPressure: health.memoryPressure ?? null,
    level: health.level
  };
}

/** `history` with `sample` folded into its slot (least disk, most memory,
 *  worst level), and slots older than 24 h before `now` dropped. A sample
 *  from before the last slot (the clock went back) starts over from it. */
export function addSample(
  history: readonly RunnerHealthSample[],
  sample: RunnerHealthSample,
  now: number
): RunnerHealthSample[] {
  const at = slotOf(sample.at);
  const kept = history.filter((s) => s.at > now - KEEP_MS && s.at <= at);
  const last = kept[kept.length - 1];
  if (last?.at !== at) return [...kept, { ...sample, at }].slice(-MAX_SLOTS);
  const merged: RunnerHealthSample = {
    at,
    diskFreeGb: pick(last.diskFreeGb, sample.diskFreeGb, Math.min),
    memoryPressure: pick(last.memoryPressure, sample.memoryPressure, Math.max),
    level: RANK[sample.level] > RANK[last.level] ? sample.level : last.level
  };
  return [...kept.slice(0, -1), merged];
}

const numberOrNull = (v: unknown): number | null | undefined => {
  if (v === null) return null;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

/** The saved file's slots, each checked, oldest first, within 24 h of
 *  `now`. Anything else is dropped, never trusted. */
export function parseHistory(raw: unknown, now: number): RunnerHealthSample[] {
  if (!Array.isArray(raw)) return [];
  const samples: RunnerHealthSample[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const diskFreeGb = numberOrNull(s.diskFreeGb);
    const memoryPressure = numberOrNull(s.memoryPressure);
    if (typeof s.at !== 'number' || diskFreeGb === undefined || memoryPressure === undefined) {
      continue;
    }
    if (s.level !== 'ok' && s.level !== 'warn' && s.level !== 'critical') continue;
    if (s.at <= now - KEEP_MS || s.at > now) continue;
    samples.push({ at: slotOf(s.at), diskFreeGb, memoryPressure, level: s.level });
  }
  return samples.sort((a, b) => a.at - b.at).slice(-MAX_SLOTS);
}

/** The day of slots for one runner folder. */
export class HealthHistory {
  private samples: RunnerHealthSample[];

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now
  ) {
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      // None yet, or unreadable: the day starts now.
    }
    this.samples = parseHistory(raw, now());
  }

  /** Fold a reading in; save when it starts a new slot. */
  add(health: RunnerMachineHealth): void {
    const now = this.now();
    const lastAt = this.samples[this.samples.length - 1]?.at;
    this.samples = addSample(this.samples, sampleOf(health, now), now);
    if (this.samples[this.samples.length - 1]?.at !== lastAt) this.save();
  }

  /** Oldest first, within the last 24 h. */
  list(): RunnerHealthSample[] {
    const since = this.now() - KEEP_MS;
    return this.samples.filter((s) => s.at > since);
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.samples), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // A chart, not a record: the next slot tries again.
    }
  }
}

let shared: HealthHistory | null = null;

/** This runner's history, opened on first use (so importing reads nothing). */
export function machineHistory(): HealthHistory {
  shared ??= new HealthHistory(FILE);
  return shared;
}
