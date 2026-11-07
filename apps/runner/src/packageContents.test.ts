import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// What the npm package ships must not look like a credential stealer. npm
// pulled 0.28.0 and 0.33.0 as malware (GHSA-9j83-qj34-g5vc) while the bundled
// embedder/app.py read the `.env` two folders above itself, the monorepo's
// file of server secrets. 0.27.0, without that folder, stayed up.
//
// 0.35.0, with no .env read, was pulled too: a remote shell with screen
// control, tunnels and a login service is what npm's dual-use policy
// (docs.npmjs.com/policies/dual-use) is for. So the package declares itself
// dual-use and ships a DISCLOSURE, and npm rejects a version that drops
// either once one has been published with them.

const RUNNER = path.join(__dirname, '..');
const EMBEDDER_SOURCE = path.join(RUNNER, '..', '..', 'services', 'embedder');

/** The files `bundle:embedder` copies from services/embedder. */
function bundledEmbedderFiles(): string[] {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(RUNNER, 'package.json'), 'utf-8')
  ) as { scripts: Record<string, string> };
  const copy = pkg.scripts['bundle:embedder']?.match(/&& cp (.+?) \.\.\//);
  assert.ok(copy, 'bundle:embedder no longer reads as `cd … && cp <files> ../…`');
  return copy[1].split(/\s+/).map((f) => path.join(EMBEDDER_SOURCE, f));
}

/** The runner's own embedder files, committed beside the copies. */
function ownEmbedderFiles(): string[] {
  const dir = path.join(RUNNER, 'embedder');
  return ['serve.py', 'onnx_backend.py', 'convert_onnx.py']
    .map((f) => path.join(dir, f))
    .filter((f) => fs.existsSync(f));
}

// A dotenv import, or a string naming a .env file. Comments that say ".env"
// in prose are fine: nothing opens them.
const READS_ENV_FILE = /dotenv|['"][^'"\n]*\.env['"]/;

describe('npm package contents', () => {
  it('declares itself dual-use and ships the DISCLOSURE', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(RUNNER, 'package.json'), 'utf-8')
    ) as { contentPolicy?: { class?: string }; files: string[] };
    assert.equal(pkg.contentPolicy?.class, 'dual-use');
    assert.ok(pkg.files.includes('DISCLOSURE'), '"files" leaves DISCLOSURE out');
    const disclosure = fs.readFileSync(path.join(RUNNER, 'DISCLOSURE'), 'utf-8');
    assert.ok(disclosure.trim().length > 0, 'DISCLOSURE is empty');
  });

  it('ships no Python that opens a .env file', () => {
    const files = [...bundledEmbedderFiles(), ...ownEmbedderFiles()];
    assert.ok(files.length > 0);
    for (const file of files.filter((f) => f.endsWith('.py'))) {
      const code = fs.readFileSync(file, 'utf-8');
      assert.doesNotMatch(code, READS_ENV_FILE, path.relative(RUNNER, file));
    }
  });
});
