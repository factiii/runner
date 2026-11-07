import { build } from 'esbuild';
import { writeFileSync, readFileSync } from 'fs';

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/cli.js',
  format: 'cjs',
  // node-datachannel: prebuilt native; pulls in optional
  // cpu-features native bindings that esbuild can't follow. Both stay as runtime
  // requires.
  external: ['node-datachannel'],
  sourcemap: true
});

// The Vault's database process (src/vault/db.ts forks it beside cli.js). Its
// engine, PGlite, is installed by the Vault part, never bundled.
await build({
  entryPoints: ['src/vault/dbChild.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/vault-db.js',
  format: 'cjs',
  sourcemap: true
});

// The shared vault router's Prisma client (src/vault/vaultRouter.ts), generated
// from shared/vault-router/vault.prisma. Its runtime stays external: adding the
// Vault part installs @prisma/client into the engine folder and copies this
// file beside it (src/vault/engine.ts), so it resolves the runtime from there
// and cli.js never carries the client.
await build({
  entryPoints: ['../../shared/vault-router/generated/client.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/vault-client.js',
  format: 'cjs',
  external: ['@prisma/client', '@prisma/client/*']
});

// Prepend shebang (esbuild banner + CJS source shebang caused duplicates, so we add it after)
const content = readFileSync('dist/cli.js', 'utf-8');
writeFileSync('dist/cli.js', '#!/usr/bin/env node\n' + content);
