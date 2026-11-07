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
 *  tool to malware scanners, and most runners never open a tunnel. */
export const FRP_VERSION = '0.66.0';

/** SHA-256 of each platform's official tarball, as frp publishes them in
 *  frp_sha256_checksums.txt for this release. A download that does not match
 *  is refused, so the binary is upstream's, byte for byte. Bump with
 *  FRP_VERSION. */
export const FRP_SHA256: Record<string, string> = {
  darwin_arm64:
    'eb24c3c172a20056d83379496500b92600a992f68e8ae2e27d128ce1f36d7a92',
  darwin_amd64:
    '9558d55a9d8bc40e22018379ea645251f803f9e2d69e7a7a2fd1588f98f8ef43',
  linux_amd64:
    '317a17a7adac2e6bed2d7a83dc077da91ced0d110e1636373ece8ae5ac8b578b',
  linux_arm64:
    '196ddaa51b716c2e99aeb2916b0a2bf55bb317494c4acdcefab36c383de950ba'
};

/** `uname -s`-`uname -m` patterns for each of frp's builds. */
const FRP_UNAME: Record<string, string> = {
  darwin_arm64: 'Darwin-arm64',
  darwin_amd64: 'Darwin-x86_64',
  linux_amd64: 'Linux-x86_64',
  linux_arm64: 'Linux-aarch64|Linux-arm64'
};

/** Shell that leaves frpc at FRPC, downloading it the first time a tunnel is
 *  opened: frp's own GitHub release, checked against FRP_SHA256, nothing run
 *  from it until the check passes. */
function frpcDownload(): string {
  const cases = Object.entries(FRP_UNAME)
    .map(([plat, uname]) => `    ${uname}) PLAT=${plat}; SUM=${FRP_SHA256[plat]} ;;`)
    .join('\n');
  return `if [ ! -x "$FRPC" ]; then
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

// The credential frps wants is the runner's access token. It is not in the env
// file and not in the toml: `factiii-expose` asks the runner for it when it
// opens a tunnel (`factiii-secrets tunnel-token`, authenticated by the
// session's FACTIII_SECRETS_TOKEN), and hands it to the frpc child in that
// process's environment only. The toml names the variable; frpc fills it in
// when it reads the file (`{{ .Envs.NAME }}`). So the token is as fresh as the
// tunnel, and it lives as long as the frpc process. frpc logs in again with
// the same token when its connection drops: a tunnel left up past the token's
// end (30 days) fails to come back and must be opened again.

export function frpcExposeScript(p: FrpcScriptPaths): string {
  return `#!/bin/sh
set -e
set -a; . '${p.envFile}' 2>/dev/null || true; set +a
# An env file from before the credential moved out of it may still hold one.
unset FACTIII_FRP_TOKEN
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
${frpcDownload()}TOML="${p.runDir}/\${NAME}.toml"
if [ -z "$FACTIII_SECRETS_SOCK" ]; then
  FACTIII_SECRETS_SOCK='${p.secretsSock}'
  export FACTIII_SECRETS_SOCK
fi
if ! FRP_TOKEN="$('${p.secretsBin}' tunnel-token)" || [ -z "$FRP_TOKEN" ]; then
  echo "factiii-expose: the runner gave no tunnel credential. This works inside a session the runner started, while the runner is up." >&2
  exit 1
fi
cat > "$TOML" <<EOF
serverAddr = "\${FACTIII_FRP_SERVER}"
serverPort = \${FACTIII_FRP_PORT}
transport.protocol = "tcp"

[metadatas]
factiii_token = "{{ .Envs.FACTIII_FRP_TOKEN }}"

[[proxies]]
name = "\${PROXY}"
type = "http"
localPort = \${PORT}
subdomain = "\${PROXY}"
EOF
# nohup, not setsid: setsid does not exist on macOS.
# The credential is set for this one command, so it is in frpc's environment
# and in no argv and no file.
FACTIII_FRP_TOKEN="$FRP_TOKEN" nohup "$FRPC" -c "$TOML" > "${p.runDir}/\${NAME}.log" 2>&1 < /dev/null &
echo $! > "${p.runDir}/\${NAME}.pid"
# Which terminal opened it, so the sessions list can show the link beside that
# terminal. The pane is the one identity a shell has without being told (tmux
# sets it); the Ports panel is not in a pane, so the runner names the owner.
printf '%s' "\${FACTIII_EXPOSE_OWNER:-\$TMUX_PANE}" > "${p.runDir}/\${NAME}.owner"
# https: the runner Mac's nginx terminates TLS for *.dev.factiii.com (wildcard
# cert, DNS-01; on the Mac Mini until 2026-11-01). :80 still works and frps
# only speaks HTTP behind it.
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
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE" "${p.runDir}/\${NAME}.toml" "${p.runDir}/\${NAME}.log" "${p.runDir}/\${NAME}.owner"
  echo "stopped \${NAME}"
else
  echo "no tunnel named \${NAME}" >&2
  exit 1
fi
`;
}
