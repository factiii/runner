import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  SESSION_FILES_MAX_BYTES,
  SESSION_FILES_MAX_BYTES_CEILING,
  type SessionRelayAnswer
} from '@shared/all/domains/sessionRelay';
import { describeSourceFile } from '@shared/all/helpers/board-agent-core/session-files';
import type {
  HypervisorBoard,
  HypervisorHost
} from '@shared/all/helpers/board-agent-core/session-hypervisor';
import type { RunnerSessionsReport, SessionRelayRequest } from '@shared/all/validators';

import {
  createRelayRemote,
  createSessionsReporter,
  probeRunnerOffers,
  sessionFilesConfig,
  sessionsReport
} from './sessionRelay';

// This runner's side of sessions across runners (.specs/card-sessions.md
// "Across runners"): the relay's calls and refusals, the directory report,
// and what the runner offers. No socket, no server, nothing macOS-only.

const origin = { actor: { userId: '1', name: 'Jon' }, from: { board: 'a', session: 'bare-me' } };

describe('the relay', () => {
  it('sends each call as one request and returns its answer', async () => {
    const sent: SessionRelayRequest[] = [];
    const remote = createRelayRemote(async (req) => {
      sent.push(req);
      const answers: Record<string, SessionRelayAnswer> = {
        runners: { runners: [] },
        sessions: { sessions: [], unreachable: ['mini (r3, offline)'] },
        message: { messageId: 'm1', state: 'waiting' },
        start: { sessionId: 'bare-x' }
      };
      return answers[req.op]!;
    });
    assert.deepEqual(await remote.runners(origin), []);
    assert.deepEqual(await remote.sessions(origin, 'a'), { sessions: [], unreachable: ['mini (r3, offline)'] });
    assert.deepEqual(await remote.message(origin, { runner: 'r3', board: 'a', session: 's', text: 'hi' }), {
      messageId: 'm1',
      state: 'waiting'
    });
    assert.deepEqual(
      await remote.start(origin, { runner: 'r3', board: 'a', start: { mode: 'chat', message: 'go' } }),
      { sessionId: 'bare-x' }
    );
    assert.deepEqual(
      sent.map((r) => r.op),
      ['runners', 'sessions', 'message', 'start']
    );
    // The asking session and its person ride on every call.
    assert.deepEqual(sent[2], { op: 'message', runner: 'r3', board: 'a', session: 's', text: 'hi', ...origin });
  });

  it('throws the server’s refusal as the error', async () => {
    const remote = createRelayRemote(async () => ({ error: 'laptop’s owner has not allowed it.' }));
    await assert.rejects(
      remote.start(origin, { runner: 'r3', board: 'a', start: { mode: 'chat', message: 'go' } }),
      { message: 'laptop’s owner has not allowed it.' }
    );
  });

  it('refuses an answer of the wrong shape', async () => {
    const remote = createRelayRemote(async () => ({ sessionId: 'x' }));
    await assert.rejects(remote.runners(origin), /no answer this runner understands/);
  });
});

const board = (ids: string[]): HypervisorBoard =>
  ({
    sessions: () =>
      ids.map((id) => ({ id, title: `t-${id}`, state: 'idle', mode: 'Chat', cardId: null, worktree: '' }))
  }) as unknown as HypervisorBoard;

const host = (boards: Record<string, string[]>): HypervisorHost => ({
  runner: 'mini',
  owner: () => ({ userId: '1', name: 'Jon', role: 'owner' }),
  boards: () => Object.keys(boards),
  board: (slug) => (boards[slug] ? board(boards[slug]!) : null),
  level: () => 'owner'
});

const OFFERS = { os: 'linux x64', tart: false, simulator: false, gpu: false };

describe('the directory report', () => {
  it('names every board’s sessions, titles only, with the offers and the setting', () => {
    const report = sessionsReport(host({ a: ['s1'], b: [] }), OFFERS, false);
    assert.deepEqual(report, {
      boards: [
        { spaceSlug: 'a', sessions: [{ id: 's1', title: 't-s1', state: 'idle', mode: 'Chat', card: null }] },
        { spaceSlug: 'b', sessions: [] }
      ],
      offers: OFFERS,
      allowRemoteStarts: false,
      busy: { boards: [], runnerWide: false }
    });
  });

  it('says where work is running, board slugs only', () => {
    const report = sessionsReport(host({ a: [] }), OFFERS, false, [
      { board: 'b' },
      { board: 'a' },
      { board: 'b' },
      { board: null }
    ]);
    assert.deepEqual(report.busy, { boards: ['a', 'b'], runnerWide: true });
  });

  it('is sent on now(), and on the timer only when it changed', () => {
    const sent: RunnerSessionsReport[] = [];
    let boards: Record<string, string[]> = { a: ['s1'] };
    const reporter = createSessionsReporter({
      report: () => sessionsReport(host(boards), OFFERS, true),
      send: (r) => sent.push(r),
      connected: () => true,
      intervalMs: 60 * 60_000
    });
    reporter.now();
    reporter.now();
    // A connect says it again, whatever was sent before.
    assert.equal(sent.length, 2);
    boards = { a: ['s1', 's2'] };
    reporter.now();
    assert.equal(sent.at(-1)!.boards[0]!.sessions.length, 2);
    reporter.stop();
  });

  it('says it again on the next look after a drop, though nothing changed', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const sent: RunnerSessionsReport[] = [];
    const reporter = createSessionsReporter({
      report: () => sessionsReport(host({ a: ['s1'] }), OFFERS, false),
      send: (r) => sent.push(r),
      connected: () => true,
      intervalMs: 1000
    });
    reporter.now();
    t.mock.timers.tick(1000);
    assert.equal(sent.length, 1);
    // A reconnect inside one look: the new connection has no report.
    reporter.reset();
    t.mock.timers.tick(1000);
    assert.equal(sent.length, 2);
    reporter.stop();
  });

  it('sends nothing while offline', () => {
    const sent: RunnerSessionsReport[] = [];
    const reporter = createSessionsReporter({
      report: () => sessionsReport(host({ a: [] }), OFFERS, false),
      send: (r) => sent.push(r),
      connected: () => false,
      intervalMs: 60 * 60_000
    });
    reporter.now();
    assert.equal(sent.length, 0);
    reporter.stop();
  });
});

