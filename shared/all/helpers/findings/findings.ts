// Findings: what in a person's own reading goes together, said honestly
// (.specs/analytics.md "Findings"). Pure and deterministic given the seed:
// the same rows always give the same list, so a caller can cache it by
// `findingsCacheKey`.
//
// The unit is the active local day (at least a minute of reading). Every test
// asks "would this show up if the days of each week were shuffled?" by
// permutation, the whole view's tests are corrected together with
// Benjamini–Hochberg, and a finding also needs an effect worth saying. Below
// the minimums there is no list, only how many more days are needed.
//
// Tests:
// - mix / swap: two factiiis' shares of a day (centred log-ratio, 0.5-minute
//   pseudo-count) by Spearman. A share is relative, so CLR parts are
//   negatively correlated by construction (about −1/(D−1) for D parts, −1
//   for two). The null keeps that: each factiii's raw minutes are permuted
//   across days within an ISO week and the CLR is taken again, and the
//   reported ρ is the observed one minus that null's mean. Two parts are
//   never compared (their CLRs are mirror images); three are needed.
// - sequence: reading A then B next within a session (gaps under 10
//   minutes), against shuffles of the reading order within each session.
//   The expected count under shuffling is exact (`expectedTransitions`).
// - tone-after: the Tone of what was read in the 60 minutes after a session
//   that had A, against the person's own baseline (the Tone of everything
//   they read). Tone is passive: it comes from the Tone tags of the posts
//   read, never from asking. Each tone scores −1, 0 or +1 (tones.ts), and a
//   reading counts by its minutes, so the effect is on a −1…1 scale.
// - tone-next-day: a day's minutes on A against the next day's mean read
//   Tone, partial Spearman holding that day's total minutes fixed, so "read
//   more of everything" is not mistaken for "read more of A".
//
// Without Tone tags there are no tone tests, and the result says why
// (`tone`), never a number.
//
// Pure: it runs in a device's web worker and in the runner's scheduled
// Findings job (apps/runner/src/vault/findingsJob.ts) alike.

import { addDays, isoWeekKey, localDayKey } from '../engagementDays';
import {
  benjaminiHochberg,
  blockBootstrapCi,
  makeGroups,
  mulberry32,
  partialFrom,
  pearson,
  permuteWithinGroups,
  rank,
  shuffleRange,
  spearman
} from './stats';

export type FindingsInterval = {
  postId: string;
  factiiiIds: number[];
  startedAt: number;
  endedAt: number;
};
export type FindingsInput = {
  intervals: FindingsInterval[];
  /** Tone factiii id → its score (tones.ts `toneValenceById`). Absent or
   *  empty when the Tone list could not be had: no tone tests then. */
  toneValence?: Record<number, number>;
  factiiiNames: Record<number, string>;
  timeZone?: string;
  seed?: number;
};
export type FindingKind =
  | 'mix'
  | 'swap'
  | 'sequence'
  | 'tone-after'
  | 'tone-next-day';
export type Finding = {
  id: string;
  kind: FindingKind;
  text: string;
  factiiiIds: number[];
  n: number;
  rho?: number;
  ci?: [number, number];
  lift?: number;
  p: number;
  q: number;
};
/** Whether the tone tests ran, and if not, why. */
export type FindingsToneStatus =
  | { status: 'no-tone-list' }
  | { status: 'no-tags' }
  | { status: 'not-enough'; readings: number; needed: number }
  | { status: 'tested'; readings: number };
export type FindingsResult =
  | {
      status: 'ok';
      findings: Finding[];
      activeDays: number;
      tone: FindingsToneStatus;
    }
  | {
      status: 'not-enough';
      activeDays: number;
      daysNeeded: number;
      message: string;
    };

// ── Constants ──

const MS_PER_MINUTE = 60_000;
/** The days a view of Findings looks back over, on a device and in the
 *  runner's job alike. */
