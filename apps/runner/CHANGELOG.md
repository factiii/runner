# Changelog

All notable changes to `@factiii/runner` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!-- Held: no npm publish while GHSA-9j83-qj34-g5vc stands (npm serves 0.27.0). -->

### Added

- **Remote connections and logs, for the runner's owner.** Two actions only the owner can call over their own link: `runnerConnections` lists each open link (account, transport, since when, open terminals), each board the runner serves, the running services (containers, pm2, LaunchAgents with what each one runs, listening ports), the embedder's health and the Vault ingest counts; `runnerLogs` returns the last lines (default 200, at most 2,000) of one of those services' logs, or the embedder's own output. A session summary sent to the owner names who started it. `factiii-runner status` prints `Runner id:` for Factiii Desktop. The apps hide the panel against an older runner. `DISCLOSURE` gains item 10.
- **Short preview links.** `factiii-expose <port> <name>` prints `https://<name>-<tag>.dev.factiii.com`, where the tag is 6 hex of the session id's hash, instead of the whole session id.

- **The IDE git panel writes, the GitHub Desktop way.** `bareGitAct` runs the panel's writes in a session's own worktree: include or exclude files and single lines or hunks (`git apply --cached`, never the working tree), discard, add to `.gitignore`, commit with summary and description (amend while unpushed; no co-author line), undo the newest unpushed commit, revert a commit, create (also from a commit), switch (bringing the changes, or leaving them stashed on the branch as `!!factiii-panel:<branch>`), rename and delete branches, merge into the current branch and abort a stopped merge or revert, fetch, pull, and push or publish, and restore or drop the panel's stash. It never commits, merges, reverts or pushes on the default branch (the space's main branch, and origin's HEAD if that differs), pushes only to the branch of the same name on origin (not the origin/main a session branch starts out tracking), never force pushes, and uses the GitHub connection's token through the existing one-shot helper. A panel showing any other folder only reads, and `bareGitStage` / `bareGitUnstage` now follow the same rule. `bareGitStatus` adds `panel` (what may be written, the branch on origin, last fetch, operation in progress, the stash), and `bareGitFileDiff` gives one file's staged and unstaged diffs. See `.specs/ide-git-panel.md`.

### Fixed

- **The old desktop view's helper is cleaned up.** A runner that once ran the desktop view (removed in 0.37.0 in favour of Screen Sharing over Tailscale) still had `~/.factiii-runner/helpers/FactiiiScreen.app`. On start the runner now removes it, resets the Screen Recording and Accessibility switches macOS kept for it (`tccutil reset ScreenCapture|Accessibility com.factiii.runner.screen`), removes `helpers/` if that leaves it empty, and logs each step under `[cleanup]`. It runs only while the bundle is there, so it happens once. That version installed no LaunchAgent or login item, so there is nothing else to remove.

## [0.37.0] - 2026-10-30

### Added

- **Agents that start and end other agents.** The board MCP gets five tools the runner answers itself: `list_sessions` (every Chat and Code session on the boards you can use here, with its state, mode, card and worktree), `start_session` (Chat or Code on a board, optionally linked to a card, with an opening message), `message_session`, `read_session` (recent transcript, and branch, dirty files, ahead/behind for Code) and `end_session` (stops it and removes its worktree, keeping the branch unless `deleteBranch`; refused while it holds uncommitted work or unpushed commits unless `discard`). An agent can do only what the person its session acts for could do by hand on that board, cannot end its own session this way, and can have at most 5 sessions it started running per board. Each start, message and end is in the audit log as "via MCP", naming the calling session. This runner's sessions only for now. The plugin's new `board-sessions` skill tells agents how to use them.

- **/resume and shared commands in the session chat.** Three actions: `bareChatConversations` lists every conversation Claude Code or Codex recorded for the session's folder (from `$CLAUDE_CONFIG_DIR/projects` and `$CODEX_HOME/sessions`, read only: which CLI, title, when, how long, model, last message); `bareChatResume` carries one on with its own CLI (`claude --resume <id>`, `codex resume <id>`) in the session's first idle tab, after closing the agent open there, and a Claude one becomes the chat's conversation; `bareChatCommand` runs `/clear`, `/model` and `/compact` the way the session's CLI takes them (the headless Claude's next run, or typed into the Claude or Codex open in a tab). Codex has no `/model` from the chat, and says so. Stop (`bareChatInterrupt`) now also reaches a Codex tab.

- **Nuke a runner.** `factiii-runner nuke`, and Runner Settings > Danger zone > "Nuke this runner" on web, desktop and mobile, erase everything the runner holds: every board's secrets store and the runner's keychain entry, every board folder and the rest of the runner home (worktrees, vault, scratchpads, drops, backups, logs, jobs, audit log, config and pairing), every runner tmux session and its processes, the simulator stream, keep-awake and the service. A Mac with the lid-closed grant gets lid closed turned off (`pmset -a disablesleep 0`); the grant itself, `/etc/sudoers.d/factiii-pmset`, is root's, so the plan and the last line say to remove it in Factiii Desktop (Lid closed → Remove). It first shows what will go, naming each worktree with uncommitted or unpushed work, the secrets count and the backups, and asks for the phrase `ALL WILL BE DELETED`, typed exactly (`--confirm "ALL WILL BE DELETED"` for a script; there is no `--yes`). The runner checks the phrase and that the owner is asking, on a direct link; members, agents and the board MCP cannot reach it. It unpairs on the server first (the runner's record is removed, so it leaves every rail and its token stops working), then stops, erases and exits for good. Each step can be run again after a crash and finishes the job. It refuses any folder that is not this runner's home. The CLI then offers `npm uninstall -g @factiii/runner`.

- **Lid closed follows keep-awake.** On a MacBook, Automatic and While plugged in now keep the Mac awake with the lid shut while they hold, and let it sleep when they let go: the runner sets `pmset -a disablesleep 1` and `0` itself with `sudo -n`, so it works with the Wi-Fi gone. It needs a one-time grant set up in Factiii Desktop (Status > Ready to be a server > Keep awake > Lid closed > Set up, one macOS admin prompt): a sudoers drop-in, `/etc/sudoers.d/factiii-pmset`, that allows only those two commands without a password, checked with `visudo` before it goes in. Without it nothing changes: the hold is caffeinate only and Status says "Set up in Factiii Desktop". Watchdogs turn it off on runner start when nothing holds it, on exit, after a crash (a small watcher waits on the runner's pid), on battery under 15% and when the Mac runs hot. It never turns off a Lid closed set by hand from Factiii Desktop.

### Fixed

- **A renamed space is named by its name, and its terminals keep working.** The runner keeps each board's space name in `spaces.json` (from `runner:space-renamed` and from the server's answer to `runner:board-names`, asked on every connect, which also catches a rename made while the runner was offline) and says it wherever it names a board: its logs, the member-level lines in the audit log, `factiii-runner status`, the CLI's output, `factiii-secrets list`, the session hook, and the apps' Running jobs and Settings → Runners lists. Sessions get `FACTIII_SPACE_ID`, and the CLI resolves the board's slug now from it (or from the old slug a terminal still holds), so `factiii-runner secret set`, `runners` and `audit` work in a terminal started before the rename without a restart. The CLI pins a runner's recipient by space id, carrying an existing pin by slug over on first use.

### Removed

- **The paste pairing flow.** `factiii-runner setup` and `connect` pair by code only (QR code, short code, approve link), which the Factiii server has answered since 2026-10-16 (runner 0.27.0). A server without `runners.startPairing` now fails the pairing instead of falling back to "paste the token shown in the browser".
- **`secureLock`, `secureSetPassword` and `secureClearPassword`.** Only apps from before the connection password was removed (0.22.1) sent them. `secureStatus` and `secureUnlock`, the one unlock a runner that had a password still needs, are unchanged.
- **`factiii-runner password --clear`.** The flag did nothing; run `factiii-runner password`.
- **The `NEED_SECRETS:` deploy marker.** A deploy skill reaches secrets with `factiii-secrets run` only. A skill drafted before `factiii-secrets` existed (August 2026) has to be drafted again.
- **The names-only `factiii-secrets list` reply.** The runner sends each key with its status (`entries`), and the CLI reads only that.
- **`factiii/card-*` branches no longer hold a worktree name.** Work branches are `card/` and `terminal/`; an old `factiii/card-*` branch is left as it is.

## [0.36.0] - 2026-10-28

### Added

- **Declared dual-use on npm.** npm pulled 0.28.0, 0.33.0 and 0.35.0 as malware (GHSA-9j83-qj34-g5vc). A runner is a remote shell with screen control, tunnels and a login service, which is what npm's dual-use policy is for. The package now carries `"contentPolicy": {"class": "dual-use"}` and a `DISCLOSURE` file that says what each of those does and how the owner controls it. Releases are staged and go live when the owner approves them on npm with 2FA. Nothing changes for people installing it.

