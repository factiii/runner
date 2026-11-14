// How a screen recording is trimmed (.specs/screen-recording.md → Trim): on
// the server for a Cloud recording, on the owner's runner for one kept there
// (Where a recording is stored). Pure: the server's ffmpeg calls are in
// apps/server/src/helpers/trimFfmpeg.ts and its job in helpers/trimUpload.ts,
// the runner's in apps/runner/src/vault/recordingTrim.ts, so this is what the
// tests cover.
//
// Stream copy where it is accurate enough, a re-encode only where it is not:
//
// - A copy can only start on a keyframe. Started from the last keyframe at or
//   before the asked start, it keeps at most the gap between the two, never
//   cuts anything the user kept, takes seconds even on a long take, and leaves
//   the picture bit-identical, H.264 + AAC, so the HLS copy still works.
// - The recorder asks for a keyframe every second (useScreenRecorder), so on
//   Chrome and Edge that gap is under KEYFRAME_TOLERANCE_SECONDS and every trim
//   is a copy.
// - A file with sparse keyframes (a browser that ignores the keyframe option)
//   would keep several seconds the user cut. That one is re-encoded from the
//   exact start: accurate to the frame, at the cost of CPU on the API box
//   (libx264 `veryfast`), which is why it is the exception.
// - The end needs no keyframe: a copy stops on the packet at `endSec`.

/** How far before the asked start a copy may begin and still count as exact. */
export const KEYFRAME_TOLERANCE_SECONDS = 1;

/** A start this close to zero is no start trim: only the end is cut. */
const START_EPSILON_SECONDS = 0.05;

// ffprobe prints pts_time with six decimals. The copy seeks to that exact
// time, so it is passed back with the same precision: rounded to fewer, a
// seek to a keyframe could land just before it and take the previous one.
const TIME_DECIMALS = 6;

export type TrimRange = { startSec: number; endSec: number };

export type TrimPlan = {
  mode: 'copy' | 'encode';
  /** Where the output starts in the source: a keyframe for a copy. */
  fromSec: number;
  /** Where it ends in the source. */
  toSec: number;
};

/**
 * Keyframe times from `ffprobe -show_entries packet=pts_time,flags -of
 * csv=p=0`: one `pts_time,flags` line per packet, `K` in the flags on a
 * keyframe. Lines without a time (`N/A`) are skipped. Sorted ascending.
 */
export const parseKeyframeTimes = (csv: string): number[] =>
  csv
    .split('\n')
    .map((line) => line.trim().split(','))
    .filter(([time, flags]) => time && flags?.includes('K'))
    .map(([time]) => Number(time))
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);

/** Copy from the keyframe at or before the start when it is close enough. */
export const planTrim = (keyframes: number[], trim: TrimRange): TrimPlan => {
  const toSec = trim.endSec;
  if (trim.startSec <= START_EPSILON_SECONDS)
    return { mode: 'copy', fromSec: 0, toSec };
  const keyframe = keyframes.filter((time) => time <= trim.startSec).pop();
  if (
    keyframe !== undefined &&
    trim.startSec - keyframe <= KEYFRAME_TOLERANCE_SECONDS
  )
    return { mode: 'copy', fromSec: keyframe, toSec };
  return { mode: 'encode', fromSec: trim.startSec, toSec };
};

const seconds = (value: number): string => value.toFixed(TIME_DECIMALS);

/**
 * The ffmpeg arguments for a plan. `-ss` before `-i` seeks the input: for a
 * copy that lands on the keyframe named, for an encode it decodes from the
 * keyframe before and drops frames up to the exact time. `-t` is the length
 * kept. First video and first audio only, as the HLS remux maps them.
 */
export const trimArgs = (
  source: string,
  output: string,
  plan: TrimPlan
): string[] => [
  '-v',
  'error',
  '-y',
  '-ss',
  seconds(plan.fromSec),
  '-i',
  source,
  '-t',
  seconds(Math.max(0, plan.toSec - plan.fromSec)),
  '-map',
  '0:v:0',
  '-map',
  '0:a:0?',
  ...(plan.mode === 'copy'
    ? // Timestamps start at zero, so players do not open on a blank frame.
      ['-c', 'copy', '-avoid_negative_ts', 'make_zero']
    : [
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        // What every browser and the mobile player decode.
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k'
      ]),
  // The index at the front: the post's player starts before the whole file is in.
  '-movflags',
  '+faststart',
  output
];

// A copy is disk I/O; an encode runs at roughly real time or better on the
// API box. Both bounds are far past a healthy run, so one that reaches them
// is wedged.
const COPY_TIMEOUT_MS = 5 * 60_000;
const ENCODE_TIMEOUT_PER_SECOND_MS = 3_000;

/** How long ffmpeg may run on this plan before it is killed. */
export const trimTimeoutMs = (plan: TrimPlan): number =>
  plan.mode === 'copy'
    ? COPY_TIMEOUT_MS
    : Math.max(
        COPY_TIMEOUT_MS,
        Math.ceil((plan.toSec - plan.fromSec) * ENCODE_TIMEOUT_PER_SECOND_MS)
      );
