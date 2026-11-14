// Shell scripts `installFrpcHarness` stages. Backslash-escaped `\${VAR}` defers
// expansion to run time. Paths are parameters so two spaces on one host get
// their own, with no root needed.

type FrpcScriptPaths = {
  /** Env file holding FACTIII_FRP_* and the task id. No credential. */
  envFile: string;
  /** Per-session dir for generated toml, pidfiles, and logs. */
  runDir: string;
  /** The staged `factiii-secrets`, which asks the runner for the tunnel
   *  credential over the space's secrets socket. */
  secretsBin: string;
  /** That socket, for a shell that does not have FACTIII_SECRETS_SOCK. */
  secretsSock: string;
  /** Where frpc lives once downloaded. Absent until the first tunnel. */
  frpcBinary: string;
};

/** The frp release `factiii-expose` downloads on first use. The package no
 *  longer ships frpc: a tunnel client inside an npm tarball reads as a hacking
 *  tool to malware scanners, and most runners never open a tunnel. Factiii
 *  Desktop's own signed frpc is built from this same pin
 *  (apps/desktop/scripts/build-tools.sh reads it and FRP_SHA256). */
export const FRP_VERSION = '0.72.0';

/** SHA-256 of each platform's official tarball, as frp publishes them in
 *  frp_sha256_checksums.txt for this release. A download that does not match
 *  is refused, so the binary is upstream's, byte for byte. Bump with
 *  FRP_VERSION. */
export const FRP_SHA256: Record<string, string> = {
  darwin_arm64:
    '6e8576c5b6b9914a86850f6ff4fb81c5a09e706f91f70f64d5f398558bdc9db8',
  darwin_amd64:
    '60439dc6bf794c4182a1a4cac147d642f839d55201607208979eb23aecd09be9',
  linux_amd64:
    'daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804',
  linux_arm64:
    '02180b857480302fd934e9ddbd50fe2f73229f99062f88756abc6de9df5e95cf'
};

/** `uname -s`-`uname -m` patterns for each of frp's builds. */
const FRP_UNAME: Record<string, string> = {
  darwin_arm64: 'Darwin-arm64',
  darwin_amd64: 'Darwin-x86_64',
  linux_amd64: 'Linux-x86_64',
  linux_arm64: 'Linux-aarch64|Linux-arm64'
};

/** Shell that leaves frpc at FRPC: Factiii Desktop's signed copy when its
 *  tools folder (FACTIII_TOOLS_DIR) has one (macOS), else downloaded the
 *  first time a tunnel is opened: frp's own GitHub release, checked against
 *  FRP_SHA256, nothing run from it until the check passes (Linux, headless,
 *  an npm runner). */
function frpcDownload(): string {
  const cases = Object.entries(FRP_UNAME)
    .map(
      ([plat, uname]) =>
        `    ${uname}) PLAT=${plat}; SUM=${FRP_SHA256[plat]} ;;`
    )
    .join('\n');
  return `if [ ! -x "$FRPC" ] && [ -n "\${FACTIII_TOOLS_DIR:-}" ] && [ -x "$FACTIII_TOOLS_DIR/frpc" ]; then
  FRPC="$FACTIII_TOOLS_DIR/frpc"
fi
if [ ! -x "$FRPC" ]; then
  case "$(uname -s)-$(uname -m)" in
${cases}
    *) echo "factiii-expose: no frp ${FRP_VERSION} build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
  esac
  URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_\${PLAT}.tar.gz"
  echo "factiii-expose: first tunnel here, so downloading the frp client (frpc ${FRP_VERSION}) from $URL" >&2
  DL="$(mktemp -d)"
  trap 'rm -rf "$DL"' EXIT
  curl -fsSL "$URL" -o "$DL/frp.tar.gz"
  GOT="$( (shasum -a 256 "$DL/frp.tar.gz" 2>/dev/null || sha256sum "$DL/frp.tar.gz") | cut -d' ' -f1)"
  if [ "$GOT" != "$SUM" ]; then
    echo "factiii-expose: the download's SHA-256 is $GOT, not frp's published $SUM. Refused; nothing was installed." >&2
    exit 1
  fi
  tar -xzf "$DL/frp.tar.gz" -C "$DL"
  mkdir -p "$(dirname "$FRPC")"
  mv "$DL/frp_${FRP_VERSION}_\${PLAT}/frpc" "$FRPC.part"
  chmod 755 "$FRPC.part"
  mv "$FRPC.part" "$FRPC"
  rm -rf "$DL"
  trap - EXIT
fi
`;
}

