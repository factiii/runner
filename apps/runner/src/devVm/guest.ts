import { SESSION_USER, shQuote, VM_ENV_BIN, VM_RUN_BIN, VM_TOKEN_DIR } from './ssh';

// Everything the runner runs inside the dev VM as a script (.specs/dev-vm.md).
// Strings, not files in the image: the runner is the one source of the VM's
// setup, so a rebuild from a clean image gets exactly this, and a runner
// update re-applies it on the next VM start.

/** The client for the narrow path's simulator op, installed in the VM. */
export const VM_SIM_BIN = '/usr/local/bin/factiii-sim';

/** Versions the provision installs. Pinned, so a rebuild is the same VM. */
export const NODE_VERSION = '22.12.0';
export const GH_VERSION = '2.63.0';

/** Address blocks a session may never reach: the LAN, link-local (cloud
 *  metadata), CGNAT (Tailscale) and multicast. The host gateway is refused on
 *  its own rule, DNS aside. */
export const BLOCKED_V4 = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '0.0.0.0/8',
  '224.0.0.0/4'
];
export const BLOCKED_V6 = ['fc00::/7', 'fe80::/10'];

/** `factiii-vm-env <slug> cmd...`: the space's tokens, then cmd. The file is
 *  on tmpfs and written by the runner from the Mac (tokens.ts). */
const VM_ENV_SCRIPT = `#!/bin/sh
# factiii-vm-env <space> <cmd...>: this space's tokens (pushed into tmpfs by
# the runner on the Mac, never on this disk), then <cmd>.
slug="$1"; shift
case "$slug" in ''|*[!A-Za-z0-9_.-]*) echo "factiii-vm-env: bad space name" >&2; exit 2;; esac
f="${VM_TOKEN_DIR}/$slug.env"
if [ -r "$f" ]; then set -a; . "$f"; set +a; fi
exec "$@"
`;

/** `factiii-vm-run cmd...`: cmd in a process group of its own, taken down when
 *  the ssh session that started it ends. Without a remote terminal sshd sends
 *  nothing when the runner kills its ssh, and an agent CLI left behind would
 *  keep working on a card nobody is watching. stdin is handed over on fd 3:
 *  a background job in a shell without job control gets /dev/null instead. */
const VM_RUN_SCRIPT = `#!/bin/bash
exec 3<&0
setsid "$@" <&3 3<&- &
child=$!
exec 3<&-
parent=$PPID
(
  while kill -0 "$child" 2>/dev/null; do
    if ! kill -0 "$parent" 2>/dev/null; then
      kill -TERM -- "-$child" 2>/dev/null
      sleep 5
      kill -KILL -- "-$child" 2>/dev/null
      exit 0
    fi
    sleep 1
  done
) </dev/null >/dev/null 2>&1 &
wait "$child"
exit $?
`;

/** `factiii-sim`: the VM's one way to the Mac's iOS simulator, through the
 *  narrow path's `simctl` op (narrowPath.ts). Node, as factiii-secrets is. */
const VM_SIM_SCRIPT = `#!/usr/bin/env node
'use strict';
// factiii-sim list | openurl <url> | launch <bundle-id> | terminate <bundle-id> | screenshot <out.png>
// Drives the iOS simulator on the Mac from the dev VM. The device is the
// booted one, or FACTIII_SIM_UDID. Metro in the VM is forwarded to the Mac's
// localhost, so "openurl exp+app://expo-development-client/?url=http://localhost:<port>"
// loads this branch's JS into the dev client built from main.
const net = require('net');
const fs = require('fs');
const [verb, arg] = process.argv.slice(2);
const sock = process.env.FACTIII_SECRETS_SOCK;
const token = process.env.FACTIII_SECRETS_TOKEN || '';
if (!verb || !sock) {
  process.stderr.write('usage: factiii-sim list | openurl <url> | launch <bundle-id> | terminate <bundle-id> | screenshot <out.png>\\n(only inside a runner session)\\n');
  process.exit(3);
}
const device = process.env.FACTIII_SIM_UDID || 'booted';
const args = verb === 'list' ? ['list', 'devices', '-j']
  : verb === 'screenshot' ? ['io', device, 'screenshot']
  : [verb, device, arg || ''];
const conn = net.createConnection(sock);
let buf = '';
conn.on('error', (e) => { process.stderr.write('factiii-sim: ' + e.message + '\\n'); process.exit(3); });
conn.on('connect', () => conn.write(JSON.stringify({ op: 'simctl', token, args }) + '\\n'));
conn.on('data', (d) => {
  buf += d;
  const nl = buf.indexOf('\\n');
  if (nl === -1) return;
  const msg = JSON.parse(buf.slice(0, nl));
  conn.end();
  if (msg.type === 'error') { process.stderr.write('factiii-sim: ' + msg.message + '\\n'); process.exit(77); }
  if (verb === 'screenshot' && msg.png) { fs.writeFileSync(arg || 'screenshot.png', Buffer.from(msg.png, 'base64')); }
  if (msg.output) process.stdout.write(msg.output);
  process.exit(typeof msg.code === 'number' ? msg.code : 1);
});
`;

