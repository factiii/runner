// The auto schedule for scheduled posts (.specs/scheduled-posts.md): an author
// says how many posts a day and the window of the day they go out in, and
// this turns that into exact times. Pure, so the server that assigns the times
// and the clients that preview them agree.

export const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60 * 1000;

export const MAX_POSTS_PER_DAY = 12;
// A slot nearer than this is skipped: the publish sweep runs once a minute,
// and a post scheduled for "now" should be posted, not scheduled.
export const MIN_LEAD_MINUTES = 2;
// Far more days than any queue needs; only stops a bad rule looping forever.
const MAX_DAYS_AHEAD = 366;

export type PostScheduleRule = {
  postsPerDay: number;
  /** Minutes after local midnight, in `timeZone`. */
  windowStartMinute: number;
  windowEndMinute: number;
  timeZone: string;
};

// One post a day, around 9am, within five minutes: the example on the card
// that asked for this.
export const DEFAULT_POST_SCHEDULE: Omit<PostScheduleRule, 'timeZone'> = {
  postsPerDay: 1,
  windowStartMinute: 9 * 60,
  windowEndMinute: 9 * 60 + 5
};

export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};

type CalendarDay = { year: number; month: number; day: number };

const wallClock = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second')
  };
};

/** How far `timeZone` runs ahead of UTC at that instant, in milliseconds. */
const zoneOffsetMs = (date: Date, timeZone: string): number => {
  const w = wallClock(date, timeZone);
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
};

/** The calendar day it is in `timeZone` at `date`. */
export const localDay = (date: Date, timeZone: string): CalendarDay => {
  const { year, month, day } = wallClock(date, timeZone);
  return { year, month, day };
};

const addDays = (from: CalendarDay, days: number): CalendarDay => {
  const d = new Date(Date.UTC(from.year, from.month - 1, from.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate()
  };
};

const sameDay = (a: CalendarDay, b: CalendarDay) =>
  a.year === b.year && a.month === b.month && a.day === b.day;

/**
 * The instant at which a wall clock in `timeZone` reads `minutes` after
 * midnight on `day`. The offset is looked up twice because the first guess can
 * land on the other side of a daylight-saving change.
 */
export const zonedTimeToUtc = (
  day: CalendarDay,
  minutes: number,
  timeZone: string
): Date => {
  const wall = Date.UTC(day.year, day.month - 1, day.day, 0, minutes);
  const guess = wall - zoneOffsetMs(new Date(wall), timeZone);
  return new Date(wall - zoneOffsetMs(new Date(guess), timeZone));
};

/**
 * The next `count` auto slots after `now`.
 *
 * Each day's window is cut into `postsPerDay` equal parts and one time is
 * picked at random inside each part, so one post a day in a five-minute window
 * lands somewhere in those five minutes, and three a day across a twelve-hour
 * window land about four hours apart. A slot is fixed once picked: the caller
 * stores it, so the author sees the real time.
 *
 * `taken` are times already held by posts this must not move (manually timed
 * ones, or every scheduled post when only the next free slot is wanted). Each
 * counts against its day: it blocks the part of the window it falls in, or the
 * day's last free part when it falls outside the window.
 */
export const computeAutoSlots = ({
  rule,
  now,
  count,
  taken = [],
  random = Math.random
}: {
  rule: PostScheduleRule;
  now: Date;
  count: number;
  taken?: Date[];
  random?: () => number;
}): Date[] => {
  const slots: Date[] = [];
  if (count <= 0) return slots;

  const { postsPerDay, windowStartMinute, windowEndMinute, timeZone } = rule;
  const partMinutes = (windowEndMinute - windowStartMinute) / postsPerDay;
  const earliest = now.getTime() + MIN_LEAD_MINUTES * MS_PER_MINUTE;
  const today = localDay(now, timeZone);

  for (let ahead = 0; ahead < MAX_DAYS_AHEAD && slots.length < count; ahead++) {
    const day = addDays(today, ahead);
    const dayStart = zonedTimeToUtc(day, 0, timeZone).getTime();
    const takenToday = taken.filter((t) => sameDay(localDay(t, timeZone), day));

    let free: number[] = [];
    for (let part = 0; part < postsPerDay; part++) free.push(part);
    let blocked = 0;
    for (const t of takenToday) {
      const minute = (t.getTime() - dayStart) / MS_PER_MINUTE;
      const part = Math.floor((minute - windowStartMinute) / partMinutes);
      if (free.includes(part)) {
        free = free.filter((p) => p !== part);
        blocked += 1;
      }
    }
    // Taken times that fell outside every free part still use up the day.
    const stillToBlock = takenToday.length - blocked;
    if (stillToBlock > 0)
      free = free.slice(0, Math.max(0, free.length - stillToBlock));

    for (const part of free) {
      if (slots.length >= count) break;
      const partStart = zonedTimeToUtc(
        day,
        windowStartMinute + part * partMinutes,
        timeZone
      ).getTime();
      const partEnd = partStart + partMinutes * MS_PER_MINUTE;
      const from = Math.max(partStart, earliest);
      // Less than a minute of the part is left: skip it, don't squeeze in.
      if (partEnd - from < MS_PER_MINUTE) continue;
      const picked = from + random() * (partEnd - from);
      slots.push(new Date(Math.floor(picked / MS_PER_MINUTE) * MS_PER_MINUTE));
    }
  }

  return slots;
};
