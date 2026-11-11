import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

import { BoardAgentEngine } from '@shared/all/helpers/board-agent-core/engine';
import { initSecrets, setSecret, spaceKeyDir } from '@shared/all/helpers/board-agent-core/host-secrets';
import { JobTargets } from '@shared/all/helpers/board-agent-core/job-targets';
import type { JobDef } from '@shared/all/helpers/board-agent-core/jobs';
import type { OpsJobHooks } from '@shared/all/helpers/board-agent-core/ops-link';
import type { authorizeAndRun } from '@shared/all/helpers/board-agent-core/secrets-run';
import { type CardAIConfig, createEventSink } from '@shared/all/helpers/board-agent-core/session';

import { createOpsBoard, type OpsBoard } from './board';
import { opsClient } from './client';
import { createOpsLink } from './link';
import { assertOpsPath, type OpsClone, opsClone } from './opsClone';
import { answerChallenge, challengePeerCheck } from './peer';
import { REFUSED_BOARD, REFUSED_OP, REFUSED_PEER, REFUSED_TOKEN } from './protocol';
import { assertRunDir } from './serve';
import { type OpsServer, startOpsServer } from './server';
import { MACHINE_SERVERS, renderLaunchDaemon, serverPlists } from './servers';
import { macSetupScript } from './setup';
import { readOpsSettings, writeOpsSettings } from './settings';
import { type Exec, installRelease, verifyAuthenticode, verifyLinuxTarball, verifyMacApp } from './updateVerify';

// The ops user's pieces (.specs/ops-user.md), with temp dirs and mocks: the
// socket's peer and token checks, the op allowlist, that no op hands back a
// secret value, that a job runs from the ops clone only, that the
// dangerous/approval and target rules hold through the socket, and the
// update verifier.

const UID = process.getuid?.() ?? 0;
const TOKEN = 'a'.repeat(64);
const PASSWORD = 'correct-horse-battery';
const SECRET = 'sk_live_OPS_TEST_VALUE_9f8e7d6c';
const OWNER = { userId: '7', name: 'Jon' };
const MEMBER = { userId: '21', name: 'Parik' };

const hasSecretsBins = ['sops', 'age', 'age-keygen'].every(
  (bin) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0
);