export const FINDINGS_WINDOW_DAYS = 90;
/** One interval counts at most this long, whatever its timestamps say. */
export const FINDINGS_MAX_INTERVAL_MINUTES = 30;
/** A day with less reading than this is not a day of data. */
export const FINDINGS_ACTIVE_DAY_MINUTES = 1;
export const FINDINGS_MIN_ACTIVE_DAYS = 14;
/** A factiii is tested only once it was read on this many active days. */
export const FINDINGS_MIN_FACTIII_DAYS = 5;
/** Tone-tagged readings (intervals) the tone tests need at all. */
export const FINDINGS_MIN_TONE_READINGS = 10;
/** The share tests need this many factiiis (two CLR parts are mirrors). */
export const FINDINGS_MIN_SHARE_PARTS = 3;
export const FINDINGS_PSEUDO_MINUTES = 0.5;
export const FINDINGS_SESSION_GAP_MINUTES = 10;
export const FINDINGS_TONE_WINDOW_MINUTES = 60;
export const FINDINGS_DAY_PERMUTATIONS = 2_000;
export const FINDINGS_SEQUENCE_SHUFFLES = 1_000;
export const FINDINGS_BOOTSTRAP_RESAMPLES = 1_000;
export const FINDINGS_FDR_Q = 0.1;
export const FINDINGS_CI_LEVEL = 0.95;
/** Effects too small to be worth a sentence, even when unlikely by chance. */
export const FINDINGS_MIN_ABS_RHO = 0.3;
export const FINDINGS_MIN_LIFT = 1.5;
export const FINDINGS_MIN_TONE_SHIFT = 0.25;
/** A pair is tested for sequence once it happened this many times. */
export const FINDINGS_MIN_SEQUENCE_COUNT = 5;
/** Tone-tagged readings after sessions with A the tone-after test needs. */
export const FINDINGS_MIN_TONE_AFTER = 5;
/** Day pairs (a day, then a day with Tone-tagged reading) the next-day test
 *  needs. */
export const FINDINGS_MIN_LAG_DAYS = 8;
export const FINDINGS_DEFAULT_SEED = 0x5eed;

// Each family of tests draws from its own generator, so adding a test to one
// does not move another's numbers.
const SALT_SHARES = 0x51;
const SALT_SEQUENCES = 0x53;
const SALT_TONE_AFTER = 0x4d;
const SALT_TONE_NEXT = 0x4e;
const SALT_BOOTSTRAP = 0xb0;

/** Two floats this close count as equal in a permutation's "at least as
 *  extreme". */
const TIE_EPSILON = 1e-12;
const DECIMALS = 2;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HEX = 16;

// ── Days ──

type DayTable = {
  days: string[];
  /** Day index → its ISO week's index. */
  week: Int32Array;
  /** Day indices of each week. */
  weekDays: number[][];
  total: Float64Array;
  /** Minutes per factiii per active day. */
  minutes: Map<number, Float64Array>;
};

const intervalMinutes = (interval: FindingsInterval): number =>
  Math.min(
    Math.max(0, interval.endedAt - interval.startedAt) / MS_PER_MINUTE,
    FINDINGS_MAX_INTERVAL_MINUTES
  );

/** An interval counts on the local day it started: at most 30 minutes can
 *  fall on the next one. */
function buildDays(intervals: FindingsInterval[], timeZone?: string): DayTable {
  const byDay = new Map<
    string,
    { total: number; perFactiii: Map<number, number> }
  >();
  for (const interval of intervals) {
    const minutes = intervalMinutes(interval);
    if (minutes <= 0) continue;
    const key = localDayKey(interval.startedAt, timeZone);
    let day = byDay.get(key);
    if (!day) {
      day = { total: 0, perFactiii: new Map() };
      byDay.set(key, day);
    }
    day.total += minutes;
    for (const id of new Set(interval.factiiiIds)) {
      day.perFactiii.set(id, (day.perFactiii.get(id) ?? 0) + minutes);
    }
  }
  const days = [...byDay.keys()]
    .filter((key) => byDay.get(key)!.total >= FINDINGS_ACTIVE_DAY_MINUTES)
    .sort();
  const weekIndex = new Map<string, number>();
  const week = new Int32Array(days.length);
  const weekDays: number[][] = [];
  const total = new Float64Array(days.length);
  const minutes = new Map<number, Float64Array>();
  days.forEach((key, d) => {
    const wk = isoWeekKey(key);
    let w = weekIndex.get(wk);
    if (w === undefined) {
      w = weekDays.length;
      weekIndex.set(wk, w);
      weekDays.push([]);
    }
    week[d] = w;
    weekDays[w]!.push(d);
    const day = byDay.get(key)!;
    total[d] = day.total;
    for (const [id, value] of day.perFactiii) {
      let column = minutes.get(id);
      if (!column) {
        column = new Float64Array(days.length);
        minutes.set(id, column);
      }
      column[d] = value;
    }
  });
  return { days, week, weekDays, total, minutes };
}

// ── A test before correction ──

