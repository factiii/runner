import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  parseKeyframeTimes,
  planTrim,
  type TrimRange,
  trimArgs,
  trimTimeoutMs
} from '@shared/all/domains/trimPlan';

// A screen recording kept on this runner is trimmed here, not on Factiii's
// server (.specs/screen-recording.md → Where a recording is stored): the same
// plan as the server's (shared/all/domains/trimPlan.ts: a stream copy from the
// keyframe at or before the start, an encode only where the keyframes are
// too sparse), run with the ffmpeg installed on this machine. A runner with
// none refuses the trimmed save before a byte is sent (RUNNER_NO_FFMPEG).

const run = promisify(execFile);

/** ffmpeg and ffprobe, from one folder. */
export type FfmpegTools = { ffmpeg: string; ffprobe: string };

/** Where Homebrew (Apple silicon, Intel) and Linux put them, after PATH: a
 *  launchd service's PATH is short. */
const KNOWN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

/** The ffmpeg this runner can use, or null when it has none. */
export function findFfmpeg(
  env: NodeJS.ProcessEnv = process.env,
  isFile: (file: string) => boolean = (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }
): FfmpegTools | null {
  const dirs = [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...KNOWN_DIRS];
  for (const dir of dirs) {
    const ffmpeg = path.join(dir, 'ffmpeg');
    const ffprobe = path.join(dir, 'ffprobe');
    if (isFile(ffmpeg) && isFile(ffprobe)) return { ffmpeg, ffprobe };
  }
  return null;
}

// Reads packet headers only, no decoding (the server's PROBE_TIMEOUT_MS).
const PROBE_TIMEOUT_MS = 2 * 60_000;
const PROBE_MAX_BUFFER = 64 * 1024 * 1024;

/** Runs one tool and answers its stdout; the tests stand in for it. */
export type RunTool = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const runTool: RunTool = async (file, args, timeoutMs) =>
  (await run(file, args, { timeout: timeoutMs, maxBuffer: PROBE_MAX_BUFFER })).stdout;

/** Cut `trim` out of `source` into `output` (an mp4). */
export async function trimRecordingFile(
  source: string,
  output: string,
  trim: TrimRange,
  tools: FfmpegTools,
  runner: RunTool = runTool
): Promise<void> {
  const csv = await runner(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', source],
    PROBE_TIMEOUT_MS
  );
  const plan = planTrim(parseKeyframeTimes(csv), trim);
  await runner(tools.ffmpeg, trimArgs(source, output, plan), trimTimeoutMs(plan));
}

/** A private folder for one trim, removed by `done` whatever happened. The
 *  take is in the clear there while ffmpeg reads it (an honest limit for a
 *  Vault recording: seconds to minutes, mode 0700, then removed). */
export function trimWorkspace(): { source: string; output: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factiii-recording-'));
  fs.chmodSync(dir, 0o700);
  return {
    source: path.join(dir, 'take.mp4'),
    output: path.join(dir, 'trimmed.mp4'),
    done: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}
