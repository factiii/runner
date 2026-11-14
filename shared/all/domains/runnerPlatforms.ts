// Where the runner is supported (.specs/versioning.md "Platforms"; Jon,
// 2026-11-11 q30): runner 1.0 supports macOS. Linux and Windows (WSL2) ship
// the same version but are labelled beta, since they are tested less often.
// Setup, `doctor`, the download page and the release notes say so.

export type RunnerPlatformSupport = 'supported' | 'beta';

/** By Node's `process.platform`. Windows runs the runner in WSL2, which
 *  reports `linux`. */
export function runnerPlatformSupport(platform: string): RunnerPlatformSupport {
  return platform === 'darwin' ? 'supported' : 'beta';
}

/** The one sentence, wherever beta is said. */
export const RUNNER_BETA_NOTE =
  'The runner on Linux and Windows is in beta: it ships the same version as on macOS, but is tested less often.';