// The credential frps wants is a tunnel credential (runner-link.md "Tunnel
// credential"). It is not in the env file and not in the toml:
// `factiii-expose` asks the runner for it when it opens a tunnel
// (`factiii-secrets tunnel-token --tunnel <name>`, authenticated by the
// session's FACTIII_SECRETS_TOKEN), and hands it to the frpc child in that
// process's environment only. The toml names the variable; frpc fills it in
// when it reads the file (`{{ .Envs.NAME }}`).
//
// frpc logs in again with the credential it started with whenever its
// connection drops, and a tunnel credential lives 7 days. So frpc does not run
// alone: a keeper (the backgrounded `keep` below, whose pid is `<name>.pid`)
// starts it and keeps it logged in:
// - Renewal: every TUNNEL_RENEW_EVERY_SECONDS it asks the runner for a fresh
//   credential with the tunnel's renewal handle (`--renew`, which outlives the
//   session that opened the tunnel) and holds it in memory. frpc is NOT
//   restarted for it: the credential only matters at a login, so a tunnel
//   that stays up is never interrupted. (frpc's admin `reload` would not help:
//   it reloads proxies, never the login metadata, and the env it reads is
//   fixed at start.)
// - Refused login: when frpc's log shows frps refusing a login
//   (FRP_LOGIN_REFUSED, after a drop past the old credential's end), frpc is
//   restarted with the held credential; when that one is what was refused,
//   the keeper asks for a new one first. Asks after a refusal, and retries of
//   a failed renewal, back off from TUNNEL_RETRY_MIN_SECONDS to
//   TUNNEL_RETRY_MAX_SECONDS, so a tunnel costs the server's mint limit (60 per
//   runner per 10 min) about one credential a day.
// - Nothing to log in with: when the refused credential is all it has (the
//   runner gave no new one, e.g. it was revoked), frpc is stopped rather than
//   left retrying the refused login every ~20 s. The keeper keeps asking on
//   the same back-off and starts frpc again once it gets a credential.
// - frpc exiting on its own is restarted; `loginFailExit = false` keeps a
//   failed first login (frps down) retrying instead of ending the tunnel.
// No line the keeper writes holds the credential or the handle.

/** How often a tunnel's keeper renews its credential: one day against the
 *  7-day life, so the held one always has 6 days left. */
export const TUNNEL_RENEW_EVERY_SECONDS = 24 * 60 * 60;
/** How often the keeper looks at frpc and its log. */
export const TUNNEL_CHECK_SECONDS = 15;
/** The first wait after a failed renewal, or after asking because of a
 *  refused login; doubled each time up to the max. */
export const TUNNEL_RETRY_MIN_SECONDS = 5 * 60;
export const TUNNEL_RETRY_MAX_SECONDS = 60 * 60;

/** What frpc's log says when frps refuses a login: the server's own reject
 *  reasons (apps/server/src/routers/frpAuth.ts), and frps's generic one when
 *  it hides details from clients. A network error is none of these: frpc
 *  retries that itself. */
export const FRP_LOGIN_REFUSED = [
  'invalid or revoked token',
  'missing factiii_token',
  'register control error'
];
/** What frpc's log says after a login that worked. */
export const FRP_LOGIN_OK = 'login to server success';

