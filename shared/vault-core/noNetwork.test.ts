import assert from 'node:assert/strict';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { build } from 'esbuild';

// vault-core never talks to the network (.specs/runner-vault.md "vault-core",
// SECURITY.md): what the Vault and Runner Cloud hold leaves the machine only
// through the runner's own link, which is not in this package. This bundles
// every vault-core module the way the runner's build does, following
// @shared/* (so the @shared/all files it reaches are checked too), and
// fails on a Node module or a package outside the lists below, or on a call
// to a network API in the code that comes out.

const HERE = __dirname;

/** Node's own modules vault-core may use: files, keys and hashes, no sockets. */
const NODE_ALLOWED = new Set([
  'crypto',
  'fs',
  'path',
  'os',
  'buffer',
  'util',
  'events',
  'stream',
  'zlib',
  'string_decoder'
]);

/** Packages vault-core may reach. None of them opens a connection. */
const PACKAGES_ALLOWED = new Set([
  // Validation, in @shared/all and the router's inputs.
  'zod',
  // The router's procedures; served over the runner's link, by the runner.
  '@trpc/server'
]);

/** Globals that reach the network without an import. */
const NETWORK_CALLS = [
  /\bfetch\s*\(/,
  /\bnew\s+WebSocket\b/,
  /\bXMLHttpRequest\b/,
  /\bnew\s+EventSource\b/,
  /\bsendBeacon\b/,
  /\bprocess\.binding\s*\(/
];

const modules = fs
  .readdirSync(HERE)
  .filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')
  )
  .map((f) => path.join(HERE, f));

const nodeName = (spec: string) =>
  spec.replace(/^node:/, '').split('/')[0] ?? spec;
const packageName = (spec: string) =>
  spec.startsWith('@')
    ? spec.split('/').slice(0, 2).join('/')
    : (spec.split('/')[0] ?? spec);

async function bundle(entryPoints: string[] = modules) {
  const imported = new Set<string>();
  const result = await build({
    entryPoints,
    absWorkingDir: HERE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
    outdir: path.join(HERE, '.no-network-unused'),
    logLevel: 'silent',
    plugins: [
      {
        name: 'record-externals',
        setup(b) {
          // Workspace code (@shared/*, relative paths) is followed; everything
          // else is recorded and left out, as the runner's build leaves npm.
          b.onResolve({ filter: /^[^./]/ }, (args) => {
            if (args.path.startsWith('@shared/')) return undefined;
            imported.add(args.path);
            return { path: args.path, external: true };
          });
          // The router's Prisma client, generated from vault.prisma: it runs
          // on the runner's driver adapter (an IPC pipe to its own database
          // process), never on a socket.
          b.onResolve({ filter: /\/generated\/client$/ }, (args) => ({
            path: args.path,
            external: true
          }));
        }
      }
    ]
  });
  return {
    imported,
    outputs: result.outputFiles.map((file) => ({
      path: file.path,
      text: file.text
    }))
  };
}

/** What a bundle reaches that it may not: imports, then network calls. */
async function refusals(entryPoints?: string[]) {
  const { imported, outputs } = await bundle(entryPoints);
  const imports = [...imported].filter((spec) => {
    const builtin =
      spec.startsWith('node:') || builtinModules.includes(nodeName(spec));
    return builtin
      ? !NODE_ALLOWED.has(nodeName(spec))
      : !PACKAGES_ALLOWED.has(packageName(spec));
  });
  const calls = outputs.flatMap((file) =>
    NETWORK_CALLS.filter((re) => re.test(file.text)).map(
      (re) => `${path.basename(file.path)}: ${re}`
    )
  );
  return { imported, imports, calls };
}

describe('vault-core and the network', () => {
  it('imports no Node module or package that could open a connection, and calls no network API', async () => {
    const { imported, imports, calls } = await refusals();
    assert.ok(
      imported.has('node:crypto'),
      'the bundle did not see vault-core’s own imports'
    );
    assert.deepEqual(
      imports,
      [],
      `vault-core reaches ${imports.join(', ')}: move it out, or add it to the lists with why`
    );
    assert.deepEqual(calls, []);
  });

  it('refuses a module that does (the check itself works)', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'vault-core-no-network-')
    );
    try {
      const file = path.join(dir, 'leak.ts');
      fs.writeFileSync(
        file,
        "import https from 'node:https';\nimport net from 'net';\nexport const leak = () => [https.get, net.connect, fetch('https://example.com')];\n"
      );
      const { imports, calls } = await refusals([file]);
      assert.deepEqual(imports.sort(), ['net', 'node:https']);
      assert.equal(calls.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
