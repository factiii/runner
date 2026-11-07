import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import type { RunnerNukeProgress } from '@shared/all/domains/electron';
import {
  actionAllowed,
  OWNER_ONLY_ACTIONS,
  relaySecretsRefusal
} from '@shared/all/helpers/board-agent-core/runner-access';
import {
  NUKE_OWNER_ONLY,
  NUKE_PHRASE,
  NUKE_PHRASE_REFUSAL,
  NUKE_RELAY_REFUSAL,
  nukePhraseMatches,
  nukePlanLines,
  nukeRefusal
} from '@shared/all/helpers/runnerNuke';

import {
  NUKE_MARKER,
  type NukeHost,
  nukeDirRefusal,
  nukeSessionRefusal,
  readNukePlan,
  runNuke
} from './nuke';

// Nuke a runner against a made-up runner home in a temp HOME. Every host
// call (server, launchctl, tmux, the keychain) is a fake that records what
// it was asked: nothing here touches the real runner, its service, its
// keychain item or its tmux server.

// Anything this process might resolve as "the runner home" points at a temp
// path that does not exist, before any module that reads it is loaded.
process.env.FACTIII_RUNNER_DIR = path.join('/tmp', `fr-nuke-${process.pid}`);

const REAL_RUNNER = path.join(os.homedir(), '.factiii-runner');
const made: string[] = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A temp HOME holding a runner home with two boards. */
function runnerHome() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-nuke-')));
  made.push(base);
  const home = path.join(base, 'home');
  const dir = path.join(home, '.factiii-runner');
  // The guard against the worst mistake a test could make.
  assert.ok(!dir.startsWith(REAL_RUNNER) && dir !== os.homedir());
  const at = (...p: string[]) => path.join(dir, ...p);
  write(at('config.json'), '{}');
  write(at('spaces.json'), '{}');
  write(at('access.json'), '{}');
  write(at('logs', 'runner.log'));
  write(at('agent-home', 'claude', 'settings.json'));
  write(at('board-a', 'secrets', 'secrets.enc.env'), 'API_KEY=enc\nDB_URL=enc\nsops_mac=x\n');
  write(at('board-a', 'secrets', 'files', 'cert.enc'));
  write(at('board-a', 'secrets', 'age-identity.enc'));
  write(at('board-a', 'repo', 'README.md'));
  write(at('board-a', 'worktrees', 'clean', 'a.txt'));
  write(at('board-a', 'worktrees', 'dirty', 'a.txt'));
  write(at('board-a', 'backups', 'db-1.sql'));
  write(at('board-a', 'backups', 'db-2.sql'));
  write(at('board-b', 'workspace', 'x'));
  write(at('board-b', 'scratchpad', 'shot.png'));
  // A renamed board's old name: a link, never a second board.
  fs.symlinkSync(at('board-b'), at('old-b'));
  // Outside the runner home: must survive every nuke.
  write(path.join(home, 'keep.txt'));
  write(path.join(home, '.factiii-runner-dev', 'config.json'));
  return { home, dir, at };
}

type Calls = string[];

function fakeHost(calls: Calls, overrides: Partial<NukeHost> = {}): NukeHost {
  return {
    pairing: () => ({ paired: true, runnerName: 'mac-mini' }),
    serviceName: async () => 'com.factiii.runner',
    workState: async (_spaceDir, worktree) =>
      path.basename(worktree) === 'dirty'
        ? { branch: 'terminal/dirty', dirty: true, unpushed: true }
        : { branch: 'terminal/clean', dirty: false, unpushed: false },
    unpair: async () => {
      calls.push('unpair');
      return ['Unpaired and removed from Factiii.'];
    },
    removeService: async () => {
      calls.push('service');
      return ['Removed the service.'];
    },
    stopWork: async () => {
      calls.push('sessions');
      return ['Stopped sessions.'];
    },
    eraseKeychain: async () => {
      calls.push('keychain');
      return ['Erased the keychain entry.'];
    },
    // No lid-closed grant unless a test sets one up.
    releaseLid: async () => [],
    leftBehind: async () => [],
    ...overrides
  };
}

