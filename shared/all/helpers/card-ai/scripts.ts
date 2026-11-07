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
};

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
TOML="${p.runDir}/\${NAME}.toml"
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
FACTIII_FRP_TOKEN="$FRP_TOKEN" nohup frpc -c "$TOML" > "${p.runDir}/\${NAME}.log" 2>&1 < /dev/null &
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
