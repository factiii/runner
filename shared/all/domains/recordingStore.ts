import type { AddPlace, OakboxBackend } from '../helpers/oakboxBackend';
import { defaultAddPlace } from '../helpers/oakboxBackend';
import { STORE_MARKS } from '../helpers/vaultSearchMerge';
import type { RunnerStoreName } from './electron';

// Where a screen recording's video and transcript live
// (.specs/screen-recording.md → Where a recording is stored): the standard
// three places of .specs/vault.md, starting on the account's default
// location (`OakboxBackend.defaultLocation`). Pure, for the web, the desktop
// app and the phone alike.
//
// - Cloud: R2, as every recording before; counts against the storage plan.
// - Runner Cloud: the owner's runner; free. The post keeps a reference (the
//   runner and the file's id there) and a small poster frame on Cloud, so it
//   renders while the runner is off.
// - Vault: the owner's runner, owner only (Vault rules 2 and 3): only on a
//   private post, played only over the direct link to the owner.

/** One of the three places, in the order every list names them. */
export type RecordingPlace = AddPlace;

export const RECORDING_PLACES: readonly RecordingPlace[] = [
  'cloud',
  'runner',
  'vault'
];

/** Why a place cannot take this recording, in one line under it. */
export const RECORDING_PLACE_NEEDS_RUNNER =
  'Add your computer in Oakbox, Account > Backend, to keep recordings on it.';
export const RECORDING_VAULT_NEEDS_PRIVATE =
  'Only for a private post: a recording in your Vault is yours alone.';
/** A take that went up to Cloud while it recorded has passed Factiii's
 *  servers, which a Vault recording never does. */
export const RECORDING_VAULT_ALREADY_UPLOADED =
  'This take already went up to Cloud while you recorded. To keep one in your Vault, set your default to Runner Cloud or Vault before recording.';

/** What each place costs or means, under its name. */
export const RECORDING_PLACE_NOTES: Record<RecordingPlace, string> = {
  cloud: 'Counts against your Cloud storage plan.',
  runner:
    'Free. Plays while your computer is on; a poster frame stays on Cloud.',
  vault: 'Free. Only you can watch it, over a direct link to your computer.'
};

export type RecordingPlaceChoice = {
  place: RecordingPlace;
  /** The store's own name (STORE_MARKS): Cloud, Runner Cloud, Vault. */
  label: string;
  note: string;
  /** Why it cannot be picked now; null when it can. */
  disabledReason: string | null;
};

/** The three places for this recording, each with why it cannot be picked
 *  (no computer chosen; the Vault on a post that is not private, or for a
 *  take that went up while it recorded). `uploadedWhileRecording` is the
 *  take's own (whether the recorder had an uploader for it), never the
 *  default as read now: a default read stale at Start, or changed since,
 *  would say otherwise. */
export function recordingPlaceChoices(
  backend: OakboxBackend,
  isPrivate: boolean,
  uploadedWhileRecording: boolean
): RecordingPlaceChoice[] {
  return RECORDING_PLACES.map((place) => {
    let disabledReason: string | null = null;
    if (place !== 'cloud' && backend.runnerId === null)
      disabledReason = RECORDING_PLACE_NEEDS_RUNNER;
    else if (place === 'vault' && !isPrivate)
      disabledReason = RECORDING_VAULT_NEEDS_PRIVATE;
    else if (place === 'vault' && uploadedWhileRecording)
      disabledReason = RECORDING_VAULT_ALREADY_UPLOADED;
    return {
      place,
      label: STORE_MARKS[place].title,
      note: RECORDING_PLACE_NOTES[place],
      disabledReason
    };
  });
}

const allowed = (
  backend: OakboxBackend,
  isPrivate: boolean,
  uploadedWhileRecording: boolean,
  place: RecordingPlace
) =>
  recordingPlaceChoices(backend, isPrivate, uploadedWhileRecording).some(
    (choice) => choice.place === place && choice.disabledReason === null
  );

/**
 * Where the recording goes: the pick when it can be taken, else the default
 * location, else the place nearest it that can: a Vault default on a post
 * made public keeps the take on the computer (Runner Cloud), and a runner
 * place with no computer falls back to Cloud.
 */
export function recordingPlaceFor(
  backend: OakboxBackend,
  picked: RecordingPlace | null,
  isPrivate: boolean,
  uploadedWhileRecording: boolean
): RecordingPlace {
  const can = (place: RecordingPlace) =>
    allowed(backend, isPrivate, uploadedWhileRecording, place);
  if (picked !== null && can(picked)) return picked;
  const fallback: RecordingPlace[] = [defaultAddPlace(backend), 'runner'];
  return fallback.find(can) ?? 'cloud';
}

/** A take kept outside Cloud never goes up while it records: the bytes would
 *  pass Factiii's servers (.specs/screen-recording.md → Upload while
 *  recording, which is Cloud's). Nor does one while the default is not known
 *  (`null`: not read yet, or the read failed): it is held on the device and
 *  goes up whole at Post if Cloud is picked then. */
export const uploadsWhileRecording = (
  backend: OakboxBackend | null
): boolean => backend !== null && defaultAddPlace(backend) === 'cloud';

