import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import type { OpsBoard } from './board';
import { opsClient } from './client';
import { startOpsServer } from './server';
import { macSetupScript } from './setup';
import { opsServicePlist } from './servers';
import { hasStore, removeOldStores, writeOpsStage } from './stage';
import { opsStatusReport, pidAlive } from './status';
import { compareVersions, createOpsUpdater, nextStep, type Release } from './updater';
import { applyMacUpdate, parseLatestMacYml, stageMacRelease } from './updaterMac';
import type { Exec } from './updateVerify';

// Factiii Desktop's side of the ops user (.specs/ops-user.md, "Factiii
// Desktop"): the stage it writes before the admin prompt, the migration in
// the setup script and that a repeat (repair) never overwrites the ops
// store, the status Desktop reads, and the updater's decisions and swap.

const roots: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeStore(spaceDir: string, marker: string): void {
  fs.mkdirSync(path.join(spaceDir, 'secrets', 'files'), { recursive: true });
  fs.writeFileSync(path.join(spaceDir, 'secrets', 'age-identity.enc'), marker);
  fs.writeFileSync(path.join(spaceDir, 'secrets', 'secrets.enc.env'), `ENC[${marker}]`);
  fs.writeFileSync(path.join(spaceDir, 'audit.jsonl'), '{"a":1}\n');
}

describe('ops stage', () => {
  it('writes ops-config.json and tokens 0600 in a 0700 dir, backs the store up, takes a board with no repository, skips a bad name', () => {
    const runner = tmp('stage-runner-');
    const stage = path.join(tmp('stage-out-'), 'stage');
    const backup = path.join(tmp('stage-bak-'), 'bak');
    fakeStore(path.join(runner, 'factiii'), 'KEY1');
    const report = writeOpsStage({
      stageDir: stage,
      uid: 501,
      boards: [
        { slug: 'factiii', repoUrl: 'https://github.com/factiii/factiii.git', mainBranch: 'main', githubToken: ' ghp_abc \n' },
        { slug: 'norepo', repoUrl: '', mainBranch: 'main', githubToken: '' },
        { slug: 'Bad Name', repoUrl: 'x', mainBranch: 'main', githubToken: '' }
      ],
      spaceDir: (slug) => path.join(runner, slug),
      backupDir: backup
    });
    const config = JSON.parse(fs.readFileSync(path.join(stage, 'ops-config.json'), 'utf-8')) as unknown;
    assert.deepEqual(config, {
      allowedUids: [501],
      boards: [
        { slug: 'factiii', repoUrl: 'https://github.com/factiii/factiii.git', mainBranch: 'main' },
        { slug: 'norepo', repoUrl: '', mainBranch: 'main' }
      ]
    });
    const token = path.join(stage, 'boards', 'factiii', 'github-token');
    assert.equal(fs.readFileSync(token, 'utf-8'), 'ghp_abc\n');
    assert.equal(fs.statSync(token).mode & 0o777, 0o600);
    assert.equal(fs.statSync(stage).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(backup, 'factiii', 'secrets', 'age-identity.enc'), 'utf-8'), 'KEY1');
    assert.ok(fs.existsSync(path.join(backup, 'factiii', 'audit.jsonl')));
    assert.deepEqual(report.boards, [
      { slug: 'factiii', hasStore: true, hasGithubToken: true, repoUrl: 'https://github.com/factiii/factiii.git' },
      { slug: 'norepo', hasStore: false, hasGithubToken: false, repoUrl: '' }
    ]);
    assert.deepEqual(report.skipped.map((s) => s.slug), ['Bad Name']);
    // The report Desktop shows holds no token.
    assert.doesNotMatch(JSON.stringify(report), /ghp_abc/);
  });

  it('removes only the store entries of the boards named', () => {
    const runner = tmp('stage-rm-');
    fakeStore(path.join(runner, 'a'), 'A');
    fakeStore(path.join(runner, 'b'), 'B');
    fs.writeFileSync(path.join(runner, 'a', 'keep.txt'), 'x');
    const removed = removeOldStores({ slugs: ['a', '../b'], spaceDir: (s) => path.join(runner, s) });
    assert.equal(removed.length, 2);
    assert.equal(hasStore(path.join(runner, 'a')), false);
    assert.ok(fs.existsSync(path.join(runner, 'a', 'keep.txt')));
    assert.equal(hasStore(path.join(runner, 'b')), true);
  });
});

