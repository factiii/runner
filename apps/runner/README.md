# @factiii/runner

A headless daemon that runs Factiii's Board AI agents (Claude-driven coding sessions) on a machine you control. Install it on a workstation, dev box, or VM with a stable network connection. Agents run directly on that machine, so it can drive whatever the machine can: simulators, native builds, platform toolchains. The mobile and web [Factiii](https://factiii.com) clients then connect to it over WebRTC and offload AI work.

## Requirements

- Node 20+
- git and tmux on PATH (installed for you when a space first opens); redis, OrbStack and Tailscale are optional extras
- The agent CLIs: `claude` and `codex`
- Optional, by feature: `sops` and `age` (Secrets), Xcode with a simulator (simulator panel, macOS)
- A Factiii account
- Outbound network access to the Factiii API server

## Install

```bash
curl -fsSL https://factiii.com/runner.sh | sh
```

It installs the newest release from [github.com/factiii/runner](https://github.com/factiii/runner/releases) after checking its `.sha256`, brings its own Node when the machine has none (or one outside 20 to 24), then runs `factiii-runner setup`. Run it again to update. npm has blocked every release after 0.27.0, so `npm install -g @factiii/runner` installs that old version until npm unblocks the package.

Without the script:

```bash
npm install -g https://github.com/factiii/runner/releases/download/v0.39.0/factiii-runner-0.39.0.tgz
factiii-runner setup
```

## Usage

```bash
factiii-runner setup       # install and pair the connector, then list the parts
factiii-runner connect     # re-pair with a different account
factiii-runner start       # run the daemon (keep this process alive)
factiii-runner status      # show current config + credential storage state
factiii-runner parts list | add | remove | start | stop <part>   # pick what this runner does
factiii-runner doctor      # check what this machine needs, and fix what the runner may fix
factiii-runner service install | status | remove   # start at login, restart after a crash
factiii-runner password    # enter an old connection password once, to remove it (see Security notes)
```

`setup` walks you through the browser pairing flow and installs nothing else: the runner starts as a **connector** (pairing plus the encrypted link to your devices). After it finishes, `factiii-runner start` runs the daemon. Everything else is a part you add (below). A board's own toolchain (git, tmux, node, the Claude CLI, and the board's provider CLI when it is Codex) also installs when you first open a space on the board, with progress shown there; `factiii-runner setup --tools` runs the same install from the terminal.

### Parts

Each part says what it does, whether it is installed, and about how much disk and memory it costs. The same list is in the app under the runner's Status > Features, where one button adds, removes, starts or stops a part and installs run in the background.

| Part | Needs |
|---|---|
| `terminals` | git, tmux, script |
| `claude` / `codex` | node and that agent CLI |
| `secrets` | sops and age |
| `simulator` (macOS) | Xcode and an iOS simulator |
| `local-ai` | Ollama (start and stop run `ollama serve`) |
| `vault` | its database, PGlite (installed into the runner folder; removing the part keeps your files) |

- `add` runs the `doctor` fixes for that part's requirements only. What needs `sudo` or a settings pane is printed, never run.
- `remove` uninstalls only what `add` installed (kept in `parts.json` in the runner folder), never node, git or script, and never a tool another installed part uses.
- A part already on the machine reads as installed, so updating an existing runner changes nothing.

`doctor` is the first thing to run when a board reports "Couldn't initialize the environment". It prints the resolved location of every tool the runner needs and the PATH it searched, which separates a tool that is genuinely absent from one that is installed somewhere the runner cannot see.

### The checklist (`doctor`)

`doctor` prints a checklist of the machine at any time. Each item says which feature needs it and whether it is required, so nobody installs Xcode for a runner that never shows a simulator. Only the connector's items are required; every tool is optional, named by the part that needs it. An unmet item gets one of two things:

- **"Fix it for me? [Y/n]"** when no administrator is needed: a tool Homebrew or npm installs (tmux, sops, age, the agent CLIs), or the runner's own folder. With a yes the runner installs tools and nothing else.
- **The command to copy** when it needs `sudo` or is your decision to make: packages on Linux (apt, dnf, pacman), sleep and power settings, automatic login, lingering. The runner prints it and never runs it.

