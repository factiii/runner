import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RUNNER_FEATURES } from '@shared/all/domains/runnerProtocol';

import { createServerPeer, runnerHello } from './serverPeer';

// .specs/versioning.md "Protocol": the runner turns off what the server it is
// connected to lacks, instead of waiting on an ack that never comes.

describe('the server peer', () => {
  it('uses everything before the server has answered', () => {
    const peer = createServerPeer({ hello: async () => ({}) });
    assert.equal(peer.has('sessionRelay'), true);
    assert.equal(peer.known(), null);
  });

  it('keeps what a current server said', async () => {
    const peer = createServerPeer({
      hello: async () => ({ protocol: 1, features: ['jobStopped', 'later'] })
    });
    await peer.greet();
    assert.deepEqual(peer.known(), ['jobStopped']);
    assert.equal(peer.has('jobStopped'), true);
    assert.equal(peer.has('sessionRelay'), false);
  });

  it('takes a hello with no answer as unknown, not a server from before it, and asks again', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const lines: string[] = [];
    let calls = 0;
    let answer: unknown = new Error('operation has timed out');
    const peer = createServerPeer({
      hello: async () => {
        calls += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      log: (line) => lines.push(line),
      retryMs: 1000
    });
    await peer.greet();
    assert.equal(peer.known(), null);
    // Nothing turned off on a guess, and nothing done that needs "lacks".
    assert.equal(peer.has('sessionRelay'), true);
    assert.equal(peer.lacks('tunnelToken'), false);
    assert.match(lines[0] ?? '', /did not answer/);
    answer = { protocol: 1, features: ['sessionRelay'] };
    t.mock.timers.tick(1000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.deepEqual(peer.known(), ['sessionRelay']);
    assert.equal(peer.lacks('tunnelToken'), true);
  });

  it('lacks a feature only when the server answered without it', async () => {
    const peer = createServerPeer({
      hello: async () => ({ protocol: 1, features: ['tunnelToken'] })
    });
    assert.equal(peer.lacks('tunnelToken'), false);
    await peer.greet();
    assert.equal(peer.lacks('tunnelToken'), false);
    assert.equal(peer.lacks('jobStopped'), true);
    peer.reset();
    assert.equal(peer.lacks('jobStopped'), false);
  });

  it('forgets on a drop, and a late answer from the old connection is dropped', async () => {
    let answer: (value: unknown) => void = () => {};
    const peer = createServerPeer({
      hello: () => new Promise((resolve) => (answer = resolve))
    });
    const greeting = peer.greet();
    peer.reset();
    answer({ protocol: 1, features: [] });
    await greeting;
    assert.equal(peer.known(), null);
    assert.equal(peer.has('sessionRelay'), true);
  });

  it('says every feature this runner has', () => {
    assert.deepEqual(runnerHello('1.0.0'), {
      version: '1.0.0',
      protocol: 1,
      features: [...RUNNER_FEATURES]
    });
  });
});
