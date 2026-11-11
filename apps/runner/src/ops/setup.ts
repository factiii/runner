import { BOARD_SLUG } from './protocol';
import { opsServicePlist } from './servers';
import { OPS_GROUP, OPS_USER } from './settings';

// The setup / repair script for the one OS admin prompt (.specs/ops-user.md,
// "Setup and repair"). Printed by `factiii-runner ops setup-script`, read by
// the person, run with admin rights by the person (or Factiii Desktop's
// prompt), never by the runner or an agent. Every step is idempotent, so the
// same script repairs.

const SAFE = /^[A-Za-z0-9_.\-/ ]+$/;

function checked(name: string, value: string): string {
  if (!SAFE.test(value)) throw new Error(`${name} has characters the script will not quote: ${value}`);
  return value;
}

/** One shell word in single quotes. For paths a person picked (an app
 *  bundle may have a space in its name); never for the dscl lines. */
function sq(value: string): string {
  if (value.includes('\0') || value.includes('\n')) throw new Error(`refusing a path with a control character: ${value}`);
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Factiii Desktop's part of the run (.specs/ops-user.md, "Rollout"):
 *  install what `ops stage` wrote, copy each board's store that the ops home
 *  does not have yet, own the app bundle. Every step is safe to repeat: a
 *  store already in the ops home is never overwritten by the normal user's
 *  older copy. */
export type MacMigration = {
  /** ops-config.json's text, from the stage. In the script itself, not read
   *  from the stage file: a normal-user process could swap that file between
   *  the person reading the checklist and root copying it, and the config
   *  names the repositories jobs come from. */
  config: string;
  /** The 0700 dir `ops stage` wrote (the GitHub tokens); removed at the end. */
  stageDir: string;
  /** The normal user's runner dir, `<runner dir>/<slug>/secrets` per board. */
  runnerDir: string;
  boards: string[];
  /** `/Applications/Factiii.app`: chowned to factiii-ops, not writable by
   *  the normal user. Omitted for a CLI-only setup. */
  app?: string;
};

function migrationBlock(home: string, m: MacMigration): string {
  const boards = m.boards.map((slug) => {
    if (!BOARD_SLUG.test(slug)) throw new Error(`not a board name: ${slug}`);
    return slug;
  });
  const own = `${OPS_USER}:${OPS_USER}`;
  // Valid JSON, and so never the heredoc's end word on a line of its own.
  const config = JSON.stringify(JSON.parse(m.config) as unknown, null, 2);
  const perBoard = boards
    .map(
      (slug) => `install -d -o ${OPS_USER} -g ${OPS_USER} -m 0700 ${home}/boards/${slug}
if [ -f "$STAGE/boards/${slug}/github-token" ] && [ ! -L "$STAGE/boards/${slug}/github-token" ]; then
  install -o ${OPS_USER} -g ${OPS_USER} -m 0600 "$STAGE/boards/${slug}/github-token" ${home}/boards/${slug}/github-token
fi
if [ ! -f ${home}/boards/${slug}/secrets/age-identity.enc ] && [ -f "$RUNNER_DIR/${slug}/secrets/age-identity.enc" ]; then
  echo "Copying the ${slug} store"
  ditto "$RUNNER_DIR/${slug}/secrets" ${home}/boards/${slug}/secrets
  if [ -f "$RUNNER_DIR/${slug}/audit.jsonl" ] && [ ! -L "$RUNNER_DIR/${slug}/audit.jsonl" ]; then
    ditto "$RUNNER_DIR/${slug}/audit.jsonl" ${home}/boards/${slug}/audit.jsonl
  fi
fi`
    )
    .join('\n');
  const app = m.app
    ? `
# The app the ops service runs from: the ops user's, so the normal user (and
# the AI) cannot change what runs as factiii-ops.
APP=${sq(m.app)}
if [ -d "$APP" ]; then
  chown -R ${OPS_USER}:wheel "$APP"
  chmod -R go-w "$APP"
fi
`
    : '';
  return `
# Migration: the staged config and GitHub tokens, then each board's store
# where the ops home has none yet (the normal user's copy stays until a job
# has run on the ops half).
STAGE=${sq(m.stageDir)}
RUNNER_DIR=${sq(m.runnerDir)}
cat > ${home}/ops-config.json <<'OPSCONFIG'
${config}
OPSCONFIG
chown ${own} ${home}/ops-config.json
chmod 0600 ${home}/ops-config.json
${perBoard}
chown -R ${own} ${home}/boards
chmod -R go-rwx ${home}/boards
rm -rf "$STAGE"
${app}`;
}

/** The ops user's own SSH key for prod (.specs/ops-user.md, "Prod SSH"):
 *  only factiii-ops can read it, so a normal-user process (the AI) cannot
 *  reach prod with it. Made once, kept on repair; prod accepts it after the
 *  prod-authorize-ops-key job. A planted link is refused, since chown and
 *  chmod as root would follow it. */
export function opsSshKeyBlock(home: string): string {
  const own = `${OPS_USER}:${OPS_USER}`;
  const key = `${home}/.ssh/prod_ed25519`;
  return `
# The ops user's SSH key for prod. Only ${OPS_USER} can read it.
[ ! -L ${home}/.ssh ] && [ ! -L ${key} ] && [ ! -L ${key}.pub ] || { echo "Refusing a link in ${home}/.ssh" >&2; exit 1; }
install -d -o ${OPS_USER} -g ${OPS_USER} -m 0700 ${home}/.ssh
[ -f ${key} ] || ssh-keygen -q -t ed25519 -N '' -C '${OPS_USER} prod' -f ${key}
chown ${own} ${key} ${key}.pub
chmod 0600 ${key}
chmod 0644 ${key}.pub
`;
}

/** The marked line the account block prints its password on, once. Factiii
 *  Desktop takes it out of the output before anything is shown or logged
 *  (desktop setup/mac.ts takeAccountPassword). */
export const ACCOUNT_PASSWORD_MARK = 'FACTIII_ACCOUNT_PASSWORD=';

const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,30}$/;