const tmpRoots: string[] = [];
function tmp(prefix: string): string {
  // Short: a unix socket path has a ~104 character limit on macOS.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const until = async (check: () => boolean | Promise<boolean>, what = 'condition') => {
  for (let i = 0; i < 500; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A clone stand-in: fixed jobs, a cwd that is a real dir under the ops
 *  home's repos (or `cwd`, to test the refusal). */
function fakeClone(opsHome: string, jobs: JobDef[], cwd?: string): OpsClone {
  const dir = path.join(opsHome, 'repos', 'board');
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    loadJobs: async () => jobs,
    readOrigin: async () => null,
    prepare: async () => cwd ?? dir
  };
}

const job = (over: Partial<JobDef>): JobDef => ({
  name: 'echo',
  description: '',
  command: 'printf ok',
  keys: [],
  files: [],
  params: {},
  timeoutMin: 1,
  ...over
});

/** A run that needs no sops: it reports running and exits 0. */
const fakeExecute: typeof authorizeAndRun = async (args) => {
  args.onPhase?.('running');
  args.onChunk?.('ran\n');
  return { code: 0, output: 'ran\n', unlockedBy: null };
};

type Harness = {
  opsHome: string;
  peerDir: string;
  socket: string;
  boards: Map<string, OpsBoard>;
  server: OpsServer;
  client: (board?: string, token?: string) => ReturnType<typeof opsClient>;
};

async function harness(opts: {
  boards: Record<string, { jobs: JobDef[]; cwd?: string; execute?: typeof authorizeAndRun }>;
  allowedUids?: number[];
  targets?: JobTargets;
}): Promise<Harness> {
  const root = tmp('ops-');
  const opsHome = path.join(root, 'home');
  const runDir = path.join(root, 'run');
  const peerDir = path.join(runDir, 'peer');
  fs.mkdirSync(peerDir, { recursive: true });
  const targets = opts.targets ?? new JobTargets();
  const boards = new Map<string, OpsBoard>();
  for (const [slug, b] of Object.entries(opts.boards)) {
    const home = path.join(opsHome, slug);
    boards.set(
      slug,
      createOpsBoard({
        slug,
        opsHome: home,
        spaceDir: path.join(home, 'boards', slug),
        clone: fakeClone(home, b.jobs, b.cwd),
        githubToken: () => '',
        targets,
        uid: UID,
        execute: b.execute ?? fakeExecute
      })
    );
  }
  const socket = path.join(runDir, 'ops.sock');
  const server = await startOpsServer({
    socketPath: socket,
    peer: challengePeerCheck({ peerDir, allowedUids: new Set(opts.allowedUids ?? [UID]) }),
    board: (slug) => boards.get(slug) ?? null,
    tokenFor: (slug) => (boards.has(slug) ? TOKEN : null)
  });
  return {
    opsHome,
    peerDir,
    socket,
    boards,
    server,
    client: (board = Object.keys(opts.boards)[0] ?? 'board', token = TOKEN) =>
      opsClient({ socketPath: socket, peerDir, board, token: () => token, timeoutMs: 10_000 })
  };
}

let open: Harness[] = [];
afterEach(async () => {
  for (const h of open) {
    await h.server.close();
    for (const b of h.boards.values()) b.destroy();
  }
  open = [];
});
const start = async (...args: Parameters<typeof harness>) => {
  const h = await harness(...args);
  open.push(h);
  return h;
};

/** Raw: connect, optionally answer the challenge, send one line. */
function raw(
  socket: string,
  request: Record<string, unknown>,
  answer: ((nonce: string) => Promise<void>) | null
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    let buf = '';
    let challenged = false;
    conn.on('error', reject);
    conn.on('data', (d) => {
      buf += d.toString();
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        const frame = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        if (!challenged) {
          challenged = true;
          void (answer ? answer(String(frame.nonce)) : Promise.resolve()).then(() =>
            conn.write(`${JSON.stringify(request)}\n`)
          );
          continue;
        }
        conn.destroy();
        resolve(frame);
        return;
      }
    });
  });
}

