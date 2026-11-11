/** execFile's error as an exit code: 0 without one, its own code when it
 *  has a number, else 1 (a spawn failure such as ENOENT, or a kill). */
export function execExitCode(err: { code?: unknown } | null): number {
  if (!err) return 0;
  return typeof err.code === 'number' ? err.code : 1;
}
