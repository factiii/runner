import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HypervisorSession } from '@shared/all/helpers/board-agent-core/session-hypervisor';
import type { ChatEvent } from '@shared/all/helpers/terminal-ai/chatTranscript';

import { sessionAnswer, watchRoutineSession } from './routineWatch';

type State = HypervisorSession['state'] | null;

const user = (text: string): ChatEvent => ({ type: 'user', id: 'u', text, time: '' });
const said = (text: string): ChatEvent => ({ type: 'assistant', id: 'a', text, time: '' });
const tool: ChatEvent = { type: 'tool', id: 't', toolId: 't', name: 'Bash', summary: 'ls', time: '' };

/** A session that goes through `states`, one per look, holding the last;
 *  `events` is what its transcript holds at each look. */
function fake(states: State[], events: ChatEvent[][]) {
  let look = 0;
  let clock = 0;
  return {
    looks: () => look,
    deps: {
      state: () => states[Math.min(look, states.length - 1)] ?? null,
      transcript: async () => events[Math.min(look, events.length - 1)] ?? [],
      sleep: async (ms: number) => {
        look += 1;
        clock += ms;
      },
      now: () => clock
    }
  };
}

describe('sessionAnswer', () => {
  it('is what the session said after the prompt, tool calls left out', () => {
    assert.equal(
      sessionAnswer([user('Check the build.'), said('Looking.'), tool, said('Build is green.')]),
      'Looking.\n\nBuild is green.'
    );
  });

  it('is empty before the session answers', () => {
    assert.equal(sessionAnswer([]), '');
    assert.equal(sessionAnswer([user('Check the build.'), tool]), '');
  });
});

describe('watchRoutineSession', () => {
  it('waits out the start, then reports the answer once the session is idle', async () => {
    const prompt = user('Check the build.');
    const s = fake(
      ['starting', 'idle', 'working', 'idle'],
      [[], [], [prompt], [prompt, said('Build is green.')]]
    );

    const result = await watchRoutineSession(s.deps, { pollMs: 1 });

    assert.deepEqual(result, { status: 'DONE', output: 'Build is green.' });
    assert.equal(s.looks(), 3);
  });

  it('keeps an answer from a session that was ended after it answered', async () => {
    const s = fake([null], [[user('Hi'), said('Done.')]]);
    assert.deepEqual(await watchRoutineSession(s.deps), { status: 'DONE', output: 'Done.' });
  });

  it('fails a session that ended without answering', async () => {
    const s = fake([null], [[user('Hi')]]);
    assert.equal((await watchRoutineSession(s.deps)).status, 'FAILED');
  });

  it('fails a session that stopped with an error', async () => {
    const s = fake(['error'], [[]]);
    assert.deepEqual(await watchRoutineSession(s.deps), {
      status: 'FAILED',
      output: undefined,
      error: 'The session stopped with an error.'
    });
  });

  it('gives up on a session still waiting for a permission, and says so', async () => {
    const s = fake(['needs you'], [[user('Post it.'), said('May I run this?')]]);

    const result = await watchRoutineSession(s.deps, { pollMs: 10, timeoutMs: 100 });

    assert.equal(result.status, 'FAILED');
    assert.match(result.error ?? '', /permission/);
    assert.equal(result.output, 'May I run this?');
  });
});