describe('ops socket: who may ask', () => {
  it('answers the runner user with the board token', async () => {
    const h = await start({ boards: { board: { jobs: [job({})] } } });
    const frame = await h.client().call('job-list');
    assert.equal(frame.type, 'jobs');
    assert.deepEqual((frame.jobs as { name: string }[]).map((j) => j.name), ['echo']);
  });

  it('refuses a peer whose uid is not allowed', async () => {
    const h = await start({ boards: { board: { jobs: [job({})] } }, allowedUids: [UID + 1] });
    await assert.rejects(h.client().call('job-list'), new RegExp(REFUSED_PEER.slice(0, 30)));
  });

  it('refuses a peer that does not answer the challenge', async () => {
    const h = await start({ boards: { board: { jobs: [job({})] } } });
    const frame = await raw(h.socket, { op: 'job-list', board: 'board', token: TOKEN }, null);
    assert.equal(frame.message, REFUSED_PEER);
  });

  it('refuses a challenge answered with a link, not a file', async () => {
    const h = await start({ boards: { board: { jobs: [job({})] } } });
    const target = path.join(tmp('ops-link-'), 'f');
    fs.writeFileSync(target, '');
    const frame = await raw(h.socket, { op: 'job-list', board: 'board', token: TOKEN }, async (nonce) => {
      fs.symlinkSync(target, path.join(h.peerDir, nonce));
    });
    assert.equal(frame.message, REFUSED_PEER);
  });

  it('checks the file owner, not who connected (mocked stat of another uid)', async () => {
    const check = challengePeerCheck({
      peerDir: '/nowhere',
      allowedUids: new Set([501]),
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, uid: 0 }),
      unlink: async () => undefined
    });
    await assert.rejects(check.verify(check.challenge()), /uid 0 is not allowed/);
    const ok = challengePeerCheck({
      peerDir: '/nowhere',
      allowedUids: new Set([501]),
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, uid: 501 }),
      unlink: async () => undefined
    });
    assert.deepEqual(await ok.verify(ok.challenge()), { uid: 501 });
    await assert.rejects(ok.verify('../../etc/passwd'), /bad nonce/);
  });

  it('refuses a wrong token and an unknown board', async () => {
    const h = await start({ boards: { board: { jobs: [job({})] } } });
    await assert.rejects(h.client('board', 'b'.repeat(64)).call('job-list'), new RegExp(REFUSED_TOKEN.slice(0, 30)));
    await assert.rejects(h.client('board', 'short').call('job-list'), new RegExp(REFUSED_TOKEN.slice(0, 30)));
    await assert.rejects(h.client('other').call('job-list'), new RegExp(REFUSED_BOARD.slice(0, 20)));
  });

  it('has no free-command op, nor any op outside the list', async () => {
    const h = await start({ boards: { board: { jobs: [job({})] } } });
    for (const op of ['run', 'tunnel-token', 'git-credential', 'secret-get', 'backup-open']) {
      const frame = await raw(h.socket, { op, board: 'board', token: TOKEN }, (n) => answerChallenge(h.peerDir, n));
      assert.equal(frame.message, REFUSED_OP, op);
    }
  });

  it('refuses a run dir someone else could write', () => {
    const run = tmp('ops-run-');
    fs.chmodSync(run, 0o750);
    assertRunDir(run, UID);
    assert.equal(fs.statSync(path.join(run, 'peer')).mode & 0o7777, 0o1730);
    fs.chmodSync(run, 0o770);
    assert.throws(() => assertRunDir(run, UID), /mode 770/);
    fs.chmodSync(run, 0o750);
    assert.throws(() => assertRunDir(run, UID + 1), /not owned by the ops user/);
  });
});

describe('ops socket: jobs from the ops clone only', () => {
  it('refuses a cwd outside <ops home>/repos', () => {
    const home = tmp('ops-home-');
    fs.mkdirSync(path.join(home, 'repos', 'b'), { recursive: true });
    assert.equal(assertOpsPath(path.join(home, 'repos', 'b'), home, UID), fs.realpathSync(path.join(home, 'repos', 'b')));
    const outside = tmp('normal-user-');
    assert.throws(() => assertOpsPath(outside, home, UID), /not the ops clone/);
    // A link inside repos that points out is judged by where it points.
    fs.symlinkSync(outside, path.join(home, 'repos', 'sneaky'));
    assert.throws(() => assertOpsPath(path.join(home, 'repos', 'sneaky'), home, UID), /not the ops clone/);
    assert.throws(() => assertOpsPath(path.join(home, 'repos', 'b'), home, UID + 1), /not owned/);
  });

  it('fails a job whose checkout is a normal-user path, before anything runs', async () => {
    let ran = false;
    const h = await start({
      boards: {
        board: {
          jobs: [job({})],
          cwd: tmp('normal-user-'),
          execute: async (args) => {
            ran = true;
            return fakeExecute(args);
          }
        }
      }
    });
    const c = h.client();
    const { callId } = (await c.call('job-call', { job: 'echo', caller: OWNER, via: 'api', mayRunDangerous: true })) as { callId: string };
    await until(async () => (await c.call('job-status', { callId })).state === 'failed', 'failed');
    const status = await c.call('job-status', { callId });
    assert.match(JSON.stringify(status.chunks), /not the ops clone/);
    assert.equal(ran, false);
  });

  it('a real ops clone: fetched, reset hard and cleaned for every job', async () => {
    const root = tmp('ops-git-');
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' }).toString();
    fs.mkdirSync(work);
    git(root, 'init', '--bare', '-b', 'main', origin);
    git(work, 'init', '-b', 'main');
    fs.mkdirSync(path.join(work, '.agents/skills/deploy'), { recursive: true });
    fs.writeFileSync(
      path.join(work, '.agents/skills/deploy/jobs.json'),
      JSON.stringify({ jobs: [{ name: 'hello', command: 'printf hi' }] })
    );
    fs.writeFileSync(path.join(work, 'tracked.txt'), 'v1\n');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'one');
    git(work, 'push', origin, 'main');
    const opsHome = path.join(root, 'home');
    const clone = opsClone({ opsHome, slug: 'b', repoUrl: origin, branch: 'main', githubToken: () => '', uid: UID });
    assert.deepEqual((await clone.loadJobs()).map((j) => j.name), ['hello']);
    const dir = await clone.prepare();
    assert.equal(dir, fs.realpathSync(path.join(opsHome, 'repos', 'b')));
    // Whatever the last job (or anyone) left: an edit and a stray file.
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'tampered\n');
    fs.writeFileSync(path.join(dir, 'stray.sh'), 'echo planted\n');
    fs.writeFileSync(path.join(work, 'tracked.txt'), 'v2\n');
    git(work, 'commit', '-am', 'two');
    git(work, 'push', origin, 'main');
    await clone.prepare();
    assert.equal(fs.readFileSync(path.join(dir, 'tracked.txt'), 'utf-8'), 'v2\n');
    assert.equal(fs.existsSync(path.join(dir, 'stray.sh')), false);
    assert.throws(() => opsClone({ opsHome, slug: 'b', repoUrl: origin, branch: '--upload-pack=x', githubToken: () => '' }), /not a branch/);
  });
});