describe('the phrase', () => {
  it('matches only exactly as typed', () => {
    assert.equal(nukePhraseMatches(NUKE_PHRASE), true);
    for (const typed of [
      'all will be deleted',
      'All Will Be Deleted',
      ` ${NUKE_PHRASE}`,
      `${NUKE_PHRASE} `,
      `${NUKE_PHRASE}\n`,
      'ALL  WILL BE DELETED',
      'ALL WILL BE DELETE',
      '',
      undefined,
      null,
      42
    ]) {
      assert.equal(nukePhraseMatches(typed), false, `accepted ${JSON.stringify(typed)}`);
    }
  });

  it('is refused on the runner when wrong, padded or missing', () => {
    const owner = { role: 'owner' as const, actorUserId: '7', ownerUserId: '7', transport: 'webrtc' as const };
    assert.equal(nukeRefusal({ ...owner, confirm: true, phrase: NUKE_PHRASE }), null);
    for (const phrase of ['all will be deleted', ` ${NUKE_PHRASE} `, undefined, '']) {
      assert.equal(nukeRefusal({ ...owner, confirm: true, phrase }), NUKE_PHRASE_REFUSAL);
    }
    // A plan needs no phrase.
    assert.equal(nukeRefusal(owner), null);
  });
});

describe('who may nuke', () => {
  it('is the owner alone, by id, on a direct link', () => {
    const base = { actorUserId: '7', ownerUserId: '7', transport: 'webrtc' as const, confirm: true, phrase: NUKE_PHRASE };
    assert.equal(nukeRefusal({ ...base, role: 'member' }), NUKE_OWNER_ONLY);
    // A channel that says owner but is not the person the pairing names.
    assert.equal(nukeRefusal({ ...base, role: 'owner', actorUserId: '8' }), NUKE_OWNER_ONLY);
    assert.equal(nukeRefusal({ ...base, role: 'owner', transport: 'socket' }), NUKE_RELAY_REFUSAL);
    assert.equal(nukeRefusal({ ...base, role: 'owner' }), null);
  });

  it('is owner-only on every level and refused on the relay before any check', () => {
    assert.ok(OWNER_ONLY_ACTIONS.has('runnerNuke'));
    for (const level of ['none', 'api', 'terminals', 'screens'] as const) {
      assert.equal(actionAllowed(level, 'runnerNuke'), false);
    }
    assert.equal(actionAllowed('owner', 'runnerNuke'), true);
    assert.ok(relaySecretsRefusal('socket', 'runnerNuke', {}));
    assert.equal(relaySecretsRefusal('webrtc', 'runnerNuke', {}), null);
  });

  it('is refused from inside a runner session or an agent shell', () => {
    assert.equal(nukeSessionRefusal({}), null);
    for (const env of [
      { FACTIII_SESSION: 'abc' },
      { SCRATCHPAD: '/x/scratchpad' },
      { CLAUDECODE: '1' },
      { CODEX_SANDBOX: 'seatbelt' },
      { TMUX: '/private/tmp/tmux-501/factiii,123,0' }
    ]) {
      assert.ok(nukeSessionRefusal(env), JSON.stringify(env));
    }
    assert.equal(nukeSessionRefusal({ TMUX: '/private/tmp/tmux-501/default,1,0' }), null);
  });
});

