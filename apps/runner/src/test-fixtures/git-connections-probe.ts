// Spawned by gitConnections.test.ts under a fake HOME, a FACTIII_RUNNER_DIR
// and a fake `security` on PATH (the same harness as connection-storage-
// probe.ts). Seeds boards the way an older runner left them, runs the move
// to the runner's Git connections (and the deletion of the old per-board
// fields) several times, then the saves a board makes, and
// prints what it saw as JSON; the test does the asserting.
import { execFileSync } from 'child_process';
import path from 'path';

async function main(): Promise<void> {
  // Refuse to load a runner module unless `security` is the fake: the
  // keychain account is resolved at import time.
  const fakeBin = process.env.FAKE_BIN;
  const security = execFileSync('which', ['security'], {
    encoding: 'utf-8'
  }).trim();
  if (!fakeBin || path.dirname(security) !== fakeBin) {
    process.stderr.write(`refusing to run: security resolves to ${security}\n`);
    process.exit(2);
  }
  console.log = console.error;

  const { boardFiles, localConfigProvider } = await import('../agent-adapter');
  const { readGitStore, reconcileGitConnections } =
    await import('../gitConnections');
  const { spaceDirPath } = await import('../paths');
  const { readSecureJson, writeSecureJson } = await import('../secureFile');
  const fs = await import('fs');

  const file = (slug: string) =>
    path.join(spaceDirPath(slug), '.creds', 'github.json');
  const seed = (slug: string, value: Record<string, unknown>) => {
    fs.mkdirSync(path.dirname(file(slug)), { recursive: true });
    writeSecureJson(file(slug), {
      repoUrl: `https://github.com/acme/${slug}`,
      mainBranch: 'main',
      provider: 'claude',
      ...value
    });
  };
  const raw = (slug: string) =>
    readSecureJson<Record<string, unknown>>(file(slug)) ?? {};

  // Three boards on one account (two tokens), one on another, one with none.
  seed('alpha', {
    githubToken: 'gho_jon_1',
    gitName: 'Jon',
    gitEmail: 'jon@x.com'
  });
  seed('beta', {
    githubToken: 'gho_jon_2',
    gitName: 'Jon',
    gitEmail: 'jon@x.com'
  });
  seed('gamma', { githubToken: 'gho_jon_1' });
  seed('delta', {
    githubToken: 'ghp_acme',
    gitName: 'Acme',
    gitEmail: 'ci@acme.dev'
  });
  seed('empty', { githubToken: '' });

  // Before the move: every board reads its own token (the fallback).
  const before = Object.fromEntries(
    ['alpha', 'beta', 'delta'].map((s) => [
      s,
      localConfigProvider.readConfig(s).githubToken
    ])
  );

  // gho_revoked: GitHub does not answer for it until `revokedKnown`.
  let revokedKnown = false;
  const identify = async (token: string) => {
    if (token === 'gho_revoked') {
      return revokedKnown
        ? { login: 'jon', name: 'Jon', email: 'jon@x.com' }
        : null;
    }
    if (token.startsWith('gho_jon')) {
      return { login: 'jon', name: 'Jon', email: 'jon@x.com' };
    }
    if (token === 'ghp_acme') {
      return { login: 'acme-bot', name: 'Acme', email: 'ci@acme.dev' };
    }
    return null;
  };

  const first = await reconcileGitConnections(boardFiles, identify);
  const storeAfterFirst = readGitStore();
  // A board already on jon's connection whose old token GitHub cannot vouch
  // for: its old fields stay until it can.
  const jonId = storeAfterFirst.connections.find((c) => c.login === 'jon')!.id;
  seed('eta', {
    githubToken: 'gho_revoked',
    gitName: 'Jon',
    gitEmail: 'jon@x.com',
    gitConnectionId: jonId
  });
  const second = await reconcileGitConnections(boardFiles, identify);
  const storeAfterSecond = readGitStore();
  const etaKept = raw('eta').githubToken ?? null;
  revokedKnown = true;
  const third = await reconcileGitConnections(boardFiles, identify);
  const etaAfter = raw('eta');
  const fourth = await reconcileGitConnections(boardFiles, identify);

  const slugs = ['alpha', 'beta', 'gamma', 'delta', 'empty'];
  const resolved = Object.fromEntries(
    slugs.map((s) => {
      const c = localConfigProvider.readConfig(s);
      return [
        s,
        {
          token: c.githubToken,
          gitName: c.gitName,
          id: c.gitConnectionId ?? null
        }
      ];
    })
  );
  const rawAfter = Object.fromEntries(
    slugs.map((s) => [
      s,
      {
        githubToken: raw(s).githubToken ?? null,
        gitName: raw(s).gitName ?? null,
        id: raw(s).gitConnectionId ?? null
      }
    ])
  );

  // A save of another setting writes no token into the board's file.
  const beta = localConfigProvider.readConfig('beta');
  localConfigProvider.writeConfig('beta', {
    ...beta,
    terminalDefault: 'codex'
  });
  const betaSaved = raw('beta');

  // Picking the other connection moves the board; its old token stays put.
  const acmeId = readGitStore().connections.find(
    (c) => c.login === 'acme-bot'
  )!.id;
  localConfigProvider.writeConfig('beta', {
    ...localConfigProvider.readConfig('beta'),
    gitConnectionId: acmeId
  });
  const betaMoved = {
    raw: raw('beta'),
    token: localConfigProvider.readConfig('beta').githubToken
  };

  // Disconnect (clearToken): none, and the old token goes too.
  const gamma = localConfigProvider.readConfig('gamma');
  localConfigProvider.writeConfig('gamma', {
    ...gamma,
    githubToken: '',
    gitConnectionId: ''
  });
  const gammaCleared = {
    raw: raw('gamma'),
    token: localConfigProvider.readConfig('gamma').githubToken
  };

  process.stdout.write(
    JSON.stringify({
      before,
      first,
      second,
      third,
      fourth,
      etaKept,
      etaAfter,
      storeAfterFirst,
      sameStore:
        JSON.stringify(storeAfterFirst) === JSON.stringify(storeAfterSecond),
      resolved,
      rawAfter,
      betaSaved,
      betaMoved,
      gammaCleared,
      choices: localConfigProvider.gitConnectionChoices?.() ?? null
    })
  );
}

void main();