- **Tart, for macOS virtual machines.** Runner > Status gets a Virtual machines row with an Install button, and "Run this board on this computer?" offers it as a choice: a fresh macOS to try the desktop app or a runner on. Tart's Homebrew tap no longer installs, so the runner downloads the pinned 2.41.1 release, refuses it unless Cirrus Labs signed it, and puts it in `~/Applications` with a link in `~/.local/bin`: no Homebrew and no password. Apple silicon only (checked on the hardware, so an x64 Node under Rosetta still qualifies); an Intel Mac's row says to install it by hand.

- **The IDE follows the agent.** A terminal session's IDE (file tree, editor, watcher, Source Control) is on the folder its agent is working in: every few seconds the runner reads the last folder the session's conversation records (the terminal Claude's, else the chat's own) and moves the IDE to that folder's project (its git top), inside the space. An agent can also move it with the board MCP's `set_work_path`, which holds until the agent moves again. Source Control shows whenever that folder is a git checkout, and with no folder seen yet the IDE is on the session's worktree or the board's workspace, never the space's own root.

- **Card links on sessions.** A terminal session can be linked to a card on its board, and the link changed at any time: from the app (the session header shows the card, with Link card and unlink) or by any agent through the board MCP, whose tools now include `link_card`, `unlink_card` and `session_card`. The runner answers those three itself (it holds the sessions), in front of the server's tools; every session it starts carries `FACTIII_SESSION` so `factiii-board-mcp` can say which session is asking. A card shows a session linked to it as it does one started on it.

- **The chat view of a session.** Four actions (`bareChatTranscript`, `bareChatSend`, `bareChatInterrupt`, `bareChatToTerminal`) let the app talk to a session's Claude as a chat. The chat runs its own Claude, headless (`claude -p`), one run per message, each resuming the session's conversation, which is kept with the session (`agentSessionId`) so a restart carries on with it. Messages sent during a turn run together as the next one, Stop ends the turn, and a failed turn (Claude not signed in) says why. The terminal is the backup: `bareChatToTerminal` resumes the same conversation in Claude's full screen, in the session's first tab idle at its prompt (after the running turn, if any), and the next chat message closes that Claude again (found from Claude Code's own session records, `$CLAUDE_CONFIG_DIR/sessions`) and carries on from what it did. The chat reads the conversation's transcript a line at a time, whichever of the two ran it.

## [0.35.0] - 2026-10-25

### Added

- **Automatic keep-awake.** Keep awake gets an "Automatic (while terminals or jobs run)" choice: the runner holds `caffeinate` while an agent session is working or a job, deploy or install is running, and lets the Mac sleep 10 minutes after the last one stops. It checks every 30 seconds and takes the hold again when work resumes. Mac only for now; a lid-closed Mac still needs `pmset disablesleep` from Factiii Desktop. A runner older than this treats Automatic as "until turned off".
- **Every client re-counts "N secrets missing" after any secrets write.** The runner emits `secrets-changed` once a write to the store lands (set, unset, files, import, inbox approval), so a key added from the phone, another window, the CLI or a backup import clears the badge everywhere, not only in the window that made it.
- **The way in when Factiii is down.** With the status page on (`factiii-runner status-page set`), each heartbeat also carries this machine's Tailscale name, address and user, read from `tailscale status --json` (read only; the runner never installs or starts Tailscale). The status page shows them only on its access-controlled admin view.

### Fixed

- **End frees a session's name even after a restart.** End used to do nothing when the runner had lost the session from memory (a restart or update that did not bring it back), so its worktree, branch and tmux sessions stayed and New terminal said the name was "already in use". End now tears down from the stored record, or from where the session's tmux panes sit, and says when something could not go (a branch with commits no remote has is kept on purpose).
- **Leftovers are swept at startup.** Terminal worktrees and their branches that no record or live session holds are removed when the runner starts, with any `terminal-bare-*` tmux session inside them. Only trees that hold no work: no uncommitted or untracked file, no ignored `.env*`, no commit a remote lacks, and nothing changed in the last 10 minutes.

## [0.34.0] - 2026-10-25

### Fixed

- **The package no longer ships code that reads a `.env` file.** npm pulled 0.28.0 and 0.33.0 as malware (GHSA-9j83-qj34-g5vc), and the change both had over 0.27.0 is the bundled `embedder/app.py`, which opened the `.env` two folders above itself (in the monorepo, the file of server secrets; in an install, a path that does not exist). The cloud embedder's `start.sh` now copies its two keys into the environment, `app.py` reads no file, and a test keeps any bundled Python from opening one again. `python-dotenv` is gone from the Linux embedder's packages.
- **A missing binary no longer crashes the runner.** `spawn redis-cli ENOENT (Unhandled 'error' event)` crash-looped mac-mini-m6 for 40 minutes on 2026-10-25, with Homebrew off the PATH. Every process the runner starts now has an `'error'` listener; without redis, live agent status is just off.
- **A password on a board with no secrets store says so** ("This board has no secrets store yet…") instead of `ENOENT … age-identity.enc`.

### Removed

- **The runner no longer installs Tailscale or joins a tailnet.** That took the owner's password for `sudo`, started `tailscaled` as a system service and read `TAILSCALE_AUTH_KEY`: root work that belongs to Factiii Desktop, not an npm package. The runner still reports whether Tailscale is installed and this Mac's Tailscale address (Ready to be a server, the Environment list), and the Environment list says to install it with the desktop app or by hand. A client that asks a 0.34 runner to install `tailscale` gets that answer as an error.

## [0.33.0] - 2026-10-24

### Added

- **Heartbeats to status.factiii.com**: `factiii-runner status-page set <url>` (token from `FACTIII_STATUS_TOKEN` or asked for) sends this runner's name, version and machine health level every 2 minutes to a status page outside Factiii, so it shows there and an alert goes out when it stops. Checked with one beat before anything is saved; `status-page off` and `show`. Off by default.
- **Ready to be a server covers the way in**: whether the screen locks by itself (a locked Mac shows only its lock screen in the desktop view, and macOS refuses typed keys there), Factiii Screen's Screen Recording and Accessibility, macOS Screen Sharing, and Tailscale. The desktop view's status says when the Mac is locked and carries its Screen Sharing address (`vnc://<Tailscale address>`), the way in past the lock screen and when Factiii is down.
- **Keep-awake** (Runner Status > Ready to be a server): the owner keeps this Mac awake from any device for 1, 2, 4 or 8 hours, until a clock time (8:00 is tomorrow's once it has passed), or until turned off, with the screen on too if asked. It is the runner's own `caffeinate`, ends with the runner, and is taken back up after a restart (an update). New owner-only action `keepAwakeSet`: a client that sends it to an older runner gets `Unknown board-agent action`.
- **Ready to be a server**: machine health reports automatic login, FileVault, sleep on power, restart after a power cut, wake for network access, whether the Mac is a laptop, and lid-closed keep-awake (`pmset disablesleep`, set from the desktop app). Read without admin; nothing is changed.
- **Free up space clears the tools' caches, not only what the runner made.** Each pnpm store version is pruned by the pnpm that owns it (only packages no project links go), and npm's cache, npx's downloads, Homebrew's downloads and old versions, Xcode's DerivedData and the container build cache (OrbStack or Docker) are cleared with their own commands, by id, never by a path. Each shows its size ("up to" for a prune). npx's downloads wait while anything runs from them (a dev server, a mobile build job), and DerivedData while an `xcodebuild` or an EAS local build runs. A full disk is usually these caches, not the runner's own files.
- **What's using space.** `machineCleanup` with `usage: true` weighs the biggest folders under the home folder (each board's clone, workspace, worktrees and job checkout apart) and labels them ("Tart virtual machines"). A reading only. It takes up to a minute on a full disk, so it is asked for apart from the plan.

## [0.32.0] - 2026-10-24

### Added

- **Status lists pm2 processes, login agents and the embedder's health.** pm2 processes show their state, uptime and restart count. An errored one is critical, and a stopped or crash-looping one warns. The user's LaunchAgents show running, not running with the last exit code, or not loaded. The production embedder (`services/embedder`) is asked for its own `/health` ("Model loaded · Neural Engine"). Listening ports fold into the row of the process that runs them, and listeners are named by what they run (`react-native start`, `GradleDaemon`) instead of `node` or `java`. Rows carry a level, so the Status tab puts whatever is wrong first. Reading Status never starts a pm2 daemon.
- **The Status tab's Services read at a glance.** One line says all is fine or names what needs attention. Rows are in sections (Needs attention, Kept up by pm2, Containers, Login agents, Other servers), idle login agents fold behind a Show toggle, and a row opens to its full detail. The list reads again every 30 s while Status is open, says when it was read, and has a Refresh button. The step's header reads To do while something needs attention.
- **Status says when the container engine is down.** When the `docker` CLI is installed but cannot reach its engine, Status shows one warning row named for the engine (OrbStack, Colima or Docker, from `docker context show`) instead of the containers silently vanishing. Before this, an engine stopped by a full disk showed nothing in Status. A machine without the CLI gets no row.

### Fixed

- **The OneDrive index no longer outlives the runner.** It ran detached and only the runner's own stop killed it, so a runner that was killed (a failed update) left it running, holding its port; the next start began a second index on a new port. The index now exits when the runner that started it is gone (it watches its stdin), and a start stops a leftover found in the index's pid file.

## [0.31.0] - 2026-10-23

### Added

- **The owner can clear the audit log** (Runner Status > Audit > Clear log). The old log is kept beside the new one as `audit.cleared-<time>.jsonl`, and the new log opens with a line saying who cleared it and how many entries were kept.
- **Sessions know what the board can show.** Every session is told about the Simulator and Desktop panels (Simulator.app is not needed), that dropped files land in `$DROPS_DIR` (new) and are untrusted, that Metro must use a port from `$FACTIII_PORTS`, and that messages from other sessions are teammates, not the user.

## [0.30.0] - 2026-10-23

### Added

- **Machine health reports CPU load, memory in use and what is running**: the 1-minute load per core, used and total memory, Docker containers and the servers the runner's user has listening on a port, so the Status tab can show them. CPU load is shown only; it never refuses anything.

### Fixed

- **The Simulator panel works on Xcode 27.** Xcode 27.1 moved SimulatorKit out of `Developer/Library/PrivateFrameworks` into `Contents/SharedFrameworks`, so the stream and touch helpers could not load it and the panel stayed black. Both now look in the new place too.

## [0.29.0] - 2026-10-23

### Added

- **A renamed space keeps its board.** The runner remembers each board by its space id. When the space's name, and so its slug, changes, the board's folder moves to the new slug (the old name stays as a link, so worktrees and open terminals keep working) and its member levels move with it.
- **Machine health counts processes** (macOS): the runner user's processes against the per-user limit, warning at 80% and critical at 95%, in the app, `parts list` and `doctor`. The runner checks every 10 minutes and logs a change of level, and a self-update the OS refuses says "process limit reached" instead of failing silently.

## [0.28.0] - 2026-10-22

### Added

- **Parts.** `factiii-runner parts list | add | remove | start | stop` and the parts list in the app (Runner Settings > Setup > Environment): terminals and boards, Claude, Codex, secrets, OneDrive search, simulator and local AI (Ollama). Each part installs only what it needs, in the background from the app; remove uninstalls only what the runner installed.
- **The Vault part.** Keeps files on this machine with the cloud vault's tables (generated from the server's Prisma schema) in PGlite, run in its own process only while the vault is in use. Devices list, search, add, download and delete files over the direct link only, never the server's relay. The owner lets people from their shared vault on Factiii in, from the Vault part's row.