describe('what a runner offers', () => {
  it('reads Tart, the simulator and a GPU off the machine', async () => {
    const has = (found: string[]) => async (cmd: string) => found.includes(cmd);
    assert.deepEqual(await probeRunnerOffers(has(['tart', 'xcrun']), 'darwin', 'arm64'), {
      os: 'darwin arm64',
      tart: true,
      simulator: true,
      gpu: true
    });
    // Linux: no simulator, a GPU only with nvidia-smi.
    assert.deepEqual(await probeRunnerOffers(has(['xcrun']), 'linux', 'x64'), {
      os: 'linux x64',
      tart: false,
      simulator: false,
      gpu: false
    });
    assert.equal((await probeRunnerOffers(has(['nvidia-smi']), 'linux', 'x64')).gpu, true);
  });
});

describe('files between sessions', () => {
  it('asks for a file’s description, then its chunks, over the relay', async () => {
    const sent: SessionRelayRequest[] = [];
    const remote = createRelayRemote(async (req) => {
      sent.push(req);
      if (req.op !== 'file') return { error: 'no' };
      return req.part === 'info'
        ? { file: { name: 'a.txt', bytes: 2, sha256: 'f'.repeat(64), chunks: 1 } }
        : { chunk: 'aGk=' };
    });
    const target = { runner: 'r3', board: 'a', session: 's', path: 'a.txt' };
    assert.deepEqual(await remote.file!(origin, { ...target, part: 'info' }), {
      file: { name: 'a.txt', bytes: 2, sha256: 'f'.repeat(64), chunks: 1 }
    });
    assert.deepEqual(await remote.file!(origin, { ...target, part: 0 }), { chunk: 'aGk=' });
    assert.deepEqual(
      sent.map((r) => (r.op === 'file' ? r.part : r.op)),
      ['info', 0]
    );
  });

  it('caps a call at 50 MB unless the runner sets its own, never over the ceiling', () => {
    assert.equal(sessionFilesConfig('/r', {}).maxBytes, SESSION_FILES_MAX_BYTES);
    assert.equal(sessionFilesConfig('/r', { FACTIII_SESSION_FILES_MAX_MB: '5' }).maxBytes, 5 * 1024 * 1024);
    assert.equal(
      sessionFilesConfig('/r', { FACTIII_SESSION_FILES_MAX_MB: '99999' }).maxBytes,
      SESSION_FILES_MAX_BYTES_CEILING
    );
    assert.equal(sessionFilesConfig('/r', { FACTIII_SESSION_FILES_MAX_MB: 'lots' }).maxBytes, SESSION_FILES_MAX_BYTES);
  });

  it('never sends the Vault or the phone vault’s backups, even through a link', () => {
    const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-files-'));
    const work = path.join(runnerDir, 'spaces', 'a', 'worktrees', 'bare-1');
    const vault = path.join(runnerDir, 'parts', 'vault');
    const backups = path.join(runnerDir, 'vault-backups');
    for (const dir of [work, vault, backups]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(vault, 'db.sealed'), 'x');
    fs.writeFileSync(path.join(backups, 'phone.pkg'), 'x');
    fs.symlinkSync(path.join(vault, 'db.sealed'), path.join(work, 'db.txt'));
    fs.symlinkSync(backups, path.join(work, 'backups'));
    fs.writeFileSync(path.join(work, 'ok.txt'), 'fine');
    const rules = { ...sessionFilesConfig(runnerDir, {}), roots: [work] };
    assert.equal(describeSourceFile(rules, 'ok.txt').bytes, 4);
    for (const p of ['db.txt', 'backups/phone.pkg', path.join(vault, 'db.sealed')]) {
      assert.throws(() => describeSourceFile(rules, p), /Vault never leaves/);
    }
  });
});
