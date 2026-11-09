// A declared secret the store lacks is often there under another name: a deploy
// skill asks for AWS_ADMIN_ACCESS_KEY_ID while the store holds the same
// credential as AWS_ACCESS_KEY_ID, undeclared (link3d, 2026-10-12). Both lists
// look fine on their own; pairing them is what shows the mistake. Used by the
// runner's `factiii-secrets list` and the board's Secrets list, web and mobile.

const tokensOf = (key: string) => key.toUpperCase().split('_').filter(Boolean);

/** Edits to turn one name into the other (insert, delete, replace). */
const editDistance = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[b.length]!;
};

// A typo-sized difference: more than this and two names are different keys.
const MAX_TYPO_EDITS = 2;
// One-word names (TOKEN, KEY) are too generic to pair by their words alone.
const MIN_SHARED_WORDS = 2;

/** How alike two names are, lower is closer; undefined when they are not. */
const closeness = (a: string, b: string): number | undefined => {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const longSet = new Set(long);
  // Every word of one name inside the other: AWS_ACCESS_KEY_ID in
  // AWS_ADMIN_ACCESS_KEY_ID. Ranked by how many words are extra.
  if (short.length >= MIN_SHARED_WORDS && short.every((t) => longSet.has(t))) {
    return long.length - short.length;
  }
  const edits = editDistance(a.toUpperCase(), b.toUpperCase());
  // After every word-subset match, which are the likelier rename.
  return edits <= MAX_TYPO_EDITS ? 10 + edits : undefined;
};

/** The stored-but-undeclared key most like `missing`, if one is close. */
export const similarSecretKey = (
  missing: string,
  candidates: string[]
): string | undefined => {
  let best: { key: string; score: number } | undefined;
  for (const key of candidates) {
    if (key === missing) continue;
    const score = closeness(missing, key);
    if (score === undefined) continue;
    if (!best || score < best.score) best = { key, score };
  }
  return best?.key;
};

/** For each declared key the store lacks, the undeclared stored key it is
 *  probably stored as. Keys with no likely match are left out. */
export const likelyStoredAs = (
  rows: { key: string; stored: boolean; declared: boolean }[]
): Record<string, string> => {
  const undeclared = rows.filter((r) => r.stored && !r.declared).map((r) => r.key);
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.stored || !row.declared) continue;
    const match = similarSecretKey(row.key, undeclared);
    if (match) out[row.key] = match;
  }
  return out;
};
