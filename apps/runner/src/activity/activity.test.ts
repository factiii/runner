import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { CardAISessionSummary, RunnerGrants } from '@shared/all/domains/electron';
import type {
  RunnerActivityView,
  RunnerJob,
  RunnerJobHistoryPage,
  RunnerJobLog
} from '@shared/all/domains/runnerActivity';
import type { VouchedScope } from '@shared/all/helpers/board-agent-core/runner-access';

import { ACTIVITY_REFUSAL, ACTIVITY_SETTINGS_REFUSAL, mayOpenActivity, mayWatchJob, NO_SUCH_JOB } from './access';
import { type ActivityBoard, createActivityHost, readOllamaService } from './daemonActivity';
import { JobHistory } from './history';
import { JobRegistry } from './registry';

// The runner's Activity (card 9b50ee2e) against temporary folders and fake
// boards: the registry, Vault jobs kept as metadata only, History's search
// and purge, who may see and stop a job, and the sessions folded in. Nothing
// here reads the runner folder or a real engine, and nothing is macOS-only.

const DAY = 24 * 60 * 60_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-activity-'));

const owner: VouchedScope = { role: 'owner', userId: '1', name: 'Jon' };
const member = (userId: string, spaceSlugs: string[]): VouchedScope => ({
  role: 'member',
  userId,
  name: `Member ${userId}`,
  spaceSlugs
});

/** Every file under `dir`, read whole (node 20's fs, no `parentPath`). */
const everything = (dir: string): string =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? everything(full) : fs.readFileSync(full, 'utf-8');
    })
    .join('\n');

describe('the job registry', () => {
  it('registers a job on start and closes it on end, into History', () => {
    const dir = tmp();
    const history = new JobHistory(dir);
    const registry = new JobRegistry({ history });
    const job = registry.start({
      type: 'ai-request',
      engine: 'claude',
      title: 'A title',
      startedBy: { userId: 1, name: 'Jon', role: 'owner' },
      log: true,
      stop: () => undefined
    });
    job.log('Prompt: hello\n');
    assert.equal(registry.running().length, 1);
    assert.equal(registry.running()[0]!.stoppable, true);
    assert.equal(registry.log(job.id), 'Prompt: hello\n');
    job.end('done');
    assert.equal(registry.running().length, 0);
    const [kept] = registry.recent();
    assert.equal(kept!.status, 'done');
    assert.ok(kept!.endedAt);
    assert.equal(kept!.stoppable, false);
    assert.equal(history.get(job.id)?.title, 'A title');
    assert.equal(history.log(job.id), 'Prompt: hello\n');
    // A second end changes nothing.
    job.end('failed', 'late');
    assert.equal(history.get(job.id)?.status, 'done');
  });

  it('keeps a Vault job as metadata only, whatever it is handed', () => {
    const dir = tmp();
    const registry = new JobRegistry({ history: new JobHistory(dir) });
    const secret = 'the patient record says SECRET-TEXT';
    for (const type of ['research', 'tagging', 'findings'] as const) {
      // `vault` left out on purpose: the type alone makes it a Vault job.
      const job = registry.start({
        type,
        engine: 'ollama',
        title: secret,
        log: true,
        session: { spaceSlug: 'b', postId: secret }
      });
      job.log(secret);
      job.setItems(3);
      assert.equal(registry.log(job.id), null);
      job.end('failed', secret);
    }
    const jobs = registry.recent();
    assert.equal(jobs.length, 3);
    for (const job of jobs) {
      assert.equal(job.vault, true);
      assert.equal(job.hasLog, false);
      assert.equal(job.error, null);
      assert.equal(job.session, null);
      assert.equal(job.items, 3);
      assert.equal(job.status, 'failed');
      assert.ok(!JSON.stringify(job).includes('SECRET'));
    }
    // Nor on disk: History's lines, no log file.
    assert.ok(!everything(dir).includes('SECRET'));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'logs')), []);
  });

  it('is a Vault job when told so, whatever its type', () => {
    const registry = new JobRegistry({ history: null });
    const job = registry.start({ type: 'ai-request', title: 'SECRET', vault: true, log: true });
    job.log('SECRET');
    assert.equal(registry.running()[0]!.title, 'AI request');
    assert.equal(registry.log(job.id), null);
  });

  it('stops a job: its stop runs, it ends stopped, and the starter is told', async () => {
    const told: RunnerJob[] = [];
    let aborted = false;
    const registry = new JobRegistry({ history: null, onStopped: (job) => told.push(job) });
    const job = registry.start({
      type: 'ask',
      startedBy: { userId: 5, name: 'Ann', role: 'member' },
      stop: () => {
        aborted = true;
        // The job's own failure path, as an aborted CLI reports it.
        job.end('failed', 'killed');
      }
    });
    assert.equal(await registry.stop(job.id, 'Jon'), true);
    assert.equal(aborted, true);
    const [ended] = registry.recent();
    assert.equal(ended!.status, 'stopped');
    assert.equal(ended!.stoppedBy, 'Jon');
    assert.equal(ended!.error, null);
    assert.equal(told.length, 1);
    assert.equal(told[0]!.startedBy?.userId, 5);
    // Gone: nothing to stop.
    assert.equal(await registry.stop(job.id, 'Jon'), false);
  });

  it('cannot stop a job with no stop', async () => {
    const registry = new JobRegistry({ history: null });
    const job = registry.start({ type: 'model-download' });
    assert.equal(registry.running()[0]!.stoppable, false);
    assert.equal(await registry.stop(job.id, 'Jon'), false);
    assert.equal(registry.running().length, 1);
  });

  it('cuts a log at its cap', () => {
    const registry = new JobRegistry({ history: null });
    const job = registry.start({ type: 'ai-request', log: true });
    job.log('x'.repeat(300 * 1024));
    job.log('more');
    const log = registry.log(job.id)!;
    assert.ok(log.length < 260 * 1024);
    assert.ok(log.endsWith('256 KB.]\n'));
  });
});

