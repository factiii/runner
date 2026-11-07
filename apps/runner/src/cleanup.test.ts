import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  cleanableRefusal,
  type CleanupIo,
  planCleanup,
  removeDesktopViewLeftovers,
  runCleanup
} from './cleanup';

// Free up space against a made-up runner folder in a temp dir. The guard is
// the point: vault, secrets and anything the runner did not make are refused
// even when listed by hand or reached through a link.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const old = new Date(NOW - 10 * DAY_MS);

function write(file: string, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A runner folder with a board, its vault and secrets, and a folder
 *  outside it. */
function runnerFolder() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cleanup-'));
  const root = path.join(base, 'runner');
  const at = (...p: string[]) => path.join(root, ...p);
  write(at('board', 'builds', 'old', 'app.js'));
  write(at('board', 'builds', 'new', 'app.js'));
  write(at('board', 'jobs', 'package.json'));
  write(at('board', 'secrets', 'store.enc'));
  write(at('board', 'repo', 'README.md'));
  write(at('parts', 'vault', 'objects', 'vault', '7', 'a', 'photo.jpg'));
  write(at('parts', 'vault', 'db', 'PG_VERSION'));
  write(at('parts', 'vault', 'embedder', 'installed.json'));
  write(at('parts', 'local-ai-model.json'), '{}');
  write(at('logs', 'runner.log.1'));
  write(at('config.json'), '{}');
  write(path.join(base, 'elsewhere', 'mine.txt'));
  // A link in builds that points into the vault.
  fs.symlinkSync(at('parts', 'vault', 'objects'), at('board', 'builds', 'vault-link'));
  for (const p of [
    at('board', 'builds', 'old', 'app.js'),
    at('board', 'builds', 'old'),
    at('board', 'jobs', 'package.json'),
    at('board', 'jobs')
  ]) {
    fs.utimesSync(p, old, old);
  }
  fs.lutimesSync(at('board', 'builds', 'vault-link'), old, old);
  const removed: string[] = [];
  const models: string[] = [];
  const io: CleanupIo = {
    runnerDir: root,
    protectedDirs: [
      at('parts', 'vault', 'objects'),
      at('parts', 'vault', 'db'),
      at('parts', 'vault', 'embedder')
    ],
    now: () => NOW,
    size: async () => 1_000_000,
    remove: (p) => {
      removed.push(path.relative(root, p));
      fs.rmSync(p, { recursive: true, force: true });
    },
    unusedModels: () => [{ id: 'llama3.1:8b', bytes: 4_900_000_000 }],
    removeModel: async (id) => {
      models.push(id);
      return true;
    }
  };
  return { io, at, base, removed, models };
}

describe('the path guard', () => {
  it('passes only what the runner made and can make again', () => {
    const { io, at } = runnerFolder();
    const refusal = (p: string) => cleanableRefusal(io.runnerDir, p, io.protectedDirs);
    assert.equal(refusal(at('board', 'builds', 'old')), null);
    assert.equal(refusal(at('board', 'jobs')), null);
    assert.equal(refusal(at('logs', 'runner.log.1')), null);
    for (const kept of [
      at(),
      at('board'),
      at('board', 'builds'),
      at('board', 'repo'),
      at('config.json'),
      at('parts', 'local-ai-model.json'),
      at('logs')
    ]) {
      assert.notEqual(refusal(kept), null, kept);
    }
  });

  it('refuses the vault, its search models and secrets, even when listed', () => {
    const { io, at, base } = runnerFolder();
    const refusal = (p: string) => cleanableRefusal(io.runnerDir, p, io.protectedDirs);
    assert.equal(refusal(at('parts', 'vault', 'objects')), 'It holds vault or model data.');
    assert.equal(refusal(at('parts', 'vault', 'objects', 'vault', '7', 'a', 'photo.jpg')), 'It holds vault or model data.');
    assert.equal(refusal(at('parts', 'vault', 'db')), 'It holds vault or model data.');
    assert.equal(refusal(at('parts', 'vault', 'embedder')), 'It holds vault or model data.');
    assert.equal(refusal(at('board', 'secrets')), 'It holds vault data, secrets or backups.');
    assert.equal(refusal(at('board', 'secrets', 'store.enc')), 'It holds vault data, secrets or backups.');
    // Through a link in builds.
    assert.equal(refusal(at('board', 'builds', 'vault-link')), 'It holds vault or model data.');
    // Outside the runner folder, and a path that climbs out of it.
    assert.equal(refusal(path.join(base, 'elsewhere')), 'It is outside the runner folder.');
    assert.equal(refusal(at('board', 'builds', '..', '..', '..', 'elsewhere')), 'It is outside the runner folder.');
    // A vault kept inside builds is still the vault.
    write(at('board', 'builds', 'store', 'f.jpg'));
    assert.equal(
      cleanableRefusal(io.runnerDir, at('board', 'builds', 'store'), [at('board', 'builds', 'store')]),
      'It holds vault or model data.'
    );
    // The protected folder inside a candidate refuses the candidate.
    assert.equal(
      cleanableRefusal(io.runnerDir, at('board', 'builds', 'old'), [at('board', 'builds', 'old', 'app.js')]),
      'It holds vault or model data.'
    );
  });
});