type Candidate = {
  id: string;
  kind: FindingKind;
  factiiiIds: number[];
  n: number;
  p: number;
  /** The effect is big enough to say (|ρ|, lift or tone shift). */
  sizable: boolean;
  rho?: number;
  lift?: number;
  /** Its interval, computed only for what is reported. */
  ci: () => [number, number];
  text: (ci: [number, number]) => string;
};

/** Two-sided permutation p around the null's own mean, and that mean. */
function twoSided(
  observed: number,
  nulls: Float64Array,
  offset: number,
  count: number
): { p: number; mean: number } {
  let mean = 0;
  for (let k = 0; k < count; k++) mean += nulls[offset + k]!;
  mean /= count;
  const distance = Math.abs(observed - mean) - TIE_EPSILON;
  let extreme = 0;
  for (let k = 0; k < count; k++) {
    if (Math.abs(nulls[offset + k]! - mean) >= distance) extreme++;
  }
  return { p: (1 + extreme) / (count + 1), mean };
}

const fmt = (value: number): string =>
  value.toFixed(DECIMALS).replace('-', '−');

const signed = (value: number): string =>
  value > 0 ? `+${fmt(value)}` : fmt(value);

const clamp1 = (value: number): number => Math.max(-1, Math.min(1, value));

const ciText = (ci: [number, number]): string =>
  `95% CI ${fmt(ci[0])} to ${fmt(ci[1])}`;

// ── mix / swap ──

/** Each day's CLR of `columns` (factiii × day), 0.5-minute pseudo-count,
 *  reading day d of factiii f from `columns[f][from(f, d)]`. */
function clrInto(
  columns: Float64Array[],
  n: number,
  out: Float64Array[],
  from: (f: number, d: number) => number
): void {
  const parts = columns.length;
  for (let d = 0; d < n; d++) {
    let mean = 0;
    for (let f = 0; f < parts; f++) {
      const value = Math.log(
        columns[f]![from(f, d)]! + FINDINGS_PSEUDO_MINUTES
      );
      out[f]![d] = value;
      mean += value;
    }
    mean /= parts;
    for (let f = 0; f < parts; f++) out[f]![d]! -= mean;
  }
}

/** Ranks centred on their mean, and their length, for fast correlations. */
function centredRanks(values: Float64Array): { r: Float64Array; norm: number } {
  const r = rank(values);
  const n = r.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += r[i]!;
  mean /= n;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    r[i]! -= mean;
    norm += r[i]! * r[i]!;
  }
  return { r, norm: Math.sqrt(norm) };
}

const dotCorr = (
  a: { r: Float64Array; norm: number },
  b: { r: Float64Array; norm: number }
): number => {
  if (a.norm === 0 || b.norm === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.r.length; i++) dot += a.r[i]! * b.r[i]!;
  return dot / (a.norm * b.norm);
};

function shareTests(
  table: DayTable,
  tested: number[],
  name: (id: number) => string,
  seed: number
): Candidate[] {
  const parts = tested.length;
  const n = table.days.length;
  if (parts < FINDINGS_MIN_SHARE_PARTS) return [];
  const columns = tested.map((id) => table.minutes.get(id)!);
  const clr = tested.map(() => new Float64Array(n));
  clrInto(columns, n, clr, (_f, d) => d);
  const observed = clr.map((c) => centredRanks(c));
  const pairs: [number, number][] = [];
  for (let a = 0; a < parts; a++) {
    for (let b = a + 1; b < parts; b++) pairs.push([a, b]);
  }

  const rng = mulberry32(seed ^ SALT_SHARES);
  const groups = makeGroups(table.week);
  const scratch = new Int32Array(n);
  const perms = tested.map(() => new Int32Array(n));
  const nullClr = tested.map(() => new Float64Array(n));
  const nulls = new Float64Array(pairs.length * FINDINGS_DAY_PERMUTATIONS);
  for (let k = 0; k < FINDINGS_DAY_PERMUTATIONS; k++) {
    for (let f = 0; f < parts; f++) {
      permuteWithinGroups(groups, rng, scratch, perms[f]!);
    }
    clrInto(columns, n, nullClr, (f, d) => perms[f]![d]!);
    const ranks = nullClr.map((c) => centredRanks(c));
    pairs.forEach(([a, b], i) => {
      nulls[i * FINDINGS_DAY_PERMUTATIONS + k] = dotCorr(ranks[a]!, ranks[b]!);
    });
  }

  return pairs.map(([a, b], i) => {
    const raw = dotCorr(observed[a]!, observed[b]!);
    const { p, mean } = twoSided(
      raw,
      nulls,
      i * FINDINGS_DAY_PERMUTATIONS,
      FINDINGS_DAY_PERMUTATIONS
    );
    const rho = clamp1(raw - mean);
    const idA = tested[a]!;
    const idB = tested[b]!;
    const kind: FindingKind = rho >= 0 ? 'mix' : 'swap';
    return {
      id: `${kind}:${idA}:${idB}`,
      kind,
      factiiiIds: [idA, idB],
      n,
      p,
      rho,
      sizable: Math.abs(rho) >= FINDINGS_MIN_ABS_RHO,
      ci: () => {
        const [lo, hi] = blockBootstrapCi(
          table.weekDays,
          (idx) =>
            spearman(
              idx.map((d) => clr[a]![d]!),
              idx.map((d) => clr[b]![d]!)
            ),
          FINDINGS_BOOTSTRAP_RESAMPLES,
          mulberry32(seed ^ SALT_BOOTSTRAP ^ i),
          FINDINGS_CI_LEVEL
        );
        return [clamp1(lo - mean), clamp1(hi - mean)];
      },
      text: (ci) =>
        `More time on ${name(idA)} was associated with ${rho >= 0 ? 'more' : 'less'} time on ${name(idB)} (ρ ${fmt(rho)}, ${ciText(ci)}, n = ${n} days).`
    };
  });
}