describe('History', () => {
  const finished = (history: JobHistory, at: number, over: Partial<RunnerJob>) => {
    const registry = new JobRegistry({ history, now: () => at });
    const job = registry.start({ type: 'ai-request', ...over, title: over.title ?? 'Job' });
    job.end('done');
    return job.id;
  };

  it('searches by type, engine, board, starter and text, newest first, a page at a time', () => {
    const history = new JobHistory(tmp());
    const now = 1_800_000_000_000;
    finished(history, now - 3000, { type: 'ask', engine: 'claude', board: 'alpha', title: 'Ask AI · Alpha' });
    finished(history, now - 2000, { type: 'coding', engine: 'codex', board: 'beta', title: 'Fix login' });
    finished(history, now - 1000, {
      type: 'ai-request',
      engine: 'ollama',
      startedBy: { userId: 9, name: 'Ann', role: 'member' }
    });
    const all = () => true;
    assert.deepEqual(
      history.search({}, all).jobs.map((j) => j.type),
      ['ai-request', 'coding', 'ask']
    );
    assert.equal(history.search({ type: 'coding' }, all).jobs[0]!.title, 'Fix login');
    assert.equal(history.search({ engine: 'claude' }, all).jobs[0]!.type, 'ask');
    assert.equal(history.search({ board: 'beta' }, all).jobs.length, 1);
    assert.equal(history.search({ starter: 'ann' }, all).jobs.length, 1);
    assert.equal(history.search({ starter: '9' }, all).jobs.length, 1);
    assert.equal(history.search({ query: 'LOGIN' }, all).jobs.length, 1);
    assert.equal(history.search({ query: 'ollama' }, all).jobs.length, 1);
    const first = history.search({ limit: 2 }, all);
    assert.equal(first.jobs.length, 2);
    assert.ok(first.next);
    const second = history.search({ limit: 2, before: first.next! }, all);
    assert.deepEqual(second.jobs.map((j) => j.type), ['ask']);
    assert.equal(second.next, null);
    // What the caller may not see is not there for them.
    assert.equal(history.search({}, (job) => job.board === 'alpha').jobs.length, 1);
  });

  it('purges what is older than the setting, with its log', () => {
    const dir = tmp();
    const now = 1_800_000_000_000;
    const history = new JobHistory(dir, () => now);
    assert.equal(history.retentionDays(), 30);
    const registry = new JobRegistry({ history, now: () => now - 10 * DAY });
    const old = registry.start({ type: 'ai-request', log: true });
    old.log('old prompt');
    old.end('done');
    const fresh = finished(history, now - DAY, {});
    assert.equal(history.purge().size, 0);
    assert.equal(history.setRetentionDays(7), 7);
    const dropped = history.purge();
    assert.deepEqual([...dropped], [old.id]);
    assert.equal(history.get(old.id), null);
    assert.ok(history.get(fresh));
    assert.ok(!fs.existsSync(path.join(dir, 'logs', `${old.id}.log`)));
    // Out of bounds is held to them.
    assert.equal(history.setRetentionDays(0), 1);
    assert.equal(history.setRetentionDays(10_000), 365);
  });

  it('reads Recent back after a restart', () => {
    const dir = tmp();
    finished(new JobHistory(dir), 1000, { title: 'Before the restart' });
    const registry = new JobRegistry({ history: new JobHistory(dir) });
    assert.equal(registry.recent()[0]!.title, 'Before the restart');
  });
});