export function frpcExposeScript(p: FrpcScriptPaths): string {
  const loginGrep = [...FRP_LOGIN_REFUSED, FRP_LOGIN_OK]
    .map((line) => `-e '${line}'`)
    .join(' ');
  return `#!/bin/sh
set -e
set -a; . '${p.envFile}' 2>/dev/null || true; set +a
# An env file from before the credential moved out of it may still hold one.
unset FACTIII_FRP_TOKEN FACTIII_FRP_RENEW
mkdir -p '${p.runDir}'
PORT="$1"
NAME="$2"
if [ -z "$PORT" ] || [ -z "$NAME" ]; then
  echo "usage: factiii-expose <port> <name>" >&2
  echo "  e.g. factiii-expose 3000 app" >&2
  exit 1
fi
case "$NAME" in *[!a-zA-Z0-9-]*|"") echo "name must be [a-zA-Z0-9-]" >&2; exit 1 ;; esac
# <name>-<tag>: the tag is a short hash of the task id (frpc.ts previewTag).
# An env file written before the tag existed falls back to the whole task id.
if [ -n "$FACTIII_FRP_TAG" ]; then
  PROXY="\${NAME}-\${FACTIII_FRP_TAG}"
else
  PROXY="\${FACTIII_TASK_ID}-\${NAME}"
fi
DOMAIN="\${PROXY}.\${FACTIII_FRP_DOMAIN}"
FRPC='${p.frpcBinary}'
${frpcDownload()}RUN='${p.runDir}'
TOML="$RUN/\${NAME}.toml"
LOG="$RUN/\${NAME}.log"
PID_FILE="$RUN/\${NAME}.pid"
NONCE_FILE="$RUN/\${NAME}.nonce"
if [ -z "$FACTIII_SECRETS_SOCK" ]; then
  FACTIII_SECRETS_SOCK='${p.secretsSock}'
  export FACTIII_SECRETS_SOCK
fi
# Re-running with the same name replaces that tunnel: its keeper stops, and
# takes its frpc with it. Its renewal handle dies with the nonce file.
if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
fi
rm -f "$PID_FILE" "$NONCE_FILE"
# Two lines: the credential, then the tunnel's renewal handle (none from a
# runner that gives none: the keeper then cannot renew).
if ! ANSWER="$('${p.secretsBin}' tunnel-token --tunnel "$NAME")"; then
  ANSWER=''
fi
FRP_TOKEN="$(printf '%s\\n' "$ANSWER" | sed -n 1p)"
FRP_RENEW="$(printf '%s\\n' "$ANSWER" | sed -n 2p)"
ANSWER=''
if [ -z "$FRP_TOKEN" ]; then
  echo "factiii-expose: the runner gave no tunnel credential. This works inside a session the runner started, while the runner is up." >&2
  exit 1
fi
cat > "$TOML" <<EOF
serverAddr = "\${FACTIII_FRP_SERVER}"
serverPort = \${FACTIII_FRP_PORT}
loginFailExit = false
transport.protocol = "\${FACTIII_FRP_PROTOCOL:-tcp}"

[metadatas]
factiii_token = "{{ .Envs.FACTIII_FRP_TOKEN }}"

[[proxies]]
name = "\${PROXY}"
type = "http"
localPort = \${PORT}
subdomain = "\${PROXY}"
EOF
# The handle's last part is its nonce, which alone opens nothing: the runner
# renews only while this file holds it and the keeper below is alive.
if [ -n "$FRP_RENEW" ]; then
  printf '%s' "\${FRP_RENEW##*.}" > "$NONCE_FILE"
fi

say() { echo "factiii-expose: $*"; }
now() { date +%s; }
# kill -0 still answers for a child that ended and was not yet waited for.
alive() {
  kill -0 "$1" 2>/dev/null || return 1
  case "$(ps -o stat= -p "$1" 2>/dev/null)" in Z*) return 1 ;; esac
  return 0
}
# A sleep a stop interrupts: sh runs a trap only between commands, and
# \`wait\` is one it breaks out of.
nap() {
  sleep "$1" &
  NAP_PID=$!
  wait "$NAP_PID" 2>/dev/null
  NAP_PID=''
}
start_frpc() {
  MARK=$(wc -l < "$LOG" | tr -d ' ')
  # The credential is set for this one command, so it is in frpc's
  # environment and in no argv and no file.
  FACTIII_FRP_TOKEN="$HELD" "$FRPC" -c "$TOML" < /dev/null &
  FRPC_PID=$!
  CURRENT="$HELD"
}
stop_frpc() {
  [ -n "$FRPC_PID" ] || return 0
  kill "$FRPC_PID" 2>/dev/null
  wait "$FRPC_PID" 2>/dev/null
}
# Was this frpc's last login refused by frps? Only its own lines count.
refused() {
  LAST="$(tail -n +$((MARK + 1)) "$LOG" | grep ${loginGrep} | tail -n 1)"
  [ -n "$LAST" ] && [ "\${LAST#*${FRP_LOGIN_OK}}" = "$LAST" ]
}
renew() {
  [ -n "$FRP_RENEW" ] || return 1
  NEW="$(FACTIII_FRP_RENEW="$FRP_RENEW" '${p.secretsBin}' tunnel-token --renew)" || NEW=''
  [ -n "$NEW" ] || return 1
  HELD="$NEW"
  NEW=''
  RENEW_AT=$(( $(now) + EVERY ))
  say "renewed the tunnel credential."
  return 0
}
backoff() {
  ASK_AT=$(( $(now) + BACKOFF ))
  BACKOFF=$(( BACKOFF * 2 ))
  if [ "$BACKOFF" -gt "$RETRY_MAX" ]; then BACKOFF=$RETRY_MAX; fi
}
keep() {
  set +e
  # Its own stdio, set here and not on the call: dash keeps a copy of the
  # caller's stdout open for a redirected function call, and that copy (the
  # pipe of whoever ran factiii-expose) would never close.
  exec >> "$LOG" 2>&1 < /dev/null
  # nohup's job: the tunnel outlives the terminal that opened it.
  trap '' HUP
  NAP_PID=''
  FRPC_PID=''
  trap '[ -n "$NAP_PID" ] && kill "$NAP_PID" 2>/dev/null; [ -n "$FRPC_PID" ] && stop_frpc; exit 0' TERM
  EVERY=\${FACTIII_FRP_RENEW_SECONDS:-${TUNNEL_RENEW_EVERY_SECONDS}}
  CHECK=\${FACTIII_FRP_CHECK_SECONDS:-${TUNNEL_CHECK_SECONDS}}
  BACKOFF=\${FACTIII_FRP_RETRY_SECONDS:-${TUNNEL_RETRY_MIN_SECONDS}}
  RETRY_MIN=$BACKOFF
  RETRY_MAX=\${FACTIII_FRP_RETRY_MAX_SECONDS:-${TUNNEL_RETRY_MAX_SECONDS}}
  HELD="$FRP_TOKEN"
  FRP_TOKEN=''
  RENEW_AT=$(( $(now) + EVERY ))
  ASK_AT=0
  SELF=''
  PARKED=''
  start_frpc
  while :; do
    nap "$CHECK"
    # The pid file names this keeper (written just after it was started).
    # Once it names another one, or is gone with the run dir, the tunnel was
    # replaced or removed without a stop reaching here: end with it.
    if [ -z "$SELF" ]; then SELF="$(cat "$PID_FILE" 2>/dev/null)"; fi
    if [ -z "$SELF" ] || [ "$(cat "$PID_FILE" 2>/dev/null)" != "$SELF" ]; then
      stop_frpc
      exit 0
    fi
    if [ -n "$PARKED" ]; then
      # frpc is stopped: its credential was refused and the runner had no new
      # one (a revoked runner). Asked again, backed off; frpc starts again
      # once there is one. With no renewal handle there is nothing to ask,
      # so the held credential is tried again on the same back-off.
      if [ "$(now)" -ge "$ASK_AT" ]; then
        if renew || [ -z "$FRP_RENEW" ]; then
          say "starting frpc again."
          PARKED=''
          start_frpc
        else
          say "still no new credential; trying again in \${BACKOFF}s."
        fi
        backoff
      fi
    elif ! alive "$FRPC_PID"; then
      wait "$FRPC_PID" 2>/dev/null
      say "frpc stopped; starting it again."
      start_frpc
    elif refused; then
      # The credential frpc holds was refused (it logged in again past its
      # end): a newer one held here is used at once; else one is asked for,
      # backed off, so a revoked runner is not asked at every check.
      if [ "$HELD" = "$CURRENT" ] && [ "$(now)" -ge "$ASK_AT" ]; then
        say "frps refused the tunnel credential; asking the runner for a new one."
        renew || say "the runner gave no new credential; trying again later."
        backoff
      fi
      if [ "$HELD" != "$CURRENT" ]; then
        say "logging in again with the newer credential."
        stop_frpc
        start_frpc
      else
        # Left running, frpc would retry the refused login about every 20 s,
        # one hook call each, for as long as the tunnel stays open.
        say "frps refuses this credential and there is no new one; stopping frpc until there is."
        stop_frpc
        FRPC_PID=''
        PARKED=1
      fi
    elif [ "$(now)" -ge "$RENEW_AT" ] && [ "$(now)" -ge "$ASK_AT" ]; then
      if renew; then
        BACKOFF=$RETRY_MIN
        ASK_AT=0
      else
        say "could not renew the tunnel credential; trying again in \${BACKOFF}s."
        backoff
      fi
    fi
  done
}

: > "$LOG"
keep &
echo $! > "$PID_FILE"
FRP_TOKEN=''
# Which terminal opened it, so the sessions list can show the link beside that
# terminal. tmux sets the pane, and its session's name is what survives: a tab
# restart gives the pane a new id but keeps the session name, so an owner
# recorded as a pane id was orphaned and the links vanished from the session
# card while the tunnel still served. The pane id is kept only when tmux can't
# name its session. The Ports panel is not in a pane, so the runner names the
# owner.
OWNER="\${FACTIII_EXPOSE_OWNER:-}"
if [ -z "$OWNER" ] && [ -n "\${TMUX_PANE:-}" ]; then
  OWNER=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null || true)
  [ -n "$OWNER" ] || OWNER="$TMUX_PANE"
fi
printf '%s' "$OWNER" > "$RUN/\${NAME}.owner"
# https: Cloudflare terminates TLS for *.factiii.org (its free wildcard
# certificate, one level deep) and "Always Use HTTPS" sends http:// there;
# frps only speaks HTTP behind the tunnel. (Before 2026-11-11: the runner Mac's
# nginx, with its own *.dev.factiii.com certificate.)
echo "https://\${DOMAIN}"
`;
}

export function frpcUnexposeScript(p: FrpcScriptPaths): string {
  return `#!/bin/sh
NAME="$1"
if [ -z "$NAME" ]; then
  echo "usage: factiii-unexpose <name>" >&2
  exit 1
fi
PID_FILE="${p.runDir}/\${NAME}.pid"
if [ -f "$PID_FILE" ]; then
  # The tunnel's keeper, which stops its frpc on the way out (for a tunnel
  # from before the keeper, frpc itself).
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE" "${p.runDir}/\${NAME}.toml" "${p.runDir}/\${NAME}.log" "${p.runDir}/\${NAME}.owner" "${p.runDir}/\${NAME}.nonce"
  echo "stopped \${NAME}"
else
  echo "no tunnel named \${NAME}" >&2
  exit 1
fi
`;
}