/** Write a file from a heredoc, mode and owner set. */
function installFile(dest: string, body: string, mode: string): string {
  const tag = 'FACTIII_EOF';
  return [
    `cat > ${shQuote(dest)} <<'${tag}'`,
    body.replace(/\n$/, ''),
    tag,
    `chmod ${mode} ${shQuote(dest)}`
  ].join('\n');
}

/**
 * The firewall, as root, re-applied on every VM start (Lima keeps no iptables
 * state across a reboot). Everything leaving the VM may go to the internet
 * and nowhere else: not the Mac (the gateway, which Lima's network maps onto
 * the Mac's 127.0.0.1), not the LAN. DNS to the gateway is the one exception,
 * since the VM's resolver forwards there.
 *
 * Every uid, not just the session user's: the session user has no sudo, so
 * this is what it cannot change, and a container (FORWARD, through
 * DOCKER-USER, which docker never flushes) is held to the same rules.
 *
 * The narrow path does not need a hole: it is a socket forwarded over the ssh
 * connection the Mac opened INTO the VM (tunnel.ts), not a connection out.
 */
export function firewallScript(): string {
  const v4 = (chain: string) =>
    [...BLOCKED_V4].map((net) => `iptables -A ${chain} -d ${net} -j REJECT`);
  return [
    'GW="$(ip -4 route show default | awk \'{print $3; exit}\')"',
    'if [ -z "$GW" ]; then echo "factiii-devvm: no default route" >&2; exit 1; fi',
    // Sessions' own traffic.
    'iptables -N FACTIII-OUT 2>/dev/null || iptables -F FACTIII-OUT',
    'iptables -A FACTIII-OUT -o lo -j RETURN',
    'iptables -A FACTIII-OUT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
    'iptables -A FACTIII-OUT -o docker0 -j RETURN',
    'iptables -A FACTIII-OUT -o br-+ -j RETURN',
    'iptables -A FACTIII-OUT -d "$GW" -p udp --dport 53 -j RETURN',
    'iptables -A FACTIII-OUT -d "$GW" -p tcp --dport 53 -j RETURN',
    'iptables -A FACTIII-OUT -p udp --sport 68 --dport 67 -j RETURN',
    'iptables -A FACTIII-OUT -d "$GW" -j REJECT',
    ...v4('FACTIII-OUT'),
    'iptables -C OUTPUT -j FACTIII-OUT 2>/dev/null || iptables -I OUTPUT 1 -j FACTIII-OUT',
    // Containers' traffic.
    'iptables -N FACTIII-FWD 2>/dev/null || iptables -F FACTIII-FWD',
    'iptables -A FACTIII-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
    'iptables -A FACTIII-FWD -o docker0 -j RETURN',
    'iptables -A FACTIII-FWD -o br-+ -j RETURN',
    'iptables -A FACTIII-FWD -d "$GW" -p udp --dport 53 -j RETURN',
    'iptables -A FACTIII-FWD -d "$GW" -p tcp --dport 53 -j RETURN',
    'iptables -A FACTIII-FWD -d "$GW" -j REJECT',
    ...v4('FACTIII-FWD'),
    'iptables -N DOCKER-USER 2>/dev/null || true',
    'iptables -C DOCKER-USER -j FACTIII-FWD 2>/dev/null || iptables -I DOCKER-USER 1 -j FACTIII-FWD',
    'iptables -C FORWARD -j DOCKER-USER 2>/dev/null || iptables -I FORWARD 1 -j DOCKER-USER',
    // IPv6: neighbour discovery needs ICMPv6; private and link-local go.
    'ip6tables -N FACTIII-OUT 2>/dev/null || ip6tables -F FACTIII-OUT',
    'ip6tables -A FACTIII-OUT -o lo -j RETURN',
    'ip6tables -A FACTIII-OUT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
    'ip6tables -A FACTIII-OUT -p ipv6-icmp -j RETURN',
    ...BLOCKED_V6.map((net) => `ip6tables -A FACTIII-OUT -d ${net} -j REJECT`),
    'ip6tables -C OUTPUT -j FACTIII-OUT 2>/dev/null || ip6tables -I OUTPUT 1 -j FACTIII-OUT'
  ].join('\n');
}

