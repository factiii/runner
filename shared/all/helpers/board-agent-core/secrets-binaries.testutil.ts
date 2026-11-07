import { spawnSync } from 'child_process';

// The real-sops/age test suites (host-secrets, secrets-run, secrets-inbox,
// inbox-then-job, jobs-cancel, qa-fixes) need the binaries on PATH.
//
// They skip rather than fail by default, because turbo's `build` depends on
// `^test`: the web deploy's builder (Vercel) runs these tests and has no
// reason to have sops or age, and a hard failure there would take an
// unrelated deploy down. A silent skip hid that the secret path went
// untested, though, so a skip now always prints one line that says so, and
// FACTIII_REQUIRE_SECRETS_BINARIES=1 turns it into a failure - set it where
// the secret path must be proven (the runner, a dev machine before a release,
// any CI job that runs these suites).

const REQUIRE_ENV = 'FACTIII_REQUIRE_SECRETS_BINARIES';

/** True when every binary answers `--version`. Otherwise prints one
 *  `SKIPPED` line naming the suite and the missing binaries, or throws when
 *  REQUIRE_ENV=1. */
export function secretsBinariesPresent(
  suite: string,
  bins: readonly string[] = ['sops', 'age-keygen', 'age']
): boolean {
  const missing = bins.filter(
    (bin) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status !== 0
  );
  if (missing.length === 0) return true;
  const what = `${suite}: ${missing.join(', ')} not on PATH`;
  if (process.env[REQUIRE_ENV] === '1') {
    throw new Error(`${what}, and ${REQUIRE_ENV}=1 requires them.`);
  }
  console.warn(
    `SKIPPED ${what} - install them, or set ${REQUIRE_ENV}=1 to fail instead.`
  );
  return false;
}
