import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// The move of every board's own GitHub token into the runner's Git
// connections, and how a board's settings resolve and save afterwards, on
// real sealed files: a subprocess under a FAKE home, FACTIII_RUNNER_DIR and
// `security` (as connection-storage.test.ts), so nothing here reaches the
// real runner folder or Keychain. The rules themselves are unit-tested in
// shared/all board-agent-core/git-connections.test.ts.

const FAKE_SECURITY = `#!/usr/bin/env node
const fs = require('fs');
const store = process.env.FAKE_KEYCHAIN;
const items = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {};
const args = process.argv.slice(2);
const flag = (f) => args[args.indexOf(f) + 1];
const id = flag('-s') + '/' + flag('-a');
if (args[0] === 'find-generic-password') {
  if (!(id in items)) process.exit(44);
  process.stdout.write(items[id] + '\\n');
} else if (args[0] === 'add-generic-password') {
  items[id] = flag('-w');
  fs.writeFileSync(store, JSON.stringify(items));
}
`;

type Conn = { id: string; login: string; token: string; gitEmail: string };
type Run = { moved: number; merged: number; cleaned: number };
type Probe = {
  before: Record<string, string>;
  first: Run;
  second: Run;
  third: Run;
  fourth: Run;
  etaKept: string | null;
  etaAfter: Record<string, unknown>;
  storeAfterFirst: { connections: Conn[] };
  sameStore: boolean;
  resolved: Record<
    string,
    { token: string; gitName: string; id: string | null }
  >;
  rawAfter: Record<
    string,
    { githubToken: string | null; gitName: string | null; id: string | null }
  >;
  betaSaved: Record<string, unknown>;
  betaMoved: { raw: Record<string, unknown>; token: string };
  gammaCleared: { raw: Record<string, unknown>; token: string };
  choices: { id: string; label: string; login: string }[] | null;
};

function runProbe(): Probe {
  const home = fs.mkdtempSync('/tmp/rgc-');
  try {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'security'), FAKE_SECURITY, {
      mode: 0o755
    });
    const res = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(__dirname, 'test-fixtures/git-connections-probe.ts')
      ],
      {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          FACTIII_RUNNER_DIR: path.join(home, '.frd'),
          FAKE_KEYCHAIN: path.join(home, 'keychain.json'),
          FAKE_BIN: bin
        }
      }
    );
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout) as Probe;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe(
  'runner Git connections',
  { skip: process.platform !== 'darwin' },
  () => {
    const out = runProbe();

    it('reads each board’s own token until it is moved', () => {
      assert.deepEqual(out.before, {
        alpha: 'gho_jon_1',
        beta: 'gho_jon_2',
        delta: 'ghp_acme'
      });
    });

    it('moves boards into one connection per account', () => {
      assert.deepEqual(out.first, { moved: 4, merged: 0, cleaned: 4 });
      const logins = out.storeAfterFirst.connections.map((c) => c.login).sort();
      assert.deepEqual(logins, ['acme-bot', 'jon']);
      const jon = out.storeAfterFirst.connections.find(
        (c) => c.login === 'jon'
      )!;
      // alpha is first by slug: its token is the one the connection keeps.
      assert.equal(jon.token, 'gho_jon_1');
      assert.equal(out.resolved.alpha!.id, jon.id);
      assert.equal(out.resolved.beta!.id, jon.id);
      assert.equal(out.resolved.gamma!.id, jon.id);
      assert.equal(out.resolved.beta!.token, 'gho_jon_1');
      assert.equal(out.resolved.gamma!.gitName, 'Jon');
    });

    it('is idempotent', () => {
      assert.deepEqual(out.second, { moved: 0, merged: 0, cleaned: 0 });
      assert.equal(out.sameStore, true);
      assert.deepEqual(out.fourth, { moved: 0, merged: 0, cleaned: 0 });
    });

    it('deletes each moved board’s old token, name and email', () => {
      for (const slug of ['alpha', 'beta', 'gamma', 'delta']) {
        assert.equal(out.rawAfter[slug]!.githubToken, null, slug);
        assert.equal(out.rawAfter[slug]!.gitName, null, slug);
      }
      // ...and still reads them from its connection.
      assert.equal(out.resolved.beta!.token, 'gho_jon_1');
      assert.equal(out.resolved.delta!.token, 'ghp_acme');
      // A board with no token is not moved.
      assert.equal(out.rawAfter.empty!.id, null);
      assert.equal(out.resolved.empty!.token, '');
    });

    it('keeps an old token GitHub cannot vouch for, until it can', () => {
      assert.equal(out.etaKept, 'gho_revoked');
      assert.deepEqual(out.third, { moved: 0, merged: 0, cleaned: 1 });
      assert.equal(out.etaAfter.githubToken, undefined);
      assert.equal(out.etaAfter.gitEmail, undefined);
      assert.ok(out.etaAfter.gitConnectionId);
    });

    it('never writes a connection’s token into a board', () => {
      assert.equal(out.betaSaved.githubToken, '');
      assert.equal(out.betaSaved.terminalDefault, 'codex');
    });

    it('switches a board to another connection', () => {
      assert.equal(out.betaMoved.token, 'ghp_acme');
      assert.equal(out.betaMoved.raw.githubToken, '');
      assert.equal(out.betaMoved.raw.terminalDefault, 'codex');
    });

    it('disconnects a board, old token and all', () => {
      assert.equal(out.gammaCleared.token, '');
      assert.equal(out.gammaCleared.raw.gitConnectionId, '');
      assert.equal(out.gammaCleared.raw.githubToken, '');
    });

    it('offers the connections by name, never by token', () => {
      assert.ok(out.choices);
      assert.deepEqual(out.choices.map((c) => c.label).sort(), [
        '@acme-bot',
        '@jon'
      ]);
      assert.ok(!JSON.stringify(out.choices).includes('gho_'));
    });
  }
);
