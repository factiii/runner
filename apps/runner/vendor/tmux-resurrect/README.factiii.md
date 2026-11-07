# tmux-resurrect (vendored subset)

Upstream: <https://github.com/tmux-plugins/tmux-resurrect>
Version: v4.0.0 (e87d7d5)
Licence: MIT — see LICENSE.md, Copyright (C) 2014 Bruno Sutic.

Unmodified copies of the files the runner executes. Regenerate with
`apps/runner/scripts/fetch-tmux-resurrect.sh`; do not edit by hand.

The runner drives `scripts/save.sh` and `scripts/restore.sh` directly (see
`shared/all/helpers/board-agent-core/tmux.ts`) rather than through tpm, and
runs them with `@resurrect-processes false`, so only tab structure and working
directories come back after a reboot — never the processes that were running.