describe('ops socket: dangerous approval and targets, unchanged', () => {
  const hooks = (): OpsJobHooks & { states: string[] } => {
    const states: string[] = [];
    return {
      states,
      onState: (callId, state) => states.push(`${callId}:${state}`),
      onLog: () => undefined,
      onEnd: (callId, state) => states.push(`${callId}:${state}`)
    };
  };

  it("holds a member's dangerous call for the owner, and runs the owner's at once", async () => {
    const h = await start({ boards: { board: { jobs: [job({ name: 'deploy', dangerous: true })] } } });
    const link = createOpsLink({ client: h.client(), hooks: hooks() });
    try {
      await until(() => link.gateState().pending === null);
      const member = await link.jobs.call({ job: 'deploy', caller: MEMBER, via: 'api', mayRunDangerous: false });
      await until(() => link.approvals().length === 1, 'approval');
      assert.equal(link.jobs.status(member.callId).state, 'waiting-owner');
      assert.equal(link.approvals()[0]?.job, 'deploy');
      assert.equal(link.approvals()[0]?.caller.name, 'Parik');
      const id = link.approvals()[0]?.id ?? '';
      assert.deepEqual(link.approvalAnswer(id, true, { by: OWNER, via: 'data-channel' }), { success: true });
      await until(() => link.jobs.status(member.callId).state === 'done', 'member done');
      const owner = await link.jobs.call({ job: 'deploy', caller: OWNER, via: 'api', mayRunDangerous: true });
      await until(() => link.jobs.status(owner.callId).state === 'done', 'owner done');
      // The owner's call never waited on anyone.
      const audit = fs.readFileSync(path.join(h.opsHome, 'board', 'boards', 'board', 'audit.jsonl'), 'utf-8');
      assert.equal(audit.match(/dangerous-approve/g)?.length, 1);
    } finally {
      link.close();
    }
  });

  it('waits on a target held by another board, across the socket', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const targets = new JobTargets();
    const h = await start({
      targets,
      boards: {
        a: {
          jobs: [job({ name: 'ship', target: 'factiii-server' })],
          execute: async (args) => {
            args.onPhase?.('running');
            await held;
            return { code: 0, output: '', unlockedBy: null };
          }
        },
        b: { jobs: [job({ name: 'ship2', target: 'factiii-server' })] }
      }
    });
    const linkA = createOpsLink({ client: h.client('a'), hooks: hooks() });
    const linkB = createOpsLink({ client: h.client('b'), hooks: hooks() });
    try {
      const a = await linkA.jobs.call({ job: 'ship', caller: OWNER, via: 'api', mayRunDangerous: true });
      await until(() => linkA.jobs.status(a.callId).state === 'running', 'a running');
      const b = await linkB.jobs.call({ job: 'ship2', caller: MEMBER, via: 'api', mayRunDangerous: false });
      await until(() => linkB.jobs.status(b.callId).state === 'waiting-target', 'b waiting');
      const wait = linkB.jobs.status(b.callId).wait;
      assert.equal(wait?.target, 'factiii-server');
      assert.equal(wait?.holder.board, 'a');
      assert.equal(wait?.position, 1);
      assert.deepEqual(linkB.jobs.active(MEMBER.userId).map((c) => c.state), ['waiting-target']);
      release();
      await until(() => linkB.jobs.status(b.callId).state === 'done', 'b done');
    } finally {
      release();
      linkA.close();
      linkB.close();
    }
  });

  it('a member reads only its own calls through the mirror', async () => {
    const h = await start({ boards: { board: { jobs: [job({})] } } });
    const link = createOpsLink({ client: h.client(), hooks: hooks() });
    try {
      const { callId } = await link.jobs.call({ job: 'echo', caller: OWNER, via: 'api', mayRunDangerous: true });
      await until(() => link.jobs.status(callId).state === 'done');
      assert.throws(() => link.jobs.status(callId, 0, { by: MEMBER, byOwner: false }), /No such job call/);
      assert.equal(link.jobs.status(callId, 0, { by: OWNER, byOwner: true }).state, 'done');
    } finally {
      link.close();
    }
  });
});

