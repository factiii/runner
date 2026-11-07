#!/usr/bin/env bash
# Vendors the part of tmux-resurrect the runner actually runs into
# apps/runner/vendor/tmux-resurrect/. Called by `prepublishOnly` so we always
# ship a pinned copy. Safe to re-run.
#
# Why vendored rather than cloned on the host: the runner is a published npm
# package, and a `git clone` at provision time would need network and git on
# every user's machine, would track a moving default branch, and would run
# whatever that branch says today. A pinned copy in the tarball is installed,
# reviewed and versioned with the rest of the runner.
#
# tmux's own plugin manager (tpm) does not help here — it is itself a git clone
# that then git-clones each plugin, which is the thing being removed.
#
# tmux-resurrect is MIT (Copyright (C) 2014 Bruno Sutic). The licence permits
# redistribution of the whole or a portion provided the copyright and permission
# notice travel with it, so LICENSE.md is copied first and is not optional.
set -euo pipefail

RESURRECT_VERSION="${RESURRECT_VERSION:-v4.0.0}"
REPO="https://github.com/tmux-plugins/tmux-resurrect.git"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/tmux-resurrect"

# Only what `save.sh` and `restore.sh` reach with the options the runner sets
# (@resurrect-processes false). Everything else in the upstream tree is process
# restore, the tpm entry point, tests, or docs.
#
# `save_command_strategies/ps.sh` looks like process restore and is not: save.sh
# calls `pane_full_command` unconditionally, so it runs even with restore off.
# `process_restore_helpers.sh` is sourced by restore.sh before the gate, so it
# has to be present even though nothing in it fires.
FILES=(
  LICENSE.md
  scripts/save.sh
  scripts/restore.sh
  scripts/variables.sh
  scripts/helpers.sh
  scripts/spinner_helpers.sh
  scripts/tmux_spinner.sh
  scripts/check_tmux_version.sh
  scripts/process_restore_helpers.sh
  save_command_strategies/ps.sh
)

if [ -f "$DEST/scripts/save.sh" ] && [ -f "$DEST/VERSION" ] &&
  [ "$(cat "$DEST/VERSION")" = "$RESURRECT_VERSION" ]; then
  echo "have $DEST at $RESURRECT_VERSION (skip; delete to refresh)"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "fetch $REPO $RESURRECT_VERSION"
# -c advice.detachedHead=false: cloning a TAG always lands detached, and the
# paragraph git prints about it is pure noise in a publish log.
git -c advice.detachedHead=false clone --quiet --depth 1 \
  --branch "$RESURRECT_VERSION" "$REPO" "$tmp/src"

rm -rf "$DEST"
mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  if [ ! -f "$tmp/src/$f" ]; then
    echo "missing upstream file: $f — the tree moved, re-check the subset" >&2
    exit 1
  fi
  mkdir -p "$DEST/$(dirname "$f")"
  cp "$tmp/src/$f" "$DEST/$f"
done
chmod +x "$DEST"/scripts/*.sh "$DEST"/save_command_strategies/*.sh

echo "$RESURRECT_VERSION" >"$DEST/VERSION"
git -C "$tmp/src" rev-parse HEAD >"$DEST/COMMIT"

cat >"$DEST/README.factiii.md" <<EOF
# tmux-resurrect (vendored subset)

Upstream: <https://github.com/tmux-plugins/tmux-resurrect>
Version: $RESURRECT_VERSION ($(git -C "$tmp/src" rev-parse --short HEAD))
Licence: MIT — see LICENSE.md, Copyright (C) 2014 Bruno Sutic.

Unmodified copies of the files the runner executes. Regenerate with
\`apps/runner/scripts/fetch-tmux-resurrect.sh\`; do not edit by hand.

The runner drives \`scripts/save.sh\` and \`scripts/restore.sh\` directly (see
\`shared/all/helpers/board-agent-core/tmux.ts\`) rather than through tpm, and
runs them with \`@resurrect-processes false\`, so only tab structure and working
directories come back after a reboot — never the processes that were running.
EOF

echo "vendored $DEST at $RESURRECT_VERSION"