### Changed

- **`factiii-runner setup` installs and pairs only the connector.** It lists the parts and offers no tool installs. `doctor` requires only the connector's items; every tool is optional, named by its part.

## [0.27.0] - 2026-10-16

### Added

- **Dangerous jobs wait for the owner.** A job that `jobs.json` marks `dangerous` (today `db-read` and `db-write`) runs at once for the owner, a terminal on the runner, or a member the owner gave the new Dangerous jobs permission. Any other member's call waits for the owner to approve it on their phone or in the app, and is denied after 10 minutes without an answer.
- **`factiii-runner setup` pairs without pasting a token.** It prints a QR code and a short code and waits while you approve it in the app or on factiii.com. The paste flow stays as a fallback.
- **The always-on service can be installed and removed from the app** (Runner Settings > Setup), not only with `factiii-runner service`. A remove sent through the service's own runner keeps the runner running until it exits.
- **The attention badge** names what needs the owner: offline, setup failed, missing secrets, repository not connected, no jobs, update available.
- **Each terminal session reports a live activity line and git counts,** and several agents in one session's tabs roll up into one state.
- **The runner keeps its own Claude Code and Codex homes,** set at startup, and cleans what older runners left in the default ones. A SessionStart hook tells every board-terminal session where it runs.

### Changed

- **GitHub auth puts no token in any remote URL.** Sessions get the token from the runner through a credential helper (`factiii-secrets git-credential`), and existing clones are migrated.
- **OneDrive disconnect deletes the Graph subscription** in the index service.

### Compatibility

- The web and mobile apps in this release send the service, attention and dangerous-approval actions. An older runner answers that it does not know the action.

## [0.26.2] - 2026-10-15

### Fixed

- **A sign-in or failed Ask Board row in Running jobs can be closed.** A new `activityDismiss` action (Terminals level by default, like cancelling a Codex sign-in) removes it, and a sign-in row also expires after 20 minutes, so a CLI that never exits cannot leave it stuck. The web app's X needs this runner; an older one answers that it does not know the action.

## [0.26.1] - 2026-10-14

### Changed

- **Claude and Codex let `factiii-secrets` run without asking first.** The runner adds an allow rule for `factiii-secrets run` and `factiii-secrets list` to Claude's user settings and writes `~/.codex/rules/factiii.rules`, for every session on the machine. The owner's password prompt is still asked before every `factiii-secrets run`; this only stops the CLI's own check (and Claude's auto mode) from refusing the command before the owner is asked. A command chained before or after it still gets the CLI's check, and `tunnel-token` is not allowed. A settings file that is not plain JSON is left alone.

### Compatibility

- The server in this release refuses a runner token with no expiry, and pairing from a CLI before 0.26.0. Runners on 0.26.0 or later are not affected; an older runner must be updated and paired again.

## [0.26.0] - 2026-10-13

### Changed

- **BREAKING: each board member gets one access level, and every member starts at None.** The two switches "Allow API access" and "Share terminals", and sharing a runner with a board, are gone. The owner gives each member of a board one level in Runner Settings > Access: None, API (jobs, the secrets prompt, encrypted secret updates), Terminals (also terminals and AI sessions) or Screens (also the simulator and the desktop view). The levels are kept on the runner. After the update nobody but the owner has access until the owner gives levels again, and the app and the server must be updated with the runner.
- **BREAKING: `job`, `secret set` and `audit` need `--runner`.** Each call names the runner it is for, by name or id, with `--runner` or `FACTIII_RUNNER`; without one the command stops. The server no longer picks a runner for a board, so a member's own runner cannot receive another member's calls or secret updates. Inside a runner session nothing changes. The server must be updated with the CLI: an older CLI is refused with a message to update.
- **BREAKING: a secrets backup opens with its passphrase alone, and older backup files cannot be opened.** A backup now holds the board's secrets sealed under the backup passphrase; the board password is no longer needed to open one. A backup made by an earlier runner is refused with a message to make a new one, so export again after updating. Keep the file and its passphrase apart: together they open every secret in it.
- **`factiii-runner backup restore` asks for a new board password.** It creates the board's store under that password and writes the backup's secrets into it. It still refuses a board that already holds secrets.
- **A runner process that is killed exits with a failure.** The supervisor exited 0 when its worker died of any signal. It now exits 0 only for an interrupt, a terminate or a hang-up, so a service manager restarts a runner that was killed, for example for lack of memory.
- **`factiii-runner doctor` is a checklist.** It lists what the machine needs by feature, marks each item required or optional, and offers to install what needs no administrator. For the rest it prints the exact command. `--no-fix` and `--json` ask nothing.

### Added

- **`factiii-runner service install | status | remove`** keeps the runner running: it starts at login and restarts after a failure, with a LaunchAgent on macOS, a systemd user service on Linux and a scheduled task on Windows. `factiii-runner setup` offers it at the end. The service writes `logs/runner.log` in the runner folder, kept under 10 MB with one older file beside it. Sleep, power and automatic login settings are explained and never changed.
- **`factiii-runner runners`** lists the runners open to you on a board: yours, and the ones whose owner gave you API access, each with its id, its name and whether it is online.
- **One person at a time has the simulator or the desktop view.** The runner sends video to the person who has it and refuses input from anyone else; the app shows who that is. A member needs the Screens level.
- **A member with no level has no connection.** The runner refuses a link from a member who has no level on any board, and closes a member's open link, terminals and video when the owner takes their last level away.
- **Import secrets from a backup into a board.** Runner Settings > Secrets > "Open a backup" > "Import into this board": tick keys and files, choose for each one the board already has, and the runner writes them under the board's password.
- **Change one key inside an env file secret** without replacing the file (Runner Settings > Secrets > Files > "Edit keys"). The app sees key names and the last four characters only.
- **The app can show which tools are present.** A new read action reports each tool the runner needs as present or missing, and whether Initialize installs it.
- **Disconnecting GitHub revokes the token at GitHub** and removes it from the checkouts' remotes. The app says when the revoke did not happen.
- **A terminal takes any dropped or pasted file,** not only images, up to 100 MB.
- **The runner mints and refreshes the embed token** that the OneDrive index now needs to reach the server.

### Fixed

- **A fresh Linux machine can create its key.** The runner read "no such key" from the keyring as a broken keyring on Debian 12 and never created one.
- **Tools installed under the runner's own folder are found on Debian.** `claude` and `codex` installed with npm and were then reported missing.
- **Reconnecting GitHub updates the token in existing checkouts at once.**

## [0.25.0] - 2026-10-12

### Added

- **The owner can push an encrypted vault backup from the mobile app to this runner.** Backups are stored under `vault-backups/`, the newest 3 are kept, with a 512 MB cap, and only the owner can write, list, read or delete them. The runner never holds the key. An older runner answers these with "Unknown board-agent action", so update the runner before using it.