// ── Sessions and sequences ──

type Session = { start: number; end: number; items: Int32Array[] };

/** Intervals in time order, split where the gap reaches 10 minutes. Each
 *  interval as the tested factiiis it carries (by index). */
function buildSessions(
  intervals: FindingsInterval[],
  index: Map<number, number>
): Session[] {
  const sorted = intervals
    .filter((i) => intervalMinutes(i) > 0)
    .sort((a, b) => a.startedAt - b.startedAt);
  const gap = FINDINGS_SESSION_GAP_MINUTES * MS_PER_MINUTE;
  const sessions: Session[] = [];
  let current: Session | null = null;
  for (const interval of sorted) {
    const carried = Int32Array.from(
      [...new Set(interval.factiiiIds)]
        .map((id) => index.get(id))
        .filter((f): f is number => f !== undefined)
    );
    if (!current || interval.startedAt - current.end >= gap) {
      current = { start: interval.startedAt, end: interval.endedAt, items: [] };
      sessions.push(current);
    }
    current.end = Math.max(current.end, interval.endedAt);
    current.items.push(carried);
  }
  return sessions;
}

function countTransitions(
  items: Int32Array[],
  order: Int32Array | null,
  parts: number,
  into: Int32Array
): void {
  for (let i = 0; i + 1 < items.length; i++) {
    const from = items[order ? order[i]! : i]!;
    const to = items[order ? order[i + 1]! : i + 1]!;
    for (const a of from) {
      for (const b of to) if (a !== b) into[a * parts + b]! += 1;
    }
  }
}

/** A→B transitions expected when a session's k readings are put in random
 *  order: each of the k−1 adjacent slots is a uniform ordered pair of
 *  distinct readings, so (#A·#B − #both) / k. */
function expectedTransitions(
  items: Int32Array[],
  a: number,
  b: number
): number {
  const k = items.length;
  if (k < 2) return 0;
  let withA = 0;
  let withB = 0;
  let both = 0;
  for (const item of items) {
    const hasA = item.includes(a);
    const hasB = item.includes(b);
    if (hasA) withA++;
    if (hasB) withB++;
    if (hasA && hasB) both++;
  }
  return (withA * withB - both) / k;
}

/** The sequence tests, and how many ordered pairs were too rare to test:
 *  each is still a hypothesis of the view, counted in the correction at
 *  p = 1, so twenty factiiis' 380 pairs cannot hide behind the few common
 *  ones. */