describe('ops socket: no op returns a secret value', { skip: hasSecretsBins ? false : 'sops/age not on PATH' }, () => {
  let h: Harness;
  let link: ReturnType<typeof createOpsLink>;
  before(async () => {
    const root = tmp('ops-store-');
    const spaceDir = path.join(root, 'home', 'board', 'boards', 'board');
    fs.mkdirSync(spaceDir, { recursive: true });
    await initSecrets(spaceKeyDir(spaceDir), PASSWORD);
    await setSecret(spaceKeyDir(spaceDir), spaceDir, PASSWORD, 'OPS_TEST_KEY', SECRET);
    h = await harness({
      boards: {
        board: { jobs: [] }
      }
    });
    // Point the harness's board at the store made above, with the real
    // authorizeAndRun (decrypt, inject, redact).
    for (const b of h.boards.values()) b.destroy();
    h.boards.set(
      'board',
      createOpsBoard({
        slug: 'board',
        opsHome: path.join(root, 'home', 'board'),
        spaceDir,
        clone: fakeClone(path.join(root, 'home', 'board'), [
          job({ name: 'leak', command: 'printf "%s\\n" "$OPS_TEST_KEY"', keys: ['OPS_TEST_KEY'] })
        ]),
        githubToken: () => '',
        targets: new JobTargets(),
        uid: UID
      })
    );
    link = createOpsLink({ client: h.client(), hooks: {} });
  });
  after(async () => {
    link.close();
    await h.server.close();
    for (const b of h.boards.values()) b.destroy();
  });

  it('runs the job with the value injected, and every answer is free of it', async () => {
    const c = h.client();
    const seen: string[] = [];
    const ask = async (op: Parameters<typeof c.call>[0], body: Record<string, unknown> = {}) => {
      const frame = await c.call(op, body);
      seen.push(JSON.stringify(frame));
      return frame;
    };
    const stream: string[] = [];
    const tap = c.stream((f) => stream.push(JSON.stringify(f)), () => undefined);
    try {
      await ask('job-list');
      await ask('key-names');
      await ask('secret-recipient');
      await ask('inbox-list');
      const { callId } = (await ask('job-call', { job: 'leak', caller: OWNER, via: 'api', mayRunDangerous: true })) as { callId: string };
      await until(async () => (await c.call('gate-state')).pending !== null, 'prompt');
      const gate = await ask('gate-state');
      const pending = gate.pending as { id: string; keys: string[] };
      assert.deepEqual(pending.keys, ['OPS_TEST_KEY']);
      // A wrong password re-prompts; the right one runs it.
      await ask('gate-answer', { id: pending.id, password: 'wrong-password', by: OWNER, via: 'data-channel' });
      await until(async () => {
        const g = await c.call('gate-state');
        return Boolean((g.pending as { error?: string } | null)?.error);
      }, 're-prompt');
      const again = (await ask('gate-state')).pending as { id: string };
      await ask('gate-answer', { id: again.id, password: PASSWORD, unlockFor: 5, by: OWNER, via: 'data-channel' });
      await until(async () => (await c.call('job-status', { callId })).state === 'done', 'done');
      const status = await ask('job-status', { callId });
      assert.match(JSON.stringify(status.chunks), /\[REDACTED\]/);
      await ask('job-active');
      await ask('audit-read', { limit: 100 });
      await ask('gate-lock', { by: OWNER, via: 'data-channel' });
      const keys = (await ask('key-names')).entries as { key: string; stored: boolean }[];
      assert.deepEqual(keys.map((k) => [k.key, k.stored]), [['OPS_TEST_KEY', true]]);
      // The mirror the engine reads holds only what the socket sent.
      await until(() => {
        try {
          return link.jobs.status(callId).state === 'done';
        } catch {
          return false;
        }
      }, 'mirror');
    } finally {
      tap.close();
    }
    const everything = [...seen, ...stream].join('\n');
    assert.equal(everything.includes(SECRET), false, 'a value crossed the socket');
    assert.equal(everything.includes(PASSWORD), false, 'the password crossed back');
    assert.match(stream.join('\n'), /\[REDACTED\]/);
  });
});