## [0.24.0] - 2026-10-11

### Changed

- **`factiii-runner setup` pairs first and finishes in seconds.** It no longer installs the host tools before opening the pairing tab. Whatever the machine is missing (git, tmux, redis, the agent CLIs) installs the first time you open a space on the board, where the progress and any failure show, with a Try Again. `factiii-runner setup --tools` runs the same install from the terminal.

### Fixed

- **A slow machine can finish installing its tools.** On a macOS version Homebrew no longer ships prebuilt packages for, tmux and its dependencies compile from source, which ran past the 15-minute limit and ended setup. A Homebrew install now gets three hours, and the log says "Still working" each minute it is quiet.
- **One tool that fails to install no longer stops the others.** The rest still install, each failure is tried once more, and the error lists every tool that is still missing.

## [0.23.2] - 2026-10-11

### Security

- **A link the server vouched nothing for is refused.** Every connection reaches the runner with a scope from the server: the owner, or a member and the boards they may use. One that arrived with no scope was served as the owner, left over from before runners could be shared, so a server that omitted it would have handed any peer full control. The runner now answers no such link, nor one whose scope names a role it does not know. Factiii's server has always sent the scope, so nothing changes for a runner paired with it.

### Changed

- **The runner's GitHub connection is `GH_TOKEN`.** A job or `factiii-secrets run` that asks for `GH_TOKEN` or `GITHUB_TOKEN` now gets the token from the runner's own GitHub connection (Setup > Sources) when Secrets holds no such key, so a board no longer needs a second GitHub token typed in. A `GH_TOKEN` already stored keeps being used; remove it to switch to the connection. The Secrets tab shows the key as "from GitHub connection".
- **The GitHub connection can push workflow files.** It now asks GitHub for the `workflow` permission as well, without which GitHub refuses any push that touches `.github/workflows`. An existing connection keeps its old permissions: disconnect and reconnect GitHub in Setup once to get it.

### Added

- **The owner can open a backup in the app.** Runner Settings > Secrets > "Open a backup": drop a backup file, type its passphrase and the board password from the day it was made, and the runner opens it and lists what it holds. Each secret shows only its last four characters (nothing at all for a value under 12 characters); a click copies the full value. File secrets are copied when they are text and saved as a file when they are not. Owner only, never over the relay, written to the audit log with the names shown, and a wrong board password counts against the guess limit. No board is read or changed. Needs the web app from the same release: an older runner answers `Unknown board-agent action: secretsOpenBackup`.

## [0.23.1] - 2026-10-10

### Added

- **A terminal's public links show beside it.** `factiii-expose` now records which terminal opened a link, and the runner reports each terminal's live links with its session, so the Sessions list in the app shows them under the terminal that made them. A link opened before this update, or one whose tab has since closed, is still listed under Public ports only.
- **Source Control shows what a branch changed.** A new "Branch changes" section lists every file the session's branch has committed since it diverged from another branch, with a picker for which one (the branch the session was cut from by default). The lists above it still show only what is uncommitted.
- **The owner can back up a board's secrets.** Runner Settings > Secrets > "Back up secrets" saves the board's secrets folder, already encrypted, sealed again under a backup passphrase you choose; `factiii-runner backup export <board>` does the same on the runner. Restoring (`factiii-runner backup restore <board> <file>`) needs the file, that passphrase and the board password, and only writes into a board that has no secrets. Owner only, never over the relay, and written to the audit log.
- **The owner can see and control the runner's Mac from the app.** A screen button in the Sessions list opens the Mac's desktop over the session window, with mouse and keyboard. Owner only, whatever the member switches say. The first time, someone at the Mac turns on "Factiii Screen" under System Settings > Privacy & Security > Screen Recording (to see it) and Accessibility (to control it). It shares the video link with the simulator panel, so opening one stops the other. Not in the phone app.

### Fixed

- **The `factiii-runner` command is installed again.** npm checks a package's `bin` before `prepublishOnly` builds `dist/cli.js`, found no file there on a clean CI checkout, and published 0.23.0 without the command. `bin` now points at a small committed `bin/factiii-runner.js` that loads `dist/cli.js`. 0.23.0 was never served; 0.23.1 carries everything listed under it.
- **A restored terminal no longer comes back with a dead pane.** After a reboot, two boards restoring their tabs at once could each add a pane to the same tab; the extra one sat there as "Pane is dead" with nothing in the app to close it. Boards now restore one at a time, a restored tab is reduced to its one pane, and a tab a neighbouring board rebuilt is finished by the board that owns it.

## [0.23.0] - 2026-10-10

### Changed

- **Each board has its own secrets password.** One password used to open every board's secrets on a runner, so changing it from one board changed it for all of them. Each board now keeps its own key in `<board>/secrets/`, its password opens that board only, and wrong guesses on one board no longer lock out another.
- **Nothing to re-enter.** Every board that already stores secrets keeps today's password. The first time each one is unlocked after the update, it gets an encryption key of its own and its secrets are re-encrypted to it, so no two boards share a key. A board with no secrets yet sets up its own password the first time you open Secrets.
- **Changing a board's password also replaces its key.** The board's secrets are re-encrypted to a new key under the new password, and any open unlock on that board is closed, so the old password opens nothing there afterwards. Other boards keep their passwords.

### Fixed

- **An ended terminal session frees its name.** End deleted only the branch the terminal had checked out, so a `git switch` inside the terminal left `terminal/<name>` behind and the name stayed taken. End now removes that branch too, and still works when the session's directory was already deleted by hand.
- **A leftover branch no longer holds a name.** A `terminal/<name>` branch with no worktree counts as taken only while it has commits that are on no remote.
- **An ended session's folder is always deleted.** When git refused to remove a session's worktree, the error was swallowed and the whole folder stayed on disk, `node_modules` and all (several GB each). End now deletes the folder itself when git will not, only ever inside the board's worktrees folder.
- **End never discards commits you were not looking at.** A session branch the terminal had switched away from is kept when it holds unpushed commits, and its name stays taken until they are pushed or the branch is deleted.

## [0.22.1] - 2026-10-08

### Changed

- Republished: the release workflow reported 0.22.0 as published, but the npm registry never served it; 0.22.1 is the same code.
- **The GitHub and OneDrive connections no longer lock behind the connection password.** `<board>/.creds/github.json` and `onedrive.json` are now sealed under the machine keychain key alone, the same way the pairing `config.json` is. A runner with a password set used to come up locked after every restart and could not clone, fetch, deploy, merge, index OneDrive or show the connected GitHub user until someone typed it. It now does all of that from the moment it starts.
- **Existing files are converted, once.** A connection file from an older runner is rewritten under the keychain key the first time it can be read: at start when no password is set, and after a single unlock when one is — for every board together. A runner upgraded while locked reports those files as locked ("N saved connection files are still locked…"), in the console, in `factiii-runner status` and in Runner Settings → Secrets, and paths that need the repository say the same instead of "no repository connected". A save over a still-locked file is refused rather than replacing it. The old file is replaced only after a successful decrypt, by temp file and rename.
- **`factiii-runner start` asks for the password only when a file still needs it**, and `setup` no longer asks for it at all: pairing never depended on it. The relaunch after a self-update never asks at the terminal, whether or not there is one (the supervisor marks its relaunches, and a version that has never started on this machine counts as one too, because the update that brings this change in is relaunched by the old supervisor): it connects with those connections locked and says how to unlock, so approving an update from the app cannot leave the runner offline at a prompt nobody sees.
- **The runner tells its owner when it is waiting for that password.** On channel open it sends its owner the same `runner-secure` frame an unlock broadcasts, and the web and mobile apps show the unlock box in the update banner area, on any page, instead of only inside Runner Settings. A runner that started locked also watches for an unlock done by `factiii-runner password` in another process and then tells its clients and starts the OneDrive indexes that were waiting.
- **The vault file is retired.** When no file is left in the old envelope — at start, or right after the one unlock — `vault-key.json` is renamed to `vault-key.retired.json` and the runner has no password. A runner with a password set and nothing sealed under it loses the password at start without being asked. A file that will not decrypt is left in place, named on the console, and keeps the vault until that board is reconnected.

### Removed

- **The connection password.** It can no longer be set or changed: `secureSetPassword` is refused, `secureLock` only answers with the status, and `factiii-runner password` no longer sets one. What remains is the unlock a runner that had a password needs once after updating: the terminal prompt at `start`, `secureUnlock` (and `secureClearPassword`, which now does the same) from the app, or `factiii-runner password` on a host with neither.

### Fixed

- The stray-plaintext sweep sealed a plaintext `config.json` in the vault envelope, which the pairing reader cannot open: a runner whose board settings were read before its pairing config lost its pairing. The sweep now writes the keychain envelope for every file it touches. In a normal `start` the pairing config was read (and converted) first, which hid this. A `config.json` an older runner already left that way is converted back at start.
- `factiii-runner password` told the owner to run `factiii-runner unlock`, a command that does not exist.

