// A date read off a document is a calendar day, not a moment: `new Date(
// '2026-10-06')` is midnight UTC, which a reader west of Greenwich sees as the
// 5th. So it is stored as written, in UTC fields, with any offset ignored. A
// bare day goes in at noon, which keeps it on its day from UTC−11 to UTC+11 for
// screens that show local time; Oakbox shows tag dates in UTC (tagDetails).

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

const NOON = 12;

const utc = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): Date | null => {
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  // Date.UTC rolls an impossible day over ("2026-02-31" → March 3); refuse it.
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month &&
    date.getUTCDate() === day
    ? date
    : null;
};

/** The date a model read off a document, or null when it is not one. */
export const parseDocumentDate = (value: string): Date | null => {
  const text = value.trim();
  const iso = ISO.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, s] = iso;
    return utc(
      Number(y),
      Number(mo) - 1,
      Number(d),
      h === undefined ? NOON : Number(h),
      mi === undefined ? 0 : Number(mi),
      s === undefined ? 0 : Number(s)
    );
  }

  // Anything else ("14 August 2026") is parsed the only way JavaScript can, in
  // the machine's zone, and its fields read back in that same zone — so the day
  // written is the day stored, whatever zone the server or runner runs in.
  const loose = new Date(text);
  if (Number.isNaN(loose.getTime())) return null;
  const hasTime = loose.getHours() !== 0 || loose.getMinutes() !== 0;
  return utc(
    loose.getFullYear(),
    loose.getMonth(),
    loose.getDate(),
    hasTime ? loose.getHours() : NOON,
    hasTime ? loose.getMinutes() : 0,
    0
  );
};
