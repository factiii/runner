import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { TRPCError } from '@trpc/server';

import type {
  FileSelection,
  FileTimes,
  RankedPost,
  VaultCaller,
  VaultPorts
} from './ports';
import {
  containsPattern,
  createVaultRouter,
  latestFileIds,
  MEANING_CANDIDATES
} from './router';

// The shared procedures against a fake backend: what each one asks of its
// ports, and what it makes of the answers. The server's own tests run the same
// procedures on Postgres (apps/server/src/tests/vault).

type FakeTypes = {
  fileRow: { id: string; name: string | null; key: string };
  post: { id: string; title: string };
  person: { username: string };
  file: { key: string };
  download: { url: string };
  deleted: { deleted: number; kept: number; matched: number };
};

type Row = FakeTypes['fileRow'] & { userId: number; chunks: number };

/** `actual` cut to the keys `shape` names, at every depth, so a deep equal
 *  checks only those (jest's `toMatchObject`). */
const cut = (actual: unknown, shape: unknown): unknown => {
  if (
    typeof shape !== 'object' ||
    shape === null ||
    Array.isArray(shape) ||
    typeof actual !== 'object' ||
    actual === null
  ) {
    return actual;
  }
  const from = actual as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [key, cut(from[key], value)])
  );
};
const assertMatches = (actual: unknown, shape: object) =>
  assert.deepEqual(cut(actual, shape), shape);

/** The arguments of each call a mock saw. */
const argsOf = (fn: { mock: { calls: { arguments: unknown[] }[] } }) =>
  fn.mock.calls.map((c) => c.arguments);

const ME: VaultCaller = { userId: 1, vaultUsers: [1, 2] };
const at = (iso: string) => new Date(iso);

const row = (id: string, name: string, userId = 1): Row => ({
  id,
  name,
  key: `vault/${id}`,
  userId,
  chunks: 3
});

const fakePorts = (
  overrides: Partial<VaultPorts<FakeTypes>['db']> = {},
  embed: VaultPorts<FakeTypes>['embed'] = {
    queryVector: async () => [0.1, 0.2]
  }
) => {
  const calls: { selection: FileSelection[]; vectors: string[] } = {
    selection: [],
    vectors: []
  };
  const files = [row('a', 'tax/2026.pdf'), row('b', 'notes.txt', 2)];
  const ports: VaultPorts<FakeTypes> = {
    db: {
      anyFile: async () => true,
      fileTimes: async () => [],
      nearestFiles: async () => [],
      fileRows: async (_caller, selection) => {
        calls.selection.push(selection);
        if (selection.kind === 'page') {
          return files.slice(
            selection.offset,
            selection.offset + selection.limit
          );
        }
        return files.filter((file) => selection.ids.includes(file.id));
      },
      skippedFolders: async () => ['tax'],
      recentPosts: async () => [],
      postsMatching: async () => [],
      nearestPosts: async () => [],
      hydratePosts: async () => [],
      findFile: async () => null,
      deleteFiles: async () => ({ deleted: 0, kept: 0, matched: 0 }),
      ...overrides
    },
    objects: {
      signDownload: async (file) => ({ url: `https://r2/${file.key}` })
    },
    embed: {
      queryVector: async (text, userId) => {
        calls.vectors.push(`${userId}:${text}`);
        return embed.queryVector(text, userId);
      }
    },
    people: {
      addedBy: async (caller) => (ownerId) =>
        ownerId === caller.userId ? null : { username: `user${ownerId}` }
    }
  };
  return { ports, calls };
};

const router = createVaultRouter<FakeTypes>();
const call = (ports: VaultPorts<FakeTypes>) =>
  router.createCaller({ caller: ME, ports });

describe('files', () => {
  it('pages the vault, marks skipped folders, names who added a row', async () => {
    const { ports, calls } = fakePorts();
    const res = await call(ports).files({ limit: 2, source: 'ALL' });

    assert.deepEqual(calls.selection, [
      {
        kind: 'page',
        filter: {
          ingestStatus: undefined,
          factiiiId: undefined,
          source: 'ALL',
          query: undefined
        },
        offset: 0,
        limit: 2
      }
    ]);
    assert.deepEqual(res.files, [
      {
        id: 'a',
        name: 'tax/2026.pdf',
        key: 'vault/a',
        addedBy: null,
        skippedBy: 'tax',
        _count: { chunks: 3 },
        distance: null
      },
      {
        id: 'b',
        name: 'notes.txt',
        key: 'vault/b',
        addedBy: { username: 'user2' },
        skippedBy: null,
        _count: { chunks: 3 },
        distance: null
      }
    ]);
    // A full page says there may be more.
    assert.equal(res.nextCursor, 2);
  });

  it('ranks by meaning only when no file has the words', async () => {
    const nearestFiles = mock.fn(async () => [
      { id: 'b', distance: 0.2 },
      { id: 'a', distance: 0.4 }
    ]);
    const { ports, calls } = fakePorts({
      anyFile: async () => false,
      nearestFiles
    });
    const res = await call(ports).files({
      query: 'invoice',
      meaning: true,
      source: 'ALL'
    });

    assert.deepEqual(calls.vectors, ['1:invoice']);
    assert.deepEqual(argsOf(nearestFiles), [
      [ME, [0.1, 0.2], MEANING_CANDIDATES]
    ]);
    // The scope is re-applied without the words, to the ranked ids.
    assertMatches(calls.selection[0], {
      kind: 'idsWithin',
      ids: ['b', 'a'],
      filter: { source: 'ALL', query: undefined }
    });
    assert.deepEqual(
      res.files.map((f) => [f.id, f.distance]),
      [
        ['b', 0.2],
        ['a', 0.4]
      ]
    );
    // A meaning page is the only page.
    assert.equal(res.nextCursor, undefined);
  });

  it('keeps the words-only answer when the embedder fails', async () => {
    const { ports, calls } = fakePorts(
      { anyFile: async () => false },
      {
        queryVector: async () => {
          throw new Error('embedder down');
        }
      }
    );
    const res = await call(ports).files({ query: 'invoice', meaning: true });
    assertMatches(calls.selection[0], { kind: 'page' });
    assert.equal(
      res.files.every((f) => f.distance === null),
      true
    );
  });

  it("orders 'latest' by the later of added, categorized and rewritten", async () => {
    const times: FileTimes[] = [
      {
        id: 'a',
        createdAt: at('2026-01-01'),
        ontologyAt: null,
        postUpdatedAt: null
      },
      {
        id: 'b',
        createdAt: at('2025-01-01'),
        ontologyAt: at('2026-06-01'),
        postUpdatedAt: null
      }
    ];
    const { ports, calls } = fakePorts({ fileTimes: async () => times });
    const res = await call(ports).files({ order: 'latest' });
    assert.deepEqual(calls.selection[0], { kind: 'ids', ids: ['b', 'a'] });
    assert.deepEqual(
      res.files.map((f) => f.id),
      ['b', 'a']
    );
  });
});