**Old clients keep working.** `secureStatus`, `secureUnlock`, `secureLock`, `secureSetPassword` and `secureClearPassword` keep their payloads and answer as above. `passwordSupported` is true only while files are locked, so an older client shows its unlock box then and never offers "Add password"; `ready` is false only then or when the keychain is unusable. The `runner-secure` frame on channel open is ignored by a client that does not know it at that point.

## [0.21.0] - 2026-10-04

### Added

- **Ask Board keeps many conversations.** A board's assistant now holds several conversations at once, each with its own CLI thread, answering in parallel. They are stored in the space's redis and survive a closed panel and a runner restart. New actions: `boardSessions` (the list), `boardSessionUpdate` (rename, topic, archive) and `boardSessionDelete`; `ask`, `boardSession`, `resetBoardSession` and `boardHandoff` take an optional `conversationId`. A terminal handoff takes one conversation out of the assistant instead of clearing the only thread.
- **Ask Board takes images.** A question can carry up to four PNG, JPEG, WEBP or GIF images in the `ask` payload. Claude receives them inline; Codex receives them as files written to the space's `drops/` directory for that run and deleted after it. The runner re-checks count, type and size and stores only a count.
- **Ask Board can propose assigning a card.** The board context lists the board's members and the prompt teaches an `assign` action. The runner still applies nothing: the client applies approved actions with the user's own session.
- **Every session is told which directories are its own.** Terminals and card sessions get `WORKSPACE`, `BACKUPS_DIR`, `BUILDS_DIR` and `FACTIII_SPACE`, and the plugin ships a `factiii-workspace` skill that tells Claude and Codex to work in their own worktree and where build output and files for the user go. `FACTIII_SPACE` is also the CLI's default for `--space`, so `factiii-runner job <name>` inside a session targets that session's board.
- **The link report names the route a link settled on.** `runnerLinkReport` carries the selected ICE candidate pair, which the server counts by day so an admin can see how often a link needs a TURN relay.

### Changed

- **"Ask AI" is "Ask Board"** in the running-jobs row and the handoff terminal's title.
- The assistant's prompt has it ask before reporting what a review changed, and report only what the client lists as applied.

**Old clients keep working.** One that sends no `conversationId` gets the most recently used conversation, and an image payload from a new client is ignored by an old runner. Terminals open at upgrade time read as stale once, because the new variables and skill change their digest.

## [0.20.1] - 2026-10-04

### Changed

- Republished: 0.20.0 was accepted by npm but never served by the registry; 0.20.1 is the same code.
- **A client picks the transport per link, and the owner's WebRTC / Socket switch is gone.** Every client dials WebRTC first and lets ICE try a direct route, STUN and a TURN relay; only when all of those fail does it fall back to relaying frames through the server socket, and it says so. The runner serves both the same way: a socket-relay link (`runnerSocketOpen`) is attached like a data channel, now tagged with its transport.
- **A relayed link never carries a password or a secret value.** The runner password must never pass through the server, and a link relayed over the server socket is the server. On such a link the runner refuses, before any role or board check, every action whose payload carries one: the deploy secrets init, list, set, unset, set-file and unset-file calls, the sudo password for Initialize, the deploy-run authorization, the password change, and the credential-store unlock, set-password and clear-password calls; a gate or inbox answer only when it carries a password (a deny passes), and `setConfig` only when it carries a GitHub token. The result is `error` starting with `RELAY_REFUSES_SECRETS:` plus `code: "RELAY_REFUSES_SECRETS"`. Jobs, terminals, reads, the gate state, locking and encrypted secret updates (`secret set` from a laptop, which arrives as ciphertext) stay open on the relay.

**No client action changed shape.** Old clients keep working, including the ones that still send `setConnectionMode` (the server no longer has it; the switch they would call it from is gone). New clients on a relayed link show a notice in place of the password or value field; an old client on a relayed link sees the refusal as the error text.

## [0.19.0] - 2026-10-03

### Added

- **Runner jobs run only from one address per account, and a new address asks for your authenticator code.** The server pins the address your job calls come from. From anywhere else, `job`, `cancel`, `secret set` and `audit` stop and ask for the 6-digit code from the Factiii app; a correct code moves the pin to the address that asked, and every device on the account is told. The code is typed by a person: an agent or a CI step with no terminal exits 3 and names `factiii-runner verify-ip`, the new command that confirms an address on its own. Two-factor authentication must be on for the account, or the server refuses job calls outright.

## [0.18.1] - 2026-10-03

### Fixed

- **0.18.0 never became installable, and this version replaces it.** npm held 0.18.0 in its publish-time processing (the same hold that took 0.17.0), so the registry kept serving 0.17.1 and the update banner never offered it. This version has the same contents: everything listed under 0.18.0 below arrives with 0.18.1.

## [0.18.0] - 2026-10-03

### Added

- **Named jobs, and a laptop CLI to call them.** A board member no longer needs the deploy secrets: they call a named job (`factiii-runner job <name> --space <slug>`) and the runner resolves the name against the board's `jobs.json` on the default branch and runs that command with its own keys. The runner never runs a free command for a member. `factiii-runner login` signs the laptop in with a device token you approve on the web; `job` streams the log and exits with the job's own code (77 = an approver declined, 3 = the job did not start); `cancel` stops one; `secret set` encrypts a new value to the runner before it leaves the laptop; `audit` reads the log.
- **Approval with an unlock window.** A secret-bearing step prompts the password holders and names who asked. Whoever approves can open a window (default 2 hours) during which later jobs run without a prompt. The window lives in runner memory only.
- **A hash-chained audit log** (`~/.factiii-runner/<space>/audit.jsonl`): every job, approval, denial, secret change and failed password lands there with who did it and how. Names only, never a value. Each line carries the hash of the one before it, so an edited or deleted line breaks the chain, and Runner Settings shows the check.
- **Two owner switches replace the single Shared flag.** "Allow API access" gives board members jobs, the secrets gate and encrypted secret updates; "Share terminals" gives terminals, card AI, the simulator and file writes. Both off leaves members read-only. Turning "Share terminals" on asks for a typed confirmation. The runner self-update stays owner-only.
- **`FACTIII_RUNNER_DIR`** moves all runner state (config, spaces, secrets, npm CLIs, the rendered plugin) and gives the at-rest key its own Keychain account, so a second runner can share a Mac with the real one.

### Fixed

- A fresh runner no longer starts with "Share terminals" on: an unpaired runner dir reads as new and writes no upgrade mapping.
- A wrong password typed in Runner Settings is audited and counts toward the guess limit for file-secret writes and the password change, not only for the gate.
- Password guesses are throttled.

**The web app from this release calls the runner with job, audit and secret-inbox messages.** A runner older than 0.18.0 answers them with "Unknown board-agent action" — approve the update banner and it resolves.

## [0.17.1] - 2026-10-02

### Fixed

- **0.17.0 never became installable, and this version replaces it.** npm held 0.17.0 in its publish-time scan, so the update banner never offered it. This version has the same contents: everything listed under 0.17.0 below arrives with 0.17.1, and the keyboard input described there needs 0.17.1.

## [0.17.0] - 2026-10-02

### Added

- **Type into the simulator with your own keyboard.** The text box under the simulator is gone. Click the simulator's screen in the session window and type: every key goes to the device as you press it, so Backspace, the arrow keys, a held key and Ctrl or Alt shortcuts behave as they do in Simulator.app. Pasting types your clipboard into the device. On a phone, a keyboard button under the simulator raises the phone's keyboard and sends each key as you press it. Cmd shortcuts stay with your browser.

  **Keyboard input needs runner 0.17.0.** An older runner does not understand a key press and drops it without an error, so typing appears to do nothing — approve the update banner and it resolves. Pasting, and the new app switcher button next to Home, work on older runners too.

## [0.16.0] - 2026-10-01

### Added

- **Reach your runner on a network that blocks WebRTC.** A runner's owner can now switch it between WebRTC and Socket in the runner selector. WebRTC stays the default: your devices connect straight to the runner, encrypted end to end. Socket sends the session through Factiii's server instead, so it works on networks where WebRTC cannot connect. Know what you trade for that: the server can then read what passes through, including terminal output and any tokens you enter, the connection is slower, and the iOS simulator panel has no video.

  **Socket mode needs runner 0.16.0.** An older runner switched to Socket does not answer, so its sessions do not connect — approve the update banner first, or switch the runner back to WebRTC.

## [0.15.0] - 2026-09-08

### Added

- **A live iOS simulator beside your terminal.** A Mac with a booted iOS simulator can now show it in the session window, under the scratchpad: the screen arrives as video, and tapping, dragging, typing, the hardware buttons and Face ID all reach the device. It rides the connection your session already holds, so nothing is exposed to the network and no third-party tool is involved. The two small helpers that capture the screen and carry the input are built on your own machine the first time you open the panel — the frameworks they use move between Xcode versions, so a prebuilt binary would be wrong on half of them. Needs macOS with Xcode; anywhere else the panel simply lists no devices.

  **This feature needs runner 0.15.0.** A board on the new web app talking to an older runner reports `Unknown board-agent action: simulatorList` when the panel opens — approve the update banner and it resolves.