/** The runner store a place is, or null for Cloud. */
export const runnerStoreOf = (place: RecordingPlace): RunnerStoreName | null =>
  place === 'cloud' ? null : place;

// ── The post's reference to a file on a runner ──

/** How an Upload row names a recording kept on a runner: `uploadSource`
 *  RUNNER (Runner Cloud) or VAULT, and `externalId` `<runnerId>:<fileId>`,
 *  the file's id in that store. */
export type RunnerRecordingRef = {
  runnerId: number;
  store: RunnerStoreName;
  fileId: string;
};

const STORE_OF_SOURCE: Partial<Record<string, RunnerStoreName>> = {
  RUNNER: 'runner',
  VAULT: 'vault'
};

/** Whether an Upload row's file lives on a runner (RUNNER, VAULT): the row's
 *  `key` and its only variant are then the poster frame, not the video. */
export const livesOnRunner = (
  uploadSource: string | null | undefined
): boolean => !!uploadSource && STORE_OF_SOURCE[uploadSource] !== undefined;

/** Why a post holding one is not cross-posted: the other sites fetch the
 *  video by URL from Cloud, which holds only its poster frame. */
export const RUNNER_RECORDING_NOT_CROSSPOSTED =
  'A recording kept on your computer cannot be cross-posted. Keep it on Cloud to share it on other sites.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const runnerRecordingExternalId = (
  ref: Pick<RunnerRecordingRef, 'runnerId' | 'fileId'>
): string => `${ref.runnerId}:${ref.fileId}`;

/** The reference an Upload row holds, or null when it is not on a runner
 *  (or the id is not one this file made). */
export function parseRunnerRecordingRef(
  uploadSource: string | null | undefined,
  externalId: string | null | undefined
): RunnerRecordingRef | null {
  const store = uploadSource ? STORE_OF_SOURCE[uploadSource] : undefined;
  if (!store || !externalId) return null;
  const at = externalId.indexOf(':');
  if (at < 1) return null;
  const runnerId = Number(externalId.slice(0, at));
  const fileId = externalId.slice(at + 1);
  if (!Number.isSafeInteger(runnerId) || runnerId <= 0 || !UUID.test(fileId))
    return null;
  return { runnerId, store, fileId };
}

/** The Upload source a runner store is written as. */
export const uploadSourceOfStore = (
  store: RunnerStoreName
): 'RUNNER' | 'VAULT' => (store === 'vault' ? 'VAULT' : 'RUNNER');

// ── Playback of a recording kept on a runner ──

/** The words a post shows over its poster frame when the video cannot play
 *  (.specs/screen-recording.md → Where a recording is stored). */
export const RUNNER_RECORDING_OFFLINE =
  "This video lives on the poster's computer, which is offline right now.";
export const RUNNER_RECORDING_RETRY = 'Try again';
/** A viewer the runner does not let in: Runner Cloud is served to the owner
 *  and the people they share it with, over the direct link. */
export const RUNNER_RECORDING_DIRECT_ONLY =
  "This video lives on the poster's computer and plays over a direct link to it, which you do not have.";
/** The Vault plays for its owner only, and never on the relay. */
export const VAULT_RECORDING_OWNER_ONLY =
  "This video is in the poster's Vault: only they can watch it.";
export const RUNNER_RECORDING_LOADING = 'Opening the video on the computer…';
/** Saving a take to a computer that is not online for its owner. */
export const RECORDING_RUNNER_OFFLINE =
  'Your computer is offline. Turn it on, or keep the recording on Cloud.';

/** Who is watching a runner's recording, and what they get. */
export type RunnerRecordingAccess = 'direct' | 'refused';

/**
 * Whether this viewer can open the recording over a direct link: the owner
 * always (both stores); a member the owner let into Runner Cloud for a Runner
 * Cloud file (the runner checks again); nobody else, and never the Vault for
 * anyone but its owner.
 */
export function runnerRecordingAccess(
  ref: RunnerRecordingRef,
  viewer: { isOwner: boolean; reachesRunner: boolean }
): RunnerRecordingAccess {
  if (viewer.isOwner) return 'direct';
  if (ref.store === 'vault') return 'refused';
  return viewer.reachesRunner ? 'direct' : 'refused';
}

/**
 * The name a take kept on the owner's runner is stored under, so Oakbox's
 * Organize (its Cloud / Runner tabs) lists each recording apart, the way a
 * scan is named: "Screen recording 2026-11-11 14.32.07.mp4". Local time, not
 * UTC, so an evening take does not carry tomorrow's date; seconds, since two
 * takes a minute apart are common.
 */
export const runnerRecordingName = (
  extension: string,
  now: Date = new Date()
): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return `Screen recording ${stamp}.${extension}`;
};

// ── The poster frame kept on Cloud ──

/** The poster frame's longer side, and its JPEG quality: small enough to be
 *  free in practice, large enough for a feed card. */
export const POSTER_MAX_SIDE = 640;
export const POSTER_JPEG_QUALITY = 0.7;
/** The largest poster the server signs. */
export const POSTER_MAX_BYTES = 300 * 1024;

/** The poster's size for a take of `width` × `height`, never upscaled. */
export function posterSize(
  width: number,
  height: number
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, POSTER_MAX_SIDE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}