describe('latestFileIds', () => {
  it('breaks ties by id and pages', () => {
    const same = at('2026-01-01');
    const times = ['c', 'a', 'b'].map((id) => ({
      id,
      createdAt: same,
      ontologyAt: null,
      postUpdatedAt: null
    }));
    assert.deepEqual(latestFileIds(times, 0, 2), ['a', 'b']);
    assert.deepEqual(latestFileIds(times, 2, 2), ['c']);
  });
});

describe('search', () => {
  const ranked: RankedPost[] = [
    { postId: 7, uuid: 'p7' },
    { postId: 3, uuid: 'p3' }
  ];
  // The loader answers in its own order; the router puts rank back.
  const hydratePosts = async () => [
    { id: 'p3', title: 'three' },
    { id: 'p7', title: 'seven' }
  ];

  it('lists the newest posts for no query, without embedding', async () => {
    const { ports, calls } = fakePorts({
      recentPosts: async () => ranked,
      hydratePosts
    });
    const res = await call(ports).search({ limit: 2 });
    assert.deepEqual(
      res.posts.map((p) => p.id),
      ['p7', 'p3']
    );
    assert.equal(res.nextCursor, 2);
    assert.deepEqual(calls.vectors, []);
  });

  it('answers a verbatim hit directly, escaping LIKE wildcards', async () => {
    const postsMatching = mock.fn(async () => ranked);
    const { ports, calls } = fakePorts({ postsMatching, hydratePosts });
    const res = await call(ports).search({ query: '50%_off' });
    assert.deepEqual(argsOf(postsMatching), [
      [ME, '%50\\%\\_off%', { offset: 0, limit: 12 }]
    ]);
    assert.deepEqual(
      res.posts.map((p) => p.id),
      ['p7', 'p3']
    );
    assert.equal(res.nextCursor, undefined);
    assert.deepEqual(calls.vectors, []);
  });

  it('falls back to meaning on an empty first page only', async () => {
    const nearestPosts = mock.fn(async () => ranked);
    const { ports, calls } = fakePorts({ nearestPosts, hydratePosts });
    const first = await call(ports).search({ query: 'lease' });
    assert.equal(nearestPosts.mock.callCount(), 1);
    assert.deepEqual(calls.vectors, ['1:lease']);
    assert.equal(first.posts.length, 2);

    // Scrolling never appends meaning under words.
    const later = await call(ports).search({ query: 'lease', cursor: 12 });
    assert.equal(nearestPosts.mock.callCount(), 1);
    assert.deepEqual(later.posts, []);
  });
});

describe('containsPattern', () => {
  it('escapes backslash, percent and underscore', () => {
    assert.equal(containsPattern('a\\b%c_d'), '%a\\\\b\\%c\\_d%');
  });
});

describe('downloadUrl', () => {
  it('signs a file the vault holds', async () => {
    const { ports } = fakePorts({ findFile: async () => ({ key: 'k1' }) });
    assert.deepEqual(await call(ports).downloadUrl({ uploadId: 'u1' }), {
      url: 'https://r2/k1'
    });
  });

  it('is NOT_FOUND for a file outside the vault', async () => {
    const { ports } = fakePorts();
    const error = await call(ports)
      .downloadUrl({ uploadId: 'u1' })
      .catch((e: unknown) => e);
    assert.ok(error instanceof TRPCError);
    assertMatches(error, {
      code: 'NOT_FOUND',
      message: 'File not found'
    });
  });
});

describe('deleteFiles', () => {
  it('passes the target through for the caller', async () => {
    const deleteFiles = mock.fn(async () => ({
      deleted: 0,
      kept: 0,
      matched: 4
    }));
    const { ports } = fakePorts({ deleteFiles });
    const res = await call(ports).deleteFiles({
      folder: ['tax'],
      dryRun: true
    });
    assert.deepEqual(argsOf(deleteFiles), [
      [ME, { uploadIds: undefined, folder: ['tax'], dryRun: true }]
    ]);
    assert.equal(res.matched, 4);
  });

  it('refuses neither or both of files and folder', async () => {
    const { ports } = fakePorts();
    await assert.rejects(call(ports).deleteFiles({}), (error: unknown) => {
      assertMatches(error, { code: 'BAD_REQUEST' });
      return true;
    });
  });
});