describe('free up space', () => {
  it('lists old builds, an idle job checkout, the old log and an unused model, and removes nothing', async () => {
    const { io, removed } = runnerFolder();
    const items = await planCleanup(io);
    assert.deepEqual(
      items.map((i) => i.id),
      ['builds:board/builds/old', 'jobs:board/jobs', 'log:logs/runner.log.1', 'ollama:llama3.1:8b']
    );
    assert.deepEqual(removed, []);
  });

  it('removes only the ids it is given that a fresh plan still lists', async () => {
    const { io, at, removed, models } = runnerFolder();
    const lines: string[] = [];
    const freed = await runCleanup(
      io,
      [
        'builds:board/builds/old',
        'ollama:llama3.1:8b',
        // Forged: never in a plan.
        'builds:parts/vault/objects',
        'builds:board/builds/vault-link',
        'jobs:board/secrets'
      ],
      (l) => lines.push(l)
    );
    assert.deepEqual(removed, [path.join('board', 'builds', 'old')]);
    assert.deepEqual(models, ['llama3.1:8b']);
    assert.equal(freed, 1_000_000 + 4_900_000_000);
    assert.ok(fs.existsSync(at('board', 'jobs')));
    assert.ok(fs.existsSync(at('board', 'builds', 'new')));
    assert.ok(fs.existsSync(at('parts', 'vault', 'objects', 'vault', '7', 'a', 'photo.jpg')));
    assert.ok(fs.existsSync(at('board', 'secrets', 'store.enc')));
    assert.deepEqual(lines, ['Removed board/builds/old (1 MB).']);
  });

  it('lists the tools’ caches after the runner’s own, and clears one only by its id', async () => {
    const { io, removed } = runnerFolder();
    const cleared: string[] = [];
    const withCaches: CleanupIo = {
      ...io,
      caches: async () => [
        { id: 'cache:npm', title: 'npm download cache', path: '~/.npm/_cacache', bytes: 2e9, kind: 'cache' }
      ],
      clearCache: async (id) => {
        cleared.push(id);
        return true;
      }
    };
    const items = await planCleanup(withCaches);
    assert.equal(items.at(-1)?.id, 'cache:npm');
    const freed = await runCleanup(withCaches, ['cache:npm', 'cache:../../etc'], () => {});
    assert.deepEqual(cleared, ['cache:npm']);
    // A cache is never removed by its path.
    assert.deepEqual(removed, []);
    assert.equal(freed, 2e9);
  });
});

describe('the desktop view’s leftovers', () => {
  function withScreenApp(extra?: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-screen-'));
    const app = path.join(root, 'helpers', 'FactiiiScreen.app');
    write(path.join(app, 'Contents', 'MacOS', 'screenhost'));
    write(path.join(app, 'Contents', 'Info.plist'));
    if (extra) write(path.join(root, 'helpers', extra));
    write(path.join(root, 'board', 'repo', 'README.md'));
    const resets: string[] = [];
    const io = {
      runnerDir: root,
      platform: 'darwin' as const,
      resetGrant: (service: string, bundleId: string) => {
        resets.push(`${service} ${bundleId}`);
        return true;
      }
    };
    return { root, app, io, resets };
  }

  it('removes the helper, resets its two switches, and says so', () => {
    const { root, app, io, resets } = withScreenApp();
    const lines = removeDesktopViewLeftovers(io);
    assert.ok(!fs.existsSync(app));
    // The emptied helpers folder goes; the board stays.
    assert.ok(!fs.existsSync(path.join(root, 'helpers')));
    assert.ok(fs.existsSync(path.join(root, 'board', 'repo', 'README.md')));
    assert.deepEqual(resets, [
      'ScreenCapture com.factiii.runner.screen',
      'Accessibility com.factiii.runner.screen'
    ]);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /Removed helpers\/FactiiiScreen\.app/);
  });

  it('does nothing on a second start', () => {
    const { io, resets } = withScreenApp();
    removeDesktopViewLeftovers(io);
    resets.length = 0;
    assert.deepEqual(removeDesktopViewLeftovers(io), []);
    assert.deepEqual(resets, []);
  });

  it('keeps anything else in helpers, and leaves the switches alone off macOS', () => {
    const { root, io, resets } = withScreenApp('other-helper');
    const lines = removeDesktopViewLeftovers({ ...io, platform: 'linux' });
    assert.ok(fs.existsSync(path.join(root, 'helpers', 'other-helper')));
    assert.deepEqual(resets, []);
    assert.equal(lines.length, 1);
  });

  it('logs no reset that tccutil refused', () => {
    const { io } = withScreenApp();
    const lines = removeDesktopViewLeftovers({ ...io, resetGrant: () => false });
    assert.equal(lines.length, 1);
  });
});