## [0.14.1] - 2026-09-05

### Fixed

- **Connecting a repository to a space that is already running now clones it.** If you created a space and only added its repository afterwards, the space reported itself ready without ever cloning anything, and every card and terminal you started failed on a missing repo directory. Nothing re-checked, so the space stayed broken until it was recreated. Connecting a repository, rotating its token or changing its base branch now provisions the clone on the next use. Pointing a space at a different repository still rebuilds it from scratch, because the old clone and its worktrees belong to the old project.
- **The branch picker shows branches pushed since the space was set up.** It listed whatever the clone happened to know about, which could be hours stale.

## [0.14.0] - 2026-09-02

### Added

- **Every stored secret can say what it is for.** Runner Settings > Secrets listed key names and nothing else, so a store with a dozen entries told you what it held but never why any of it was there. Each key now carries a title and a description you can edit, and a key imported from a vault arrives already described. Descriptions are stored beside the names, never with the values, so reading them never unlocks anything.
- **You can change the password on your secrets, and replace the key behind it.** Neither was possible before: a password you no longer trusted meant re-pairing the machine, and the key itself could not be replaced at all. Changing the password leaves every stored value untouched; replacing the key re-encrypts them to the new one. An interrupted rotation leaves the old key working rather than a half-written one.
- **You are told when a terminal stops, not only when a card pipeline finishes.** A terminal that finished its work, or that is waiting on your approval, now raises the same notification a finished card does.

### Fixed

- **OneDrive sync sets up on machines with more than one Node installed.** The index compiles a native database driver, and it was picking up whichever Node came first on the PATH — usually Homebrew's — instead of the one running the runner. On a machine with a newer Homebrew Node the build failed with a wall of unrelated errors. It now always compiles with the runner's own Node.
- **OneDrive sync failures are no longer invisible.** They were console lines on your own machine that nobody would ever read. They now reach the same error list as everything else, filed under your account, with tokens, e-mail addresses, document names and home directories stripped out before anything leaves the machine.
- **The Resume button goes away once its draft branch does.** A deploy draft that had been merged or deleted still offered Resume, and pressing it failed with raw git output. It now says the branch is gone and retires the button.
- **Card previews are served over HTTPS and work end to end.** The preview's web and API halves are two different hostnames, which broke sign-in silently: the session cookie set on one was never sent to the other, and every authenticated call came back unauthorized while the page still looked signed in.

## [0.13.1] - 2026-09-01

### Fixed

- **The scratchpad updates on its own again.** It was watching a folder that did not exist yet the first time you opened a board, gave up on the spot, and never tried again — so everything an agent drew after that only appeared if you pressed refresh. It now waits for the folder and reconnects on its own.
- **File watching survives a sleep or a busy machine.** The same watcher backs the file tree beside your terminal. If the system dropped the watch — waking from sleep, a disk remounting, too many watches open at once — it stayed dropped until the runner restarted. It now reconnects and re-reads what changed while it was out.

## [0.13.0] - 2026-09-01

### Added

- **Agents can show you things now, not only print them.** Anything an agent saves to its scratchpad — a screenshot, a chart, a recorded run, a link, a note — turns up in a panel beside the terminal on the board instead of scrolling past as text. The file type decides how it is shown, so an agent just names the file. Every item can be saved to your machine, including recordings too large to preview.
- **One scratchpad per board, not per terminal.** Every session on the board writes to and reads the same one, so something an agent drew yesterday is still there today, in a different terminal.

## [0.12.2] - 2026-08-29

### Fixed

- **The runner starts on Node 25 and newer.** It used to refuse outright, so a machine on a current Node had no runner at all — and if an update arrived while you were on one, the runner stopped and then restarted in a loop until someone noticed. Only OneDrive search ever needed an older Node; cards, terminals, deploys and secrets all work regardless, and now they keep working.
- **OneDrive search finds a Node it can use.** If your machine has a supported one installed through nvm or Homebrew, the index quietly runs on it. If it has none, the runner says so and tells you how to install one, instead of failing later with a build error nobody can read. Point `FACTIII_INDEX_NODE` at a specific one to override it.
- **Changing your Node version no longer breaks OneDrive search.** The index remembers which version it was built against and rebuilds itself when that changes, rather than refusing to load.
- **An update can no longer leave you without a runner.** The runner now checks that the version it is about to install can actually run on your machine before installing it, and stays on the working version if it cannot. The update is approved from a phone or a browser, which cannot see what your machine is running — so the machine checks for you.

## [0.12.1] - 2026-08-29

### Fixed

- **Your terminals keep reaching your secrets after the runner updates.** A terminal you left open stopped being recognised the moment the runner restarted, so `factiii-secrets` refused it until you restarted that tab by hand. Open terminals now stay recognised across a restart.
- **A terminal opened just after the runner starts can search your OneDrive.** The file index takes a few seconds to come up, and a terminal opened before then never received the key it needed - so OneDrive search failed in that tab for as long as it stayed open.
- **The "refresh your terminals" prompt stops coming back.** It reappeared in every new terminal window even right after you had answered it, because the check behind it was reacting to values that moved on their own rather than to anything an update had changed. Refreshing is now remembered too, not only "skip for this version".
- **Tabs no longer carry an "older setup" dot.** It was up on every tab all the time, so it told you nothing. The refresh prompt is where this gets raised, and it can say how many tabs will restart and what is running in them.

## [0.12.0] - 2026-08-29

### Added

- **Restart a terminal without losing it.** A tab now has a restart button that stops everything running inside it and hands you a fresh shell, while the tab keeps its place and its number. Previously the only way to clear a wedged terminal was to close it and open a new one, which renumbered the rest.
- **Your terminals say when an update has left them behind.** Some settings only reach a terminal when it starts, so one you left open can be running the setup from before you updated. The board now notices, marks those tabs, and offers to refresh them - telling you first how many will restart and how many have something running. You can skip it for now, or skip it until something actually changes again.
- **Tabs come back after a reboot.** Restarting the machine used to lose the whole tab layout. Tabs and their working directories now return; what was running inside them does not, by design.
- **Tabs are labelled by what they are doing.** A tab running an agent shows the task it is on rather than a number, and you can drag tabs to reorder them.
- **Start a card on Claude or Codex.** The AI icon on a card asks which one, and the session opens in a terminal on that card with the CLI already running. A CLI the runner is not signed in to is shown, and disabled, rather than hidden.

### Changed

- **Each board keeps its own credentials.** A board's GitHub token and OneDrive connection now live with that board instead of in one shared file, so a board you remove takes its credentials with it. Your existing boards move across automatically the first time this version starts. Boards no longer inherit from whichever board you set up first - a new board asks for its own token.
- **A stray `exit` no longer closes the tab.** The tab stays, showing that the shell ended, and restarting brings it back.
- **Reboot support ships with the runner.** The pieces that restore your tabs are now included in the package rather than downloaded from GitHub the first time a board starts, so a machine with no network, or behind a proxy, sets up the same as any other.

### Fixed

- **Disconnecting a source stays disconnected.** Clearing a repo or a OneDrive connection could come back after a restart, because a cleared field fell back to the value it was meant to replace.
- **Ending a session no longer leaves its agent running.** Dismissing a card cleaned up its workspace but left the shell and the CLI inside it alive, invisible to the board. On one machine that had built up fifteen abandoned sessions, eight of them live agents, the oldest a week old. Every way of ending a session now stops what it started.
- **Migrating repo skills survives a second click.** Clicking migrate again while the first proposal was still waiting to be merged failed instead of telling you the branch was already there.
- **Credential files are never removed unless they were actually read.** If this machine's keychain entry had been replaced, or its settings had been copied from another machine, the move to per-board storage could delete the old files without having been able to read them - losing the only copy of those tokens. It now stops and leaves everything in place instead.

### Note

- This release adds board features that need a runner on 0.12.0 or later. If a board reports an unknown action, update the runner.

## [0.11.3] - 2026-08-28

### Fixed

- **A too-new Node now says so instead of failing cryptically.** The bundled OneDrive index compiles a native database driver that has no build for Node 25 or later. On such a machine the runner used to die deep inside a OneDrive call with a wall of compiler output that named nothing you could act on. It now checks at startup, refuses to run, and tells you to switch to Node 24.11.1. `doctor` and `status` still run on a too-new machine, and flag the version, so the problem stays diagnosable.

## [0.11.2] - 2026-08-26

### Added

- **Commands that need a secret now work anywhere on the board, not just during a deploy.** A terminal or card session can run one, and the password prompt opens over whatever you have on screen - on the web app or on your phone - instead of only inside the Deploy modal. It names which session is asking, the exact command, and the keys that command will receive.
- **Every request is attributed before you are ever asked.** The runner hands each session it starts its own token and refuses anything that arrives without one, so nothing else on the machine can put a password prompt in front of you.

### Changed