describe('engine with the ops user on', () => {
  it('routes jobs, approvals and the gate to the ops half, and has no local store', async () => {
    const h = await start({
      boards: {
        board: {
          jobs: [job({ name: 'deploy', dangerous: true, keys: ['K'] })],
          // The gate stays open until answered, like a real keyed job.
          execute: async (args) => {
            args.onPhase?.('waiting-auth');
            const answer = await args.gate.request({ command: args.command, keys: args.keys, origin: args.origin, queued: true, job: args.job, caller: args.caller });
            if ('denied' in answer) return { denied: true };
            args.onPhase?.('running');
            return { code: 0, output: '', unlockedBy: null };
          }
        }
      }
    });
    const spaceDir = tmp('ops-space-');
    const relayed: string[] = [];
    const engine = new BoardAgentEngine({
      spaceSlug: 'board',
      emitter: createEventSink(() => undefined, 'board'),
      configProvider: {
        readConfig: () => ({ repoUrl: '', githubToken: '' }) as CardAIConfig,
        writeConfig: () => undefined,
        spaceDir: () => spaceDir
      },
      runnerOwnerId: OWNER.userId,
      onJobState: (callId, state) => relayed.push(`${state}`),
      onJobEnd: (callId, state) => relayed.push(`end:${state}`),
      opsLink: (hooks) => createOpsLink({ client: h.client(), hooks })
    });
    try {
      assert.deepEqual((await engine.jobsList()).jobs.map((j) => j.name), ['deploy']);
      const memberCtx = { actor: MEMBER, via: 'api' as const, role: 'member' as const };
      const ownerCtx = { actor: OWNER, via: 'data-channel' as const, role: 'owner' as const };
      const { callId } = await engine.jobsCall({ job: 'deploy', params: {} }, memberCtx);
      await until(() => engine.dangerousApprovalState(ownerCtx).pending.length === 1, 'approval');
      const [pending] = engine.dangerousApprovalState(ownerCtx).pending;
      assert.equal(engine.dangerousApprovalAnswer({ id: pending?.id ?? '', approve: true }, ownerCtx).success, true);
      await until(() => engine.secretsAuthState().pending !== null, 'prompt');
      assert.deepEqual(engine.secretsAuthState().pending?.keys, ['K']);
      assert.equal(engine.jobStatus({ callId }, ownerCtx).state, 'waiting-auth');
      const id = engine.secretsAuthState().pending?.id ?? '';
      assert.equal(engine.secretsAuthAnswer({ id, password: 'pw' }, ownerCtx).success, true);
      await until(() => engine.jobStatus({ callId }, ownerCtx).state === 'done', 'done');
      assert.deepEqual(relayed.filter((s) => s === 'waiting-owner' || s === 'end:done'), ['waiting-owner', 'end:done']);
      // Nothing was written to the session half's own store.
      assert.equal(fs.existsSync(path.join(spaceDir, 'secrets', 'age-identity.enc')), false);
    } finally {
      engine.destroy();
    }
  });
});

