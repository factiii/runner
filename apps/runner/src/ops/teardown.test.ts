import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appBundleOf,
  linuxTeardownScript,
  macTeardownScript,
  opsTeardownLeftBehind
} from './teardown';

// The ops user's teardown for a nuke (.specs/ops-user.md, "Teardown"): only
// what setup made, never anything else on the machine.

const mac = {
  user: 'jon',
  opsHome: '/private/var/factiii-ops',
  runDir: '/private/var/factiii-ops-run',
  app: '/Applications/Factiii.app'
};

describe('ops teardown script', () => {
  it('macOS: the daemons, the user and groups, the home and run dir, the app back', () => {
    const script = macTeardownScript(mac);
    assert.match(script, /^#!\/bin\/sh\n/);
    assert.match(script, /\[ "\$\(id -u\)" = 0 \]/);
    assert.match(script, /\/Library\/LaunchDaemons\/com\.factiii\.ops\.plist \/Library\/LaunchDaemons\/com\.factiii\.ops\.\*\.plist/);
    assert.match(script, /launchctl bootout "system\/\$label"/);
    assert.match(script, /pkill -u factiii-ops/);
    assert.match(script, /dscl \. -delete \/Users\/factiii-ops/);
    assert.match(script, /dscl \. -delete \/Groups\/factiii-ops/);
    assert.match(script, /dseditgroup -o edit -d jon -t user factiii/);
    assert.match(script, /dscl \. -delete \/Groups\/factiii\n/);
    assert.match(script, /rm -rf \/private\/var\/factiii-ops \/private\/var\/factiii-ops-run\n/);
    assert.match(script, /APP='\/Applications\/Factiii\.app'\n/);
    assert.match(script, /chown -R jon:staff "\$APP"/);
    // Only these deletes: nothing of Homebrew, node, git or Ollama.
    const removes = script.split('\n').filter((l) => /\brm\b|-delete|userdel|groupdel/.test(l));
    assert.equal(removes.length, 5);
    assert.doesNotMatch(script, /brew|ollama|\/usr\/local|\/opt\/homebrew|\.factiii-runner/);
  });

  it('refuses a home or run dir that is not the ops user\'s, or not plain', () => {
    for (const bad of ['/', '/Users/jon', '/private/var', '/private/var/factiii-ops/../..', 'factiii-ops', "/private/var/factiii-ops'; rm -rf /"]) {
      assert.throws(() => macTeardownScript({ ...mac, opsHome: bad }), Error, bad);
      assert.throws(() => linuxTeardownScript({ ...mac, runDir: bad }), Error, bad);
    }
    assert.throws(() => macTeardownScript({ ...mac, user: 'jon; rm -rf /' }));
  });

  it('Linux: the units, the user and groups, the home and run dir', () => {
    const script = linuxTeardownScript({ user: 'jon', opsHome: '/var/lib/factiii-ops', runDir: '/run/factiii-ops' });
    assert.match(script, /systemctl disable --now/);
    assert.match(script, /userdel factiii-ops/);
    assert.match(script, /gpasswd -d jon factiii/);
    assert.match(script, /groupdel factiii\n/);
    assert.match(script, /rm -rf \/var\/lib\/factiii-ops \/run\/factiii-ops\n/);
  });

  it('the plan names each part, and how it is run', () => {
    const desktop = opsTeardownLeftBehind({ ...mac, platform: 'darwin', desktop: true }).join('\n');
    assert.match(desktop, /Factiii Desktop removes the ops user next/);
    assert.match(desktop, /com\.factiii\.ops/);
    assert.match(desktop, /hidden user factiii-ops/);
    assert.match(desktop, /\/private\/var\/factiii-ops is erased: every board's secrets/);
    assert.match(desktop, /\/Applications\/Factiii\.app is given back to jon/);
    assert.match(desktop, /Nothing else is uninstalled/);
    assert.match(desktop, /~\/\.factiii-desktop\/bin\/factiii-runner/);
    const cli = opsTeardownLeftBehind({ ...mac, platform: 'darwin', desktop: false }).join('\n');
    assert.match(cli, /factiii-runner ops teardown-script \| sudo sh/);
    assert.doesNotMatch(cli, /factiii-desktop/);
  });

  it('finds the app a bundled runner runs from', () => {
    assert.equal(appBundleOf('/Applications/Factiii.app/Contents/MacOS/Factiii'), '/Applications/Factiii.app');
    assert.equal(appBundleOf('/usr/local/bin/node'), null);
  });
});

describe('the runner\'s own account in the setup script', () => {
  it('made once with sysadminctl, its password made in the script and printed only on the marked line', async () => {
    const { macSetupScript, ACCOUNT_PASSWORD_MARK } = await import('./setup');
    const script = macSetupScript({
      user: 'factiii',
      opsHome: '/private/var/factiii-ops',
      runDir: '/private/var/factiii-ops-run',
      serveProgram: ['/x'],
      account: { name: 'factiii', fullName: 'Factiii' }
    });
    assert.match(script, /if ! dscl \. -read \/Users\/factiii >\/dev\/null 2>&1; then/);
    assert.match(script, /PW=\$\(LC_ALL=C tr -dc 'A-Za-z0-9' <\/dev\/urandom \| head -c 24\)/);
    assert.match(script, /sysadminctl -addUser factiii -fullName 'Factiii' >\/dev\/null 2>&1/);
    assert.ok(script.includes(`printf 'passwd /Users/factiii %s\\n' "$PW" | dscl . >/dev/null`));
    // The password is never in a command's arguments: only the shell
    // builtins printf (into dscl's stdin) and echo (the marked line) see it.
    const uses = script.split('\n').filter((l) => l.includes('$PW') && !l.trim().startsWith('PW='));
    assert.deepEqual(
      uses.map((l) => l.trim().split(' ')[0]),
      ['printf', 'echo']
    );
    assert.doesNotMatch(script, /-password|-passwd|dscl \. -passwd/);
    for (const line of uses) {
      // Piped: whatever runs after the builtin gets it on stdin, not argv.
      const [, after] = line.split('|');
      if (after) assert.doesNotMatch(after, /\$PW/);
    }
    assert.ok(script.includes(`echo "${ACCOUNT_PASSWORD_MARK}$PW"`));
    assert.match(script, /\n  PW=\n/);
    // The account, not the person, joins group factiii, after it exists.
    assert.ok(script.indexOf('sysadminctl') < script.indexOf('dseditgroup -o edit -a factiii -t user factiii'));
    // No account block without the option.
    const plain = macSetupScript({ user: 'jon', opsHome: '/private/var/factiii-ops', runDir: '/r', serveProgram: ['/x'] });
    assert.doesNotMatch(plain, /sysadminctl|FACTIII_ACCOUNT_PASSWORD/);
  });

  it('refuses an account name or full name it would have to quote', async () => {
    const { macAccountBlock } = await import('./setup');
    assert.throws(() => macAccountBlock({ name: 'Fac tiii', fullName: 'Factiii' }), Error);
    assert.throws(() => macAccountBlock({ name: 'factiii', fullName: "F'; rm -rf /" }), Error);
  });
});
