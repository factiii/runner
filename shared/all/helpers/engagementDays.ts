// Local days for viewing data (.specs/analytics.md "Local day"): one helper
// for the device, the runner's Vault and the stats, so a day is the same day
// everywhere. A day is the viewer's calendar day in their IANA zone, never a
// UTC date (`toISOString()`), which put an evening's reading on the next day
// west of Greenwich.

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const HALF_DAY_MS = MS_PER_DAY / 2;
const NOON_UTC_HOUR = 12;
const DAYS_PER_WEEK = 7;
/** ISO 8601: the week holding the year's first Thursday is week 1. */
const ISO_THURSDAY = 4;

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string | undefined): Intl.DateTimeFormat => {
  const key = timeZone ?? '';
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
    formatters.set(key, formatter);
  }
  return formatter;
};

type LocalParts = {
  year: number;
  month: number;
  day: number;
  /** Ms since local midnight. */
  sinceMidnight: number;
};

const localParts = (ms: number, timeZone?: string): LocalParts => {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts['year']!,
    month: parts['month']!,
    day: parts['day']!,
    sinceMidnight:
      (parts['hour']! % 24) * MS_PER_HOUR +
      parts['minute']! * MS_PER_MINUTE +
      parts['second']! * MS_PER_SECOND +
      (((ms % MS_PER_SECOND) + MS_PER_SECOND) % MS_PER_SECOND)
  };
};

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of `ms` in `timeZone` (the device's when absent). */
export const localDayKey = (ms: number, timeZone?: string): string => {
  const { year, month, day } = localParts(ms, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
};

/** The first moment of the local day after the one `ms` is in. Right across
 *  a 23- or 25-hour DST day. */
export const nextLocalMidnight = (ms: number, timeZone?: string): number => {
  const guess = ms - localParts(ms, timeZone).sinceMidnight + MS_PER_DAY;
  const { sinceMidnight } = localParts(guess, timeZone);
  // The guess lands an hour off on a DST day: 23:00 (back to the midnight
  // after it) or 01:00 (back to the one before).
  return sinceMidnight > HALF_DAY_MS
    ? guess + (MS_PER_DAY - sinceMidnight)
    : guess - sinceMidnight;
};

/** An interval's time cut at each local midnight, so a view across midnight
 *  counts on both days. */
export const splitByLocalDay = (
  startedAt: number,
  endedAt: number,
  timeZone?: string
): { dayKey: string; ms: number; endsAt: number }[] => {
  const parts: { dayKey: string; ms: number; endsAt: number }[] = [];
  let from = startedAt;
  while (from < endedAt) {
    const to = Math.min(endedAt, nextLocalMidnight(from, timeZone));
    parts.push({
      dayKey: localDayKey(from, timeZone),
      ms: to - from,
      endsAt: to
    });
    from = to;
  }
  return parts;
};

type DayTotalInterval = {
  factiiiIds: readonly number[];
  factiiiNames: Readonly<Record<string, string>>;
  startedAt: number;
  endedAt: number;
};

/** Seconds per factiii per local day of `intervals`. */
export const factiiiDayTotals = (
  intervals: readonly DayTotalInterval[],
  timeZone?: string
): {
  dayKey: string;
  factiiiId: number;
  factiiiName: string;
  duration: number;
  viewedAt: number;
}[] => {
  const totals = new Map<
    string,
    {
      dayKey: string;
      factiiiId: number;
      factiiiName: string;
      ms: number;
      viewedAt: number;
    }
  >();
  for (const interval of intervals) {
    if (interval.factiiiIds.length === 0) continue;
    for (const part of splitByLocalDay(
      interval.startedAt,
      interval.endedAt,
      timeZone
    )) {
      // The part's last moment, inside its day: a part cut at midnight ends
      // exactly at the next day's first moment, which a chart would bin on
      // the next day.
      const lastMoment = part.endsAt - 1;
      for (const factiiiId of interval.factiiiIds) {
        const key = `${part.dayKey}:${factiiiId}`;
        const current = totals.get(key);
        if (current) {
          current.ms += part.ms;
          current.viewedAt = Math.max(current.viewedAt, lastMoment);
        } else {
          totals.set(key, {
            dayKey: part.dayKey,
            factiiiId,
            factiiiName:
              interval.factiiiNames[String(factiiiId)] ??
              `Factiii ${factiiiId}`,
            ms: part.ms,
            viewedAt: lastMoment
          });
        }
      }
    }
  }
  return [...totals.values()].map(({ ms, ...total }) => ({
    ...total,
    duration: Math.round(ms / MS_PER_SECOND)
  }));
};

// ── Calendar arithmetic on day keys ──

/** Noon UTC of a day key: a stable instant for calendar arithmetic on the
 *  key itself, unaffected by any zone's DST. */
export const dayKeyToUtcNoon = (dayKey: string): number => {
  const [y, m, d] = dayKey.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!, NOON_UTC_HOUR);
};

const utcToDayKey = (ms: number): string => {
  const date = new Date(ms);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** The day key `days` calendar days after `dayKey` (negative for before). */
export const addDays = (dayKey: string, days: number): string =>
  utcToDayKey(dayKeyToUtcNoon(dayKey) + days * MS_PER_DAY);

/** Whole calendar days from `a` to `b`. */
export const daysBetween = (a: string, b: string): number =>
  Math.round((dayKeyToUtcNoon(b) - dayKeyToUtcNoon(a)) / MS_PER_DAY);

/** The ISO week of a day key, as `YYYY-Www` (`2026-W45`). */
export const isoWeekKey = (dayKey: string): string => {
  const date = new Date(dayKeyToUtcNoon(dayKey));
  // Monday = 1 … Sunday = 7
  const weekday = date.getUTCDay() || DAYS_PER_WEEK;
  // The Thursday of this week decides its year.
  date.setUTCDate(date.getUTCDate() + ISO_THURSDAY - weekday);
  const year = date.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1, NOON_UTC_HOUR);
  const week =
    Math.floor((date.getTime() - jan1) / MS_PER_DAY / DAYS_PER_WEEK) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
};
