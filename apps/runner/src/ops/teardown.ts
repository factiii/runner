import { OPS_GROUP, OPS_USER } from './settings';

// The ops user's teardown, for a nuke (.specs/ops-user.md, "Teardown";
// .specs/runner-setup.md, "Nuke a runner"): the root half of what setup
// made, undone. Printed by `factiii-runner ops teardown-script`, run behind
// one admin prompt (Factiii Desktop's, or `| sudo sh` by the person), never
// by the runner or an agent. Only what setup made goes: the ops service and
// its servers, the ops user and its group, group factiii, the ops home (every
// board's secrets on the ops half) and the run dir, and the app given back.
// Nothing else on the machine (Homebrew, node, git, Ollama, ...) is touched.
// Every line is safe to repeat: a second run finds nothing and says Done.

const SAFE = /^[A-Za-z0-9_.\-/ ]+$/;

/** A path the script deletes: plain characters, absolute, and one of the
 *  ops user's own (its name in it), so a bad flag can never aim `rm -rf` at
 *  `/`, a home folder or anything else. */
function opsPath(name: string, value: string): string {
  if (!SAFE.test(value) || !value.startsWith('/') || value.includes('..')) {
    throw new Error(`${name} is not a plain absolute path: ${value}`);
  }
  if (!value.split('/').some((part) => part.startsWith(OPS_USER))) {
    throw new Error(`${name} is not the ops user's (${OPS_USER} is not in it): ${value}`);
  }
  return value;
}

function plain(name: string, value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`${name} has characters the script will not quote: ${value}`);
  return value;
}

/** One shell word in single quotes (an app bundle may have a space). */
function sq(value: string): string {
  if (value.includes('\0') || value.includes('\n')) throw new Error(`refusing a path with a control character: ${value}`);
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type TeardownOptions = {
  /** The normal user: leaves group factiii, and gets the app back. */
  user: string;
  opsHome: string;
  runDir: string;
  /** macOS: `/Applications/Factiii.app`, chowned back to the user. */
  app?: string;
};

/** What the teardown removes, as the lines the nuke plan shows before the
 *  phrase (shared by the runner's plan and Factiii Desktop). */
export function teardownPlanLines(opts: TeardownOptions & { platform: NodeJS.Platform }): string[] {
  const service =
    opts.platform === 'linux'
      ? 'The ops service (factiii-ops.service) and each server unit it runs are stopped and deleted.'
      : 'The ops service (com.factiii.ops) and each server it runs are stopped and their LaunchDaemons deleted.';
  return [
    `With your ${opts.platform === 'linux' ? 'sudo' : 'macOS admin'} password, once:`,
    service,
    `The hidden user ${OPS_USER} and its group are deleted, and group ${OPS_GROUP} (you leave it).`,
    `${opts.opsHome} is erased: every board's secrets on the ops user, its repositories, servers, keys and logs. And ${opts.runDir}.`,
    ...(opts.app ? [`${opts.app} is given back to ${opts.user}.`] : []),
    'Nothing else is uninstalled: Homebrew, node, git, Ollama and your other tools stay.'
  ];
}

/** The app bundle a bundled runner runs from (Factiii Desktop's Electron,
 *  `<app>/Contents/MacOS/<exe>`), or null. */
export function appBundleOf(execPath: string): string | null {
  const at = execPath.indexOf('.app/Contents/MacOS/');
  return at === -1 ? null : execPath.slice(0, at + '.app'.length);
}

/** What the nuke plan names for the ops half, when the ops user is on: left
 *  for the teardown, and how it is run. Factiii Desktop runs it after the
 *  erase; from a terminal the person runs it. */
export function opsTeardownLeftBehind(opts: TeardownOptions & { platform: NodeJS.Platform; desktop: boolean }): string[] {
  const how = opts.desktop
    ? 'Factiii Desktop removes the ops user next'
    : 'Then remove the ops user: `factiii-runner ops teardown-script | sudo sh`';
  return [
    `${how}.`,
    ...teardownPlanLines(opts),
    ...(opts.desktop
      ? ["And Factiii Desktop's runner command (~/.factiii-desktop/bin/factiii-runner) and its setup record."]
      : [])
  ];
}

export function macTeardownScript(opts: TeardownOptions): string {
  const user = plain('user', opts.user);
  const home = opsPath('ops home', opts.opsHome);
  const run = opsPath('run dir', opts.runDir);
  const app = opts.app
    ? `
# The app back to ${user}: setup gave it to ${OPS_USER}.
APP=${sq(opts.app)}
if [ -d "$APP" ]; then
  chown -R ${user}:staff "$APP"
fi
`
    : '';
  return `#!/bin/sh
# Factiii ops user: teardown (.specs/ops-user.md). Run once with admin
# rights:  sudo sh ops-teardown.sh
set -eu
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }

# The ops service and each server it runs.
for plist in /Library/LaunchDaemons/com.factiii.ops.plist /Library/LaunchDaemons/com.factiii.ops.*.plist; do
  [ -f "$plist" ] || continue
  label=$(basename "$plist" .plist)
  launchctl bootout "system/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "Removed $label"
done

# Anything still running as ${OPS_USER}, then the user and its group.
pkill -u ${OPS_USER} 2>/dev/null || true
if dscl . -read /Users/${OPS_USER} >/dev/null 2>&1; then
  dscl . -delete /Users/${OPS_USER}
  echo "Deleted user ${OPS_USER}"
fi
if dscl . -read /Groups/${OPS_USER} >/dev/null 2>&1; then
  dscl . -delete /Groups/${OPS_USER}
fi
# Group factiii, which only reached the ops socket.
if dscl . -read /Groups/${OPS_GROUP} >/dev/null 2>&1; then
  dseditgroup -o edit -d ${user} -t user ${OPS_GROUP} 2>/dev/null || true
  dscl . -delete /Groups/${OPS_GROUP}
  echo "Deleted group ${OPS_GROUP}"
fi
dscacheutil -flushcache || true

# The ops home (every board's secrets on the ops half) and the run dir.
rm -rf ${home} ${run}
echo "Erased ${home} and ${run}"
${app}
echo "Done."
`;
}

export function linuxTeardownScript(opts: TeardownOptions): string {
  const user = plain('user', opts.user);
  const home = opsPath('ops home', opts.opsHome);
  const run = opsPath('run dir', opts.runDir);
  return `#!/bin/sh
# Factiii ops user: teardown (.specs/ops-user.md). sudo sh ops-teardown.sh
set -eu
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
for unit in /etc/systemd/system/factiii-ops.service /etc/systemd/system/factiii-ops-*.service; do
  [ -f "$unit" ] || continue
  systemctl disable --now "$(basename "$unit")" 2>/dev/null || true
  rm -f "$unit"
done
systemctl daemon-reload
pkill -u ${OPS_USER} 2>/dev/null || true
id ${OPS_USER} >/dev/null 2>&1 && userdel ${OPS_USER}
getent group ${OPS_USER} >/dev/null && groupdel ${OPS_USER}
if getent group ${OPS_GROUP} >/dev/null; then
  gpasswd -d ${user} ${OPS_GROUP} 2>/dev/null || true
  groupdel ${OPS_GROUP}
fi
rm -rf ${home} ${run}
echo "Done."
`;
}