describe('the board MCP', () => {
  const repo = path.resolve(__dirname, '../../..');

  const boardMcp = path.join(repo, 'apps/server/src/mcp/board.ts');

  // The public source mirror (scripts/public-mirror.mjs) has no apps/server;
  // this check runs in the monorepo, where the server lives.
  it('has no tool that reaches a nuke or an unpair', { skip: !fs.existsSync(boardMcp) && 'apps/server is not in this checkout' }, () => {
    const source = fs.readFileSync(boardMcp, 'utf-8');
    const tools = [...source.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(tools.includes('list_cards'), 'read the tool list');
    for (const tool of tools) assert.doesNotMatch(tool, /nuke|unpair|runner|revoke/);
    assert.doesNotMatch(source, /runnerNuke|runner:unpair|revokeRunner/);
  });

  it('cannot be reached through the session socket either', () => {
    // A session's only road to the runner: its fixed ops, none of them a
    // dispatch of an arbitrary action.
    const bridge = fs.readFileSync(
      path.join(repo, 'shared/all/helpers/board-agent-core/secrets-bridge.ts'),
      'utf-8'
    );
    const ops = [...bridge.matchAll(/request\.op === '([a-z-]+)'/g)].map((m) => m[1]);
    assert.ok(ops.includes('board-mcp'), 'read the op list');
    for (const op of ops) assert.doesNotMatch(op, /nuke|unpair|dispatch/);
    const plugin = path.join(repo, 'apps/runner/plugin');
    const files = fs.readdirSync(plugin, { recursive: true, encoding: 'utf-8' });
    for (const file of files) {
      const at = path.join(plugin, file);
      if (!fs.statSync(at).isFile()) continue;
      assert.doesNotMatch(fs.readFileSync(at, 'utf-8'), /runnerNuke|factiii-runner nuke/, file);
    }
  });
});

describe('the folder guard', () => {
  it('refuses /, the home folder, what holds it, a link and a stranger', () => {
    const { home, dir } = runnerHome();
    const ok = { expectedDir: dir, home };
    assert.equal(nukeDirRefusal(dir, ok), null);
    assert.match(nukeDirRefusal('/', { expectedDir: '/', home }) ?? '', /root/);
    assert.match(nukeDirRefusal(home, { expectedDir: home, home }) ?? '', /home folder/);
    assert.match(
      nukeDirRefusal(path.dirname(home), { expectedDir: path.dirname(home), home }) ?? '',
      /home folder/
    );
    assert.match(nukeDirRefusal('.factiii-runner', ok) ?? '', /absolute/);
    assert.match(nukeDirRefusal('', ok) ?? '', /absolute/);
    // Not the runner home this process resolved.
    assert.match(
      nukeDirRefusal(path.join(home, '.factiii-runner-dev'), ok) ?? '',
      /not this runner's folder/
    );
    // A link to the runner home is not the runner home.
    const link = path.join(home, 'link');
    fs.symlinkSync(dir, link);
    assert.match(nukeDirRefusal(link, { expectedDir: link, home }) ?? '', /link/);
    // A folder that does not look like a runner's.
    const stranger = path.join(home, 'Documents');
    write(path.join(stranger, 'thesis.docx'));
    assert.match(nukeDirRefusal(stranger, { expectedDir: stranger, home }) ?? '', /does not look like/);
  });

  it('erases nothing when the folder is refused', async () => {
    const { home, dir } = runnerHome();
    const calls: Calls = [];
    const other = path.join(home, '.factiii-runner-dev');
    await assert.rejects(
      runNuke({ dir: other, expectedDir: dir, home, host: fakeHost(calls) }),
      /not this runner's folder/
    );
    assert.deepEqual(calls, []);
    assert.ok(fs.existsSync(path.join(other, 'config.json')));
    assert.ok(fs.existsSync(path.join(dir, 'config.json')));
  });
});

describe('the plan', () => {
  it('names the boards, the worktrees with work, the secrets and the backups', async () => {
    const { dir } = runnerHome();
    const plan = await readNukePlan(dir, fakeHost([]));
    assert.deepEqual(
      plan.boards.map((b) => b.slug),
      ['board-a', 'board-b']
    );
    assert.equal(plan.secretsTotal, 3);
    assert.equal(plan.backupsTotal, 2);
    const lines = nukePlanLines(plan).join('\n');
    assert.match(lines, /board-a\/dirty \(terminal\/dirty\) has uncommitted changes and commits no remote has/);
    assert.doesNotMatch(lines, /board-a\/clean/);
    assert.match(lines, /3 secrets/);
    assert.match(lines, /2 backups/);
    assert.match(lines, /Nothing can be recovered/);
    assert.match(lines, /unpaired from Factiii first/);
  });
});

describe('the erase', () => {
  it('runs in order: unpair, service, sessions, keychain, secrets, folder', async () => {
    const { home, dir } = runnerHome();
    const calls: Calls = [];
    const frames: RunnerNukeProgress[] = [];
    let secretsAtKeychain = false;
    const host = fakeHost(calls, {
      eraseKeychain: async () => {
        calls.push('keychain');
        // The secrets go after the keychain entry, the folder after both.
        secretsAtKeychain = fs.existsSync(path.join(dir, 'board-a', 'secrets'));
        return [];
      }
    });
    await runNuke({ dir, expectedDir: dir, home, host, onProgress: (p) => frames.push(p) });
    assert.deepEqual(calls, ['unpair', 'service', 'sessions', 'keychain']);
    assert.ok(secretsAtKeychain);
    assert.equal(fs.existsSync(dir), false);
    // Outside the runner home, and the link's target's sibling: untouched.
    assert.ok(fs.existsSync(path.join(home, 'keep.txt')));
    assert.ok(fs.existsSync(path.join(home, '.factiii-runner-dev', 'config.json')));
    const done = frames.filter((f) => f.state === 'done').map((f) => f.step);
    assert.deepEqual(done, ['plan', 'unpair', 'service', 'sessions', 'keychain', 'secrets', 'folder', 'done']);
  });

  it('erases nothing when the server cannot be asked to unpair', async () => {
    const { home, dir } = runnerHome();
    const calls: Calls = [];
    const host = fakeHost(calls, {
      unpair: async () => {
        throw new Error('Could not reach the server. Nothing was erased.');
      }
    });
    const frames: RunnerNukeProgress[] = [];
    await assert.rejects(
      runNuke({ dir, expectedDir: dir, home, host, onProgress: (p) => frames.push(p) }),
      /unpair failed/
    );
    assert.deepEqual(calls, []);
    assert.ok(fs.existsSync(path.join(dir, 'board-a', 'secrets', 'secrets.enc.env')));
    assert.ok(fs.existsSync(path.join(dir, 'config.json')));
    assert.deepEqual(frames.at(-1), {
      step: 'unpair',
      state: 'failed',
      lines: ['Could not reach the server. Nothing was erased.']
    });
  });

  it('lets go of a closed lid after the sessions, and names the grant it leaves', async () => {
    const { LID_GRANT_LEFT_BEHIND } = await import('./nukeHost');
    const { home, dir } = runnerHome();
    const calls: Calls = [];
    const frames: RunnerNukeProgress[] = [];
    const host = fakeHost(calls, {
      releaseLid: async () => {
        calls.push('lid');
        return ['Lid closed is off: the Mac sleeps with its lid shut again.'];
      },
      leftBehind: async () => [LID_GRANT_LEFT_BEHIND]
    });
    const plan = await readNukePlan(dir, host);
    assert.deepEqual(plan.leftBehind, [LID_GRANT_LEFT_BEHIND]);
    assert.match(
      nukePlanLines(plan).join('\n'),
      /factiii-pmset \(the lid-closed grant\) stays.*Remove in Factiii Desktop \(Lid closed → Remove\)/
    );
    await runNuke({ dir, expectedDir: dir, home, host, onProgress: (p) => frames.push(p) });
    assert.deepEqual(calls, ['unpair', 'service', 'sessions', 'lid', 'keychain']);
    const sessions = frames.find((f) => f.step === 'sessions' && f.state === 'done');
    assert.deepEqual(sessions?.lines, [
      'Stopped sessions.',
      'Lid closed is off: the Mac sleeps with its lid shut again.'
    ]);
    // The final output says it too.
    assert.deepEqual(frames.at(-1), { step: 'done', state: 'done', lines: [LID_GRANT_LEFT_BEHIND] });
  });

  it('finishes on a re-run after a crash, without asking the server again', async () => {
    const { home, dir } = runnerHome();
    const calls: Calls = [];
    let keychainFails = true;
    const host = fakeHost(calls, {
      eraseKeychain: async () => {
        calls.push('keychain');
        if (keychainFails) throw new Error('keychain locked');
        return ['Erased the keychain entry.'];
      }
    });
    await assert.rejects(runNuke({ dir, expectedDir: dir, home, host }), /keychain failed/);
    assert.ok(fs.existsSync(path.join(dir, NUKE_MARKER)));
    assert.ok(fs.existsSync(path.join(dir, 'board-a', 'secrets')));

    // The server is gone now: the marker says it already said yes.
    keychainFails = false;
    const rerun = fakeHost(calls, {
      eraseKeychain: host.eraseKeychain,
      unpair: async () => {
        throw new Error('offline');
      }
    });
    await runNuke({ dir, expectedDir: dir, home, host: rerun });
    assert.deepEqual(calls, ['unpair', 'service', 'sessions', 'keychain', 'service', 'sessions', 'keychain']);
    assert.equal(fs.existsSync(dir), false);

    // And once more on nothing: nothing left to do, nothing outside touched.
    await runNuke({ dir, expectedDir: dir, home, host: rerun });
    assert.ok(fs.existsSync(path.join(home, 'keep.txt')));
  });

  it('finishes a folder erase that crashed halfway (config.json already gone)', async () => {
    const { home, dir } = runnerHome();
    fs.writeFileSync(path.join(dir, NUKE_MARKER), JSON.stringify({ startedAt: 'x', done: ['unpair', 'service', 'sessions', 'keychain', 'secrets'] }));
    for (const f of ['config.json', 'spaces.json', 'access.json']) fs.rmSync(path.join(dir, f));
    const calls: Calls = [];
    await runNuke({ dir, expectedDir: dir, home, host: fakeHost(calls) });
    assert.equal(fs.existsSync(dir), false);
    assert.ok(!calls.includes('unpair'));
  });
});

describe('the daemon road', () => {
  it('re-checks the owner and the phrase, and starts only on an exact one', async () => {
    const { createDaemonNuke } = await import('./daemonNuke');
    const { home, dir } = runnerHome();
    const calls: Calls = [];
    const frames: RunnerNukeProgress[] = [];
    let exited = false;
    let started: (() => void) | null = null;
    const nuke = createDaemonNuke({
      dir,
      expectedDir: dir,
      ownerUserId: '7',
      host: fakeHost(calls),
      broadcast: (p) => frames.push(p),
      exit: () => {
        exited = true;
      },
      later: (fn) => {
        started = fn;
      }
    });
    const owner = { role: 'owner' as const, userId: '7' };
    await assert.rejects(nuke.handle({ confirm: true, phrase: NUKE_PHRASE }, { role: 'member', userId: '9' }, 'webrtc'), /Only the owner/);
    await assert.rejects(nuke.handle({ confirm: true, phrase: NUKE_PHRASE }, owner, 'socket'), /relayed/);
    await assert.rejects(nuke.handle({ confirm: true, phrase: 'all will be deleted' }, owner, 'webrtc'), /Type exactly/);
    await assert.rejects(nuke.handle({ confirm: true }, owner, 'webrtc'), /Type exactly/);
    await assert.rejects(nuke.handle({ confirm: true, phrase: NUKE_PHRASE, yes: true }, owner, 'webrtc'), /only confirm/);

    const plan = await nuke.handle({}, owner, 'webrtc');
    assert.equal(plan.started, false);
    assert.equal(plan.plan.boards.length, 2);
    assert.deepEqual(calls, []);
    assert.ok(fs.existsSync(dir));

    const run = await nuke.handle({ confirm: true, phrase: NUKE_PHRASE }, owner, 'webrtc');
    assert.equal(run.started, true);
    assert.equal(nuke.running(), true);
    await assert.rejects(nuke.handle({ confirm: true, phrase: NUKE_PHRASE }, owner, 'webrtc'), /already/);
    assert.ok(started);
    (started as () => void)();
    for (let i = 0; i < 50 && !exited; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(exited, true);
    assert.deepEqual(calls, ['unpair', 'service', 'sessions', 'keychain']);
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(frames.at(-1), { step: 'done', state: 'done', lines: [] });
    assert.ok(fs.existsSync(path.join(home, 'keep.txt')));
  });

  it('two confirms at once start one nuke, and refuse the other', async () => {
    const { createDaemonNuke } = await import('./daemonNuke');
    const { dir } = runnerHome();
    const scheduled: (() => void)[] = [];
    const nuke = createDaemonNuke({
      dir,
      expectedDir: dir,
      ownerUserId: '7',
      host: fakeHost([]),
      broadcast: () => {},
      exit: () => {},
      later: (fn) => {
        scheduled.push(fn);
      }
    });
    const owner = { role: 'owner' as const, userId: '7' };
    const both = await Promise.allSettled([
      nuke.handle({ confirm: true, phrase: NUKE_PHRASE }, owner, 'webrtc'),
      nuke.handle({ confirm: true, phrase: NUKE_PHRASE }, owner, 'webrtc')
    ]);
    assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(scheduled.length, 1);
  });
});

describe('the host', () => {
  it('turns lid closed off through the grant first, and leaves root\'s file named', async () => {
    const { LID_GRANT_LEFT_BEHIND, lidGrantLeftBehind, releaseLidGrant } = await import('./nukeHost');
    const seen: string[][] = [];
    const grant = (file: string) => file === '/etc/sudoers.d/factiii-pmset';
    const ok = async (bin: string, args: string[]) => {
      seen.push([bin, ...args]);
      return { code: 0, output: '' };
    };
    assert.deepEqual(await releaseLidGrant({ platform: 'darwin', exists: grant, exec: ok }), [
      'Lid closed is off: the Mac sleeps with its lid shut again.'
    ]);
    assert.deepEqual(seen, [['/usr/bin/sudo', '-n', '/usr/bin/pmset', '-a', 'disablesleep', '0']]);
    assert.deepEqual(lidGrantLeftBehind({ platform: 'darwin', exists: grant }), [LID_GRANT_LEFT_BEHIND]);
    assert.match(LID_GRANT_LEFT_BEHIND, /^\/etc\/sudoers\.d\/factiii-pmset .*Remove in Factiii Desktop \(Lid closed → Remove\)\.$/);

    // A refused sudo is a line, never a throw: the nuke goes on.
    const refused = await releaseLidGrant({
      platform: 'darwin',
      exists: grant,
      exec: async () => ({ code: 1, output: 'sudo: a password is required\n' })
    });
    assert.match(refused[0] ?? '', /Could not turn lid closed off \(sudo: a password is required\)/);
    const threw = await releaseLidGrant({
      platform: 'darwin',
      exists: grant,
      exec: async () => {
        throw new Error('spawn sudo ENOENT');
      }
    });
    assert.match(threw[0] ?? '', /spawn sudo ENOENT/);

    // No grant, or not a Mac: nothing runs and nothing is left.
    seen.length = 0;
    assert.deepEqual(await releaseLidGrant({ platform: 'darwin', exists: () => false, exec: ok }), []);
    assert.deepEqual(await releaseLidGrant({ platform: 'linux', exists: grant, exec: ok }), []);
    assert.deepEqual(seen, []);
    assert.deepEqual(lidGrantLeftBehind({ platform: 'darwin', exists: () => false }), []);
    assert.deepEqual(lidGrantLeftBehind({ platform: 'linux', exists: grant }), []);
  });

  it('erases the keychain entry until none is left, and calls a missing one done', async () => {
    const { eraseRunnerKeychain } = await import('./nukeHost');
    const seen: string[][] = [];
    const answers = [0, 44];
    const lines = await eraseRunnerKeychain({
      platform: 'darwin',
      account: 'config-encryption-key:abc',
      exec: async (bin, args) => {
        seen.push([bin, ...args]);
        return { code: answers.shift() ?? 44, output: '' };
      }
    });
    assert.deepEqual(lines, ['Erased the keychain entry.']);
    assert.deepEqual(seen[0], [
      'security',
      'delete-generic-password',
      '-s',
      'factiii-runner',
      '-a',
      'config-encryption-key:abc'
    ]);
    assert.deepEqual(
      await eraseRunnerKeychain({
        platform: 'darwin',
        account: 'x',
        exec: async () => ({ code: 44, output: '' })
      }),
      ['No keychain entry was left.']
    );
    await assert.rejects(
      eraseRunnerKeychain({
        platform: 'darwin',
        account: 'x',
        exec: async () => ({ code: 51, output: 'User interaction is not allowed.' })
      }),
      /refused/
    );
  });

  it('stops only the tmux sessions of this runner folder', async () => {
    const { stopTmuxSessionsIn } = await import('./nukeHost');
    const dir = '/Users/x/.factiii-runner';
    const seen: string[][] = [];
    const lines = await stopTmuxSessionsIn(dir, async (bin, args) => {
      seen.push([bin, ...args]);
      if (args.includes('list-sessions')) {
        return {
          code: 0,
          output: [
            `card-1\t${dir}/board-a/worktrees/card-1`,
            `term-2\t${dir}`,
            `dev-1\t/Users/x/.factiii-runner-dev/board/worktrees/a`,
            `mine\t/Users/x/code`
          ].join('\n')
        };
      }
      if (args.includes('list-panes')) return { code: 0, output: '101\n102\n' };
      return { code: 0, output: '' };
    });
    const killed = seen.filter((c) => c.includes('kill-session')).map((c) => c.at(-1));
    assert.deepEqual(killed, ['card-1', 'term-2']);
    assert.ok(seen.every((c) => c[0] !== 'tmux' || (c[1] === '-L' && c[2] === 'factiii')));
    assert.ok(seen.some((c) => c.join(' ') === 'pkill -TERM -P 101'));
    assert.deepEqual(lines, ['Stopped 2 tmux sessions.']);
  });

  it('unpairs over the socket, and reads a refused token as already unpaired', async () => {
    const { unpairOverSocket } = await import('./nukeHost');
    type Handler = (...args: unknown[]) => void;
    const fakeConnect = (script: (on: Map<string, Handler>, emitted: string[]) => void) => {
      const emitted: string[] = [];
      const factory = (() => {
        const handlers = new Map<string, Handler>();
        const socket = {
          on: (event: string, fn: Handler) => {
            handlers.set(event, fn);
            return socket;
          },
          emit: (event: string, _data: unknown, ack: (res: unknown) => void) => {
            emitted.push(event);
            ack({ removed: true });
          },
          disconnect: () => socket
        };
        setTimeout(() => script(handlers, emitted), 0);
        return socket;
      }) as unknown as Parameters<typeof unpairOverSocket>[2];
      return { factory, emitted };
    };

    const ok = fakeConnect((h) => h.get('connect')?.());
    assert.deepEqual(await unpairOverSocket('http://s', 't', ok.factory), ['Unpaired and removed from Factiii.']);
    assert.deepEqual(ok.emitted, ['runner:unpair']);

    const revoked = fakeConnect((h) => h.get('connect_error')?.(new Error('runner revoked or invalid')));
    assert.match((await unpairOverSocket('http://s', 't', revoked.factory))[0], /already unpaired/);

    const down = fakeConnect((h) => h.get('connect_error')?.(new Error('xhr poll error')));
    await assert.rejects(unpairOverSocket('http://s', 't', down.factory), /Nothing was erased/);
  });
});
