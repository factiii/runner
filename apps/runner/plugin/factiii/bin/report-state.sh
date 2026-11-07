#!/usr/bin/env bash
# Tell the runner what the agent is doing, so the board's status dot reflects
# it and the sessions rail can say it in a line. Called from hooks.json on the
# events both CLIs share.
#
# Everything is derived, nothing is injected. The runner sets a tmux session's
# environment only when it CREATES the session (`new-session -A -e`), so a var
# added by a runner upgrade never reaches a session that is already running —
# which on any real host is most of them. TMUX_PANE is set by tmux itself at
# pane creation, so it is already there in every session ever started.
#
# It doubles as the gate. This plugin installs globally, so its hooks fire on
# every claude and codex run on this machine; outside a factiii workspace there
# is no pane and no space redis to find, and this exits having done nothing.
#
# Never fails the CLI. A hook that exits non-zero can block the turn it fired
# on, and a status dot is not worth interrupting someone's work for.
set -u
[ -n "${TMUX_PANE:-}" ] || exit 0

# The space's redis sits at <spaceDir>/state/redis.sock and the CLI runs inside
# that space's tree, so walk up for it. Bounded by reaching the root.
dir="$PWD"
sock=""
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if [ -S "$dir/state/redis.sock" ]; then
    sock="$dir/state/redis.sock"
    break
  fi
  dir="$(dirname "$dir")"
done
[ -n "$sock" ] || exit 0

state="${1:-idle}"

# The hook's own JSON input, for the one-line activity the rail shows
# (agentActivity.ts derives the line; bash has no JSON parser to rely on).
# Read whole, not with `head -c`: closing the pipe early would hand the CLI an
# EPIPE for a status line. Capped after, since a Write carries the whole file,
# and flattened to one line: redis-cli prints a payload's newlines as they are,
# and the subscriber reads one line per message.
input="$(cat 2>/dev/null || true)"
input="${input:0:8192}"
input="${input//$'\n'/ }"
input="${input//$'\r'/ }"
# The pane is the identity; the runner resolves it to a session. Keeping that
# mapping on the runner is what stops this script from having to know how tmux
# sessions are named.
#
# SET then PUBLISH: the publish drives live dots, the key lets a subscriber
# that starts mid-session read where things stand without waiting for a hook.
# -t 2 so a dead socket costs milliseconds rather than hanging the turn.
redis-cli -t 2 -s "$sock" set "agent-state:$TMUX_PANE" "$state" >/dev/null 2>&1
redis-cli -t 2 -s "$sock" publish agent-state "$TMUX_PANE $state" >/dev/null 2>&1
# Same SET-then-PUBLISH, on its own channel so a runner that predates it never
# mistakes the JSON for a state.
if [ -n "$input" ]; then
  redis-cli -t 2 -s "$sock" set "agent-activity:$TMUX_PANE" "$input" >/dev/null 2>&1
  redis-cli -t 2 -s "$sock" publish agent-activity "$TMUX_PANE $input" >/dev/null 2>&1
fi
exit 0
