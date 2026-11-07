import { type RouterInputs, type RouterOutputs } from './trpc';

export type Factiii =
  RouterOutputs['factiiis']['factiiiItems']['factiiiList'][number];

export type PinnedFactiii =
  RouterOutputs['spaces']['get']['pinnedFactiiis'][number];

export type SearchFactiii =
  RouterOutputs['search']['factiiis']['factiiis'][number];

export type SearchedUser = RouterOutputs['search']['users']['users'][number];

export type UserFactiiiCount =
  RouterOutputs['users']['factiiisCount']['factiiisCount'][number];

export type AddFactiii = Exclude<
  RouterInputs['factiiis']['tag']['addFactiiis'],
  undefined
>[number];

export type FactiiiTag = Omit<
  RouterOutputs['factiiis']['myFactiiiTags'][number],
  'postFactiiis'
> & {
  isNewFactiii: boolean;
  isRemovedFactiii: boolean;
  isPinnedFactiii: boolean;
  groupId?: number | null;
  // Present when this tag is actually an award "pretending to be a factiii" so
  // it renders through the same card. Holds the award-specific fields.
  award?: {
    image: string | null | undefined;
    cost: number;
    anonymous: boolean;
    count: number;
  };
  postFactiiis: (Omit<
    RouterOutputs['factiiis']['myFactiiiTags'][number]['postFactiiis'][number],
    'photo'
  > & {
    photo?: { uri: string }; // Front end photo holder. not sent to back end yet
    spaceTimes: SpaceTimeTag[];
    error?: boolean;
  })[];
};

export type PostFactiiiReference = Exclude<
  AddFactiii['factiiiReferences'],
  undefined
>[number] & {
  factiii: Pick<Factiii, 'id' | 'avatarKey' | 'name' | 'requirements' | 'slug'>;
};

export type PostFactiii = Exclude<
  RouterOutputs['posts']['singlePost']['posts'][number]['postFactiiisCount'],
  undefined
>[number];

export type SpaceTimeTag = Exclude<
  AddFactiii['spaceTimes'],
  undefined
>[number] & {
  //Added items for front end
  locationValue?: string; // this is needed front end to check if the location is valid
  locationError?: boolean; // this is needed front end to check if the location is valid
  dateTimeError?: boolean; // this is needed front end to check if the date is valid
  deviceVerifiedAt?: Date | null; // read back: the app proved this location (locked in the editor)
  date?: string | ''; // this is needed front end side to convert to UTC
  time?: string | ''; // this is needed front end side to convert to UTC
  timezone?: {
    value: string | '';
    label: string | '';
    offset: number | 0;
  }; // this is needed front end side to convert to UTC
};

const MS_PER_HOUR = 60 * 60 * 1000;

// A timezone's `offset` is in hours east of UTC (react-timezone-select's
// unit, and `-getTimezoneOffset() / 60` everywhere a default is built).

/** The UTC instant of a wall-clock date ("YYYY-MM-DD") and time ("HH:MM") in a zone. */
export const instantOfWallClock = (
  date: string,
  time: string,
  offsetHours: number
): Date => {
  const [hours, minutes] = time.split(':').map(Number);
  const utcDate = new Date(date);
  utcDate.setUTCHours(hours, minutes, 0, 0);
  return new Date(utcDate.getTime() - offsetHours * MS_PER_HOUR);
};

/**
 * The offset, in hours east of UTC, an IANA zone has on a wall-clock date and
 * time, or null when the zone is unknown. A picked zone's `offset` is its
 * offset today, so a date across a daylight-saving change (picked in October
 * for December in America/Chicago) was saved an hour off; this is the offset
 * on the day itself. Reads it twice: once at the wall clock taken as UTC, then
 * at the instant that gives, which settles a time near the change.
 */
export const zoneOffsetHoursOn = (
  zone: string,
  date: string,
  time: string
): number | null => {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return null;
  }
  const offsetAt = (instant: Date): number => {
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(format.formatToParts(instant).find((p) => p.type === type)?.value);
    const shown = Date.UTC(
      part('year'),
      part('month') - 1,
      part('day'),
      part('hour'),
      part('minute')
    );
    return (shown - instant.getTime()) / MS_PER_HOUR;
  };
  const asUtc = instantOfWallClock(date, time, 0);
  if (isNaN(asUtc.getTime())) return null;
  const first = offsetAt(asUtc);
  return offsetAt(new Date(asUtc.getTime() - first * MS_PER_HOUR));
};

