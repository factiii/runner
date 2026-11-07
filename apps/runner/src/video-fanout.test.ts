import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decideScreenUse,
  type ScreenHold
} from '@shared/all/helpers/board-agent-core/screen-holder';

import { sendFrameToHolder, type VideoSink } from './video-fanout';

// One person at a time on the runner's video stream: the runner, not the app,
// keeps frames from everyone but the holder and refuses their input.

type Link = { peer: string };

const sinkFor = (link: Link, open = true) => {
  const sent: Buffer[] = [];
  const sink: VideoSink<Link> = {
    link,
    track: {
      isOpen: () => open,
      sendMessageBinary: (packet) => sent.push(packet)
    },
    // Two packets per frame, so "none" cannot pass by sending a part.
    packetizer: { packetize: (unit) => [unit, unit] }
  };
  return { sink, sent };
};

const FRAME = new Uint8Array([0, 0, 0, 1, 0x65]);

describe('video fan-out', () => {
  it('sends a frame to the holder and none to a second viewer', () => {
    const alice = sinkFor({ peer: 'alice' });
    const bob = sinkFor({ peer: 'bob' });
    const sinks = new Set([alice.sink, bob.sink]);
    assert.equal(sendFrameToHolder(sinks, alice.sink.link, FRAME, 1), true);
    assert.equal(alice.sent.length, 2);
    assert.equal(bob.sent.length, 0);
  });

  it('sends nothing to anyone when nobody holds the stream', () => {
    const alice = sinkFor({ peer: 'alice' });
    const bob = sinkFor({ peer: 'bob' });
    const sinks = new Set([alice.sink, bob.sink]);
    assert.equal(sendFrameToHolder(sinks, null, FRAME, 1), false);
    assert.equal(alice.sent.length + bob.sent.length, 0);
  });

  it('moves the frames with the hold, and stops the first viewer’s', () => {
    const alice = sinkFor({ peer: 'alice' });
    const bob = sinkFor({ peer: 'bob' });
    const sinks = new Set([alice.sink, bob.sink]);
    sendFrameToHolder(sinks, alice.sink.link, FRAME, 1);
    sendFrameToHolder(sinks, bob.sink.link, FRAME, 2);
    sendFrameToHolder(sinks, bob.sink.link, FRAME, 3);
    assert.equal(alice.sent.length, 2);
    assert.equal(bob.sent.length, 4);
  });

  it('treats the same person on a second link as a second viewer', () => {
    const first = sinkFor({ peer: 'alice' });
    const second = sinkFor({ peer: 'alice' });
    const sinks = new Set([first.sink, second.sink]);
    sendFrameToHolder(sinks, first.sink.link, FRAME, 1);
    assert.equal(second.sent.length, 0);
  });

  it('reports no delivery when the holder’s track is closed', () => {
    const alice = sinkFor({ peer: 'alice' }, false);
    const bob = sinkFor({ peer: 'bob' });
    const sinks = new Set([alice.sink, bob.sink]);
    assert.equal(sendFrameToHolder(sinks, alice.sink.link, FRAME, 1), false);
    assert.equal(bob.sent.length, 0);
  });

  it('drops a track that throws and keeps the runner up', () => {
    const alice = sinkFor({ peer: 'alice' });
    alice.sink.track.sendMessageBinary = () => {
      throw new Error('closed');
    };
    const sinks = new Set([alice.sink]);
    assert.equal(sendFrameToHolder(sinks, alice.sink.link, FRAME, 1), false);
    assert.equal(sinks.size, 0);
  });
});

describe('input on the video stream', () => {
  const alice: Link = { peer: 'alice' };
  const bob: Link = { peer: 'bob' };
  const hold: ScreenHold<Link> = {
    link: alice,
    userId: '12',
    name: 'Alice',
    kind: 'simulator',
    spaceSlug: 'alpha'
  };
  const input = (link: Link) =>
    decideScreenUse(hold, {
      link,
      userId: link === alice ? '12' : '13',
      name: link === alice ? 'Alice' : 'Bob',
      spaceSlug: 'alpha',
      use: 'input',
      kind: 'simulator',
      hasVideo: true
    });

  it('refuses a non-holder’s touches and keys', () => {
    const decision = input(bob);
    assert.equal(decision.run, false);
    assert.match(decision.refusal ?? '', /Alice is using the simulator/);
  });

  it('takes the holder’s input', () => {
    assert.equal(input(alice).run, true);
  });
});
