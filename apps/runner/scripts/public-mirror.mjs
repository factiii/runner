#!/usr/bin/env node
// Assemble the public source mirror of @factiii/runner: apps/runner plus ONLY
// the shared files it actually compiles, as a standalone pnpm workspace.
//
// Why: the monorepo is private, so the GitHub advisory for the runner showed
// "No known source code", and users stuck behind npm's malware flag had
// nowhere public to download a release. The runner itself is already public in
// effect (dist/cli.js is an unminified bundle on npm), so this publishes
// nothing new. It just publishes it as readable source.
//
// What goes in is computed, never hand-listed: esbuild resolves every runner
// source file (tests included, so the mirror's test suite runs) and its
// metafile names each shared file reached. A new import ships automatically;
// a shared file the runner never reaches never ships. A denylist and a secret
// scan then refuse the run if anything private slipped through.
//
// Usage (from the repo root):
//   pnpm --filter @factiii/runner exec node scripts/public-mirror.mjs <outDir> [--verify]
// --verify installs the mirror and runs its build and tests in <outDir>.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(RUNNER, '..', '..');

/** Paths that must never reach the mirror, whatever the bundle says. */
const DENY = [
  /^apps\/(?!runner\/)/,
  /^shared\/all\/contentFilter\//,
  /^shared\/all\/crosspost/,
  /^shared\/utils\//,
  /(^|\/)\.env/
];

/** Literal secrets the scan refuses. Test fixtures use obvious fakes. */
const SECRET = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
  /\bsk_live_[A-Za-z0-9]{16,}/,
  /\bxox[abp]-[A-Za-z0-9-]{20,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/
];

/** Runner tests that check the runner against the server itself, so they
 *  only mean something in the monorepo. */
const MONOREPO_ONLY = ['apps/runner/src/vault/schemaGen.test.ts'];

/** The embedder files `bundle:embedder` copies; keep in step with package.json. */
const EMBEDDER = [
  'app.py',
  'clip_tokenizer.py',
  'text_tokenizer.py',
  'convert_text.py',
  'convert_clip.py',
  'requirements.txt'
];

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

const gitFiles = (dir) =>
  execFileSync('git', ['ls-files', '-z', dir], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

/** Every shared file the runner's sources reach, through any import. */
async function sharedFilesReached() {
  const entryPoints = gitFiles('apps/runner')
    .filter((f) => f.startsWith('apps/runner/src/') && f.endsWith('.ts'))
    .map((f) => path.join(ROOT, f));
  const result = await build({
    entryPoints,
    // Metafile paths are relative to this, and read back against ROOT below.
    absWorkingDir: ROOT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
    outdir: path.join(ROOT, '.public-mirror-unused'),
    logLevel: 'silent',
    plugins: [
      {
        // Only workspace sources matter here. Every npm package is left
        // external (the mirror installs those itself); @shared/* is walked.
        name: 'workspace-only',
        setup(b) {
          // esbuild filters are Go regexps (no lookahead), so @shared is
          // let through in the callback.
          b.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path.startsWith('@shared/') ? undefined : { path: args.path, external: true }
          );
          // The vault's Prisma client is generated at install; the mirror
          // regenerates it from vault.prisma, so it is not a source to copy.
          b.onResolve({ filter: /\/generated\/client$/ }, (args) => ({
            path: args.path,
            external: true
          }));
        }
      }
    ]
  });
  return Object.keys(result.metafile.inputs)
    .map((f) => rel(path.resolve(ROOT, f)))
    .filter((f) => f.startsWith('shared/'))
    .sort();
}

function copy(file, out) {
  const dest = path.join(out, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, file), dest);
  // Keep the execute bit git records (plugin/factiii/bin, bin/). The 0.37.0
  // tarball lost it once and every Stop hook failed.
  fs.chmodSync(dest, fs.statSync(path.join(ROOT, file)).mode & 0o777);
}

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

const writeJson = (out, file, value) =>
  fs.writeFileSync(path.join(out, file), `${JSON.stringify(value, null, 2)}\n`);

