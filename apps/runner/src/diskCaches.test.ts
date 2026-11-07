import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildCacheBytes,
  cacheItems,
  clearCache,
  type DiskIo,
  diskUse,
  duBytes,
  MIN_CACHE_BYTES,
  diskUseCandidates,
  diskUseLabel
} from './diskCaches';

const GB = 1024 ** 3;

/** A home folder with a pnpm store (v3 and v10), an npm cache, Xcode's
 *  DerivedData and a Tart VM; `run` answers as the tools would. */
function machine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-caches-'));
  const runnerDir = path.join(home, '.factiii-runner');
  const dirs = [
    'Library/pnpm/store/v3',
    'Library/pnpm/store/v10',
    'Library/Developer/Xcode/DerivedData',
    'Library/Caches/Homebrew',
    '.npm/_cacache',
    '.tart/vms/onboard-test',
    '.factiii-runner/factiii-board/builds',
    '.factiii-runner/link3d'
  ];
  for (const d of dirs) fs.mkdirSync(path.join(home, d), { recursive: true });
  const calls: string[] = [];
  const removed: string[] = [];
  const sizes: Record<string, number> = {
    'Library/pnpm/store/v3': 13 * GB,
    'Library/pnpm/store/v10': 5 * GB,
    'Library/Developer/Xcode/DerivedData': 3.5 * GB,
    'Library/Caches/Homebrew': 0.4 * GB,
    '.npm/_cacache': 0.05 * GB
  };
  const io: DiskIo = {
    home,
    runnerDir,
    platform: 'darwin',
    async run(bin, args) {
      calls.push([bin, ...args].join(' '));
      if (bin === 'pnpm') return { code: 0, output: `${home}/Library/pnpm/store/v10\n` };
      if (bin === 'brew') return { code: 0, output: `${home}/Library/Caches/Homebrew\n` };
      // Nothing is running from a cache.
      if (bin === 'pgrep') return { code: 1, output: '' };
      if (bin === 'docker' && args[0] === 'system') {
        return {
          code: 0,
          output: [
            'TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE',
            'Images          20        7         4.562GB   93.72MB (2%)',
            'Build Cache     10        0         498MB     0B'
          ].join('\n')
        };
      }
      return { code: 0, output: '' };
    },
    async size(p) {
      return sizes[path.relative(home, p)] ?? 0;
    },
    remove(p) {
      removed.push(p);
    }
  };
  return { home, runnerDir, io, calls, removed };
}

