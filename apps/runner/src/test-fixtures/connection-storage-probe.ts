// Spawned by connection-storage.test.ts under a fake HOME, a
// FACTIII_RUNNER_DIR and a fake `security` on PATH. Runs the steps named on
// the command line, in order, and prints what each observed as JSON; the test
// does the asserting. One process is one runner lifetime, so a test restarts
// the runner by spawning this again over the same directory.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

type Observed = Record<string, unknown>;

const GITHUB = {
  repoUrl: 'https://github.com/acme/app',
  mainBranch: 'main',
  gitName: 'Probe',
  gitEmail: 'probe@example.com',
  githubToken: 'ghp_probe_alpha',
  provider: 'claude' as const
};
// What the removed runner OneDrive index kept per board, for the check that
// the runner now deletes it.
const ONEDRIVE = {
  clientId: 'client',
  refreshToken: 'refresh-probe',
  driveId: 'drive',
  driveType: 'personal',
  rootFolderId: 'root'
};
const PASSWORD = 'correct horse battery';

async function main(): Promise<void> {
  // Refuse to load a single runner module unless `security` is the fake: the
  // keychain account is resolved at import time, and the real binary would
  // mint a key into the real login keychain.
  const fakeBin = process.env.FAKE_BIN;
  const resolved = execFileSync('which', ['security'], {
    encoding: 'utf-8'
  }).trim();
  if (!fakeBin || path.dirname(resolved) !== fakeBin) {
    process.stderr.write(`refusing to run: security resolves to ${resolved}\n`);
    process.exit(2);
  }

  // The runner logs conversions with console.log; stdout is the JSON channel.
  console.log = console.error;

  const { convertVaultSealedFiles, credentialStoreStatus, localConfigProvider } =
    await import('../agent-adapter');
  const { readRunnerConfig } = await import('../config');
  const { getKeychainKey } = await import('../keychain');
  const { CONFIG_DIR, spaceDirPath } = await import('../paths');
  const { runSecureAction } = await import('../secureActions');

  const creds = (slug: string, file: string): string =>
    path.join(spaceDirPath(slug), '.creds', file);
  const FILES = {
    alphaGithub: creds('alpha', 'github.json'),
    betaGithub: creds('beta', 'github.json'),
    gammaGithub: creds('gamma', 'github.json')
  };
  const BETA_ONEDRIVE = creds('beta', 'onedrive.json');
  const VAULT_FILE = path.join(CONFIG_DIR, 'vault-key.json');
  const RETIRED_VAULT_FILE = path.join(CONFIG_DIR, 'vault-key.retired.json');

  const raw = (filePath: string): string => fs.readFileSync(filePath, 'utf-8');
  /** 1 or 2 for one of our envelopes, 0 for other bytes, -1 for no file. */
  const envelope = (filePath: string): number => {
    if (!fs.existsSync(filePath)) return -1;
    const body = raw(filePath);
    if (!body.startsWith('FACTIII1')) return 0;
    return (JSON.parse(body.slice('FACTIII1'.length)) as { v: number }).v;
  };
  const caught = (work: () => unknown): Observed => {
    try {
      return { result: work() };
    } catch (err) {
      return { error: (err as { code?: string }).code ?? String(err) };
    }
  };

  // ── What a runner before this change left on disk. Nothing in the runner
  // can write these any more, so the fixture reproduces the formats. ──

  const gcm = (plain: Buffer, key: Buffer) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64')
    };
  };

  let dek = crypto.randomBytes(32);

  /** vault-key.json: the DEK under HKDF(keychainKey [|| scrypt(password)]). */
  const seedVault = (password: string | null): void => {
    const machineKey = getKeychainKey();
    if (!machineKey) throw new Error('the fake keychain gave no key');
    dek = crypto.randomBytes(32);
    const salt = password ? crypto.randomBytes(16) : null;
    const pwKey =
      password && salt
        ? crypto.scryptSync(password, salt, 32, {
            N: 1 << 15,
            maxmem: 64 * 1024 * 1024
          })
        : null;
    const wrapKey = Buffer.from(
      crypto.hkdfSync(
        'sha256',
        pwKey ? Buffer.concat([machineKey, pwKey]) : machineKey,
        Buffer.alloc(0),
        Buffer.from('factiii-runner-vault-v1'),
        32
      )
    );
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      VAULT_FILE,
      JSON.stringify({
        v: 1,
        passwordEnabled: Boolean(password),
        salt: salt ? salt.toString('base64') : null,
        ...gcm(dek, wrapKey)
      })
    );
  };

  /** A connection file in the vault (v2) envelope. */
  const writeVaultSealed = (
    filePath: string,
    value: unknown,
    key: Buffer = dek
  ): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `FACTIII1${JSON.stringify({
        v: 2,
        ...gcm(Buffer.from(JSON.stringify(value), 'utf-8'), key)
      })}`
    );
  };

  const observe = (): Observed => ({
    status: credentialStoreStatus(),
    vaultFile: fs.existsSync(VAULT_FILE),
    retiredVaultFile: fs.existsSync(RETIRED_VAULT_FILE),
    envelopes: Object.values(FILES).map(envelope),
    alpha: localConfigProvider.readConfig('alpha').githubToken,
    beta: localConfigProvider.readConfig('beta').githubToken,
    gamma: localConfigProvider.readConfig('gamma').githubToken,
    alphaProblem: localConfigProvider.configProblem?.('alpha') ?? null,
    gammaProblem: localConfigProvider.configProblem?.('gamma') ?? null
  });

  const steps: Record<string, () => Observed> = {
    'seed-vault': () => (seedVault(null), {}),
    'seed-vault-password': () => (seedVault(PASSWORD), {}),

    // Two good vault-sealed files across two boards.
    'seed-v2': () => {
      writeVaultSealed(FILES.alphaGithub, GITHUB);
      writeVaultSealed(FILES.betaGithub, {
        ...GITHUB,
        githubToken: 'ghp_probe_beta'
      });
      return {};
    },

    // One the vault key will never open.
    'seed-v2-bad': () => {
      writeVaultSealed(FILES.gammaGithub, GITHUB, crypto.randomBytes(32));
      return { bytes: raw(FILES.gammaGithub) };
    },

    // Today's files, written by the runner itself.
    'seed-v1': () => {
      localConfigProvider.writeConfig('alpha', GITHUB);
      localConfigProvider.writeConfig('beta', {
        ...GITHUB,
        githubToken: 'ghp_probe_beta'
      });
      return {
        leaksToken: raw(FILES.alphaGithub).includes('ghp_probe')
      };
    },

    observe,
    // What the daemon does at start, and again after an unlock.
    start: () => convertVaultSealedFiles(),

    unlock: () =>
      caught(() => runSecureAction('secureUnlock', { password: PASSWORD })),
    'unlock-wrong': () =>
      caught(() => runSecureAction('secureUnlock', { password: 'not it' })),

    // A save built on the empty read a locked file degrades to.
    'write-alpha': () => {
      const bytes = raw(FILES.alphaGithub);
      const res = caught(() =>
        localConfigProvider.writeConfig('alpha', { ...GITHUB, githubToken: '' })
      );
      return { ...res, untouched: raw(FILES.alphaGithub) === bytes };
    },
    'gamma-bytes': () => ({ bytes: raw(FILES.gammaGithub) }),
    'reconnect-gamma': () =>
      caught(() =>
        localConfigProvider.writeConfig('gamma', {
          ...GITHUB,
          githubToken: 'ghp_probe_gamma'
        })
      ),

    // For the test that unlocks from a second process while this one lives:
    // say this process has got this far, then hold until told to go on.
    'signal-ready': () => (fs.writeFileSync(process.env.PROBE_READY_FILE!, ''), {}),
    'wait-for-go': () => {
      const pause = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(process.env.PROBE_GO_FILE!)) {
        if (Date.now() > deadline) throw new Error('never told to go on');
        Atomics.wait(pause, 0, 0, 50);
      }
      return {};
    },

    'plaintext-legacy': () => {
      fs.mkdirSync(path.dirname(FILES.betaGithub), { recursive: true });
      fs.writeFileSync(FILES.betaGithub, JSON.stringify(GITHUB));
      fs.writeFileSync(BETA_ONEDRIVE, JSON.stringify(ONEDRIVE));
      return {
        token: localConfigProvider.readConfig('beta').githubToken,
        github: envelope(FILES.betaGithub),
        onedrive: envelope(BETA_ONEDRIVE),
        vaultFile: fs.existsSync(VAULT_FILE)
      };
    },

    'conversion-write-fails': () => {
      const file = FILES.alphaGithub;
      writeVaultSealed(file, GITHUB);
      const bytes = raw(file);
      const dir = path.dirname(file);
      // No new file can be created in the directory, so the rewrite fails.
      fs.chmodSync(dir, 0o500);
      const token = localConfigProvider.readConfig('alpha').githubToken;
      const failed = convertVaultSealedFiles();
      const whileReadOnly = {
        token,
        failed,
        untouched: raw(file) === bytes,
        dirListing: fs.readdirSync(dir),
        vaultFile: fs.existsSync(VAULT_FILE)
      };
      fs.chmodSync(dir, 0o700);
      return {
        whileReadOnly,
        retried: convertVaultSealedFiles(),
        envelope: envelope(file),
        token: localConfigProvider.readConfig('alpha').githubToken
      };
    },

    sweep: () => {
      const pairing = {
        serverUrl: 'http://localhost:5001',
        authToken: 'fake.pairing.token',
        runnerName: 'probe'
      };
      const configFile = path.join(CONFIG_DIR, 'config.json');
      const legacyFile = path.join(CONFIG_DIR, 'space-old.json');
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(pairing));
      fs.writeFileSync(legacyFile, JSON.stringify(GITHUB));
      // A board read comes first, so the sweep meets config.json as plaintext.
      const oldToken = localConfigProvider.readConfig('old').githubToken;
      return {
        configEnvelope: envelope(configFile),
        pairing: readRunnerConfig(),
        oldToken,
        legacyGone: !fs.existsSync(legacyFile),
        oldEnvelope: envelope(creds('old', 'github.json'))
      };
    },

    // The pairing config as the old sweep could leave it: in the vault envelope.
    'seed-v2-pairing': () => {
      writeVaultSealed(path.join(CONFIG_DIR, 'config.json'), {
        serverUrl: 'http://localhost:5001',
        authToken: 'fake.pairing.token',
        runnerName: 'probe'
      });
      return {};
    },
    pairing: () => ({ pairing: readRunnerConfig() }),

    'no-keychain': () => {
      const file = FILES.alphaGithub;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(GITHUB));
      const bytes = raw(file);
      return {
        status: credentialStoreStatus(),
        token: localConfigProvider.readConfig('alpha').githubToken,
        problem: localConfigProvider.configProblem?.('alpha') ?? null,
        unconfiguredProblem:
          localConfigProvider.configProblem?.('nothing') ?? null,
        write: caught(() => localConfigProvider.writeConfig('beta', GITHUB)),
        betaWritten: fs.existsSync(FILES.betaGithub),
        untouched: raw(file) === bytes
      };
    }
  };

  const results = process.argv.slice(2).map((name) => {
    const step = steps[name];
    if (!step) {
      process.stderr.write(`unknown step ${name}\n`);
      process.exit(2);
    }
    return step();
  });
  process.stdout.write(JSON.stringify({ configDir: CONFIG_DIR, results }));
}

void main();
