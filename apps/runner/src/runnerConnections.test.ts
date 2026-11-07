import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunnerService } from '@shared/all/domains/electron';

import {
  allowedService,
  clampLogLines,
  createRunnerConnections,
  type ConnectionsDeps,
  lastLines,
  LOG_LINES_DEFAULT,
  LOG_LINES_MAX,
  personOf,
  startedByOther,
  stripTerminalControls
} from './runnerConnections';
import { LineRing } from './vault/embedder';

const svc = (kind: RunnerService['kind'], name: string, ports: number[] = []): RunnerService => ({
  kind,
  name,
  detail: '',
  running: true,
  ports
});

describe('clampLogLines', () => {
  it('defaults when absent or not a number', () => {
    assert.equal(clampLogLines(undefined), LOG_LINES_DEFAULT);
    assert.equal(clampLogLines('50'), LOG_LINES_DEFAULT);
    assert.equal(clampLogLines(Number.NaN), LOG_LINES_DEFAULT);
    assert.equal(clampLogLines(Number.POSITIVE_INFINITY), LOG_LINES_DEFAULT);
  });
  it('keeps it in 1..2000, whole', () => {
    assert.equal(clampLogLines(0), 1);
    assert.equal(clampLogLines(-5), 1);
    assert.equal(clampLogLines(12.9), 12);
    assert.equal(clampLogLines(99_999), LOG_LINES_MAX);
  });
});

describe('allowedService', () => {
  const list = [svc('pm2', 'embedder'), svc('docker', 'postgres'), svc('launchd', 'com.factiii.runner')];
  it('finds a service by kind and name as listed now', () => {
    assert.equal(allowedService(list, 'pm2', 'embedder')?.name, 'embedder');
    assert.equal(allowedService(list, 'launchd', 'com.factiii.runner')?.kind, 'launchd');
  });
  it('refuses a name of another kind, or not listed', () => {
    assert.equal(allowedService(list, 'docker', 'embedder'), null);
    assert.equal(allowedService(list, 'pm2', 'redis'), null);
  });
  it('never passes a flag or a path, even when listed', () => {
    const odd = [svc('pm2', '--help'), svc('launchd', '../evil'), svc('docker', '')];
    assert.equal(allowedService(odd, 'pm2', '--help'), null);
    assert.equal(allowedService(odd, 'launchd', '../evil'), null);
    assert.equal(allowedService(odd, 'docker', ''), null);
  });
});

