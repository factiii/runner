import type { RepoDefaults } from '../../domains/electron';

// What a repository's own files say about how to install and run it, so the
// board can show sensible defaults without asking (`repoDefaults`). Read from
// the names at the root of the default branch and its package.json. Shown
// only: nothing runs these for the person.

/** A JS package manager, by the lockfile it writes. First match wins. */
const PACKAGE_MANAGERS: { lock: string[]; name: string; run: string }[] = [
  { lock: ['pnpm-lock.yaml'], name: 'pnpm', run: 'pnpm' },
  { lock: ['yarn.lock'], name: 'yarn', run: 'yarn' },
  { lock: ['bun.lockb', 'bun.lock'], name: 'bun', run: 'bun run' },
  { lock: ['package-lock.json'], name: 'npm', run: 'npm run' }
];
const NPM = PACKAGE_MANAGERS[PACKAGE_MANAGERS.length - 1];

/** Everything else, by its marker file. First match wins. */
const OTHER: { file: string; install: string; dev: string }[] = [
  { file: 'Cargo.toml', install: 'cargo build', dev: 'cargo run' },
  { file: 'go.mod', install: 'go mod download', dev: 'go run .' },
  { file: 'Gemfile', install: 'bundle install', dev: '' },
  { file: 'uv.lock', install: 'uv sync', dev: '' },
  { file: 'poetry.lock', install: 'poetry install', dev: '' },
  {
    file: 'requirements.txt',
    install: 'pip install -r requirements.txt',
    dev: ''
  }
];

function scriptsOf(packageJson: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(packageJson ?? '');
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
    return scripts && typeof scripts === 'object'
      ? (scripts as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The install and dev commands for a repository, '' for one it cannot tell.
 * `files` are the names at the root of the default branch; `packageJson` is
 * that file's text when it is there.
 */
export function detectRepoDefaults(
  files: string[],
  packageJson: string | null
): RepoDefaults {
  if (files.includes('package.json')) {
    const pm =
      PACKAGE_MANAGERS.find((m) => m.lock.some((f) => files.includes(f))) ??
      NPM;
    const scripts = scriptsOf(packageJson);
    const script = ['dev', 'start'].find((s) => typeof scripts[s] === 'string');
    return {
      installCommand: `${pm.name} install`,
      devCommand: script ? `${pm.run} ${script}` : ''
    };
  }
  const other = OTHER.find((o) => files.includes(o.file));
  return {
    installCommand: other?.install ?? '',
    devCommand: other?.dev ?? ''
  };
}