export type GuestLayout = {
  /** The Mac's runner dir (~/.factiii-runner). The same path exists in the
   *  VM, as the VM's own directory, with only the mounts below in it. */
  runnerDir: string;
  /** Each space dir, by the same path. */
  spaceDirs: string[];
  /** The runner's Claude home path (CLAUDE_CONFIG_DIR): on the VM's disk,
   *  with the plugin and settings copied in and never a credential. */
  claudeHome: string;
  /** The runner's Codex home path (CODEX_HOME): tmpfs in the VM, since its
   *  auth.json is a sign-in. */
  codexHome: string;
};

/** The directories in a space dir that are the VM's own (not mounts). */
const VM_LOCAL_SPACE_DIRS = ['state', 'builds', 'backups', 'workspace'];

/**
 * Run as root on every VM start, and before sessions (devVm.ts ensure):
 * cheap and idempotent. Prints the boot id last, which is how the runner
 * tells a VM that restarted (and so lost /run and the firewall) from one that
 * did not.
 */
export function bootScript(layout: GuestLayout): string {
  const U = SESSION_USER;
  const own = (dir: string) => `install -d -m 755 -o ${U} -g ${U} ${shQuote(dir)}`;
  const lines = [
    'set -eu',
    `if ! id -u ${U} >/dev/null 2>&1; then echo "factiii-devvm: no ${U} user in the VM; run: factiii-runner devvm provision" >&2; exit 3; fi`,
    `install -d -m 700 -o ${U} -g ${U} ${VM_TOKEN_DIR}`,
    `mkdir -p ${shQuote(layout.runnerDir)}`,
    own(layout.runnerDir)
  ];
  for (const space of layout.spaceDirs) {
    // mkdir, not install: the space dir holds mount points, and those parents
    // exist already when Lima mounted under them.
    lines.push(`mkdir -p ${shQuote(space)}`, `chown ${U}:${U} ${shQuote(space)}`);
    for (const sub of VM_LOCAL_SPACE_DIRS) lines.push(own(`${space}/${sub}`));
  }
  lines.push(
    `mkdir -p ${shQuote(layout.claudeHome)} ${shQuote(layout.codexHome)}`,
    `chown ${U}:${U} ${shQuote(layout.claudeHome)}`,
    `if ! mountpoint -q ${shQuote(layout.codexHome)}; then mount -t tmpfs -o size=256m,mode=700,uid=$(id -u ${U}),gid=$(id -g ${U}) tmpfs ${shQuote(layout.codexHome)}; fi`,
    firewallScript(),
    'cat /proc/sys/kernel/random/boot_id'
  );
  return lines.join('\n');
}

/**
 * The full setup, as root, from a clean Colima image: packages, the agent
 * CLIs, the session user and the wrappers, then the boot script. Run by
 * `factiii-runner devvm provision` (and rebuild), never by the daemon on its
 * own: it downloads and installs, and the owner should see it happen.
 */