describe('setup script migration', () => {
  const config = JSON.stringify({ allowedUids: [501], boards: [{ slug: 'factiii', repoUrl: 'r', mainBranch: 'main' }] });
  const script = (app?: string) =>
    macSetupScript({
      user: 'jon',
      opsHome: '/private/var/factiii-ops',
      runDir: '/private/var/factiii-ops-run',
      serveProgram: ['/Applications/Factiii Dev.app/Contents/MacOS/Factiii Dev', '/x/cli.js', 'ops', 'serve'],
      serveEnv: { ELECTRON_RUN_AS_NODE: '1', FACTIII_OPS_APP: '/Applications/Factiii Dev.app' },
      migrate: { config, stageDir: "/Users/jon/.factiii-runner/ops-stage", runnerDir: '/Users/jon/.factiii-runner', boards: ['factiii'], app }
    });

  it('embeds the config, copies a store only where the ops home has none, owns the app', () => {
    const s = script("/Applications/Factiii Dev's.app");
    assert.match(s, /cat > \/private\/var\/factiii-ops\/ops-config\.json <<'OPSCONFIG'\n\{\n {2}"allowedUids"/);
    assert.match(s, /if \[ ! -f \/private\/var\/factiii-ops\/boards\/factiii\/secrets\/age-identity\.enc \] && \[ -f "\$RUNNER_DIR\/factiii\/secrets\/age-identity\.enc" \]/);
    assert.match(s, /ditto "\$RUNNER_DIR\/factiii\/secrets" \/private\/var\/factiii-ops\/boards\/factiii\/secrets/);
    assert.match(s, /\[ ! -L "\$STAGE\/boards\/factiii\/github-token" \]/);
    assert.match(s, /chmod -R go-rwx \/private\/var\/factiii-ops\/boards/);
    assert.match(s, /APP='\/Applications\/Factiii Dev'\\''s\.app'/);
    assert.match(s, /chown -R factiii-ops:wheel "\$APP"/);
    assert.match(s, /<key>ELECTRON_RUN_AS_NODE<\/key><string>1<\/string>/);
    assert.match(s, /<key>AbandonProcessGroup<\/key><true\/>/);
    // The migration comes before the daemon starts.
    assert.ok(s.indexOf('Copying the factiii store') < s.indexOf('launchctl bootstrap system'));
    assert.throws(() => macSetupScript({ user: 'jon', opsHome: '/h', runDir: '/r', serveProgram: [], migrate: { config, stageDir: '/s', runnerDir: '/r', boards: ['../x'] } }), /not a board name/);
    assert.throws(() => macSetupScript({ user: 'jon', opsHome: '/h', runDir: '/r', serveProgram: [], migrate: { config: 'nope', stageDir: '/s', runnerDir: '/r', boards: [] } }));
  });

  // macOS only, as the setup script it runs: the migration copies with ditto.
  it('runs twice (repair) without overwriting the ops store', { skip: process.platform !== 'darwin' && 'ditto is macOS only' }, () => {
    // The migration block alone, against temp dirs, as the person's sh runs
    // it: no dscl, no root. install -o needs root, so it is shimmed.
    const home = tmp('mig-home-');
    const runner = tmp('mig-runner-');
    const stage = tmp('mig-stage-');
    fakeStore(path.join(runner, 'factiii'), 'OLD');
    fs.mkdirSync(path.join(stage, 'boards', 'factiii'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'boards', 'factiii', 'github-token'), 'ghp_x\n');
    const full = macSetupScript({
      user: 'jon',
      opsHome: home,
      runDir: '/r',
      serveProgram: ['/n'],
      migrate: { config, stageDir: stage, runnerDir: runner, boards: ['factiii'] }
    });
    const block = full.slice(full.indexOf('# Migration:'), full.indexOf('# The ops service.'));
    const shim = tmp('mig-bin-');
    const me = os.userInfo().username;
    // Drops -o / -g and their values, keeps the rest.
    const dropOwner = ['#!/bin/sh', 'skip=0', 'for a do', '  shift', '  if [ $skip = 1 ]; then skip=0; continue; fi', '  case "$a" in -o|-g) skip=1; continue;; esac', '  set -- "$@" "$a"', 'done', 'exec /usr/bin/install "$@"', ''];
    fs.writeFileSync(path.join(shim, 'install'), dropOwner.join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(shim, 'chown'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const run = () =>
      execFileSync('/bin/sh', ['-eu', '-c', block], { env: { PATH: `${shim}:/usr/bin:/bin:/usr/sbin`, USER: me } });
    run();
    const ops = path.join(home, 'boards', 'factiii');
    assert.equal(fs.readFileSync(path.join(ops, 'secrets', 'age-identity.enc'), 'utf-8'), 'OLD');
    assert.equal(fs.readFileSync(path.join(ops, 'github-token'), 'utf-8'), 'ghp_x\n');
    assert.ok(fs.existsSync(path.join(home, 'ops-config.json')));
    assert.equal(fs.existsSync(stage), false, 'the stage is removed');
    // The ops half re-keyed since; the normal user's old copy must not win.
    fs.writeFileSync(path.join(ops, 'secrets', 'age-identity.enc'), 'NEW');
    fs.mkdirSync(stage);
    run();
    assert.equal(fs.readFileSync(path.join(ops, 'secrets', 'age-identity.enc'), 'utf-8'), 'NEW');
  });

  it('the service plist runs the app on Electron as Node', () => {
    const plist = opsServicePlist({ opsHome: '/h', program: ['/A.app/Contents/MacOS/A', 'cli.js'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    assert.match(plist, /<string>\/A\.app\/Contents\/MacOS\/A<\/string>/);
    assert.match(plist, /<key>UserName<\/key><string>factiii-ops<\/string>/);
  });
});

describe('ops status report', () => {
  it('is healthy only with a socket and every served board answering; notes a good job', async () => {
    const configDir = tmp('status-cfg-');
    const runDir = tmp('status-run-');
    fs.writeFileSync(path.join(configDir, 'ops.json'), JSON.stringify({ enabled: true, runDir }));
    fs.mkdirSync(path.join(runDir, 'boards'));
    fs.writeFileSync(path.join(runDir, 'boards', 'a.token'), 'tok\n');
    fs.writeFileSync(path.join(runDir, 'ops.sock'), '');
    let answers = true;
    const clientFor = () => ({
      call: async (op: string) => {
        if (!answers) throw new Error('The ops service is not answering');
        if (op === 'audit-read') return { entries: [{ action: 'job-end', exitCode: 0, detail: 'done' }] };
        return { type: 'gate', pending: null, unlocked: null };
      }
    });
    const report = await opsStatusReport({ configDir, slugs: ['a', 'b'], clientFor, exists: fs.existsSync, alive: () => true });
    assert.equal(report.healthy, true);
    const stopped = await opsStatusReport({ configDir, slugs: ['a'], clientFor, exists: fs.existsSync, alive: () => false });
    assert.equal(stopped.healthy, false, 'a stale socket of a stopped service');
    const empty = await opsStatusReport({ configDir, slugs: [], clientFor, exists: fs.existsSync, alive: () => true });
    assert.equal(empty.healthy, true, 'no board yet: the running service is enough');
    const pidFile = path.join(runDir, 'ops.pid');
    fs.writeFileSync(pidFile, `${process.pid}\n`);
    assert.equal(pidAlive(pidFile), true);
    assert.equal(pidAlive(pidFile, () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); }), true);
    assert.equal(pidAlive(pidFile, () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); }), false);
    assert.deepEqual(
      report.boards.map((b) => [b.slug, b.served, b.answers, b.jobSucceeded]),
      [
        ['a', true, true, true],
        ['b', false, false, false]
      ]
    );
    answers = false;
    const down = await opsStatusReport({ configDir, slugs: ['a'], clientFor, exists: fs.existsSync, alive: () => true });
    assert.equal(down.healthy, false);
    assert.match(down.boards[0]?.error ?? '', /not answering/);
  });
});

describe('ops updater', () => {
  const base = {
    phase: 'idle' as const,
    current: '1.8.45',
    latest: null,
    refused: null,
    manual: false,
    activeJobs: 0,
    now: 10_000,
    lastCheckAt: 9_000,
    intervalMs: 5_000
  };

  it('decides: check on schedule or ask, wait for jobs, install, never re-try a refused one unasked', () => {
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(nextStep(base), 'sleep');
    assert.equal(nextStep({ ...base, lastCheckAt: null }), 'check');
    assert.equal(nextStep({ ...base, lastCheckAt: 4_000 }), 'check');
    assert.equal(nextStep({ ...base, manual: true }), 'check');
    assert.equal(nextStep({ ...base, latest: '1.8.46' }), 'install');
    assert.equal(nextStep({ ...base, latest: '1.8.46', activeJobs: 2 }), 'wait-for-jobs');
    assert.equal(nextStep({ ...base, latest: '1.8.45' }), 'sleep');
    assert.equal(nextStep({ ...base, latest: '1.8.46', refused: '1.8.46' }), 'sleep');
    assert.equal(nextStep({ ...base, latest: '1.8.46', refused: '1.8.46', manual: true }), 'install');
    assert.equal(nextStep({ ...base, phase: 'installing', manual: true }), 'busy');
  });

  it('loop: waits while a job runs, installs after, records a refusal', async () => {
    const release: Release = { version: '1.8.46', url: 'u', sha512: 's' };
    let jobs = 1;
    let verdict: { ok: true; staged: string } | { ok: false; reason: string } = { ok: false, reason: 'unsigned (no team)' };
    const applied: string[] = [];
    let now = 0;
    const updater = createOpsUpdater({
      current: '1.8.45',
      intervalMs: 1_000,
      now: () => now,
      fetchLatest: async () => release,
      activeJobs: () => jobs,
      stage: async () => verdict,
      apply: async (staged) => {
        applied.push(staged);
      }
    });
    assert.equal((await updater.tick()).phase, 'waiting-for-jobs');
    jobs = 0;
    const refused = await updater.tick();
    assert.equal(refused.phase, 'refused');
    assert.match(refused.message ?? '', /unsigned/);
    now = 500;
    assert.equal((await updater.tick()).phase, 'refused', 'not retried on its own');
    verdict = { ok: true, staged: '/staged/Factiii.app' };
    await updater.updateNow();
    assert.deepEqual(applied, ['/staged/Factiii.app']);
  });

  it('reads latest-mac.yml', () => {
    const yml = 'version: 1.8.46\nfiles:\n  - url: Factiii-1.8.46-arm64.dmg\n    sha512: AAA\n  - url: Factiii-1.8.46-arm64-mac.zip\n    sha512: BBB==\npath: x\n';
    assert.deepEqual(parseLatestMacYml(yml), {
      version: '1.8.46',
      url: 'https://github.com/factiii/desktop-releases/releases/download/v1.8.46/Factiii-1.8.46-arm64-mac.zip',
      sha512: 'BBB=='
    });
    assert.equal(parseLatestMacYml('version: 1\nfiles:\n  - url: ../evil.zip\n    sha512: A\n'), null);
  });

  it('a dev build (no team) and a bad hash are refused and nothing stays staged', async () => {
    const home = tmp('upd-home-');
    const noTeam: Exec = async () => ({ code: 0, stdout: '', stderr: 'TeamIdentifier=not set\n' });
    const release = { version: '2.0.0', url: 'https://x/a.zip', sha512: 'nope' };
    const dev = await stageMacRelease({ release, opsHome: home, app: '/A.app', exec: noTeam });
    assert.equal(dev.ok, false);
    const team: Exec = async () => ({ code: 0, stdout: '', stderr: 'TeamIdentifier=ABCDE12345\n' });
    const fetchImpl = (async () => new Response(Buffer.from('zip'))) as typeof fetch;
    const bad = await stageMacRelease({ release, opsHome: home, app: '/A.app', exec: team, fetchImpl });
    assert.deepEqual(bad, { ok: false, reason: 'the download does not match its sha512' });
    assert.equal(fs.existsSync(path.join(home, 'releases', 'staged')), false);
    const good = { ...release, sha512: createHash('sha512').update('zip').digest('base64') };
    const unzipFails: Exec = async (cmd, args) => (cmd.endsWith('ditto') ? { code: 1, stdout: '', stderr: 'bad zip' } : team(cmd, args));
    const notZip = await stageMacRelease({ release: good, opsHome: home, app: '/A.app', exec: unzipFails, fetchImpl });
    assert.deepEqual(notZip, { ok: false, reason: 'could not unpack it: bad zip' });
  });

  it('swap renames Contents in and, on a failed health check, back', async () => {
    const home = tmp('swap-home-');
    const app = path.join(tmp('swap-apps-'), 'Factiii.app');
    const staged = path.join(home, 'releases', 'staged', 'Factiii.app');
    fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'v'), 'old');
    fs.mkdirSync(path.join(staged, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'Contents', 'v'), 'new');
    const signed: Exec = async (cmd, args) => {
      if (cmd.endsWith('spctl')) return { code: 0, stdout: '', stderr: `${args.at(-1)}: accepted\nsource=Notarized Developer ID\n` };
      return { code: 0, stdout: '', stderr: 'Authority=Developer ID Application: F (ABCDE12345)\nTeamIdentifier=ABCDE12345\n' };
    };
    const common = { app, staged, opsHome: home, runDir: home, pid: 999_999_999, exec: signed, sleep: async () => undefined };
    const sick = await applyMacUpdate({ ...common, healthy: async () => false });
    assert.deepEqual(sick, { ok: false, reason: 'health check failed', rolledBack: true });
    assert.equal(fs.readFileSync(path.join(app, 'Contents', 'v'), 'utf-8'), 'old');
    fs.mkdirSync(path.join(staged, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'Contents', 'v'), 'new');
    const good = await applyMacUpdate({ ...common, healthy: async () => true });
    assert.deepEqual(good, { ok: true });
    assert.equal(fs.readFileSync(path.join(app, 'Contents', 'v'), 'utf-8'), 'new');
    assert.equal(fs.readFileSync(path.join(home, 'releases', 'previous', 'Contents', 'v'), 'utf-8'), 'old');
  });
});

describe('store ops over the socket', () => {
  it('reach the board store, answer names only, and the panel ops refuse bad bodies', async () => {
    const dir = tmp('store-sock-');
    const socketPath = path.join(dir, 's');
    const calls: string[] = [];
    const store: OpsBoard['store'] = {
      set: async (b) => {
        calls.push(`set ${b.key}=${b.value} by ${b.by.name}`);
        return { success: true };
      },
      unset: async () => ({ success: true }),
      setFile: async () => ({ success: true }),
      unsetFile: async () => ({ success: true }),
      changePassword: async () => ({ success: true }),
      backupExport: async () => ({ file: 'factiii-secrets-x.factiii-backup' }),
      backupImport: async (b) => {
        calls.push(`import picks ${JSON.stringify(b.picks ?? null)}`);
        return { secrets: ['A'], files: [] };
      },
      status: async () => ({ initialized: true }),
      init: async () => ({ success: true }),
      list: async () => ({
        keys: ['API_KEY'],
        meta: { API_KEY: { title: 'API', description: 'for x', category: 'release', source: 'manual' } },
        files: ['ASC_KEY']
      }),
      setMeta: async (b) => {
        calls.push(`meta ${b.key} ${JSON.stringify(b.patch)}`);
        return { success: true };
      },
      backupPlan: async () => ({
        board: 'factiii',
        createdAt: '2026-11-10T00:00:00.000Z',
        secrets: [{ name: 'API_KEY', exists: true }],
        files: [{ name: 'ASC_KEY', size: 12, exists: false }]
      }),
      // A store that leaked a tail: the server's answer must not carry it.
      fileEnvKeys: async () =>
        [{ name: 'DATABASE_URL', editable: true, masked: '…1234' }] as unknown as { name: string; editable: boolean }[],
      fileEnvSet: async () => ({ occurrences: 1, keys: [{ name: 'DATABASE_URL', editable: true }] }),
      fileEnvUnset: async () => ({ removed: 1, keys: [] })
    };
    const board = { slug: 'factiii', store } as unknown as OpsBoard;
    const added = new Set<string>();
    const server = await startOpsServer({
      socketPath,
      peer: { challenge: () => 'c'.repeat(64), verify: async () => ({ uid: 501 }) },
      board: (slug) => (slug === 'factiii' || added.has(slug) ? board : null),
      tokenFor: () => 'tok',
      addBoard: (slug) => {
        if (slug === 'factiii' || added.has(slug)) return false;
        added.add(slug);
        return true;
      },
      updater: {
        state: () => ({ current: '1', phase: 'up-to-date', latest: '1', lastCheckAt: null, message: null }),
        updateNow: async () => ({ current: '1', phase: 'checking', latest: null, lastCheckAt: null, message: null })
      }
    });
    try {
      const client = opsClient({ socketPath, peerDir: dir, board: 'factiii', token: () => 'tok', answer: async () => undefined });
      const by = { userId: 'owner', name: 'Desktop' };
      const set = await client.call('store-set', { by, via: 'owner-terminal', password: 'pw', key: 'API_KEY', value: 'sk_live_VALUE' });
      assert.deepEqual(set, { type: 'stored', success: true });
      assert.deepEqual(calls, ['set API_KEY=sk_live_VALUE by Desktop']);
      const backup = await client.call('backup-export', { by, via: 'owner-terminal', password: 'pw', passphrase: 'pp' });
      assert.deepEqual(backup, { type: 'backup', file: 'factiii-secrets-x.factiii-backup' });
      await assert.rejects(client.call('store-set', { by, via: 'owner-terminal', key: 'K', value: 'v' }), /Malformed store-set/);
      // The Secrets tab's ops (shared ops-store-actions.ts): names only.
      assert.deepEqual(await client.call('store-status'), { type: 'store-status', initialized: true });
      assert.deepEqual(await client.call('store-list', { by, via: 'data-channel', password: 'pw' }), {
        type: 'store-list',
        keys: ['API_KEY'],
        meta: { API_KEY: { title: 'API', description: 'for x', category: 'release', source: 'manual' } },
        files: ['ASC_KEY']
      });
      await client.call('store-set-meta', { key: 'API_KEY', title: 'API key' });
      assert.equal(calls.at(-1), 'meta API_KEY {"title":"API key"}');
      const planned = await client.call('backup-plan', {
        by,
        via: 'data-channel',
        bundle: 'b',
        passphrase: 'pp',
        targetPassword: 'pw'
      });
      assert.deepEqual(planned.secrets, [{ name: 'API_KEY', exists: true }]);
      assert.deepEqual(await client.call('file-env-keys', { by, via: 'data-channel', password: 'pw', name: 'PROD_ENV' }), {
        type: 'file-env',
        env: true,
        keys: [{ name: 'DATABASE_URL', editable: true }]
      });
      await client.call('backup-import', {
        by,
        via: 'data-channel',
        bundle: 'b',
        passphrase: 'pp',
        targetPassword: 'pw',
        picks: { secrets: [{ name: 'API_KEY', conflict: 'take' }], files: [] }
      });
      assert.equal(calls.at(-1), 'import picks {"secrets":[{"name":"API_KEY","conflict":"take"}],"files":[]}');
      await assert.rejects(client.call('store-list', { by, via: 'data-channel' }), /Malformed store-list/);
      // A board made after setup: taken by the peer check alone (no token
      // yet), once.
      const fresh = opsClient({ socketPath, peerDir: dir, board: 'premium', token: () => '', answer: async () => undefined });
      assert.deepEqual(await fresh.call('board-add'), { type: 'board', added: true });
      assert.deepEqual(await fresh.call('board-add'), { type: 'board', added: false });
      assert.equal((await client.call('update-state')).phase, 'up-to-date');
      assert.equal((await client.call('update-now')).phase, 'checking');
    } finally {
      await server.close();
    }
  });
});
