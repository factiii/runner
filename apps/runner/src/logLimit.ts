import fs from 'node:fs';

// The service log (service.ts) has no end of its own: the service manager
// appends to it for as long as the runner lives. This keeps it to one live
// file and one old one.

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const CHECK_EVERY_MS = 60 * 60 * 1000;

export type LogFiles = {
  /** Null when the file is not there. */
  size(file: string): number | null;
  copy(from: string, to: string): void;
  truncate(file: string): void;
};

const realFiles: LogFiles = {
  size(file) {
    try {
      return fs.statSync(file).size;
    } catch {
      return null;
    }
  },
  copy: (from, to) => fs.copyFileSync(from, to),
  truncate: (file) => fs.truncateSync(file, 0)
};

/**
 * Past the limit, keep the content as `<log>.1` (over any earlier one) and
 * empty the live file. Answers whether it did.
 *
 * Copy, then truncate in place, and never rename: launchd, systemd and the
 * Windows launcher each hold the file open in append mode for the life of the
 * process, so a renamed file would go on taking every line. A line written
 * between the copy and the truncate is lost; that is the price.
 *
 * Never throws. Windows can refuse to truncate a file another process holds,
 * and a log that stays large is better than a runner that stops over it.
 */
export function limitLog(
  log: string,
  files: LogFiles = realFiles,
  maxBytes = MAX_LOG_BYTES
): boolean {
  try {
    const size = files.size(log);
    // No file: a runner started by hand in a terminal has no service log.
    if (size === null || size <= maxBytes) return false;
    files.copy(log, `${log}.1`);
    files.truncate(log);
    return true;
  } catch {
    return false;
  }
}

/** Check now, and hourly after: a runner can stay up for months. */
export function keepLogLimited(log: string): void {
  limitLog(log);
  setInterval(() => limitLog(log), CHECK_EVERY_MS).unref();
}
