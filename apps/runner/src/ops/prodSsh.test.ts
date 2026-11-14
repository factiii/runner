import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { linuxSetupScript, macSetupScript } from './setup';

// Prod SSH with the ops user's own key (.specs/ops-user.md, "Prod SSH"):
// scripts/deploy-lib.sh's options, the scripts that reach prod, and
// scripts/prod-ops-key.sh, against a fake `id` and a fake `ssh` that records
// its argv (and, for the Tailscale leg, runs the remote script in a temp
// "prod" home). Nothing reaches a network.

const REPO = path.resolve(__dirname, '../../../..');
// The repo's scripts/ is not in the runner's public mirror (factiii/runner),
// whose release workflow runs these tests too; there they have nothing to run.
const NO_SCRIPTS =
  !fs.existsSync(path.join(REPO, 'scripts/deploy-lib.sh')) &&
  'the repo scripts are not in the public mirror';
const KEY_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIOpsKeyBlobForTestsOnly000000000000000';
const HOST_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyBlobForTestsOnly00000000000000';

let dir = '';
let bin = '';
let sshDir = '';
let prodHome = '';
let sshLog = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-ssh-'));
  bin = path.join(dir, 'bin');
  sshDir = path.join(dir, 'ops', '.ssh');
  prodHome = path.join(dir, 'prod-home');
  sshLog = path.join(dir, 'ssh.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(sshDir, { recursive: true });
  fs.mkdirSync(prodHome);
  fs.writeFileSync(path.join(dir, 'host_key.pub'), `ssh-ed25519 ${HOST_BLOB} root@prod\n`);
  // id -un answers $FAKE_USER; everything else is the real id.
  fs.writeFileSync(
    path.join(bin, 'id'),
    `#!/bin/sh\n[ "$1" = -un ] && { echo "$FAKE_USER"; exit 0; }\nexec /usr/bin/id "$@"\n`,
    { mode: 0o755 }
  );
  // ssh: one argv per line (NUL-free, space-joined) in $SSH_LOG. The key leg
  // (-i) answers $KEY_LEG_ANSWER; the Tailscale leg runs its stdin like the
  // remote shell would, in $PROD_HOME, with the host key file swapped in.
  fs.writeFileSync(
    path.join(bin, 'ssh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SSH_LOG"
for a in "$@"; do [ "$a" = -i ] && { [ -n "\${KEY_LEG_ANSWER:-}" ] && echo "$KEY_LEG_ANSWER"; exit 0; }; done
cmd="\${@: -1}"
script="$(cat)"
script="\${script//\\/etc\\/ssh\\/ssh_host_ed25519_key.pub/$FAKE_HOST_KEY}"
HOME="$PROD_HOME" bash -c "$cmd" <<< "$script"
`,
    { mode: 0o755 }
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function env(user: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: dir,
    FAKE_USER: user,
    OPS_SSH_DIR: sshDir,
    SSH_LOG: sshLog,
    PROD_HOME: prodHome,
    FAKE_HOST_KEY: path.join(dir, 'host_key.pub'),
    ...extra
  };
}

/** SSH_OPTS after deploy_ssh_opts <target>, one per line, and the exit code. */
function sshOpts(user: string, target = 'prod'): { code: number; opts: string[]; stderr: string } {
  const r = spawnSync(
    'bash',
    ['-c', `source scripts/deploy-lib.sh && deploy_ssh_opts ${target} && printf '%s\\n' "\${SSH_OPTS[@]}"`],
    { cwd: REPO, env: env(user), encoding: 'utf8' }
  );
  return { code: r.status ?? -1, opts: r.stdout.split('\n').filter(Boolean), stderr: r.stderr };
}

function writeKey(): void {
  fs.writeFileSync(path.join(sshDir, 'prod_ed25519'), 'PRIVATE', { mode: 0o600 });
  fs.writeFileSync(path.join(sshDir, 'prod_ed25519.pub'), `ssh-ed25519 ${KEY_BLOB} factiii-ops prod\n`);
}

function writePin(): void {
  fs.writeFileSync(path.join(sshDir, 'known_hosts_prod'), `[100.85.155.18]:2222 ssh-ed25519 ${HOST_BLOB}\n`, { mode: 0o600 });
}

function sshCalls(): string[] {
  return fs.existsSync(sshLog) ? fs.readFileSync(sshLog, 'utf8').split('\n').filter(Boolean) : [];
}

describe('deploy-lib.sh prod ssh options', { skip: NO_SCRIPTS }, () => {
  it('keeps Tailscale SSH, unchanged, for any user but the ops user', () => {
    writeKey();
    writePin();
    const r = sshOpts('jon');
    assert.equal(r.code, 0);
    assert.deepEqual(r.opts, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20']);
    assert.equal(r.stderr, '');
  });

  it('uses only the ops key, the pin and sshd’s tailnet port as the ops user', () => {
    writeKey();
    writePin();
    const r = sshOpts('factiii-ops');
    assert.equal(r.code, 0, r.stderr);
    const joined = r.opts.join(' ');
    for (const want of [
      '-F /dev/null',
      `-i ${path.join(sshDir, 'prod_ed25519')}`,
      '-o IdentitiesOnly=yes',
      '-o IdentityAgent=none',
      '-o PasswordAuthentication=no',
      `-o UserKnownHostsFile=${path.join(sshDir, 'known_hosts_prod')}`,
      '-o GlobalKnownHostsFile=/dev/null',
      '-o StrictHostKeyChecking=yes',
      '-o Port=2222',
      '-o BatchMode=yes'
    ]) {
      assert.ok(joined.includes(want), `missing ${want} in ${joined}`);
    }
    assert.match(r.stderr, /prod ssh: ops key, port 2222/);
  });

  it('fails as the ops user without the key or the pin, never falling back', () => {
    let r = sshOpts('factiii-ops');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /No ops SSH key/);
    writeKey();
    r = sshOpts('factiii-ops');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /prod-authorize-ops-key/);
    assert.deepEqual(r.opts, []);
  });

  it('hands prod the job call, in plain characters, as the ops user only', () => {
    writeKey();
    writePin();
    const job = {
      FACTIII_JOB: 'health-prod',
      FACTIII_JOB_CALL: 'c-1',
      FACTIII_JOB_CALLER: 'Jon Snyder',
      FACTIII_JOB_CALLER_ID: '7',
      FACTIII_JOB_VIA: 'owner-terminal'
    };
    const opts = (user: string) =>
      spawnSync('bash', ['-c', `source scripts/deploy-lib.sh && deploy_ssh_opts prod && printf '%s\\n' "\${SSH_OPTS[@]}"`], {
        cwd: REPO,
        env: env(user, job),
        encoding: 'utf8'
      }).stdout.split('\n');
    const setenv = opts('factiii-ops').find((o) => o.startsWith('SetEnv='));
    assert.match(
      setenv ?? '',
      /^SetEnv=FACTIII_JOB=health-prod FACTIII_JOB_CALL=c-1 FACTIII_JOB_CALLER=Jon_Snyder FACTIII_JOB_CALLER_ID=7 FACTIII_JOB_VIA=owner-terminal FACTIII_JOB_HOST=\S+$/
    );
    assert.equal(opts('jon').find((o) => o.startsWith('SetEnv=')), undefined);
  });

  it('leaves the Mini to its key blob', () => {
    const r = sshOpts('factiii-ops', 'mini');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /STAGING_DEPLOY_KEY/);
  });
});

describe('scripts that reach prod', { skip: NO_SCRIPTS }, () => {
  it('server-ops.sh health goes over the ops key as the ops user, Tailscale SSH otherwise', () => {
    writeKey();
    writePin();
    spawnSync('bash', ['scripts/server-ops.sh', 'prod', 'health'], { cwd: REPO, env: env('factiii-ops'), encoding: 'utf8' });
    spawnSync('bash', ['scripts/server-ops.sh', 'prod', 'health'], { cwd: REPO, env: env('jon'), encoding: 'utf8' });
    const [ops, normal] = sshCalls();
    assert.match(ops, /-i \S+prod_ed25519 .*IdentitiesOnly=yes.*StrictHostKeyChecking=yes.*Port=2222.* ubuntu@100\.85\.155\.18 docker ps/);
    assert.equal(normal, "-o BatchMode=yes -o ConnectTimeout=20 ubuntu@100.85.155.18 docker ps --filter name=prodFactiii --format '{{.Status}}'");
  });

  it('db-ops.sh and prod-db.sh take their options from deploy-lib.sh', () => {
    writeKey();
    writePin();
    spawnSync('bash', ['scripts/db-ops.sh', 'prod', 'read'], {
      cwd: REPO,
      env: env('factiii-ops', { JOB_PARAM_SQL: 'SELECT 1' }),
      input: '',
      encoding: 'utf8'
    });
    assert.match(sshCalls()[0] ?? '', /-i \S+prod_ed25519 .*Port=2222/);
    const src = fs.readFileSync(path.join(REPO, 'scripts/prod-db.sh'), 'utf8');
    assert.match(src, /source "\$REPO_ROOT\/scripts\/deploy-lib\.sh"/);
    assert.match(src, /PSSH=\(ssh "\$\{SSH_OPTS\[@\]\}" "\$PROD_HOST"\)/);
  });
});

describe('prod-ops-key.sh authorize', { skip: NO_SCRIPTS }, () => {
  const run = (user: string, extra: Record<string, string> = {}) =>
    spawnSync('bash', ['scripts/prod-ops-key.sh', 'authorize'], {
      cwd: REPO,
      env: env(user, { JOB_PARAM_FROM: '100.77.190.87', ...extra }),
      encoding: 'utf8'
    });
  const authorized = () => fs.readFileSync(path.join(prodHome, '.ssh', 'authorized_keys'), 'utf8');
  const pinFile = () => path.join(sshDir, 'known_hosts_prod');

  it('refuses outside the ops user, and touches nothing', () => {
    writeKey();
    const r = run('jon');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /factiii-ops only/);
    assert.deepEqual(sshCalls(), []);
  });

  it('refuses an address outside the tailnet', () => {
    writeKey();
    const r = run('factiii-ops', { JOB_PARAM_FROM: '10.0.0.5' });
    assert.equal(r.status, 2);
    assert.deepEqual(sshCalls(), []);
  });

  it('adds the key with from= and restrict over Tailscale SSH, checks the key login, then pins', () => {
    writeKey();
    fs.mkdirSync(path.join(prodHome, '.ssh'));
    fs.writeFileSync(path.join(prodHome, '.ssh', 'authorized_keys'), `ssh-ed25519 ${KEY_BLOB} old-line\nssh-ed25519 OTHERKEY owner\n`);
    const r = run('factiii-ops', { KEY_LEG_ANSWER: 'ops-key-ok' });
    assert.equal(r.status, 0, r.stderr);
    const forced = path.join(prodHome, '.ssh', 'factiii-ops-command');
    assert.equal(
      authorized(),
      `ssh-ed25519 OTHERKEY owner\nfrom="100.77.190.87",restrict,command="${forced}" ssh-ed25519 ${KEY_BLOB} factiii-ops\n`
    );
    // The alerting forced command is the repo's, private to the deploy user.
    assert.equal(
      fs.readFileSync(forced, 'utf8'),
      fs.readFileSync(path.join(REPO, 'scripts/prod-ops-command.sh'), 'utf8').replace(/\n$/, '')
    );
    assert.equal(fs.statSync(forced).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(pinFile(), 'utf8'), `[100.85.155.18]:2222 ssh-ed25519 ${HOST_BLOB}\n`);
    assert.equal(fs.statSync(pinFile()).mode & 0o777, 0o600);
    const [tailscale, key] = sshCalls();
    // The Tailscale leg carries no key; the key leg is key-only on the pin.
    assert.doesNotMatch(tailscale, / -i /);
    assert.match(tailscale, /StrictHostKeyChecking=accept-new/);
    assert.match(key, /-i \S+prod_ed25519 .*IdentitiesOnly=yes.*UserKnownHostsFile=\S+known_hosts_prod.*StrictHostKeyChecking=yes.*Port=2222/);
    // A re-run keeps one line for the key.
    assert.equal(run('factiii-ops', { KEY_LEG_ANSWER: 'ops-key-ok' }).status, 0);
    assert.equal(authorized().split(KEY_BLOB).length - 1, 1);
  });

  it('pins nothing when the key login fails', () => {
    writeKey();
    const r = run('factiii-ops');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Nothing pinned/);
    assert.equal(fs.existsSync(pinFile()), false);
  });

  it('refuses a host key that differs from the pin', () => {
    writeKey();
    fs.writeFileSync(pinFile(), '[100.85.155.18]:2222 ssh-ed25519 AAAAdifferent\n');
    const r = run('factiii-ops', { KEY_LEG_ANSWER: 'ops-key-ok' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /differs/);
    assert.equal(fs.readFileSync(pinFile(), 'utf8'), '[100.85.155.18]:2222 ssh-ed25519 AAAAdifferent\n');
  });
});

// The key's forced command on prod (scripts/prod-ops-command.sh, card
// ab928ef5): a fake docker and logger record their argv; timeout just runs.
describe('prod-ops-command.sh, the prod key alert', { skip: NO_SCRIPTS }, () => {
  const dockerLog = () => path.join(dir, 'docker.log');
  const loggerLog = () => path.join(dir, 'logger.log');
  const lines = (file: string) =>
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  beforeEach(() => {
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DOCKER_LOG"\n[ "$2" = exec ] && exit "\${DOCKER_EXEC_EXIT:-0}"\nexit "\${DOCKER_RUN_EXIT:-0}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'logger'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LOGGER_LOG"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
  });
  const login = (extra: Record<string, string>, input = '') =>
    spawnSync('bash', [path.join(REPO, 'scripts/prod-ops-command.sh')], {
      cwd: prodHome,
      input,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: prodHome,
        DOCKER_LOG: dockerLog(),
        LOGGER_LOG: loggerLog(),
        SSH_CLIENT: '100.77.190.87 51000 2222',
        ...extra
      }
    });
  const job = {
    FACTIII_JOB: 'deploy-prod-server',
    FACTIII_JOB_CALL: 'call-1',
    FACTIII_JOB_CALLER: 'Jon_Snyder',
    FACTIII_JOB_CALLER_ID: '7',
    FACTIII_JOB_VIA: 'owner-terminal',
    FACTIII_JOB_HOST: 'mini'
  };

  it('alerts once per job call, logs every login, and runs the command with its stdin', () => {
    const first = login({ ...job, SSH_ORIGINAL_COMMAND: 'cat' }, 'compose file');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, 'compose file');
    assert.deepEqual(lines(dockerLog()), [
      'compose exec -T prodFactiii node dist/prodKeyAlert.js --job=deploy-prod-server --call=call-1 --caller=Jon_Snyder --caller-id=7 --via=owner-terminal --host=mini --from=100.77.190.87'
    ]);
    const second = login({ ...job, SSH_ORIGINAL_COMMAND: 'echo again' });
    assert.equal(second.stdout, 'again\n');
    assert.equal(lines(dockerLog()).length, 1);
    assert.equal(lines(loggerLog()).filter((l) => l.includes('ops key login: job=deploy-prod-server')).length, 2);
  });

  it('alerts on every login that names no call, with odd values made plain', () => {
    login({ FACTIII_JOB: 'x; rm -rf /', FACTIII_JOB_CALLER_ID: '7; id', SSH_ORIGINAL_COMMAND: 'true' });
    login({ SSH_ORIGINAL_COMMAND: 'true' });
    const calls = lines(dockerLog());
    assert.equal(calls.length, 2);
    assert.match(calls[0] ?? '', /--job=x__rm_-rf__ --call= --caller= --caller-id= /);
  });

  it('falls back to a one-off container, and still runs the command when no alert goes out', () => {
    let r = login({ ...job, DOCKER_EXEC_EXIT: '1', SSH_ORIGINAL_COMMAND: 'echo ran' });
    assert.equal(r.stdout, 'ran\n');
    assert.match(lines(dockerLog())[1] ?? '', /^compose run --rm --no-deps -T prodFactiii node dist\/prodKeyAlert\.js --job=deploy-prod-server/);
    r = login({ ...job, FACTIII_JOB_CALL: 'call-2', DOCKER_EXEC_EXIT: '1', DOCKER_RUN_EXIT: '1', SSH_ORIGINAL_COMMAND: 'echo ran' });
    assert.equal(r.stdout, 'ran\n');
    assert.ok(lines(loggerLog()).some((l) => l.includes('alert NOT sent for call=call-2')));
  });

  it('refuses a login with no command', () => {
    const r = login(job);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /commands only/);
  });
});

describe('the setup script makes the ops key', () => {
  for (const [name, script] of [
    ['macOS', macSetupScript({ user: 'jon', opsHome: '/private/var/factiii-ops', runDir: '/private/var/factiii-ops-run', serveProgram: ['/x'] })],
    ['Linux', linuxSetupScript({ user: 'jon', opsHome: '/var/lib/factiii-ops', serveProgram: ['/x'] })]
  ] as const) {
    it(`${name}: ed25519, 0600, owned by factiii-ops, kept on repair`, () => {
      const home = name === 'Linux' ? '/var/lib/factiii-ops' : '/private/var/factiii-ops';
      const key = `${home}/.ssh/prod_ed25519`;
      assert.ok(script.includes(`install -d -o factiii-ops -g factiii-ops -m 0700 ${home}/.ssh`));
      assert.ok(script.includes(`[ -f ${key} ] || ssh-keygen -q -t ed25519 -N '' -C 'factiii-ops prod' -f ${key}`));
      assert.ok(script.includes(`chown factiii-ops:factiii-ops ${key} ${key}.pub`));
      assert.ok(script.includes(`chmod 0600 ${key}\n`));
      assert.ok(script.includes(`[ ! -L ${home}/.ssh ]`));
    });
  }

  it('runs: makes the key once and keeps it', () => {
    const home = path.join(dir, 'opshome');
    fs.mkdirSync(home);
    const block = macSetupScript({ user: 'jon', opsHome: home, runDir: '/r', serveProgram: ['/x'] })
      .split('\n')
      .filter((l) => l.includes('.ssh') && !l.startsWith('#'))
      // As a normal user in a test: no chown, install -d without owner.
      .map((l) => (l.startsWith('chown') ? ':' : l.replace('-o factiii-ops -g factiii-ops ', '')))
      .join('\n');
    const once = spawnSync('sh', ['-eu', '-c', block], { encoding: 'utf8' });
    assert.equal(once.status, 0, once.stderr);
    const key = path.join(home, '.ssh', 'prod_ed25519');
    assert.equal(fs.statSync(key).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(`${key}.pub`, 'utf8'), /^ssh-ed25519 \S+ factiii-ops prod/);
    const first = fs.readFileSync(key, 'utf8');
    assert.equal(spawnSync('sh', ['-eu', '-c', block]).status, 0);
    assert.equal(fs.readFileSync(key, 'utf8'), first);
  });
});