/** A standard macOS account of its own for the runner (.specs/ops-user.md,
 *  "Its own account"), made once: `sysadminctl -addUser` with no password,
 *  then a random password made here and set through dscl's stdin (never in
 *  any process's arguments), printed on the marked line and kept nowhere.
 *  Nothing is copied into it. */
export function macAccountBlock(account: { name: string; fullName: string }): string {
  if (!ACCOUNT_NAME.test(account.name)) throw new Error(`not an account name: ${account.name}`);
  if (!/^[A-Za-z0-9 ]{1,40}$/.test(account.fullName)) throw new Error(`not a plain full name: ${account.fullName}`);
  return `
# The runner's own account: a standard user, made once. Its password is made
# here, printed once on the marked line for Factiii Desktop to show, and kept
# nowhere.
if ! dscl . -read /Users/${account.name} >/dev/null 2>&1; then
  PW=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
  sysadminctl -addUser ${account.name} -fullName '${account.fullName}' >/dev/null 2>&1 || true
  dscl . -read /Users/${account.name} >/dev/null 2>&1 || { echo "Could not create the ${account.name} account." >&2; exit 1; }
  # The password never goes on a command line (any process can read argv):
  # dscl's own prompt reads it from stdin, written by printf, a shell builtin
  # that starts no process. No secure token: the account logs in by Fast
  # User Switching once the Mac is unlocked, not at a cold FileVault boot.
  printf 'passwd /Users/${account.name} %s\\n' "$PW" | dscl . >/dev/null
  echo "${ACCOUNT_PASSWORD_MARK}$PW"
  PW=
fi
`;
}