/** The version this monorepo actually installed, for a `*` range: the mirror
 *  must build with the same compiler (esbuild) the release does. */
const installed = (name) => readJson(`node_modules/${name}/package.json`).version;

/** `catalog:` means nothing outside this workspace; pin what it names. */
function resolveCatalog(deps) {
  const yaml = fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const catalog = Object.fromEntries(
    [...yaml.matchAll(/^\s+"?([@\w./-]+)"?:\s*"?([^"\n#]+?)"?\s*$/gm)].map((m) => [m[1], m[2]])
  );
  return Object.fromEntries(
    Object.entries(deps ?? {}).map(([name, range]) => {
      if (range === '*') return [name, installed(name)];
      if (range !== 'catalog:') return [name, range];
      if (!catalog[name]) throw new Error(`No catalog entry for ${name}`);
      return [name, catalog[name]];
    })
  );
}

/** Subpath exports for exactly the files mirrored under `dir`: `./x` for
 *  x.ts, and `./d` for d/index.ts. Not the original map, which names files
 *  the mirror leaves out. */
function exportsFor(dir, files) {
  const map = {};
  for (const f of files.filter((x) => x.startsWith(`${dir}/`) && x.endsWith('.ts'))) {
    const sub = f.slice(dir.length + 1, -'.ts'.length);
    map[sub === 'index' ? '.' : `./${sub}`] = `./${sub}.ts`;
    if (sub.endsWith('/index')) map[`./${sub.slice(0, -'/index'.length)}`] = `./${sub}.ts`;
  }
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
}

/** A shared package's manifest, cut to what the mirror needs. */
function sharedManifest(dir, files, deps, devDeps) {
  const src = readJson(`${dir}/package.json`);
  return {
    name: src.name,
    version: '0.0.0',
    private: true,
    // Tree-shaking reads this; dropping it changes what the bundle keeps.
    sideEffects: src.sideEffects,
    exports: exportsFor(dir, files),
    dependencies: resolveCatalog(deps),
    devDependencies: { '@configs/typescript': 'workspace:*', ...resolveCatalog(devDeps) }
  };
}

function writeWorkspace(out, version, files) {
  const runner = readJson('apps/runner/package.json');
  runner.dependencies = resolveCatalog(runner.dependencies);
  runner.devDependencies = resolveCatalog(runner.devDependencies);
  writeJson(out, 'apps/runner/package.json', runner);

  const all = readJson('shared/all/package.json');
  writeJson(out, 'shared/all/package.json', sharedManifest('shared/all', files, { zod: all.dependencies.zod }, {}));

  const vault = readJson('shared/vault-router/package.json');
  const vaultManifest = sharedManifest(
    'shared/vault-router',
    files,
    {
      '@prisma/client': vault.dependencies['@prisma/client'],
      '@shared/all': 'workspace:*',
      '@trpc/server': vault.dependencies['@trpc/server'],
      zod: vault.dependencies.zod
    },
    { prisma: vault.devDependencies.prisma }
  );
  vaultManifest.scripts = { postinstall: 'prisma generate --schema vault.prisma' };
  writeJson(out, 'shared/vault-router/package.json', vaultManifest);

  writeJson(out, 'package.json', {
    name: 'factiii-runner-source',
    version,
    private: true,
    packageManager: readJson('package.json').packageManager,
    scripts: {
      build: 'pnpm --filter @factiii/runner build',
      test: 'pnpm --filter @factiii/runner test'
    }
  });
  fs.writeFileSync(
    path.join(out, 'pnpm-workspace.yaml'),
    'packages:\n  - "apps/runner"\n  - "shared/*"\n  - "configs/*"\nonlyBuiltDependencies:\n  - "@prisma/engines"\n  - prisma\n  - esbuild\n  - node-datachannel\n'
  );
  // Hoisted like the monorepo: runner sources import zod through the shared
  // packages without declaring it. The age guard matches the monorepo's.
  fs.writeFileSync(path.join(out, '.npmrc'), 'node-linker=hoisted\nminimum-release-age=10080\n');
  fs.writeFileSync(path.join(out, '.gitignore'), 'node_modules/\ndist/\n*.tgz\n');
  fs.writeFileSync(
    path.join(out, 'README.md'),
    `# @factiii/runner ${version}: source

The source of [\`@factiii/runner\`](https://www.npmjs.com/package/@factiii/runner),
the program that lets you drive AI coding agents on a computer you own from the
Factiii apps (https://factiii.com).

This repository is generated from Factiii's private monorepo on every release.
It holds \`apps/runner\` and exactly the shared files the runner compiles, so
what you read here is what \`dist/cli.js\` is built from. Pull requests are not
merged here; please open an issue instead.

- What the runner can do, and how you control it: [DISCLOSURE](apps/runner/DISCLOSURE)
- Build: \`pnpm install && pnpm build\` (output in \`apps/runner/dist\`)
- Test: \`pnpm test\`
- Release tarballs: see Releases. Install one with \`npm install -g ./factiii-runner-<version>.tgz\`.

Contact: support@factiii.com
`
  );
}

function check(files) {
  const denied = files.filter((f) => DENY.some((re) => re.test(f)));
  if (denied.length) throw new Error(`Refusing private paths:\n  ${denied.join('\n  ')}`);
  const leaks = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'latin1');
    for (const re of SECRET) if (re.test(text)) leaks.push(`${f} (${re})`);
  }
  if (leaks.length) throw new Error(`Refusing files that look like they hold secrets:\n  ${leaks.join('\n  ')}`);
}