function sequenceTests(
  sessions: Session[],
  tested: number[],
  name: (id: number) => string,
  seed: number
): { candidates: Candidate[]; untested: number } {
  const parts = tested.length;
  if (parts < 2) return { candidates: [], untested: 0 };
  const multi = sessions.filter((s) => s.items.length >= 2);
  const observed = new Int32Array(parts * parts);
  for (const s of multi) countTransitions(s.items, null, parts, observed);
  const pairs: number[] = [];
  for (let c = 0; c < observed.length; c++) {
    if (observed[c]! >= FINDINGS_MIN_SEQUENCE_COUNT) pairs.push(c);
  }
  const untested = parts * (parts - 1) - pairs.length;
  if (pairs.length === 0) return { candidates: [], untested };

  const rng = mulberry32(seed ^ SALT_SEQUENCES);
  const orders = multi.map((s) => Int32Array.from(s.items.keys()));
  const counts = new Int32Array(parts * parts);
  const atLeast = new Int32Array(parts * parts);
  for (let k = 0; k < FINDINGS_SEQUENCE_SHUFFLES; k++) {
    counts.fill(0);
    multi.forEach((s, i) => {
      shuffleRange(orders[i]!, rng);
      countTransitions(s.items, orders[i]!, parts, counts);
    });
    for (const c of pairs) if (counts[c]! >= observed[c]!) atLeast[c]! += 1;
  }

  const candidates = pairs.map((c): Candidate => {
    const a = Math.floor(c / parts);
    const b = c % parts;
    const perSession = multi.map((s) => {
      const one = new Int32Array(parts * parts);
      countTransitions(s.items, null, parts, one);
      return { obs: one[c]!, exp: expectedTransitions(s.items, a, b) };
    });
    const expected = perSession.reduce((sum, s) => sum + s.exp, 0);
    const lift =
      expected > 0 ? observed[c]! / expected : Number.POSITIVE_INFINITY;
    const idA = tested[a]!;
    const idB = tested[b]!;
    return {
      id: `sequence:${idA}:${idB}`,
      kind: 'sequence' as const,
      factiiiIds: [idA, idB],
      n: observed[c]!,
      p: (1 + atLeast[c]!) / (FINDINGS_SEQUENCE_SHUFFLES + 1),
      lift,
      sizable: lift >= FINDINGS_MIN_LIFT,
      ci: () =>
        blockBootstrapCi(
          perSession.map((_, i) => [i]),
          (idx) => {
            let obs = 0;
            let exp = 0;
            for (const i of idx) {
              obs += perSession[i]!.obs;
              exp += perSession[i]!.exp;
            }
            return exp > 0 ? obs / exp : Number.NaN;
          },
          FINDINGS_BOOTSTRAP_RESAMPLES,
          mulberry32(seed ^ SALT_BOOTSTRAP ^ c),
          FINDINGS_CI_LEVEL
        ),
      text: (ci: [number, number]) =>
        `Reading ${name(idA)} was associated with reading ${name(idB)} right after (${fmt(lift)}× chance, ${ciText(ci)}, n = ${observed[c]!} times).`
    };
  });
  return { candidates, untested };
}

// ── Tone ──

/** One Tone-tagged reading: when it started, its tone's score and how many
 *  minutes it counts for. */
type ToneReading = {
  at: number;
  valence: number;
  minutes: number;
  week: number;
  day: string;
};

/** Every interval that carries a Tone with a score, in time order. A post
 *  has one Tone; if one carries several, its score is their mean. */
function toneReadings(
  intervals: FindingsInterval[],
  toneValence: Record<number, number>,
  timeZone?: string
): ToneReading[] {
  const weekIndex = new Map<string, number>();
  const readings: ToneReading[] = [];
  const sorted = [...intervals].sort((a, b) => a.startedAt - b.startedAt);
  for (const interval of sorted) {
    const minutes = intervalMinutes(interval);
    if (minutes <= 0) continue;
    const scores = [...new Set(interval.factiiiIds)]
      .map((id) => toneValence[id])
      .filter((v): v is number => v !== undefined);
    if (scores.length === 0) continue;
    const day = localDayKey(interval.startedAt, timeZone);
    const wk = isoWeekKey(day);
    let week = weekIndex.get(wk);
    if (week === undefined) {
      week = weekIndex.size;
      weekIndex.set(wk, week);
    }
    readings.push({
      at: interval.startedAt,
      valence: scores.reduce((sum, v) => sum + v, 0) / scores.length,
      minutes,
      week,
      day
    });
  }
  return readings;
}

/** The minute-weighted mean score of `list` minus that of `all`. */
function weightedShift(
  values: ArrayLike<number>,
  weights: ArrayLike<number>,
  list: readonly number[],
  all: readonly number[]
): number {
  const mean = (idx: readonly number[]) => {
    let sum = 0;
    let weight = 0;
    for (const i of idx) {
      sum += values[i]! * weights[i]!;
      weight += weights[i]!;
    }
    return weight > 0 ? sum / weight : 0;
  };
  return mean(list) - mean(all);
}