export function provisionScript(layout: GuestLayout): string {
  const U = SESSION_USER;
  return [
    'set -eu',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -q',
    'apt-get install -y -q tmux git curl ca-certificates jq python3 build-essential ripgrep xz-utils iptables',
    // Node, from nodejs.org, checked against its published SHA-256 list.
    'ARCH="$(uname -m)"; case "$ARCH" in aarch64) NARCH=arm64; GARCH=arm64;; x86_64) NARCH=x64; GARCH=amd64;; *) echo "unsupported arch $ARCH" >&2; exit 1;; esac',
    `if [ "$(node --version 2>/dev/null)" != "v${NODE_VERSION}" ]; then`,
    '  T="$(mktemp -d)"',
    `  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-$NARCH.tar.xz" -o "$T/node.tar.xz"`,
    `  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$T/SUMS"`,
    `  (cd "$T" && grep " node-v${NODE_VERSION}-linux-$NARCH.tar.xz\\$" SUMS | sed "s/node-v.*/node.tar.xz/" | sha256sum -c -)`,
    '  tar -xJf "$T/node.tar.xz" -C /usr/local --strip-components=1',
    '  rm -rf "$T"',
    'fi',
    // gh, from its release, checked against its checksums file.
    `if [ "$(gh --version 2>/dev/null | head -1 | awk '{print $3}')" != "${GH_VERSION}" ]; then`,
    '  T="$(mktemp -d)"',
    `  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_$GARCH.tar.gz" -o "$T/gh.tar.gz"`,
    `  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" -o "$T/SUMS"`,
    `  (cd "$T" && grep " gh_${GH_VERSION}_linux_$GARCH.tar.gz\\$" SUMS | sed "s/gh_.*/gh.tar.gz/" | sha256sum -c -)`,
    '  tar -xzf "$T/gh.tar.gz" -C "$T"',
    `  install -m 755 "$T/gh_${GH_VERSION}_linux_$GARCH/bin/gh" /usr/local/bin/gh`,
    '  rm -rf "$T"',
    'fi',
    'npm install -g --no-fund --no-audit @anthropic-ai/claude-code @openai/codex',
    // The session user: no sudo, no docker group, the Lima key to log in.
    `id -u ${U} >/dev/null 2>&1 || useradd -m -s /bin/bash ${U}`,
    `gpasswd -d ${U} docker >/dev/null 2>&1 || true`,
    `gpasswd -d ${U} sudo >/dev/null 2>&1 || true`,
    `rm -f /etc/sudoers.d/${U}`,
    'LIMA_HOME_DIR="$(getent passwd "${SUDO_USER:-}" | cut -d: -f6)"',
    'if [ -z "$LIMA_HOME_DIR" ] || [ ! -f "$LIMA_HOME_DIR/.ssh/authorized_keys" ]; then echo "factiii-devvm: run as the Lima user through sudo" >&2; exit 1; fi',
    `install -d -m 700 -o ${U} -g ${U} /home/${U}/.ssh`,
    `install -m 600 -o ${U} -g ${U} "$LIMA_HOME_DIR/.ssh/authorized_keys" /home/${U}/.ssh/authorized_keys`,
    // The narrow path's -R socket replaces a stale one from the last tunnel.
    "printf 'StreamLocalBindUnlink yes\\nAllowStreamLocalForwarding yes\\n' > /etc/ssh/sshd_config.d/60-factiii.conf",
    'systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true',
    installFile(VM_ENV_BIN, VM_ENV_SCRIPT, '755'),
    installFile(VM_RUN_BIN, VM_RUN_SCRIPT, '755'),
    installFile(VM_SIM_BIN, VM_SIM_SCRIPT, '755'),
    bootScript(layout)
  ].join('\n');
}

export type IsolationTargets = {
  /** The Mac's home and runner dir, by their Mac paths. */
  hostHome: string;
  runnerDir: string;
  spaceDirs: string[];
  /** The only paths that may be mounted from the Mac. */
  allowedMounts: string[];
  /** Ports listening on the Mac (its loopback included), all of which must be
   *  out of reach through the gateway. */
  hostPorts: number[];
  /** Addresses on the Mac's LAN, e.g. its own LAN IP and its router. */
  lanHosts: string[];
  /** The narrow path's socket for each space, inside the VM. */
  narrowSockets: string[];
};

/**
 * The isolation test, run in the VM AS THE SESSION USER: every way out of
 * the VM a session should not have, tried, and each one must fail. Prints
 * PASS/FAIL per probe and exits 1 on any FAIL. `devvm isolation-test` runs it.
 */