- **A command receives only the keys it names.** `factiii-secrets run --key NAME -- <command>` injects exactly those and nothing else in your store; previously every authorized command received the whole store, including keys your deploy skill never declared. `factiii-secrets list` now also reports which keys the store actually holds and which your skill declares.
- **BREAKING - deploy skills must name their keys.** A skill written before this calls `factiii-secrets run --` with no keys, which now receives no secrets and will fail. Regenerate or revise your deploy skill so each step names the keys it reads, and merge it, before your next release.

### Fixed

- **An updated runner no longer keeps serving the old helper.** After updating and restarting, a board that reattached its workspace kept the previous `factiii-secrets` for the life of the space, so it would have spoken the wrong protocol to the new runner and every secret-bearing command would have failed.

## [0.11.1] - 2026-08-26

### Added

- **Pick the branch a deploy ships, before it starts.** The Deploy modal now lists what your repo has on origin - each branch with how many commits it carries that the default branch does not, what its last commit was and when - and the run ships the one you pick. Previously the deploy had to stop mid-flight and ask, and the modal claimed it was shipping the default branch whatever you answered. Picking nothing keeps the old behaviour and the run asks. This needs a board on the matching web release; a runner older than 0.11.1 shows the picker as unavailable and the run falls back to asking.

### Fixed

- **A long release step is no longer killed for taking its time.** Any command you authorize was cut off at 45 minutes of wall clock, which is less than two mobile builds or a signed desktop release take - so those steps died mid-build every time. A command that keeps producing output now keeps running; one that goes completely silent for 45 minutes is still stopped, and six hours is the hard ceiling.

## [0.11.0] - 2026-08-25

### Fixed

- **The board's own tools work again.** Moving the board connection into the plugin also stopped anything setting the token it authenticates with, so every session sent an empty one and the board turned it away. It has been broken since 0.10.2. Sessions already running keep the old environment until they restart.
- **Plugin updates actually reach Claude and Codex.** Both CLIs load a *copy* of the plugin, filed under its version — and that version had never changed, so a runner upgrade that added a skill or a helper wrote new files somewhere nothing reads. The plugin now carries the runner's own version, and the runner asks each CLI to update it.

### Changed

- **Deploy runs on the agent you pick, with the model you configured.** The Deploy modal now has an Agent picker when both Claude Code and Codex are signed in on the machine, defaulting to the space's setting; a live run reports which one it is actually using. The deploy sessions also no longer pin a Claude model — they use whatever your CLI is configured for, like every other session.
- **Deploy skills use a command for secrets instead of a protocol.** A step that needs a stored secret is now written `factiii-secrets run -- <command>`: it blocks, you authorize it on the board exactly as before, and it returns the command's own output and exit code. Previously the agent had to end its turn with a marker the harness caught, which it had to be taught in every prompt and which broke `&&` and `set -e`. The command and the skill describing it ship in the `factiii` plugin, so the deploy-skill creator learns the secrets model from the machine rather than from you describing it. Skills written against the old marker keep working.

## [0.10.2] - 2026-08-24

### Added

- **The board's status dot now shows what the agent is actually doing.** A session was either "alive" or nothing, so a terminal sitting idle looked identical to one working. The runner installs a small plugin into Claude and Codex whose hooks report each turn, and the dot follows it: working, idle, or waiting on you for a permission prompt. Nothing changes for a session without the plugin — the dot keeps its old behaviour.
- **A skill for sharing a local port.** Sessions can hand a port running in the workspace a public HTTPS URL without being told how.

### Fixed

- **The task manager sees processes that left their terminal.** A dev server that detached from the pane it was started in disappeared from the list, so it could not be inspected or stopped from the board — it is found by the pane it came from instead.

### Note

- Installing this version adds the `factiii` plugin to Claude and Codex on the machine, at user scope. Its hooks run on every CLI session there and do nothing outside a factiii workspace.

## [0.10.1] - 2026-08-22

### Fixed

- **Dropping a screenshot on a terminal works again.** A dropped image was passed to the shell as one enormous command line, so anything past about a megabyte — which most retina screenshots exceed — failed outright, and the error you saw was the wrong one. Images now stream to the runner in pieces and are written to a single file on disk, up to 10 MB. Writing a file from the board had the same size limit and is fixed with it.
- **A command that fails to start now reports why.** When a login shell could not be spawned at all, the runner replaced the real reason with an unrelated internal error, leaving nothing to act on.

### Note

- The board sends dropped images in pieces as of this release. An older runner treats each piece as a whole image and the drop fails — update from the board's runner banner.

## [0.10.0] - 2026-08-21

### Added

- **Stage files before you commit them.** The source-control panel showed your changes as one flat list, with no way to say which of them a commit should include. It now separates what is staged from what is not, and each row can be moved in or out of the staging area from the board.
- **Read the commits already made in a session.** Recent history sits under the changes, and clicking a commit loads its patch.
- **See what a session is running, and stop it.** A new task manager lists every process a session started — what it is, its CPU and memory, how long it has been up, which ports it listens on and how many connections it is serving. Anything that has wandered off can be stopped from the board instead of hunting for it in a terminal.
- **Ports opened from a terminal now show up.** The panel only knew about ports forwarded from the board, so a tunnel the agent or your own shell opened was invisible, and a runner restart forgot ports that were still public. What is actually running on disk is read instead, so every live tunnel is listed and a dead one stops being.
- **Agents know they can share a port.** `factiii-expose` has been available to them all along and went unused because nothing told them it existed. A `share-a-port` skill is now installed alongside it, so the knowledge arrives with the capability.

### Note

- The board needs this version for the panels above. An older runner answers `Unknown board-agent action` and the panels stay empty — update from the board's runner banner.

## [0.9.8] - 2026-08-19

### Fixed

- **A phone can reach your runner again.** Connecting from the app sat on a spinner and gave up after 45 seconds, on every network — your own Wi-Fi included. The runner described each of its network addresses in a way the app's release build would not accept, so it discarded every one of them and had nothing left to connect to. The runner now describes them in a form every version of the app accepts. The app also stopped discarding them, so this connects whichever side updates first.
- **A runner behind a restrictive network is reachable more often.** The runner could only use relay servers it can reach over UDP, but it accepted whichever ones it was offered, so it regularly ended up holding two it could not use and none it could. It now keeps only the ones it can actually connect through.

## [0.9.7] - 2026-08-18

### Fixed

- **Runners answer again.** 0.9.6 could not open any connection at all, on any network: preparing the relay details raised an error before the runner replied, so every attempt waited out its timeout and gave up. Preparing them can no longer stop a reply — if the relay details are ever unusable the runner answers anyway and connects directly.

## [0.9.6] - 2026-08-18

### Fixed

- **A runner is reachable from a phone on mobile data, not only from your own network.** Connecting from anywhere else timed out with a spinner that never resolved and nothing written down anywhere. Both machines sit behind routers that hand out a different address for every destination they talk to, so each side learned an address the other could not actually send to. The runner now accepts a relay from the server and connects through it whenever a direct route does not exist, and keeps connecting directly whenever one does.

## [0.9.5] - 2026-08-18

Superseded by 0.9.6 — the relay was accepted but never used, so connecting from
another network still timed out.

## [0.9.4] - 2026-08-17

### Added

- **Everything the runner is doing now shows up in Running jobs.** Until now the list only knew about cards, so Ask AI, deploys, space setup, OneDrive indexing and sign-ins ran invisibly — a deploy could sit waiting on an answer for an hour with nothing on screen to say so. The runner now reports all of them, including when one needs you and when a runner is updating itself. A job that is actually working spins; one that is waiting or has stopped sits still.
- Whatever is already running is sent to a device the moment it connects, so opening the app mid-deploy shows the deploy instead of an empty list.

## [0.9.3] - 2026-08-17

### Fixed

- **Terminals open again.** Opening a terminal could fail outright once a board was watching a repository for outside changes, and the editor could throw instead of loading. Watching a project of any real size used up every file handle the process was allowed, so everything that needed one afterwards failed. A whole project is now watched with a single handle, however large the repository is.
- **A deploy no longer floods a card with changes.** Cards without their own repository were watching the folder deploy checks out and cleans up, so a deploy looked like thousands of edits arriving at once.
- **A board could refuse to start on a machine that had everything it needed.** The runner looks for its tools the way a fresh login shell would, and a login shell never reads `.zshrc` — so the Claude and Codex CLIs, which their own installers put in `~/.local/bin` and put on your PATH from `.zshrc`, were invisible. The runner decided they were missing, tried to install them again through npm, and npm refused because its default install location belongs to root: `Couldn't initialize the environment — npm error code EACCES`. The runner now also looks in `~/.local/bin`, so an installed CLI is found instead of reinstalled.
- **npm installs no longer need root.** Anything the runner installs through npm now goes under `~/.factiii-runner/npm`, which you own, instead of the system-wide location that only root can write to. The failure above cannot happen on any machine now, whichever way Node was installed.
- The runner also looks in whatever install location npm itself is configured with. Pointing npm somewhere you own (`prefix` in `.npmrc`) is the common way to avoid needing root, and on those machines that is exactly where the CLIs are — but the line that puts it on your PATH usually lives in `.zshrc`, out of the runner's sight. Such a machine could start a board fine and then fail mid-job with "claude: command not found".
- An environment failure now names the PATH it searched, so "not installed" and "installed where I can't see it" are told apart from the message alone.