function toneAfterTests(
  readings: ToneReading[],
  sessions: Session[],
  tested: number[],
  name: (id: number) => string,
  seed: number
): Candidate[] {
  const parts = tested.length;
  const window = FINDINGS_TONE_WINDOW_MINUTES * MS_PER_MINUTE;
  // Each reading's preceding session (the latest that ended before it
  // started, within the hour), as the factiiis that session carried. The
  // reading's own session has not ended yet, so it is never its own "after".
  const after: Set<number>[] = readings.map((reading) => {
    let lo = 0;
    let hi = sessions.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sessions[mid]!.end <= reading.at) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const carried = new Set<number>();
    const session = found >= 0 ? sessions[found]! : null;
    if (session && reading.at - session.end <= window) {
      for (const item of session.items) for (const f of item) carried.add(f);
    }
    return carried;
  });
  const members = Array.from({ length: parts }, (_, f) =>
    readings.flatMap((_, i) => (after[i]!.has(f) ? [i] : []))
  );
  const testedParts = members
    .map((list, f) => ({ list, f }))
    .filter(({ list }) => list.length >= FINDINGS_MIN_TONE_AFTER);
  if (testedParts.length === 0) return [];

  const valence = Float64Array.from(readings.map((r) => r.valence));
  const weight = Float64Array.from(readings.map((r) => r.minutes));
  const everyone = readings.map((_, i) => i);

  // The null moves each reading's score (with its minutes) to another
  // reading of the same ISO week.
  const rng = mulberry32(seed ^ SALT_TONE_AFTER);
  const groups = makeGroups(readings.map((r) => r.week));
  const scratch = new Int32Array(readings.length);
  const perm = new Int32Array(readings.length);
  const shuffledValence = new Float64Array(readings.length);
  const shuffledWeight = new Float64Array(readings.length);
  const nulls = new Float64Array(
    testedParts.length * FINDINGS_DAY_PERMUTATIONS
  );
  for (let k = 0; k < FINDINGS_DAY_PERMUTATIONS; k++) {
    permuteWithinGroups(groups, rng, scratch, perm);
    for (let i = 0; i < readings.length; i++) {
      shuffledValence[i] = valence[perm[i]!]!;
      shuffledWeight[i] = weight[perm[i]!]!;
    }
    testedParts.forEach(({ list }, t) => {
      nulls[t * FINDINGS_DAY_PERMUTATIONS + k] = weightedShift(
        shuffledValence,
        shuffledWeight,
        list,
        everyone
      );
    });
  }
  const weeks: number[][] = [];
  readings.forEach((r, i) => (weeks[r.week] ??= []).push(i));

  return testedParts.map(({ list, f }, t) => {
    const observed = weightedShift(valence, weight, list, everyone);
    const { p } = twoSided(
      observed,
      nulls,
      t * FINDINGS_DAY_PERMUTATIONS,
      FINDINGS_DAY_PERMUTATIONS
    );
    const id = tested[f]!;
    return {
      id: `tone-after:${id}`,
      kind: 'tone-after' as const,
      factiiiIds: [id],
      n: list.length,
      p,
      sizable: Math.abs(observed) >= FINDINGS_MIN_TONE_SHIFT,
      ci: () =>
        blockBootstrapCi(
          weeks,
          (idx) => {
            const chosen = idx.filter((i) => after[i]!.has(f));
            return chosen.length > 0
              ? weightedShift(valence, weight, chosen, idx)
              : Number.NaN;
          },
          FINDINGS_BOOTSTRAP_RESAMPLES,
          mulberry32(seed ^ SALT_BOOTSTRAP ^ (SALT_TONE_AFTER + f)),
          FINDINGS_CI_LEVEL
        ),
      text: (ci: [number, number]) =>
        `Reading ${name(id)} was associated with a ${observed >= 0 ? 'more pleasant' : 'less pleasant'} tone in what you read in the hour after than your usual (${signed(observed)} on a −1 to 1 scale, ${ciText(ci)}, n = ${list.length} readings).`
    };
  });
}

