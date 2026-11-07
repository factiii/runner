import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgentAuthResult } from '@shared/all/helpers/board-agent-core/claude-login';
import type { ExecTarget } from '@shared/all/helpers/board-agent-core/exec';
import {
  actionAllowed,
  RELAY_SIGNIN_REFUSAL,
  RUNNER_SIGNIN_ACTIONS
} from '@shared/all/helpers/board-agent-core/runner-access';

import { createCliSignins, type CliSigninDeps, machineCliSignins } from './cliSignins';

// Oakbox's runner-wide sign-ins (cliSignins.ts) against fake CLIs and flows:
// nothing here runs `claude` or `codex`, or signs anything in.

type Cli = 'claude' | 'codex';

function harness(installed: Cli[] = ['claude', 'codex']) {
  const signedIn = new Set<Cli>();
  const changes: [Cli, boolean][] = [];
  const typed: string[] = [];
  let claudeDone: ((r: AgentAuthResult) => void) | null = null;
  let codexDone: ((r: AgentAuthResult) => void) | null = null;
  let claudeActive = false;
  const deps: CliSigninDeps = {
    installed: async (cli) => installed.includes(cli),
    signedIn: async (cli) => signedIn.has(cli),
    signOut: async (cli) => {
      signedIn.delete(cli);
    },
    claudeFlow: (onDone) => {
      claudeDone = onDone;
      return {
        get active() {
          return claudeActive;
        },
        start: async () => {
          claudeActive = true;
          return { url: 'https://claude.ai/oauth/authorize?x=1' };
        },
        submitCode: (code) => {
          typed.push(code);
          return { success: true };
        },
        cancel: async () => {
          claudeActive = false;
        }
      };
    },
    codexFlow: (onDone) => {
      codexDone = onDone;
      return {
        active: false,
        start: async () => ({ url: 'https://auth.openai.com/codex/device', code: 'AB12-CD34' }),
        cancel: async () => {}
      };
    },
    changed: (cli, value) => changes.push([cli, value])
  };
  return {
    signins: createCliSignins(deps),
    signedIn,
    changes,
    typed,
    finishClaude: (r: AgentAuthResult) => claudeDone?.(r),
    finishCodex: (r: AgentAuthResult) => codexDone?.(r)
  };
}

describe('runner-wide CLI sign-ins', () => {
  it('signs Claude in: the url, the pasted code, then the outcome on status', async () => {
    const h = harness();
    assert.deepEqual(await h.signins.claudeStart(), {
      url: 'https://claude.ai/oauth/authorize?x=1'
    });
    assert.deepEqual((await h.signins.status()).claude.flow, { state: 'running', message: null });
    h.signins.claudeCode({ code: '  abc#def  ' });
    assert.deepEqual(h.typed, ['abc#def']);
    h.signedIn.add('claude');
    h.finishClaude({ status: 'complete' });
    const after = (await h.signins.status()).claude;
    assert.equal(after.signedIn, true);
    assert.deepEqual(after.flow, { state: 'complete', message: null });
    // Every board's cached sign-in follows.
    assert.deepEqual(h.changes, [['claude', true]]);
  });

  it('refuses a code with a line break, which would type a second line', async () => {
    const h = harness();
    await h.signins.claudeStart();
    assert.throws(() => h.signins.claudeCode({ code: 'abc\ny' }), /does not look like the code/);
    assert.throws(() => h.signins.claudeCode({ code: '' }), /Paste the code/);
    assert.deepEqual(h.typed, []);
  });

  it('takes no code without a sign-in running, or after a cancel', async () => {
    const h = harness();
    assert.throws(() => h.signins.claudeCode({ code: 'abc' }), /No Claude sign-in/);
    await h.signins.claudeStart();
    await h.signins.cancel('claude');
    assert.throws(() => h.signins.claudeCode({ code: 'abc' }), /No Claude sign-in/);
    assert.equal((await h.signins.status()).claude.flow, null);
  });

  it('signs Codex in with the device code, and reports a failure', async () => {
    const h = harness();
    assert.deepEqual(await h.signins.codexStart(), {
      url: 'https://auth.openai.com/codex/device',
      code: 'AB12-CD34'
    });
    h.finishCodex({ status: 'error', message: 'Expired.' });
    const codex = (await h.signins.status()).codex;
    assert.deepEqual(codex.flow, { state: 'error', message: 'Expired.' });
    assert.equal(codex.signedIn, false);
    assert.deepEqual(h.changes, []);
  });

  it('asks for the CLI first where it is not added', async () => {
    const h = harness(['claude']);
    await assert.rejects(h.signins.codexStart(), /Add Codex on this runner first/);
    const status = await h.signins.status();
    assert.equal(status.codex.installed, false);
    assert.equal(status.codex.signedIn, false);
  });

  it('signs out, and the boards follow', async () => {
    const h = harness();
    h.signedIn.add('codex');
    await h.signins.signOut('codex');
    assert.equal((await h.signins.status()).codex.signedIn, false);
    assert.deepEqual(h.changes, [['codex', false]]);
  });

  it('looks for the CLI on the target it is given before a sign-in starts', async () => {
    const commands: string[] = [];
    const target = {
      paths: { root: '/tmp/factiii-test-runner' },
      sh: async (cmd: string) => {
        commands.push(cmd);
        throw new Error('not found');
      }
    } as unknown as ExecTarget;
    const signins = machineCliSignins(target, () => {});
    await assert.rejects(signins.claudeStart(), /Add Claude/);
    assert.deepEqual(commands, ['command -v claude']);
  });

  it('is the owner’s, never a member’s, and the relay refuses it', () => {
    for (const action of RUNNER_SIGNIN_ACTIONS) {
      assert.ok(actionAllowed('owner', action));
    }
    assert.equal(actionAllowed('terminals', 'cliSignins'), false);
    assert.match(RELAY_SIGNIN_REFUSAL, /^RELAY_REFUSES_SECRETS/);
  });
});