### Added

- `factiii-runner doctor` prints where each host tool actually resolves, the npm install location, and the PATH — the first command to run when a board won't initialize.

## [0.9.0] - 2026-08-11

### Added

- **Your OneDrive, indexed for the AI — and you choose which folders.** Connect OneDrive to a board and pick the folders it should know about. Each one is indexed for semantic search and stays current on its own from then on, so the AI can find a file by what it says rather than what it's called. Nothing outside your picks is ever read. Pick a parent folder and it takes over the ones you'd already picked underneath it, so the list stays one row per area of your drive. Stop indexing a folder and everything indexed from it is deleted.
- **An optional password on your connection tokens.** Runner Settings → Connections can now put a password of yours in front of the stored GitHub, OneDrive and AI-provider credentials, on top of the machine keychain — both halves are needed to open them, so a stolen machine isn't enough on its own. Also available as `factiii-runner password`. The trade-off is explicit: a runner with a password comes up **locked** after every restart and does no work until you unlock it, from the app or by typing it at the terminal. Adding, changing or removing the password re-wraps one key file and rewrites no credentials.
- **AI provider sign-ins are encrypted between sessions.** The Claude/Codex OAuth files have to be readable while a container is running, so they are now sealed the rest of the time: unsealed when a board's container starts, re-encrypted when the board goes idle, when you lock the runner, and on shutdown. A crashed session's leftovers get swept up on the next start.
- `factiii-runner status` reports how credentials are protected, and names the missing piece when they can't be.

### Changed

- **No more plaintext fallback.** A machine with no usable keyring used to store your tokens unencrypted and carry on. It now stores nothing at all: `setup` stops before pairing, and a running daemon still connects — so the app can reach it — but every credential read and write fails with the name of the missing tool and the exact command to install it. Nothing that was already encrypted is affected.

### Fixed

- A keychain read that failed for any reason other than "no such item" (a locked keychain, a denied access prompt, the wrong `$HOME`) would mint a fresh key and overwrite the existing one, leaving every already-encrypted file undecryptable. Only a genuine miss creates a key now; anything else reports the problem and leaves your key alone.
- The Connections badge for an AI provider sign-in never lit up: it checked a config field that had been removed, which the runner's type-check would have caught had the package been wired into `pnpm check-types`. Both fixed.
- The OneDrive index never started on a runner installed from source (`npm link`): it looked for its bundled service in one place that only exists in the published package. It now falls back to the in-repo build, as the desktop app already did.
- The index service wrote its diagnostics nowhere, so a failed pass left nothing to read. It now appends to `index.log` beside the index data.

## [0.8.0] - 2026-07-29

### Added

- **Connect GitHub from the board, without pasting a token.** The board's Connect GitHub button now starts a device-code sign-in on the runner: GitHub shows you a short code, you approve it at github.com, and the runner stores the resulting token where a hand-pasted PAT used to go — so cloning and pushing work unchanged. The token is obtained and held on the runner machine; it is never sent to or stored by the Factiii server.

### Fixed

- Runners older than this rejected the board's Connect GitHub button with "Unknown board-agent action: githubStartDeviceCode", because the web app shipped the button before any runner build carried the handler. Update to 0.8.0 to use it.

## [0.7.0] - 2026-07-10

### Added

- **Deploy your project from the board.** The board's new Deploy entry runs your repo's own deploy process on the runner. The first time in, a deploy skill creator asks you to describe how you ship, reads through the whole repo, and writes a deploy runbook to a branch, along with the exact variables it needs and a script that proves the machine is ready to run it. Merging that branch is the approval that arms the button. From then on, Deploy shows the environment checklist and executes the runbook, with every command authorized by the harness and journaled so a failed push can be captured and rolled back.
- **A secrets store on your runner.** Deploy secrets live on the machine you control, encrypted (SOPS) under a single age key protected by your password. Each unlock covers one operation and nothing is cached. Secret values never cross the wire, never show in the app, and never enter the model's context: the app only ever sees key names and whether they're set.
- **One-click Claude sign-in.** Instead of pasting an OAuth token into the runner config, sign in from the board: the runner drives the Claude CLI's own login flow and keeps the resulting credentials per board, so terminals and background AI runs share the same sign-in.
- **Card merging runs on your runner.** Merging cards on a board is now powered by the runner: a model combines the selected cards into one, and each source card's completed session work is reconciled into a fresh session on the merged card, so nothing already done is lost.

### Changed

- **More tools in session containers.** Sessions now ship with the AWS CLI, jq, and the Vercel and Cloudflare (wrangler) CLIs out of the box.

### Fixed

- Hardened the run protocol between the app and the runner, and fixed session credential handling.

## [0.6.0] - 2026-06-30

### Added

- **Manage idle containers from the jobs panel.** The runner now reports every factiii container it holds — running and stopped — so the app's jobs panel can show idle VMs/dockers left from past sessions and let you delete them to reclaim the machine. Listing and deletion are scope-checked: a shared member only ever sees and removes containers for boards the runner is shared to them for; everything else stays private to the owner.

### Changed

- **Containers are now named by stable board id instead of slug.** Board slugs can change; ids don't, so container names (`factiii-…-card-<spaceId>-…` / `…-util-<spaceId>-…`) stay stable across renames. Existing util containers are migrated to the new name on the next session. (Older stopped card containers without an id segment can't be re-attributed and may linger as orphans — remove them once from the jobs panel.)

## [0.5.0] - 2026-06-29

### Added

- **Share a runner with a board.** A runner's owner can now let other members of a board use it. Shared members run Board AI on the runner and see that board's jobs; every other board on the same machine stays private unless shared there too. The runner enforces this per connection — a shared member only ever receives and controls the boards they're granted, including terminals.

## [0.4.0] - 2026-06-29

### Added

- **Update your runner from the board.** The runner now reports its version to the app, and when a newer release is on npm the board shows an "Update available" banner. One click approves it: the runner installs the latest version and restarts itself — no SSH or terminal needed. It only updates when you approve, and never while a session is mid-run. (Runners on older versions need a one-time `npm i -g @factiii/runner` to pick up this feature.)

## [0.3.0] - 2026-06-29

### Changed

- **One runner config, shared across boards.** The per-board `space-<slug>.json` files are replaced by a single `runner-config.json` holding a shared `default` config plus per-board overrides. New boards inherit the default — set it once and reuse it across boards — and a board only persists the fields that actually differ (e.g. a different repo and GitHub token when it points at another git). Editing the default propagates to every board that inherits it; clearing an override field re-inherits the default. Legacy per-board files are migrated automatically on first read, so no manual steps are needed.

## [0.2.1] - 2026-06-27

### Fixed

- **Ask AI no longer fails to start on some spaces.** On OneDrive-backed spaces (and any case where the workspace folder hadn't been created yet) Ask AI could error out before responding. It now ensures the working directory exists first, and surfaces the underlying container error clearly instead of a generic exit code.

## [0.2.0] - 2026-06-13

### Added

- **Run sessions straight out of your OneDrive.** A connected Microsoft OneDrive account can now be mounted as a session's workspace, so everything the session does is saved to your own cloud automatically, an alternative to keeping your work in a git repo. Files created or deleted on either side stay in sync.

## [0.1.0] - 2026-06-02

### Added

- **Host full terminal sessions, not just AI tasks.** Your runner can now power complete terminal sessions, with a built-in code editor and file browser, on top of the existing AI coding pipeline. Use your own machine's power and storage to do real work from the Factiii web and mobile apps.
- **Reach apps running on your runner.** When a session starts a web app or dev server, its ports are forwarded back to you, so you can open and preview it from the Factiii client wherever you are.
- **Choose the tools for each session.** Sessions can be set up with the specific languages and developer tools they need, picked from the Factiii app when the session starts.

### Changed

- **A much bigger toolbox, and faster sessions.** Runners can now provide a far wider range of programming languages and developer tools out of the box. Tools and downloads are cached between sessions, so after the first run new sessions start up noticeably faster.
- **Run several sessions side by side.** Each session is now isolated and tracked on its own, so you can have multiple running at once without them interfering, and one finishing doesn't disturb the others. Sessions are grouped by runner in the app so it's clear where each one is running.

### Fixed

- Stability and reliability fixes for the daemon and its pairing flow.

## [0.0.1] - 2026-04-29

Initial release.

### Added

- **Run Factiii's AI coding agents on your own machine.** A headless daemon you install on a workstation, dev box, or VM you control. The Factiii web and mobile apps connect to it and offload AI coding work to your hardware.
- **Simple command-line setup.** `factiii-runner setup` takes you from zero to running: it checks that Docker is available, prepares the environment it needs, and walks you through pairing with your Factiii account in the browser.
- **Everyday commands.** `connect` to pair with a different account, `start` to run the daemon, and `status` to see your current configuration.
- **Secure pairing.** Link the runner to your account through a browser approval flow.