describe('caches Free up space can clear', () => {
  it('lists each known cache with its size, the pnpm stores by the pnpm that owns them', async () => {
    const { io } = machine();
    const items = await cacheItems(io);
    assert.deepEqual(
      items.map((i) => [i.id, i.path, i.upTo ?? false]),
      [
        ['cache:pnpm-v3', '~/Library/pnpm/store/v3', true],
        ['cache:pnpm-v10', '~/Library/pnpm/store/v10', true],
        ['cache:homebrew', '~/Library/Caches/Homebrew', false],
        ['cache:xcode', '~/Library/Developer/Xcode/DerivedData', false],
        ['cache:containers-build', 'docker builder', false]
      ]
    );
    // The npm cache, under MIN_CACHE_BYTES, is not worth a line.
    assert.ok(items.every((i) => i.kind === 'cache' && i.bytes >= MIN_CACHE_BYTES));
  });

  it('clears by id with the tool’s own command, and Xcode’s one folder', async () => {
    const { io, calls, removed, home } = machine();
    const lines: string[] = [];
    assert.equal(await clearCache(io, 'cache:pnpm-v3', (l) => lines.push(l)), true);
    assert.ok(
      calls.includes(
        `npx -y pnpm@9 store prune --store-dir ${home}/Library/pnpm/store`
      )
    );
    assert.equal(await clearCache(io, 'cache:containers-build', () => {}), true);
    assert.ok(calls.includes('docker builder prune -f'));
    assert.equal(await clearCache(io, 'cache:xcode', () => {}), true);
    assert.deepEqual(removed, [path.join(home, 'Library/Developer/Xcode/DerivedData')]);
    assert.equal(await clearCache(io, 'cache:/etc', (l) => lines.push(l)), false);
    assert.match(lines.at(-1) ?? '', /no longer there/);
  });

  it('leaves a cache a build or a program is using, and clears it once nothing is', async () => {
    const { io, removed, home } = machine();
    fs.mkdirSync(path.join(home, '.npm', '_npx'), { recursive: true });
    const sized: DiskIo = {
      ...io,
      size: async (p) =>
        p.endsWith('_npx') || p.endsWith('DerivedData') ? 2 * GB : io.size(p)
    };
    const patterns: string[] = [];
    let running = true;
    const busy: DiskIo = {
      ...sized,
      run: async (bin, args) => {
        if (bin !== 'pgrep') return sized.run(bin, args);
        patterns.push(args[1]);
        return { code: running ? 0 : 1, output: running ? '27920\n' : '' };
      }
    };
    const lines: string[] = [];
    assert.equal(await clearCache(busy, 'cache:npx', (l) => lines.push(l)), false);
    assert.equal(await clearCache(busy, 'cache:xcode', (l) => lines.push(l)), false);
    assert.deepEqual(lines, [
      'Left npx downloads: something is running from it. Try again when it finishes.',
      'Left Xcode build output (DerivedData): a build is using it. Try again when it finishes.'
    ]);
    assert.deepEqual(removed, []);
    assert.deepEqual(patterns, [
      'eas-cli-local-build-plugin|/\\.npm/_npx/',
      'xcodebuild|eas-cli-local-build-plugin'
    ]);
    running = false;
    assert.equal(await clearCache(busy, 'cache:npx', () => {}), true);
    assert.deepEqual(removed, [path.join(home, '.npm', '_npx')]);
  });

  it('says why a clear failed', async () => {
    const { io } = machine();
    const failing: DiskIo = {
      ...io,
      run: async (bin, args) =>
        bin === 'brew' && args[0] === 'cleanup'
          ? { code: 1, output: 'Error: permission denied\n' }
          : io.run(bin, args)
    };
    const lines: string[] = [];
    assert.equal(await clearCache(failing, 'cache:homebrew', (l) => lines.push(l)), false);
    assert.equal(lines[0], 'Could not clear Homebrew downloads and old versions: Error: permission denied');
  });

  it('reads the build cache size off docker system df', () => {
    assert.equal(buildCacheBytes('Build Cache     10        0         498MB     0B'), 498e6);
    assert.equal(buildCacheBytes('Build Cache  2  0  1.5GB  1.5GB'), 1.5e9);
    assert.equal(buildCacheBytes('Cannot connect to the Docker daemon'), 0);
  });
});

describe('what is using space', () => {
  it('weighs each home folder, Library’s and the runner’s children in their place', () => {
    const { home, runnerDir } = machine();
    const found = diskUseCandidates(home, runnerDir).map((d) => path.relative(home, d)).sort();
    assert.deepEqual(found, [
      '.factiii-runner/factiii-board/builds',
      '.factiii-runner/link3d',
      '.npm',
      '.tart',
      'Library/Caches',
      'Library/Developer',
      'Library/pnpm'
    ]);
    assert.equal(diskUseLabel(home, runnerDir, path.join(home, '.tart')), 'Tart virtual machines');
    assert.equal(diskUseLabel(home, runnerDir, path.join(runnerDir, 'link3d')), 'link3d: folder');
    assert.equal(
      diskUseLabel(home, runnerDir, path.join(runnerDir, 'factiii-board', 'worktrees')),
      'factiii-board: worktrees (one per session)'
    );
    assert.equal(diskUseLabel(home, runnerDir, path.join(home, 'Movies')), 'Movies');
  });

  it('finds du’s total by its path, past the folders it could not read', () => {
    const dir = '/Users/jon/Library';
    const output = [
      '33554432\t/Users/jon/Library',
      'du: /Users/jon/Library/Group Containers/x: Operation not permitted'
    ].join('\n');
    assert.equal(duBytes(output, dir), 33554432 * 1024);
    assert.equal(duBytes('du: cannot read', dir), 0);
  });

  it('lists the biggest first, and leaves out the small', async () => {
    const { io, home } = machine();
    const kb: Record<string, number> = { '.tart': 27 * GB, 'Library/pnpm': 18 * GB, '.npm': 1024 };
    const use = await diskUse({
      ...io,
      run: async (_bin, args) => {
        const dir = args[1];
        return { code: 0, output: `${Math.round((kb[path.relative(home, dir)] ?? 0) / 1024)}\t${dir}\n` };
      }
    });
    assert.deepEqual(
      use.map((u) => [u.label, u.path]),
      [
        ['Tart virtual machines', '~/.tart'],
        ['pnpm stores', '~/Library/pnpm']
      ]
    );
  });
});