export function macSetupScript(opts: {
  /** The normal user, who joins group factiii. */
  user: string;
  opsHome: string;
  runDir: string;
  /** argv of `factiii-runner ops serve` as the daemon runs it. */
  serveProgram: string[];
  /** Extra env for the daemon: ELECTRON_RUN_AS_NODE=1 when it is
   *  Factiii.app's Electron. */
  serveEnv?: Record<string, string>;
  migrate?: MacMigration;
  /** Also make the runner's own account (its name is then `user`). */
  account?: { name: string; fullName: string };
}): string {
  const user = checked('user', opts.user);
  const accountBlock = opts.account ? macAccountBlock(opts.account) : '';
  const home = checked('ops home', opts.opsHome);
  const run = checked('run dir', opts.runDir);
  const plist = opsServicePlist({ opsHome: home, program: opts.serveProgram, env: opts.serveEnv });
  const migration = opts.migrate ? migrationBlock(home, opts.migrate) : '';
  return `#!/bin/sh
# Factiii ops user: setup and repair (.specs/ops-user.md). Run once with
# admin rights:  sudo sh ops-setup.sh
set -eu
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }

free_id() {  # first id in 400-499 used by no user and no group
  for id in $(seq 461 499); do
    dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$id" && continue
    dscl . -list /Groups PrimaryGroupID | awk '{print $2}' | grep -qx "$id" && continue
    echo "$id"; return
  done
  echo "No free id in 461-499" >&2; exit 1
}

# Group factiii-ops (the user's own) and the user, hidden, no login.
if ! dscl . -read /Users/${OPS_USER} >/dev/null 2>&1; then
  ID=$(free_id)
  dscl . -create /Groups/${OPS_USER}
  dscl . -create /Groups/${OPS_USER} PrimaryGroupID "$ID"
  dscl . -create /Groups/${OPS_USER} RealName "Factiii Ops"
  dscl . -create /Users/${OPS_USER}
  dscl . -create /Users/${OPS_USER} UniqueID "$ID"
  dscl . -create /Users/${OPS_USER} PrimaryGroupID "$ID"
  dscl . -create /Users/${OPS_USER} RealName "Factiii Ops"
  dscl . -create /Users/${OPS_USER} UserShell /usr/bin/false
  dscl . -create /Users/${OPS_USER} NFSHomeDirectory ${home}
  dscl . -create /Users/${OPS_USER} Password '*'
  dscl . -create /Users/${OPS_USER} IsHidden 1
fi

${accountBlock}
# Group factiii: who may reach the socket. The normal user only.
if ! dscl . -read /Groups/${OPS_GROUP} >/dev/null 2>&1; then
  GID=$(free_id)
  dscl . -create /Groups/${OPS_GROUP}
  dscl . -create /Groups/${OPS_GROUP} PrimaryGroupID "$GID"
  dscl . -create /Groups/${OPS_GROUP} RealName "Factiii runner"
fi
dseditgroup -o edit -a ${user} -t user ${OPS_GROUP}
# So the new membership is resolved now, not at the next login.
dscacheutil -flushcache || true

# Dirs, owners, modes (the table in the spec).
install -d -o ${OPS_USER} -g ${OPS_USER} -m 0700 ${home} ${home}/boards ${home}/repos ${home}/servers ${home}/logs
install -d -o ${OPS_USER} -g ${OPS_GROUP} -m 0750 ${run} ${run}/boards
install -d -o ${OPS_USER} -g ${OPS_GROUP} -m 1730 ${run}/peer
chown ${OPS_USER}:${OPS_USER} ${home}
chmod 0700 ${home}
chown ${OPS_USER}:${OPS_GROUP} ${run} ${run}/boards ${run}/peer
chmod 0750 ${run} ${run}/boards
chmod 1730 ${run}/peer
${opsSshKeyBlock(home)}${migration}
# The ops service.
cat > /Library/LaunchDaemons/com.factiii.ops.plist <<'PLIST'
${plist}PLIST
chown root:wheel /Library/LaunchDaemons/com.factiii.ops.plist
chmod 0644 /Library/LaunchDaemons/com.factiii.ops.plist
# bootout returns before launchd has torn the old service down, and a
# bootstrap in that window fails with "5: Input/output error" (Repair on a
# running service). Wait for it to go, then retry the bootstrap briefly.
launchctl bootout system/com.factiii.ops 2>/dev/null || true
i=0
while launchctl print system/com.factiii.ops >/dev/null 2>&1 && [ $i -lt 20 ]; do sleep 0.5; i=$((i+1)); done
i=0
until launchctl bootstrap system /Library/LaunchDaemons/com.factiii.ops.plist; do
  i=$((i+1))
  [ $i -ge 5 ] && { echo "Could not start the ops service (launchctl bootstrap)." >&2; exit 1; }
  sleep 1
done

echo "Done. Log out and back in so ${user} is in group ${OPS_GROUP}."
`;
}

export function linuxSetupScript(opts: {
  user: string;
  opsHome: string;
  serveProgram: string[];
}): string {
  const user = checked('user', opts.user);
  const home = checked('ops home', opts.opsHome);
  const exec = opts.serveProgram.map((a) => checked('program', a)).join(' ');
  return `#!/bin/sh
# Factiii ops user: setup and repair (.specs/ops-user.md). sudo sh ops-setup.sh
set -eu
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
getent group ${OPS_GROUP} >/dev/null || groupadd --system ${OPS_GROUP}
id ${OPS_USER} >/dev/null 2>&1 || useradd --system --home-dir ${home} --shell /usr/sbin/nologin --user-group ${OPS_USER}
usermod -aG ${OPS_GROUP} ${user}
install -d -o ${OPS_USER} -g ${OPS_USER} -m 0700 ${home} ${home}/boards ${home}/repos ${home}/servers ${home}/logs
${opsSshKeyBlock(home)}cat > /etc/systemd/system/factiii-ops.service <<'UNIT'
[Unit]
Description=Factiii ops user: secrets, jobs, servers
After=network-online.target

[Service]
User=${OPS_USER}
Group=${OPS_GROUP}
ExecStart=${exec}
Environment=HOME=${home}
Environment=SHELL=/bin/bash
RuntimeDirectory=factiii-ops
RuntimeDirectoryMode=0750
StateDirectory=factiii-ops
UMask=0077
Restart=always
RestartSec=10
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${home}

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now factiii-ops.service
echo "Done. Log out and back in so ${user} is in group ${OPS_GROUP}."
`;
}