The tools of this checklist (git, tmux, script, node, claude, codex, redis, sops, age, OrbStack, Tailscale) also show in the app, item by item, under the runner's Status > Features. Initialize installs the basics (git, tmux, script, node, claude); each extra (codex, redis for live agent status in terminals, sops and age, OrbStack for containers, Tailscale for remote access) has its own Install button, and Connect Codex installs codex itself. Tailscale's Install also starts tailscaled as a system service (your password, once), makes you its operator, and runs `tailscale up`: open the "Sign in to Tailscale" button it shows, or set `TAILSCALE_AUTH_KEY` (an auth key, or an OAuth client secret with `?preauthorized=true` and its tags) in the runner's environment to join with no sign-in. Screen Sharing then works at `vnc://<its tailnet IP>`, even when Factiii is down.

`doctor` exits 1 while a required item is unmet and 0 otherwise. Without a terminal, or with `--no-fix`, it only reports: it asks nothing and changes nothing. `--json` prints the same report for a script.

sops is not packaged for Debian, Ubuntu or Fedora; there `doctor` points at the release page instead of offering an install.

### Always on (`service`)

```bash
factiii-runner service install   # start at login, restart after a crash
factiii-runner service status    # installed? running? what it runs, where it logs
factiii-runner service remove    # stop it and delete what install wrote
```

`setup` offers this at the end ("Keep this runner running after a restart?"). It uses the operating system's own service manager, for the current user, without `sudo`:

| | What is installed | Where |
|---|---|---|
| macOS | a LaunchAgent | `~/Library/LaunchAgents/com.factiii.runner.plist` |
| Linux | a systemd user service | `~/.config/systemd/user/factiii-runner.service` |
| Windows | a scheduled task at logon | task `FactiiiRunner`, files in `~/.factiii-runner/service/` |

- The service runs `factiii-runner start` with the node and the runner that were installed when you ran `service install`, and the PATH of that terminal. If you move to another Node version or reinstall the runner somewhere else, run `service install` again: it rewrites its file and restarts the service.
- It restarts the runner after a crash, not after a stop: a runner you disconnect from your account in Settings stays down.
- Updates approved from the app work as before. The runner relaunches itself; the service is not involved.
- Output goes to `~/.factiii-runner/logs/runner.log`. When it passes 10 MB the runner copies it to `runner.log.1` (replacing the last one) and empties it, at start and once an hour, so the two files are all it ever keeps.
- If a runner is already running when you install the service (started by hand, or under another process manager), the service is written but not started, so there are never two. Stop the old one and run `service install` again.
- `install` refuses to overwrite a file of the same name that it did not write, and `remove` deletes only what `install` wrote.
- A runner set up with `FACTIII_RUNNER_DIR` gets its own service name and log.

**After a restart with nobody at the machine.** The service starts when its user logs in, and the key that opens the runner's config is in that user's keychain, which is locked until then. So an unattended machine needs one more thing, and it is yours to decide. The runner explains it and never does it:

- **macOS:** automatic login (System Settings > Users & Groups > Automatically log in as). It is a security trade: anyone who can reach the Mac gets a logged-in session, and macOS does not offer it while FileVault is on.
- **Linux:** `sudo loginctl enable-linger <user>` starts user services at boot. The login keyring still has to be unlocked for the runner to read its config.
- **Windows:** automatic logon (`netplwiz`), with the same trade as macOS.
- **Sleep and power:** `service install` and `doctor` print the commands (`pmset` on macOS, including "start up automatically after a power failure"). They never run them.

**Secrets stay locked after a restart.** The board password is never stored. The runner comes back by itself, but each board's secrets stay locked until someone unlocks them from the app.

### What works on each platform today

- **macOS:** everything above. The LaunchAgent has not yet been run on a real Mac by us; its file is checked with `plutil` and its commands are tested against a fake launchd.
- **Linux:** the runner, the checklist and the service file are implemented. The libsecret keychain path and the systemd unit are untested on a real machine (beta).
- **Windows:** a runner that hosts boards needs WSL2, because tmux and redis have no Windows build; install the runner inside WSL2 and it is a Linux runner. On Windows itself `doctor` says WSL2 is missing, and the scheduled task is implemented but untested (beta).

## Security notes