function toneNextDayTests(
  table: DayTable,
  readings: ToneReading[],
  tested: number[],
  name: (id: number) => string,
  seed: number
): Candidate[] {
  const byDay = new Map<string, { sum: number; minutes: number }>();
  for (const reading of readings) {
    const day = byDay.get(reading.day) ?? { sum: 0, minutes: 0 };
    day.sum += reading.valence * reading.minutes;
    day.minutes += reading.minutes;
    byDay.set(reading.day, day);
  }
  // Active days followed by a day with Tone-tagged reading.
  const rows: { d: number; tone: number }[] = [];
  table.days.forEach((key, d) => {
    const next = byDay.get(addDays(key, 1));
    if (next && next.minutes > 0) {
      rows.push({ d, tone: next.sum / next.minutes });
    }
  });
  if (rows.length < FINDINGS_MIN_LAG_DAYS) return [];

  const n = rows.length;
  const y = rank(rows.map((r) => r.tone));
  const z = rank(rows.map((r) => Math.log(table.total[r.d]!)));
  const groups = makeGroups(rows.map((r) => table.week[r.d]!));
  const weeks: number[][] = [];
  rows.forEach((r, i) => (weeks[table.week[r.d]!] ??= []).push(i));
  const compact = weeks.filter((w) => w !== undefined);
  const rng = mulberry32(seed ^ SALT_TONE_NEXT);
  const scratch = new Int32Array(n);
  const perm = new Int32Array(n);
  const yPerm = new Float64Array(n);

  const xs = tested.map((id) => {
    const column = table.minutes.get(id)!;
    return rank(
      rows.map((r) => Math.log(column[r.d]! + FINDINGS_PSEUDO_MINUTES))
    );
  });
  const rxz = xs.map((x) => pearson(x, z));
  const nulls = new Float64Array(tested.length * FINDINGS_DAY_PERMUTATIONS);
  for (let k = 0; k < FINDINGS_DAY_PERMUTATIONS; k++) {
    permuteWithinGroups(groups, rng, scratch, perm);
    for (let i = 0; i < n; i++) yPerm[i] = y[perm[i]!]!;
    const ryz = pearson(yPerm, z);
    xs.forEach((x, f) => {
      nulls[f * FINDINGS_DAY_PERMUTATIONS + k] = partialFrom(
        pearson(x, yPerm),
        rxz[f]!,
        ryz
      );
    });
  }
  const ryzObserved = pearson(y, z);

  return tested.map((id, f) => {
    const rho = partialFrom(pearson(xs[f]!, y), rxz[f]!, ryzObserved);
    const { p } = twoSided(
      rho,
      nulls,
      f * FINDINGS_DAY_PERMUTATIONS,
      FINDINGS_DAY_PERMUTATIONS
    );
    const column = table.minutes.get(id)!;
    return {
      id: `tone-next-day:${id}`,
      kind: 'tone-next-day' as const,
      factiiiIds: [id],
      n,
      p,
      rho,
      sizable: Math.abs(rho) >= FINDINGS_MIN_ABS_RHO,
      ci: () =>
        blockBootstrapCi(
          compact,
          (idx) => {
            const xr = rank(
              idx.map((i) =>
                Math.log(column[rows[i]!.d]! + FINDINGS_PSEUDO_MINUTES)
              )
            );
            const yr = rank(idx.map((i) => rows[i]!.tone));
            const zr = rank(idx.map((i) => Math.log(table.total[rows[i]!.d]!)));
            return partialFrom(
              pearson(xr, yr),
              pearson(xr, zr),
              pearson(yr, zr)
            );
          },
          FINDINGS_BOOTSTRAP_RESAMPLES,
          mulberry32(seed ^ SALT_BOOTSTRAP ^ (SALT_TONE_NEXT + f)),
          FINDINGS_CI_LEVEL
        ),
      text: (ci: [number, number]) =>
        `More time on ${name(id)} was associated with a ${rho >= 0 ? 'more pleasant' : 'less pleasant'} tone in what you read the next day (ρ ${fmt(rho)}, ${ciText(ci)}, n = ${n} days).`
    };
  });
}

/** The tone tests of the view, or why there are none: no Tone list, nothing
 *  read with a Tone tag, or too few such readings. Never a made-up number. */