describe('servers registry and setup script', () => {
  it('renders every server as a LaunchDaemon run by factiii-ops, with no secret inline', () => {
    const plists = serverPlists('/private/var/factiii-ops');
    assert.equal(plists.length, MACHINE_SERVERS.length);
    for (const { file, content } of plists) {
      assert.match(file, /^com\.factiii\.ops\.[a-z-]+\.plist$/);
      assert.match(content, /<key>UserName<\/key><string>factiii-ops<\/string>/);
      assert.match(content, /<key>HOME<\/key><string>\/private\/var\/factiii-ops<\/string>/);
      assert.doesNotMatch(content, /\/Users\/jon|\{servers\}|\{home\}/);
      assert.doesNotMatch(content, /TOKEN=|API_KEY=|PASSWORD=/);
    }
    const frps = plists.find((p) => p.file === 'com.factiii.ops.frps.plist')?.content ?? '';
    assert.match(frps, /<string>\/private\/var\/factiii-ops\/servers\/dev-tunnel\/bin\/frps<\/string>/);
    const cal = renderLaunchDaemon({
      label: 'x',
      program: ['/bin/true'],
      run: { kind: 'calendar', weekday: 1, hour: 4, minute: 17 },
      opsHome: '/h',
      log: '/h/l'
    });
    assert.match(cal, /<key>Weekday<\/key><integer>1<\/integer>/);
  });

  it('the setup script creates the hidden user, the group, the dirs and the daemon; refuses odd input', () => {
    const script = macSetupScript({
      user: 'jon',
      opsHome: '/private/var/factiii-ops',
      runDir: '/private/var/factiii-ops-run',
      serveProgram: ['/usr/local/bin/node', '/x/factiii-runner.js', 'ops', 'serve']
    });
    assert.match(script, /dscl \. -create \/Users\/factiii-ops IsHidden 1/);
    assert.match(script, /UserShell \/usr\/bin\/false/);
    assert.match(script, /dseditgroup -o edit -a jon -t user factiii/);
    assert.match(script, /-m 1730 \/private\/var\/factiii-ops-run\/peer/);
    assert.match(script, /launchctl bootstrap system \/Library\/LaunchDaemons\/com\.factiii\.ops\.plist/);
    assert.match(script, /<key>GroupName<\/key><string>factiii<\/string>/);
    assert.throws(() => macSetupScript({ user: 'jon; rm -rf /', opsHome: '/h', runDir: '/r', serveProgram: [] }), /will not quote/);
  });

  it('the setting is off unless ops.json says on, and off on Windows', () => {
    const dir = tmp('ops-cfg-');
    assert.equal(readOpsSettings(dir, 'darwin').enabled, false);
    writeOpsSettings(dir, { enabled: true, runDir: '/r' });
    assert.equal(readOpsSettings(dir, 'darwin').enabled, true);
    assert.equal(readOpsSettings(dir, 'win32').enabled, false);
    fs.writeFileSync(path.join(dir, 'ops.json'), '{nope');
    assert.equal(readOpsSettings(dir, 'darwin').enabled, false);
  });
});