export function isolationTestScript(t: IsolationTargets): string {
  const list = (xs: (string | number)[]) => xs.map((x) => shQuote(String(x))).join(' ');
  const secretPaths = [
    `${t.hostHome}/.ssh`,
    `${t.hostHome}/Library/Keychains`,
    `${t.hostHome}/.colima`,
    `${t.hostHome}/.aws`,
    `${t.runnerDir}/config.json`,
    `${t.runnerDir}/access.json`,
    `${t.runnerDir}/secrets`,
    `${t.runnerDir}/agent-home/claude/.credentials.json`,
    `${t.runnerDir}/agent-home/claude/history.jsonl`,
    ...t.spaceDirs.flatMap((d) => [
      `${d}/.secret`,
      `${d}/.session-key`,
      `${d}/secrets`,
      `${d}/.creds`,
      `${d}/.factiii-frp-env`
    ])
  ];
  return `#!/bin/bash
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }
echo "isolation test as $(id -un) (uid $(id -u)) on $(hostname)"
GW="$(ip -4 route show default | awk '{print $3; exit}')"

# 1. The Mac's files. None of these may exist in the VM at all.
for p in ${list(secretPaths)}; do
  if [ -e "$p" ] || [ -L "$p" ]; then bad "file reachable: $p"; else ok "no $p"; fi
done
if command -v security >/dev/null 2>&1; then bad "a keychain tool (security) exists"; else ok "no keychain tool"; fi

# 2. Mounts: only the allowed paths, never the Mac's home.
allowed=(${list(t.allowedMounts)})
while read -r target; do
  [ -z "$target" ] && continue
  hit=0; for a in "\${allowed[@]}"; do [ "\${target%/}" = "\${a%/}" ] && hit=1; done
  if [ $hit = 1 ]; then ok "mount allowed: $target"; else bad "mount not allowed: $target"; fi
done < <(findmnt -rn -t virtiofs,fuse.sshfs,9p -o TARGET)
if findmnt -rn -o TARGET | grep -qx ${shQuote(t.hostHome)}; then bad "the Mac home is mounted"; else ok "the Mac home is not mounted"; fi

# 3. No way to root: sudo, the docker socket.
if sudo -n true 2>/dev/null; then bad "sudo works"; else ok "no sudo"; fi
if timeout 3 curl -s --unix-socket /var/run/docker.sock http://d/_ping >/dev/null 2>&1; then bad "docker socket reachable"; else ok "docker socket refused"; fi

# 4. The Mac's ports through the gateway, and the LAN.
for p in ${list(t.hostPorts)}; do
  # DNS is the firewall's one exception: the VM's resolver forwards to the
  # gateway, which answers on Lima's own resolver, not a Mac service.
  if [ "$p" = 53 ]; then echo "ALLOW Mac port 53 via gateway (DNS, the one exception)"; continue; fi
  if timeout 2 bash -c "</dev/tcp/$GW/$p" 2>/dev/null; then bad "Mac port $p open via gateway $GW"; else ok "Mac port $p closed via gateway"; fi
done
for h in ${list(t.lanHosts)} 169.254.169.254 100.100.100.100; do
  for p in 22 80 443 5000 8080; do
    if timeout 2 bash -c "</dev/tcp/$h/$p" 2>/dev/null; then bad "LAN $h:$p reachable"; else ok "LAN $h:$p refused"; fi
  done
done
if python3 - <<'PY' 2>/dev/null
import socket, sys
opened = []
for port in (22, 1024, 2222, 5000, 8080):
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        s.connect((2, port)); opened.append(port)
    except Exception:
        pass
    finally:
        s.close()
sys.exit(1 if opened else 0)
PY
then ok "no vsock service on the host (CID 2)"; else bad "a vsock port on the host answered"; fi

# 5. The narrow path: what it refuses, it must refuse.
for s in ${list(t.narrowSockets)}; do
  if [ ! -S "$s" ]; then bad "narrow path socket missing: $s"; continue; fi
  for op in run tunnel-token; do
    reply="$(python3 - "$s" "$op" <<'PY' 2>&1
import json, os, socket, sys
c = socket.socket(socket.AF_UNIX); c.settimeout(10); c.connect(sys.argv[1])
c.sendall((json.dumps({"op": sys.argv[2], "command": "id", "keys": [], "token": os.environ.get("FACTIII_SECRETS_TOKEN", "")}) + "\\n").encode())
print(c.makefile().readline().strip())
PY
)"
    case "$reply" in *'"type": "error"'*|*'"type":"error"'*) ok "narrow path refuses $op ($s)";; *) bad "narrow path answered $op: $reply";; esac
  done
  reply="$(python3 - "$s" <<'PY' 2>&1
import json, socket, sys
c = socket.socket(socket.AF_UNIX); c.settimeout(10); c.connect(sys.argv[1])
c.sendall((json.dumps({"op": "job-list", "token": "not-a-token"}) + "\\n").encode())
print(c.makefile().readline().strip())
PY
)"
  case "$reply" in *'"type": "error"'*|*'"type":"error"'*) ok "narrow path refuses a bad token ($s)";; *) bad "narrow path took a bad token: $reply";; esac
done

# Control: the internet itself is reachable (npm, GitHub, the model APIs).
if timeout 10 curl -sI https://github.com >/dev/null 2>&1; then echo "INFO internet reachable"; else echo "INFO internet NOT reachable"; fi

echo "isolation: $pass passed, $fail failed"
[ $fail = 0 ]
`;
}