describe('stripTerminalControls', () => {
  it('drops colours, cursor moves and titles, keeps the text', () => {
    assert.equal(stripTerminalControls('\x1b[31mred\x1b[0m done'), 'red done');
    assert.equal(stripTerminalControls('\x1b]0;title\x07hi'), 'hi');
    assert.equal(stripTerminalControls('\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\'), 'link');
    assert.equal(stripTerminalControls('a\x1b[2K\x1b[1Gb'), 'ab');
  });
  it('keeps what a carriage return wrote last, and tabs and newlines', () => {
    assert.equal(stripTerminalControls('10%\r50%\r100%\nnext\r\n'), '100%\nnext\n');
    assert.equal(stripTerminalControls('a\tb\x07\x00c'), 'a\tbc');
  });
});

describe('lastLines', () => {
  it('takes the last lines after the trailing blank ones', () => {
    assert.equal(lastLines('1\n2\n3\n\n  \n', 2), '2\n3');
    assert.equal(lastLines('', 5), '');
  });
});

describe('people and starters', () => {
  it('names a person, with a numeric id or none', () => {
    assert.deepEqual(personOf({ userId: '42', name: 'Sam', role: 'member' }), {
      userId: 42,
      name: 'Sam',
      role: 'member'
    });
    assert.deepEqual(personOf({ userId: '', name: '', role: 'owner' }), {
      userId: null,
      name: 'Owner',
      role: 'owner'
    });
  });
  it('counts a member’s session as someone else’s, and an unrecorded one as the owner’s', () => {
    assert.equal(startedByOther(undefined, '1'), false);
    assert.equal(startedByOther({ userId: '1', name: 'Jon', role: 'owner' }, '1'), false);
    assert.equal(startedByOther({ userId: '', name: 'Owner', role: 'owner' }, '1'), false);
    assert.equal(startedByOther({ userId: '2', name: 'Sam', role: 'member' }, '1'), true);
  });
});

describe('LineRing', () => {
  it('keeps the last lines, the unfinished one included', () => {
    const ring = new LineRing(3);
    ring.write('a\nb\nc');
    ring.write('c\nd\ne\n');
    assert.deepEqual(ring.tail(10), ['cc', 'd', 'e']);
    ring.write('partial');
    ring.note('--- stopped');
    assert.deepEqual(ring.tail(2), ['partial', '--- stopped']);
  });
});

function deps(over: Partial<ConnectionsDeps> = {}): ConnectionsDeps {
  return {
    ownerUserId: '1',
    links: () => [
      {
        id: 'a',
        scope: { role: 'owner', userId: '1', name: 'Jon' },
        transport: 'webrtc',
        connectedAt: 10,
        terminals: 2
      },
      {
        id: 'b',
        scope: { role: 'member', userId: '2', name: 'Sam', spaceSlugs: ['acme'] },
        transport: 'socket',
        connectedAt: 20,
        terminals: 0
      }
    ],
    boards: () =>
      new Map([
        [
          'acme',
          {
            terminalSessions: () => [
              {
                summary: { postId: 'p1', taskTitle: 'Mine', startedAt: 1, exposed: [] },
                startedBy: undefined
              },
              {
                summary: {
                  postId: 'p2',
                  taskTitle: 'Theirs',
                  startedAt: 2,
                  exposed: [{ name: 'web', port: 3000, url: 'https://x.example' }]
                },
                startedBy: { userId: '2', name: 'Sam', role: 'member' as const }
              }
            ],
            captureTerminalTab: async (postId: string, tabId: string | undefined) =>
              postId === 'p2' ? { tabId: tabId ?? '0', text: '\x1b[32m$ ls\x1b[0m\nfile\n\n' } : null
          }
        ]
      ]).entries(),
    embedder: {
      state: () => 'ready',
      process: () => ({ running: true, port: 5555 }),
      logTail: () => []
    },
    vaultIngest: async () => ({
      pending: 3,
      embedded: 9,
      failed: 1,
      running: true,
      current: 'a.pdf',
      embedder: 'ready'
    }),
    services: async () => [svc('pm2', 'embedder'), svc('port', 'node', [3000])],
    run: async () => ({ code: 0, output: 'line1\nline2\n' }),
    now: () => 99,
    ...over
  };
}

describe('createRunnerConnections', () => {
  it('lists links, others’ terminals, the embedder, services and public links', async () => {
    const view = await createRunnerConnections(deps()).connections('b');
    assert.deepEqual(
      view.links.map((l) => [l.id, l.transport, l.boards, l.you, l.terminals, l.userId]),
      [
        ['a', 'direct', null, false, 2, 1],
        ['b', 'socket', ['acme'], true, 0, 2]
      ]
    );
    assert.deepEqual(
      view.remoteSessions.map((s) => [s.postId, s.startedBy.name, s.exposed.length]),
      [['p2', 'Sam', 1]]
    );
    assert.deepEqual(view.exposed, [
      { name: 'web', port: 3000, url: 'https://x.example', postId: 'p2', spaceSlug: 'acme', title: 'Theirs' }
    ]);
    assert.deepEqual(view.embedder, {
      state: 'ready',
      running: true,
      port: 5555,
      pending: 3,
      embedded: 9,
      failed: 1,
      current: 'a.pdf'
    });
    assert.equal(view.services.length, 2);
    assert.equal(view.at, 99);
  });

  it('has no embedder without a Vault', async () => {
    const view = await createRunnerConnections(deps({ vaultIngest: async () => null })).connections('a');
    assert.equal(view.embedder, null);
  });

  it('reads a listed pm2 service’s log with its args, never a shell', async () => {
    const calls: [string, string[]][] = [];
    const host = createRunnerConnections(
      deps({
        run: async (bin, args) => {
          calls.push([bin, args]);
          return { code: 0, output: 'one\ntwo\n' };
        }
      })
    );
    const tail = await host.logs({ source: { kind: 'service', service: 'pm2', name: 'embedder' }, lines: 1 });
    assert.deepEqual(calls, [['pm2', ['logs', 'embedder', '--lines', '1', '--nostream', '--raw']]]);
    assert.equal(tail.text, 'two');
    assert.equal(tail.label, 'pm2 logs embedder');
  });

  it('refuses a service it does not list', async () => {
    await assert.rejects(
      createRunnerConnections(deps()).logs({ source: { kind: 'service', service: 'docker', name: 'x; rm -rf /' } }),
      /not among this runner's services/
    );
  });

  it('says a bare listening port has no log', async () => {
    const tail = await createRunnerConnections(deps()).logs({
      source: { kind: 'service', service: 'port', name: 'node' }
    });
    assert.equal(tail.text, '');
    assert.match(tail.note ?? '', /terminal/);
  });

  it('captures a terminal tab, escapes stripped', async () => {
    const host = createRunnerConnections(deps());
    const tail = await host.logs({ source: { kind: 'session', spaceSlug: 'acme', postId: 'p2' } });
    assert.equal(tail.text, '$ ls\nfile');
    assert.equal(tail.label, 'Theirs · tab 0');
    const gone = await host.logs({ source: { kind: 'session', spaceSlug: 'acme', postId: 'p9' } });
    assert.equal(gone.text, '');
    assert.ok(gone.note);
  });

  it('notes an embedder that has printed nothing', async () => {
    const tail = await createRunnerConnections(deps()).logs({ source: { kind: 'embedder' } });
    assert.equal(tail.text, '');
    assert.ok(tail.note);
  });
});