describe('who sees Activity', () => {
  const grants: RunnerGrants = { alpha: { '5': 'shell', '6': 'jobs' }, beta: { '6': 'shell' } };

  it('gives the owner every job', () => {
    assert.equal(mayWatchJob(owner, grants, { board: null }), true);
    assert.equal(mayWatchJob(owner, grants, { board: 'alpha' }), true);
  });

  it('gives a member at Shell their board’s jobs, never runner-wide work', () => {
    const ann = member('5', ['alpha', 'beta']);
    assert.equal(mayOpenActivity(ann, grants), true);
    assert.equal(mayWatchJob(ann, grants, { board: 'alpha' }), true);
    assert.equal(mayWatchJob(ann, grants, { board: 'beta' }), false);
    assert.equal(mayWatchJob(ann, grants, { board: null }), false);
  });

  it('refuses a limited member', () => {
    // Jobs on alpha, and Shell on beta - but the server named only alpha.
    const bob = member('6', ['alpha']);
    assert.equal(mayOpenActivity(bob, grants), false);
    assert.equal(mayWatchJob(bob, grants, { board: 'alpha' }), false);
    assert.equal(mayWatchJob(bob, grants, { board: 'beta' }), false);
    assert.equal(mayOpenActivity(member('7', ['alpha']), grants), false);
  });
});

/** A board engine with sessions in a map the test changes. */
const fakeBoard = () => {
  const sessions = new Map<string, Partial<CardAISessionSummary>>();
  const stopped: string[] = [];
  const fake = {
    sessions,
    stopped,
    /** The runner that started a session through the relay (none here). */
    startedByRunner: (_postId: string): string | undefined => undefined,
    board: null as unknown as ActivityBoard
  };
  fake.board = {
    cardSessions: () => Object.fromEntries(sessions),
    sessionStarter: (postId) =>
      postId === 'p2' ? { userId: '5', name: 'Ann', role: 'member' } : undefined,
    sessionStartedByRunner: (postId) => fake.startedByRunner(postId),
    stopSession: async (postId) => {
      stopped.push(postId);
      return true;
    }
  };
  return fake;
};

