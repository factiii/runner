import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Where the Vault lives, and its database engine (PGlite), which the runner
// package does not carry: adding the Vault part installs it, removing the
// part removes it, and the files stay.
//
// Under `<runner dir>/parts/vault`, not `<runner dir>/vault`: a board's
// folder is `<runner dir>/<slug>`, and a board may be called "vault".

export const VAULT_ENGINE_PACKAGE = '@electric-sql/pglite';
/** Pinned: the version the repo tests against (the lockfile's). */
export const VAULT_ENGINE_VERSION = '0.4.3';

// The shared vault router's Prisma client (.specs/vault-router.md → Decisions
// → 1) goes into the same folder: its runtime, about 70 MB of query compilers
// for every database, from npm; and the vault-only client generated from
// vault.prisma, which the runner package carries as dist/vault-client.js and
// copies in. Not in dist/cli.js, so a runner with no Vault never loads it.
const VAULT_PRISMA_PACKAGE = '@prisma/client';
/** Pinned: the version the client was generated with (the lockfile's). */
const VAULT_PRISMA_VERSION = '7.10.1';
export const VAULT_CLIENT_FILE = 'vault-client.js';

type VaultPaths = { engine: string; db: string; objects: string };

export function vaultPaths(runnerDir: string): VaultPaths {
  const root = path.join(runnerDir, 'parts', 'vault');
  return {
    engine: path.join(root, 'engine'),
    db: path.join(root, 'db'),
    objects: path.join(root, 'objects')
  };
}

const installedVersion = (engineDir: string, name: string): unknown => {
  try {
    return (
      JSON.parse(
        fs.readFileSync(path.join(engineDir, 'node_modules', name, 'package.json'), 'utf-8')
      ) as { version?: unknown }
    ).version;
  } catch {
    return null;
  }
};

/** The pinned engine is in its folder. */
export function engineInstalled(engineDir: string): boolean {
  return installedVersion(engineDir, VAULT_ENGINE_PACKAGE) === VAULT_ENGINE_VERSION;
}

/** The vault client this runner package carries, beside cli.js (build.mjs). */
const packagedClient = (): string => path.join(__dirname, VAULT_CLIENT_FILE);

/** The router's Prisma client is in the engine folder, and it is this
 *  runner's: a runner update that changed vault.prisma copies it again. */
export function routerClientInstalled(engineDir: string): boolean {
  if (installedVersion(engineDir, VAULT_PRISMA_PACKAGE) !== VAULT_PRISMA_VERSION) return false;
  try {
    return fs
      .readFileSync(path.join(engineDir, VAULT_CLIENT_FILE))
      .equals(fs.readFileSync(packagedClient()));
  } catch {
    return false;
  }
}

const npmInstall = (engineDir: string) =>
  new Promise<void>((resolve, reject) => {
    execFile(
      'npm',
      ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: engineDir, timeout: 10 * 60_000 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`npm install failed: ${stderr.trim().split('\n').pop() ?? err.message}`));
        } else {
          resolve();
        }
      }
    );
  });

const writeEngineManifest = (engineDir: string) =>
  // Its own package.json, so npm does not walk up into another project.
  fs.writeFileSync(
    path.join(engineDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'factiii-runner-vault-engine',
        private: true,
        dependencies: {
          [VAULT_ENGINE_PACKAGE]: VAULT_ENGINE_VERSION,
          [VAULT_PRISMA_PACKAGE]: VAULT_PRISMA_VERSION
        }
      },
      null,
      2
    )}\n`
  );

/** Put the router's Prisma client into an engine folder: its runtime from
 *  npm, and the vault client copied from the runner package. */
export async function installRouterClient(
  engineDir: string,
  onLine: (line: string) => void
): Promise<void> {
  if (installedVersion(engineDir, VAULT_PRISMA_PACKAGE) !== VAULT_PRISMA_VERSION) {
    writeEngineManifest(engineDir);
    onLine(`Installing the vault's query client (${VAULT_PRISMA_PACKAGE} ${VAULT_PRISMA_VERSION})…`);
    await npmInstall(engineDir);
  }
  fs.copyFileSync(packagedClient(), path.join(engineDir, VAULT_CLIENT_FILE));
  if (!routerClientInstalled(engineDir)) throw new Error("The vault's query client did not install.");
}

/** `npm install` of the pinned engine into its own folder, scripts off. Pure
 *  JavaScript and WebAssembly: nothing is compiled, and no root is needed. */
export async function installEngine(
  engineDir: string,
  onLine: (line: string) => void
): Promise<void> {
  fs.mkdirSync(engineDir, { recursive: true, mode: 0o700 });
  writeEngineManifest(engineDir);
  onLine(
    `Installing the vault database (${VAULT_ENGINE_PACKAGE} ${VAULT_ENGINE_VERSION}, ${VAULT_PRISMA_PACKAGE} ${VAULT_PRISMA_VERSION})…`
  );
  await npmInstall(engineDir);
  if (!engineInstalled(engineDir)) throw new Error('The vault database did not install.');
  await installRouterClient(engineDir, onLine);
  onLine('The vault database is installed.');
}

/** Remove the engine only. The database and the files are the owner's. */
export function removeEngine(engineDir: string, onLine: (line: string) => void): void {
  fs.rmSync(engineDir, { recursive: true, force: true });
  onLine('Removed the vault database engine. Your vault’s files stay on this machine; add the Vault again to open them.');
}