/** The wall-clock date ("YYYY-MM-DD") and time ("HH:MM") an instant shows in a zone. */
export const wallClockOf = (
  instant: Date | string,
  offsetHours: number
): { date: string; time: string } => {
  const shifted = new Date(
    new Date(instant).getTime() + offsetHours * MS_PER_HOUR
  );
  const [date, rest] = shifted.toISOString().split('T');
  return { date, time: rest.slice(0, 5) };
};

export type Goal = RouterOutputs['factiiis']['goals']['goals'][number];

export type SearchedGoal = RouterOutputs['search']['goals']['factiiis'][number];

export type NewGoal = Goal & {
  isNew: boolean;
  isValid: boolean;
};

export type UpdateFactiiiPayload = RouterInputs['factiiis']['update'];

/**
 * The platform's own space. Its ROOT factiiis are the seeded set every user's
 * file analyser runs (helpers/seedRootFactiiis.ts), so a root added there would
 * analyse the whole platform's documents. Roots may go in any OTHER space, and
 * then run for that space's members.
 */
export const FACTIII_SPACE_SLUG = 'factiii';

export enum FactiiiRequirement {
  MEDIA_REQUIRED = 'MEDIA_REQUIRED', //Post has to have media
  VIDEO_REQUIRED = 'VIDEO_REQUIRED', //Post has to have a video
  CONTENT_REQUIRED = 'CONTENT_REQUIRED', //post content has to have content inside
  HUMAN_SOURCE = 'HUMAN_SOURCE', //source that is a single human
  GOVERNMENT_SOURCE = 'GOVERNMENT_SOURCE', //source that is a government
  ENTERPRISE_SOURCE = 'ENTERPRISE_SOURCE', //source that is a company or any other enterprise
  ANONYMOUS_SOURCE = 'ANONYMOUS_SOURCE', //source that is anonymous
  WIKI = 'WIKI', //locks content of post to 120 characters
  DATA_REQUIRED = 'DATA_REQUIRED', //PostFactiii content has to have information
  LOCATION_REQUIRED = 'LOCATION_REQUIRED', //PostFactiii has to have location
  TIME_REQUIRED = 'TIME_REQUIRED', //PostFactiii has to have time
  CAMERA = 'CAMERA', //PostFactiii has to have Image
  DISAPPEARING_DATA = 'DISAPPEARING_DATA', // this will keep the post visible until another user adds data to it
  DEVICE_LOCATION = 'DEVICE_LOCATION', //PostFactiii has to have device location,
  NO_POST_DUPLICATES = 'NO_POST_DUPLICATES', //PostFactiii can be cited once on a post
  INTEGER_REQUIRED = 'INTEGER_REQUIRED', // PostFactiii has integer data  value
  POST_REFERENCE_REQUIRED = 'POST_REFERENCE_REQUIRED', // PostFactiii has to have a link to another post
  SOURCE_REQUIRED = 'SOURCE_REQUIRED', // PostFactiii has to have a source
  POSTFACTIII_MODERATION_REQUIRED = 'POSTFACTIII_MODERATION_REQUIRED', // PostFactiii attachments require moderation approval
  APPROXIMATE_LOCATION = 'APPROXIMATE_LOCATION', // Randomizes location by ~0.5 miles when tagged
  MEDIA_MATCH = 'MEDIA_MATCH', // Groups this media with structurally-similar posts (e.g. the same meme) and makes them searchable; allows no other requirements
  LIST = 'LIST', // Renders this factiii as a list/column on a board space
  ROOT = 'ROOT' // Runs against every uploaded file: the description IS the skill, and the other requirements decide what the tag carries
  // POSTFACTIII_REQUIRED = 'POSTFACTIII_REQUIRED' // Requires specific factiii to be present on the post
}

export enum FactiiiStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RETIRED = 'RETIRED',
  DELETED = 'DELETED'
}

export enum FactiiiGoalType {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
  YEARLY = 'YEARLY'
}

export type FactiiiSearchResult =
  RouterOutputs['search']['factiiis']['factiiis'][number];
