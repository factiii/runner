// When a Routine runs next (.todos/routines.md). A routine's schedule is a
// wall-clock time on chosen weekdays in its owner's IANA time zone, so 8:00 in
// New York stays 8:00 across a daylight-saving change. Pure: the server's
// sweep, the router and the clients' "Next run" readout all call it.

/** How far ahead to look for the next chosen weekday: a week and a day, so a
 *  run due later today or the same weekday next week is always found. */
const SEARCH_DAYS = 8;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export const TIME_OF_DAY_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short'
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function wallClock(instant: number, timeZone: string): WallClock {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(instant))) {
    parts[p.type] = p.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday)
  };
}

/** The zone's offset from UTC at `instant`, in ms (New York in winter: -5 h). */
function offsetAt(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return asUtc - Math.floor(instant / MS_PER_MINUTE) * MS_PER_MINUTE;
}

/** The instant a wall-clock time happens in `timeZone`. A time that does not
 *  exist that day (inside a spring-forward gap) lands just after the gap. */
function instantOf(
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const first = guess - offsetAt(guess, timeZone);
  // Read the offset again at the answer: the guess may sit on the other side
  // of a daylight-saving change.
  return guess - offsetAt(first, timeZone);
}

/**
 * The next time strictly after `after` that the schedule fires, or null when
 * no weekday is chosen. `timeOfDay` is "HH:MM", 24-hour.
 */
export function nextRoutineRun(
  schedule: { timeOfDay: string; timezone: string; daysOfWeek: number[] },
  after: Date
): Date | null {
  const days = new Set(schedule.daysOfWeek.filter((d) => d >= 0 && d <= 6));
  if (days.size === 0 || !TIME_OF_DAY_REGEX.test(schedule.timeOfDay)) {
    return null;
  }
  const [hour, minute] = schedule.timeOfDay.split(':').map(Number);
  const start = after.getTime();
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const day = wallClock(start + i * MS_PER_DAY, schedule.timezone);
    if (!days.has(day.weekday)) continue;
    const at = instantOf(
      day.year,
      day.month,
      day.day,
      hour,
      minute,
      schedule.timezone
    );
    if (at > start) return new Date(at);
  }
  return null;
}
