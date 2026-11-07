// Set-up for the vault router probe (.specs/vault-router.md → Decisions → 1).
//
// 1. Its Prisma client: the runner's vault.prisma (the server's vault models,
//    schemaGen.ts) generated as CommonJS into probe/generated.
// 2. Its engine folder, probe/engine: PGlite and pglite-prisma-adapter, put
//    in with npm the way vault/engine.ts installs PGlite on a runner. Not a
//    devDependency: adding the adapter to the workspace re-resolved peers
//    across unrelated packages in pnpm-lock.yaml and re-hoisted
//    @prisma/driver-adapter-utils to the adapter's 7.2.0.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PGLITE = '0.4.3'; // VAULT_ENGINE_VERSION in src/vault/engine.ts
const ADAPTER = '0.7.2';

const here = path.dirname(fileURLToPath(import.meta.url));
// Already CommonJS (moduleFormat in schemaGen.ts).
const schema = fs.readFileSync(
  path.join(here, '../../../shared/vault-router/vault.prisma'),
  'utf-8'
);
fs.writeFileSync(path.join(here, 'vault.prisma'), schema);
// The workspace's prisma CLI (the server's, hoisted to the root).
const prismaCli = path.join(here, '../../../node_modules/.bin/prisma');
execFileSync(prismaCli, ['generate', '--schema', path.join(here, 'vault.prisma')], {
  stdio: 'inherit'
});

const engine = path.join(here, 'engine');
fs.mkdirSync(engine, { recursive: true });
fs.writeFileSync(
  path.join(engine, 'package.json'),
  `${JSON.stringify(
    {
      name: 'vault-router-probe-engine',
      private: true,
      dependencies: {
        '@electric-sql/pglite': PGLITE,
        'pglite-prisma-adapter': ADAPTER
      }
    },
    null,
    2
  )}\n`
);
// --legacy-peer-deps: the adapter's peer @prisma/client is the workspace's,
// which the generated client already loads.
execFileSync(
  'npm',
  ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'],
  { cwd: engine, stdio: 'inherit' }
);
