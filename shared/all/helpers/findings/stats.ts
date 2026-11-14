// Small statistics primitives for the Findings engine (findings.ts). Pure,
// deterministic given the generator, and on typed arrays so a view's few
// thousand permutations stay fast.

export type Rng = () => number;

const UINT32 = 4_294_967_296;
const MULBERRY_STEP = 0x6d2b79f5;
const MULBERRY_SHIFT_A = 15;
const MULBERRY_SHIFT_B = 7;
const MULBERRY_SHIFT_C = 14;
const MULBERRY_OR_A = 1;
const MULBERRY_OR_B = 61;

/** mulberry32: a seeded generator of uniform numbers in [0, 1). */
export const mulberry32 = (seed: number): Rng => {
  let a = seed >>> 0;
  return () => {
    a = (a + MULBERRY_STEP) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> MULBERRY_SHIFT_A), t | MULBERRY_OR_A);
    t ^= t + Math.imul(t ^ (t >>> MULBERRY_SHIFT_B), t | MULBERRY_OR_B);
    return ((t ^ (t >>> MULBERRY_SHIFT_C)) >>> 0) / UINT32;
  };
};

/** Fisher–Yates over `arr[start..end)`, in place. */
export const shuffleRange = (
  arr: Int32Array | number[],
  rng: Rng,
  start = 0,
  end = arr.length
): void => {
  for (let i = end - 1; i > start; i--) {
    const j = start + Math.floor(rng() * (i - start + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
};

/** Index groups as one array of indices plus each group's [start, end), so
 *  a shuffle within groups is a few range shuffles. */
export type Groups = { order: Int32Array; bounds: Int32Array };

/** Groups of the indices 0..n-1 by `groupOf[i]`, in index order. */
export const makeGroups = (groupOf: ArrayLike<number>): Groups => {
  const byGroup = new Map<number, number[]>();
  for (let i = 0; i < groupOf.length; i++) {
    const g = groupOf[i]!;
    const list = byGroup.get(g);
    if (list) list.push(i);
    else byGroup.set(g, [i]);
  }
  const order = new Int32Array(groupOf.length);
  const bounds = new Int32Array(byGroup.size + 1);
  let k = 0;
  let b = 0;
  for (const list of byGroup.values()) {
    bounds[b++] = k;
    for (const i of list) order[k++] = i;
  }
  bounds[b] = k;
  return { order, bounds };
};

/** A fresh permutation of 0..n-1 that only moves indices within their group:
 *  `perm[i]` is where position i takes its value from. */
export const permuteWithinGroups = (
  groups: Groups,
  rng: Rng,
  scratch: Int32Array,
  out: Int32Array
): void => {
  scratch.set(groups.order);
  for (let b = 0; b < groups.bounds.length - 1; b++) {
    shuffleRange(scratch, rng, groups.bounds[b]!, groups.bounds[b + 1]!);
  }
  for (let k = 0; k < groups.order.length; k++) {
    out[groups.order[k]!] = scratch[k]!;
  }
};

/** Ranks 1..n, ties sharing their average rank. */
export const rank = (values: ArrayLike<number>): Float64Array => {
  const n = values.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => values[a]! - values[b]!);
  const out = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[idx[j + 1]!] === values[idx[i]!]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]!] = avg;
    i = j + 1;
  }
  return out;
};

/** Pearson's r; 0 when either side has no spread. */
export const pearson = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  const n = a.length;
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
};

export const spearman = (a: ArrayLike<number>, b: ArrayLike<number>): number =>
  pearson(rank(a), rank(b));

/** The correlation of x and y with z held fixed, from the three pairwise
 *  correlations. On ranks, this is the partial Spearman. */
export const partialFrom = (rxy: number, rxz: number, ryz: number): number => {
  const den = Math.sqrt((1 - rxz * rxz) * (1 - ryz * ryz));
  return den > 0 ? (rxy - rxz * ryz) / den : 0;
};

export const partialSpearman = (
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  z: ArrayLike<number>
): number => {
  const rx = rank(x);
  const ry = rank(y);
  const rz = rank(z);
  return partialFrom(pearson(rx, ry), pearson(rx, rz), pearson(ry, rz));
};

/** Benjamini–Hochberg q-values for `ps`, in the same order. */
export const benjaminiHochberg = (ps: readonly number[]): number[] => {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const qs = new Array<number>(m);
  let running = 1;
  for (let k = m - 1; k >= 0; k--) {
    const { p, i } = order[k]!;
    running = Math.min(running, (p * m) / (k + 1));
    qs[i] = running;
  }
  return qs;
};

/** The `fraction` quantile of `values` (sorted copy, linear between points). */
export const quantile = (
  values: readonly number[],
  fraction: number
): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * fraction;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

/** Bootstrap by block: draw blocks with replacement until as many as there
 *  are, and hand `stat` the indices of the drawn blocks' members. NaN draws
 *  (too few members to compute) are left out. Returns the percentile
 *  interval at `level`. */
export const blockBootstrapCi = (
  blocks: readonly (readonly number[])[],
  stat: (indices: number[]) => number,
  resamples: number,
  rng: Rng,
  level: number
): [number, number] => {
  const draws: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const indices: number[] = [];
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[Math.floor(rng() * blocks.length)]!;
      for (const i of block) indices.push(i);
    }
    const value = stat(indices);
    if (Number.isFinite(value)) draws.push(value);
  }
  const tail = (1 - level) / 2;
  return [quantile(draws, tail), quantile(draws, 1 - tail)];
};