async function main() {
  const [outArg, ...flags] = process.argv.slice(2);
  if (!outArg) {
    console.error('usage: public-mirror.mjs <outDir> [--verify]');
    process.exit(2);
  }
  const out = path.resolve(outArg);
  // Only ever clear a directory this script made, never an arbitrary path.
  if (fs.existsSync(out)) {
    const marker = path.join(out, 'apps', 'runner', 'DISCLOSURE');
    // A fresh clone of the empty public repo holds only .git.
    const content = fs.readdirSync(out).filter((entry) => entry !== '.git');
    if (content.length && !fs.existsSync(marker)) {
      throw new Error(`${out} is not empty and is not a previous mirror; refusing to clear it`);
    }
    for (const entry of fs.readdirSync(out)) {
      if (entry !== '.git') fs.rmSync(path.join(out, entry), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(out, { recursive: true });

  const runnerFiles = gitFiles('apps/runner').filter(
    (f) => f !== 'apps/runner/package.json' && !MONOREPO_ONLY.includes(f)
  );
  const shared = (await sharedFilesReached()).filter((f) => !f.endsWith('/package.json'));
  const extra = [
    'shared/vault-router/vault.prisma',
    'shared/vault-router/.gitignore',
    // esbuild reads these: target and class-field semantics. Without them the
    // mirror compiles the shared code differently from the release.
    'shared/all/tsconfig.json',
    'shared/vault-router/tsconfig.json',
    'configs/typescript/package.json',
    'configs/typescript/base.json',
    ...EMBEDDER.map((f) => `services/embedder/${f}`)
  ];
  const files = [...runnerFiles, ...shared, ...extra];
  check(files);
  for (const f of files) copy(f, out);

  const version = readJson('apps/runner/package.json').version;
  writeWorkspace(out, version, files);
  fs.writeFileSync(path.join(out, 'MIRRORED_FILES.txt'), `${files.sort().join('\n')}\n`);

  const count = (prefix) => files.filter((f) => f.startsWith(prefix)).length;
  console.log(
    `Mirror of @factiii/runner ${version} in ${out}: ${count('apps/runner/')} runner files, ` +
      `${count('shared/all/')} from shared/all, ${count('shared/vault-router/')} from shared/vault-router, ` +
      `${count('services/embedder/')} from services/embedder.`
  );

  if (flags.includes('--verify')) {
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: out, stdio: 'inherit' });
    run('pnpm', ['install', '--no-frozen-lockfile']);
    run('pnpm', ['build']);
    run('pnpm', ['test']);
    console.log('Mirror installs, builds and passes its tests.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