The credentials the runner itself stores in `~/.factiii-runner/` — each board's GitHub PAT (`<board>/.creds/`), and the pairing JWT (`config.json`) — are **encrypted at rest** with AES-256-GCM at permissions `0600`, all under the same machine keychain key. Existing plaintext files migrate automatically on the first read; no re-pairing. A board's `onedrive.json`, left by the since-removed runner OneDrive index, is deleted on the first read: nothing uses it. The Claude/Codex sign-ins are not in this list: see Provider sign-ins below.

**There is no plaintext fallback.** A host with no usable keychain (headless Linux without libsecret, a CI container, a locked login keyring) stores nothing at all: `setup` refuses, and a running daemon connects but fails every credential read and write. It tells you which tool is missing and how to install it, both on the console and in Runner Settings → Secrets. Fix the keyring, restart, and it picks up where it left off.

### The machine key, and the connection password that is gone

1. **Machine key (always).** A 32-byte key in the OS keychain — macOS Keychain, libsecret on Linux, DPAPI on Windows. Bound to the logged-in OS user, so the daemon works unattended. The runner touches exactly one keychain item (`factiii-runner` / `config-encryption-key`) and never deletes anything; if that item exists but can't be read, it reports the problem rather than minting a replacement over the top of it.
2. **Connection password (removed).** Older versions let you put a password on top of the machine key. It sealed the GitHub connections (and the OneDrive ones of the since-removed runner OneDrive index) under a data key (`vault-key.json`), so a password-protected runner came up locked after every restart (including auto-update) and could not clone, deploy, or even show which GitHub user was connected until someone typed it. That password can no longer be set or changed. The connections are sealed under the machine key alone, like the pairing config, and the runner reads them the moment it starts. Values that must stay behind a password belong in deploy secrets (below).

**Upgrading a runner that has a password set: one unlock, then never again.** Connection files written before this change are still in the old envelope. With no password set they are converted at the first start. With a password set, the runner needs it **one last time**: it starts, connects, and reports those files as locked (console, and Runner Settings → Secrets) rather than as "no repository". Enter the password once — in the app, at the terminal prompt `start` shows, or with `factiii-runner password` on a host with neither — and every board's files are rewritten under the machine key together. A file is rewritten only after it has been decrypted, through a temp file and a rename, so a failed conversion leaves the old file as it was. **An update approved from the app never waits at a terminal for this.** The relaunch after a self-update skips the terminal prompt even when the runner was started in a terminal — nobody is sitting at it — so the runner connects with those connections locked, prints the problem and the ways to unlock, and the app asks its owner for the password in the same banner that offered the update, on any page. A runner that is unlocked with `factiii-runner password` while it is running notices within a few seconds and tells its connected clients.

**When the vault file goes.** As soon as no file is left in the old envelope — at start, or right after that unlock — `vault-key.json` is renamed to `vault-key.retired.json` and the password stops existing: no later restart asks for it. A runner that has a password set but nothing sealed under it loses the password at start without being asked. If a file will not decrypt even with the vault open, it is left in place and named on the console, and the vault stays until that board is reconnected (which replaces the file).

### Provider sign-ins

The Claude/Codex OAuth files are written by those CLIs into each board's state dir (`<board>/claude`, `<board>/codex`) or the OS keychain, and the CLIs own them. **The runner does not encrypt them.** An earlier version of this section said they were sealed between sessions; no code does that, and the files are exactly as the CLI left them.

> **Beta on Linux and Windows.** Only the macOS Keychain path has been tested end to end. The libsecret (`secret-tool`) and Windows DPAPI paths are implemented but unverified — we have no machine to exercise them on yet. They now fail closed rather than degrading, so the expected failure mode is "the runner says it can't store credentials", not silent plaintext. Please report it if you hit that.

What this protects is **offline** access to the files without the login keychain: a synced folder, a backup, a disk read on another machine. It does **not** protect against someone signed in as the runner's OS user, nor a compromised runner host — the daemon can always read what it can use. Only run a runner on a machine you trust, and only pair with accounts you own.

The deploy **Secrets** panel is a separate store with a different model: sops/age, under a password supplied per operation and never cached. The two passwords are independent on purpose — deploy secrets never need to be read unattended, connection tokens do, which is why connection tokens no longer sit behind any password. See `.specs/runner-secrets-store.md`.