describe('update verifier', () => {
  const TEAM = 'ABCDE12345';
  const mac = (o: { verify?: number; team?: string; authority?: string; spctl?: string; spctlCode?: number }): Exec =>
    async (cmd, args) => {
      if (cmd.endsWith('codesign') && args[0] === '--verify') {
        return { code: o.verify ?? 0, stdout: '', stderr: o.verify ? 'code object is not signed at all' : 'valid on disk' };
      }
      if (cmd.endsWith('codesign')) {
        return {
          code: 0,
          stdout: '',
          stderr: `Executable=/Applications/Factiii.app/Contents/MacOS/Factiii\nAuthority=${o.authority ?? 'Developer ID Application: Factiii Inc (ABCDE12345)'}\nAuthority=Developer ID Certification Authority\nTeamIdentifier=${o.team ?? TEAM}\n`
        };
      }
      return {
        code: o.spctlCode ?? 0,
        stdout: '',
        stderr: o.spctl ?? '/Applications/Factiii.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Factiii Inc (ABCDE12345)\n'
      };
    };

  it('accepts a notarized bundle of the pinned team', async () => {
    assert.deepEqual(await verifyMacApp('/A.app', { teamId: TEAM, exec: mac({}) }), { ok: true });
  });

  it('rejects unsigned, wrong-team, non-Developer-ID and un-notarized bundles', async () => {
    const reason = async (o: Parameters<typeof mac>[0]) => {
      const v = await verifyMacApp('/A.app', { teamId: TEAM, exec: mac(o) });
      return v.ok ? 'ok' : v.reason;
    };
    assert.match(await reason({ verify: 1 }), /signature invalid/);
    assert.match(await reason({ team: 'not set' }), /unsigned/);
    assert.match(await reason({ team: 'ZZZZZ99999' }), /team ZZZZZ99999, not ABCDE12345/);
    assert.match(await reason({ authority: 'Apple Development: someone' }), /not a Developer ID/);
    assert.match(await reason({ spctl: '/A.app: rejected\nsource=Unnotarized Developer ID', spctlCode: 3 }), /Gatekeeper rejected/);
    assert.match(await reason({ spctl: '/A.app: accepted\nsource=Developer ID' }), /not notarized/);
    assert.equal((await verifyMacApp('/A.app', { teamId: 'bad', exec: mac({}) })).ok, false);
  });

  it('checks a Linux tarball signature and a Windows signer', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const tar = Buffer.from('release bytes');
    const sig = sign(null, createHash('sha256').update(tar).digest(), privateKey).toString('base64');
    assert.deepEqual(verifyLinuxTarball(tar, sig, pem), { ok: true });
    assert.equal(verifyLinuxTarball(Buffer.from('tampered'), sig, pem).ok, false);
    assert.equal(verifyLinuxTarball(tar, sig, 'not a key').ok, false);
    const report = (status: unknown, thumb: string) => JSON.stringify({ Status: status, SignerCertificate: { Thumbprint: thumb } });
    assert.deepEqual(verifyAuthenticode(report(0, 'aa11'), { thumbprint: 'AA11' }), { ok: true });
    assert.equal(verifyAuthenticode(report(1, 'AA11'), { thumbprint: 'AA11' }).ok, false);
    assert.equal(verifyAuthenticode(report('Valid', 'BB22'), { thumbprint: 'AA11' }).ok, false);
  });

  it('discards a refused update, and rolls back one that fails its health check', async () => {
    const steps: string[] = [];
    const base = {
      discard: async () => void steps.push('discard'),
      swap: async () => void steps.push('swap'),
      restart: async () => void steps.push('restart'),
      rollback: async () => void steps.push('rollback')
    };
    const refused = await installRelease({ ...base, verify: async () => ({ ok: false, reason: 'unsigned' }), health: async () => true });
    assert.deepEqual(refused, { ok: false, reason: 'unsigned', rolledBack: false });
    assert.deepEqual(steps, ['discard']);
    steps.length = 0;
    const sick = await installRelease({ ...base, verify: async () => ({ ok: true }), health: async () => false });
    assert.deepEqual(sick, { ok: false, reason: 'health check failed', rolledBack: true });
    assert.deepEqual(steps, ['swap', 'restart', 'rollback', 'restart']);
    steps.length = 0;
    assert.deepEqual(await installRelease({ ...base, verify: async () => ({ ok: true }), health: async () => true }), { ok: true });
    assert.deepEqual(steps, ['swap', 'restart']);
  });
});
