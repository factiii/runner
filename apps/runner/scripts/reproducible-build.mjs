#!/usr/bin/env node
// Build the runner twice from the same source and check every output is the
// same byte for byte (.specs/runner-vault.md "vault-core"): the release must
// be something anyone can rebuild from the public mirror and compare. Its
// checksums cover what ships (dist/cli.js, which carries vault-core, the
// Vault's database process and the vault router's client) and vault-core on
// its own (every module bundled the way the runner's build reads them), so a
// reviewer can check the open part of the stores without the rest.
//
// Usage (in the monorepo or a mirror, from apps/runner):
//   node scripts/reproducible-build.mjs [runnerDir] [--out <SHA256SUMS>]
// Exits 1 when the two builds differ. The second build is left in dist/.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/** What build.mjs writes, as package.json `files` ships it (maps beside). */
const OUTPUTS = ['dist/cli.js', 'dist/cli.js.map', 'dist/vault-db.js', 'dist/vault-db.js.map', 'dist/vault-client.js'];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** vault-core's modules bundled into one file, npm and Node left out, so its
 *  checksum moves only when vault-core's code (or what it reaches in
 *  @shared/*) does. Paths in it are relative, so any checkout gives the same. */
async function vaultCoreBundle(root) {
  const dir = path.join(root, 'shared', 'vault-core');
  const entry = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
    .map((f) => `export * from './${f.slice(0, -'.ts'.length)}';`)
    .join('\n');
  const result = await build({
    stdin: { contents: entry, resolveDir: dir, sourcefile: 'vault-core.ts', loader: 'ts' },
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'workspace-only',
        setup(b) {
          b.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path.startsWith('@shared/') ? undefined : { path: args.path, external: true }
          );
          b.onResolve({ filter: /\/generated\/client$/ }, (args) => ({ path: args.path, external: true }));
        }
      }
    ]
  });
  return Buffer.from(result.outputFiles[0].contents);
}

async function buildOnce(runnerDir) {
  for (const f of OUTPUTS) fs.rmSync(path.join(runnerDir, f), { force: true });
  execFileSync(process.execPath, ['build.mjs'], { cwd: runnerDir, stdio: 'inherit' });
  const sums = new Map();
  for (const f of OUTPUTS) {
    const file = path.join(runnerDir, f);
    if (!fs.existsSync(file)) throw new Error(`The build wrote no ${f}`);
    sums.set(`apps/runner/${f}`, sha256(fs.readFileSync(file)));
  }
  sums.set('vault-core (bundled alone)', sha256(await vaultCoreBundle(path.resolve(runnerDir, '..', '..'))));
  return sums;
}

async function main() {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const outFile = outAt >= 0 ? args[outAt + 1] : null;
  const positional = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
  const runnerDir = path.resolve(positional[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

  const first = await buildOnce(runnerDir);
  const second = await buildOnce(runnerDir);
  const differ = [...first].filter(([name, sum]) => second.get(name) !== sum).map(([name]) => name);
  const lines = [...second].map(([name, sum]) => `${sum}  ${name}`);
  console.log(lines.join('\n'));
  if (differ.length) {
    console.error(`Not reproducible: two builds of the same source differ in\n  ${differ.join('\n  ')}`);
    process.exit(1);
  }
  if (outFile) fs.writeFileSync(path.resolve(outFile), `${lines.join('\n')}\n`);
  console.log('Reproducible: two builds of the same source are byte-identical.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