function toneTests(
  input: FindingsInput,
  table: DayTable,
  sessions: Session[],
  tested: number[],
  name: (id: number) => string,
  seed: number
): { status: FindingsToneStatus; candidates: Candidate[] } {
  const toneValence = input.toneValence ?? {};
  if (Object.keys(toneValence).length === 0) {
    return { status: { status: 'no-tone-list' }, candidates: [] };
  }
  const readings = toneReadings(input.intervals, toneValence, input.timeZone);
  if (readings.length === 0) {
    return { status: { status: 'no-tags' }, candidates: [] };
  }
  if (readings.length < FINDINGS_MIN_TONE_READINGS) {
    return {
      status: {
        status: 'not-enough',
        readings: readings.length,
        needed: FINDINGS_MIN_TONE_READINGS
      },
      candidates: []
    };
  }
  const candidates =
    tested.length > 0
      ? [
          ...toneAfterTests(readings, sessions, tested, name, seed),
          ...toneNextDayTests(table, readings, tested, name, seed)
        ]
      : [];
  return {
    status: { status: 'tested', readings: readings.length },
    candidates
  };
}

/** Why the tone tests did not run, in words; null when they ran. */
export const toneStatusMessage = (tone: FindingsToneStatus): string | null => {
  switch (tone.status) {
    case 'no-tone-list':
      return 'Tone was not tested: the list of Tone tags could not be loaded.';
    case 'no-tags':
      return 'Tone was not tested: nothing you read has a Tone tag yet.';
    case 'not-enough':
      return `Tone was not tested yet: ${tone.readings} of the ${tone.needed} Tone-tagged readings it needs.`;
    case 'tested':
      return null;
  }
};

// ── The view ──

export const notEnoughMessage = (daysNeeded: number): string =>
  `Not enough data yet: about ${daysNeeded} more ${daysNeeded === 1 ? 'day' : 'days'}`;

export function computeFindings(input: FindingsInput): FindingsResult {
  const seed = input.seed ?? FINDINGS_DEFAULT_SEED;
  const table = buildDays(input.intervals, input.timeZone);
  const activeDays = table.days.length;
  if (activeDays < FINDINGS_MIN_ACTIVE_DAYS) {
    const daysNeeded = FINDINGS_MIN_ACTIVE_DAYS - activeDays;
    return {
      status: 'not-enough',
      activeDays,
      daysNeeded,
      message: notEnoughMessage(daysNeeded)
    };
  }
  const tested = [...table.minutes.entries()]
    .filter(([, column]) => {
      let days = 0;
      for (const value of column) if (value > 0) days++;
      return days >= FINDINGS_MIN_FACTIII_DAYS;
    })
    .map(([id]) => id)
    .sort((a, b) => a - b);
  const name = (id: number) => input.factiiiNames[id] ?? `Factiii ${id}`;
  const index = new Map(tested.map((id, f) => [id, f]));
  const sessions = buildSessions(input.intervals, index);

  const sequences = sequenceTests(sessions, tested, name, seed);
  const candidates: Candidate[] = [
    ...shareTests(table, tested, name, seed),
    ...sequences.candidates
  ];
  const tone = toneTests(input, table, sessions, tested, name, seed);
  candidates.push(...tone.candidates);

  const qs = benjaminiHochberg([
    ...candidates.map((c) => c.p),
    ...Array.from({ length: sequences.untested }, () => 1)
  ]);
  const findings: Finding[] = [];
  candidates.forEach((c, i) => {
    const q = qs[i]!;
    if (q > FINDINGS_FDR_Q || !c.sizable) return;
    const ci = c.ci();
    findings.push({
      id: c.id,
      kind: c.kind,
      text: c.text(ci),
      factiiiIds: c.factiiiIds,
      n: c.n,
      ...(c.rho !== undefined ? { rho: c.rho } : {}),
      ...(c.lift !== undefined ? { lift: c.lift } : {}),
      ci,
      p: c.p,
      q
    });
  });
  findings.sort((a, b) => a.q - b.q || a.id.localeCompare(b.id));
  return { status: 'ok', findings, activeDays, tone: tone.status };
}

/** A cheap fingerprint of everything the result depends on (FNV-1a over the
 *  rows, the zone and the seed), for a cache keyed by data and view. */
export function findingsCacheKey(input: FindingsInput): string {
  let hash = FNV_OFFSET;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
  };
  for (const i of input.intervals) {
    feed(`${i.postId}|${i.startedAt}|${i.endedAt}|${i.factiiiIds.join(',')};`);
  }
  const tones = Object.entries(input.toneValence ?? {}).sort(
    ([a], [b]) => Number(a) - Number(b)
  );
  for (const [id, valence] of tones) feed(`${id}=${valence};`);
  feed(`${input.timeZone ?? ''}|${input.seed ?? FINDINGS_DEFAULT_SEED}`);
  return `${input.intervals.length}.${tones.length}.${hash.toString(HEX)}`;
}