describe('the daemon host', () => {
  const host = (grants: RunnerGrants = {}) => {
    const alpha = fakeBoard();
    const told: RunnerJob[] = [];
    const activity = createActivityHost({
      dir: tmp(),
      grants: () => grants,
      owner: () => ({ userId: '1', name: 'Jon' }),
      boardName: (slug) => slug.toUpperCase(),
      boards: () => [['alpha', alpha.board]],
      ollama: async () => null,
      onStopped: (job) => told.push(job)
    });
    return { activity, alpha, told };
  };

  it('folds sessions in as coding jobs, and ends one that is gone or over', async () => {
    const { activity, alpha } = host();
    alpha.sessions.set('p1', { postId: 'p1', taskTitle: 'Fix it', provider: 'claude', phase: 'bare-active', agentState: 'working', startedAt: 10 });
    alpha.sessions.set('p2', { postId: 'p2', taskTitle: 'Card run', chatCli: 'codex', phase: 'implement', startedAt: 20 });
    const view = (await activity.handle('runnerActivity', undefined, owner)) as RunnerActivityView;
    assert.deepEqual(
      view.running.map((j) => [j.type, j.title, j.engine, j.boardName, j.startedBy?.name, j.session?.postId]),
      // The terminal's job is its turn, started now: newest first.
      [
        ['coding', 'Fix it', 'claude', 'ALPHA', 'Jon', 'p1'],
        ['coding', 'Card run', 'codex', 'ALPHA', 'Ann', 'p2']
      ]
    );
    // A second read starts nothing twice.
    activity.syncSessions();
    assert.equal(activity.registry.running().length, 2);
    alpha.sessions.delete('p1');
    alpha.sessions.set('p2', { ...alpha.sessions.get('p2'), phase: 'error', error: 'boom' });
    activity.syncSessions();
    assert.equal(activity.registry.running().length, 0);
    assert.deepEqual(
      activity.registry.recent().map((j) => [j.title, j.status]),
      [
        ['Card run', 'failed'],
        ['Fix it', 'done']
      ]
    );
  });

  it('runs a terminal job only while its turn is live: at rest or in review it ends', async () => {
    const { activity, alpha } = host();
    // Open, but no CLI or chat at work: nothing runs.
    alpha.sessions.set('p1', { postId: 'p1', taskTitle: 'Fix it', phase: 'bare-active', startedAt: 10 });
    activity.syncSessions();
    assert.equal(activity.registry.running().length, 0);
    // A turn starts: a job, from now rather than when the terminal opened.
    alpha.sessions.set('p1', { ...alpha.sessions.get('p1'), agentState: 'working' });
    activity.syncSessions();
    const [turn] = activity.registry.running();
    assert.notEqual(turn?.startedAt, 10);
    // Waiting on a permission is still the turn.
    alpha.sessions.set('p1', { ...alpha.sessions.get('p1'), agentState: 'blocked' });
    activity.syncSessions();
    assert.equal(activity.registry.running()[0]?.id, turn?.id);
    // The turn ends: the job is done, and the board is no longer busy.
    alpha.sessions.set('p1', { ...alpha.sessions.get('p1'), agentState: 'idle' });
    activity.syncSessions();
    assert.equal(activity.registry.running().length, 0);
    assert.deepEqual(activity.registry.recent().map((j) => j.status), ['done']);
    // In review, even with the last state still working: nothing runs.
    alpha.sessions.set('p1', { ...alpha.sessions.get('p1'), phase: 'bare-review', agentState: 'working' });
    activity.syncSessions();
    assert.equal(activity.registry.running().length, 0);
  });

  it('stops a session from Activity and tells its starter; it is not taken up again', async () => {
    const { activity, alpha, told } = host();
    alpha.sessions.set('p2', { postId: 'p2', taskTitle: 'Card run', phase: 'bare-active', agentState: 'working' });
    const [job] = ((await activity.handle('runnerActivity', undefined, owner)) as RunnerActivityView).running;
    const result = await activity.handle('runnerJobStop', { id: job!.id }, owner);
    assert.deepEqual(result, { stopped: true });
    assert.deepEqual(alpha.stopped, ['p2']);
    assert.equal(told[0]!.startedBy?.name, 'Ann');
    assert.equal(told[0]!.stoppedBy, 'Jon');
    // Its record stays (stopSession), and that is not new work.
    activity.syncSessions();
    assert.equal(activity.registry.running().length, 0);
  });

  it('refuses a limited member every action, and hides another board’s jobs', async () => {
    const grants: RunnerGrants = { alpha: { '5': 'jobs' }, beta: { '6': 'shell' } };
    const { activity, alpha } = host(grants);
    alpha.sessions.set('p1', { postId: 'p1', taskTitle: 'Fix it', phase: 'bare-active', agentState: 'working' });
    const [job] = ((await activity.handle('runnerActivity', undefined, owner)) as RunnerActivityView).running;
    const limited = member('5', ['alpha']);
    for (const [action, payload] of [
      ['runnerActivity', undefined],
      ['runnerJobHistory', {}],
      ['runnerJobLog', { id: job!.id }],
      ['runnerJobStop', { id: job!.id }]
    ] as const) {
      await assert.rejects(activity.handle(action, payload, limited), { message: ACTIVITY_REFUSAL });
    }
    // Full access on beta: Activity opens, but alpha's job is not theirs.
    const other = member('6', ['beta']);
    const view = (await activity.handle('runnerActivity', undefined, other)) as RunnerActivityView;
    assert.deepEqual(view.running, []);
    assert.equal(view.owner, false);
    await assert.rejects(activity.handle('runnerJobStop', { id: job!.id }, other), { message: NO_SUCH_JOB });
    await assert.rejects(activity.handle('runnerJobLog', { id: job!.id }, other), { message: NO_SUCH_JOB });
    await assert.rejects(
      activity.handle('runnerActivitySettings', { retentionDays: 3 }, other),
      { message: ACTIVITY_SETTINGS_REFUSAL }
    );
    assert.equal(activity.registry.running().length, 1);
  });

  it('answers a log: the text of a background job, a note for a Vault job or a terminal', async () => {
    const { activity, alpha } = host();
    const ask = activity.start({ type: 'ask', log: true, board: 'alpha' });
    ask.log('Question: why?');
    const research = activity.start({ type: 'research' });
    alpha.sessions.set('p1', { postId: 'p1', phase: 'bare-active', agentState: 'working' });
    activity.syncSessions();
    const coding = activity.registry.running().find((j) => j.type === 'coding')!;
    const read = (id: string) => activity.handle('runnerJobLog', { id }, owner) as Promise<RunnerJobLog>;
    assert.equal((await read(ask.id)).text, 'Question: why?');
    assert.match((await read(research.id)).note ?? '', /Vault job keeps no log/);
    assert.match((await read(coding.id)).note ?? '', /open its terminal/);
  });

  it('lets the owner set the days and finds History', async () => {
    const { activity } = host();
    activity.start({ type: 'ai-request', title: 'Title for a recording' }).end('done');
    const page = (await activity.handle('runnerJobHistory', { query: 'recording' }, owner)) as RunnerJobHistoryPage;
    assert.equal(page.jobs.length, 1);
    const view = (await activity.handle('runnerActivitySettings', { retentionDays: 3 }, owner)) as RunnerActivityView;
    assert.equal(view.retentionDays, 3);
  });

  it('keeps "Allow sessions to be started from other runners" off until the owner turns it on', async () => {
    const { activity } = host({ beta: { '6': 'shell' } });
    const before = (await activity.handle('runnerActivity', undefined, owner)) as RunnerActivityView;
    assert.equal(before.allowRemoteStarts, false);
    assert.equal(activity.allowRemoteStarts(), false);
    const on = (await activity.handle('runnerActivitySettings', { allowRemoteStarts: true }, owner)) as RunnerActivityView;
    assert.equal(on.allowRemoteStarts, true);
    // The days are kept beside it.
    await activity.handle('runnerActivitySettings', { retentionDays: 9 }, owner);
    assert.equal(activity.allowRemoteStarts(), true);
    const member6 = member('6', ['beta']);
    await assert.rejects(
      activity.handle('runnerActivitySettings', { allowRemoteStarts: false }, member6),
      { message: ACTIVITY_SETTINGS_REFUSAL }
    );
  });

  it('labels a session another runner started', async () => {
    const { activity, alpha } = host();
    alpha.sessions.set('p9', { postId: 'p9', taskTitle: 'Run X', phase: 'bare-active', agentState: 'working' });
    alpha.startedByRunner = () => 'laptop';
    activity.syncSessions();
    const job = activity.registry.running().find((j) => j.session?.postId === 'p9');
    assert.equal(job?.startedByRunner, 'laptop');
  });
});

describe('the Ollama service row', () => {
  it('is null without Ollama, down when it does not answer, and lists what is loaded', async () => {
    assert.equal(await readOllamaService('http://x', async () => false), null);
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    assert.deepEqual(await readOllamaService('http://x', async () => true, down), { running: false, models: [] });
    const up = (async () =>
      new Response(JSON.stringify({ models: [{ name: 'qwen3:8b', size: 5 * 1024 * 1024 * 1024 }] }))) as unknown as typeof fetch;
    assert.deepEqual(await readOllamaService('http://x', async () => true, up), {
      running: true,
      models: [{ name: 'qwen3:8b', memoryMb: 5120 }]
    });
  });
});
