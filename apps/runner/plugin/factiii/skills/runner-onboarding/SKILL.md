---
name: runner-onboarding
description: Walk the owner of a runner that Factiii Desktop just set up through the rest - a board, a repository, secrets, keeping the Mac on - and install the tools a feature needs (git, sops, Ollama, Tailscale, Xcode) only when that feature is first wanted, asking first. TRIGGER when a session's first message says the runner was just set up, when the user asks to finish setting up this runner or this Mac, or asks what to do next with a new runner.
license: ISC
---

# runner-onboarding

Factiii Desktop has already done the minimum: this Mac is a runner, paired to
the person's account and online; the AI (you) is installed and signed in;
tmux, Valkey, age and frpc are in `$FACTIII_TOOLS_DIR`. Everything else is
optional, and you set it up by talking it through.

## How to run it

- **One step at a time.** Say what the step is for in a line, ask, and wait.
  "Skip" is always an answer; skip and move on.
- **Ask before every install**, naming what it is, its size, and whether
  macOS will ask for a password. Install nothing that no step needs.
- **Never use sudo and never ask for a password yourself.** Admin steps go
  through macOS's own dialog (an installer, `xcode-select --install`, System
  Settings), which the person answers.
- **Never ask for a secret in the chat.** Values go into the board's store
  from the app (Settings > Secrets); you use them through `factiii-secrets`.
- Install a command-line tool into `~/.local/bin` (on the runner's PATH),
  never into `$FACTIII_TOOLS_DIR`, which the app replaces on every update.
- Check first (`command -v <tool>`, `factiii-runner doctor`): a step this Mac
  already has is only mentioned.

## The steps

1. **Where things stand.** Run `factiii-runner status` and
   `factiii-runner doctor`; tell the person in three lines what works and
   what this walk-through can add.
2. **A board.** This session runs on a board (the `session_card` and
   `list_sessions` tools of the `factiii-board` MCP name it). Ask what they
   want to work on. A project of their own gets its own board: they make it
   in the app (New board), then pick this runner for it. Offer to put their
   first tasks on it as cards (`create_card`).
3. **A repository** (only if they code). Git is the first tool on demand,
   below. Connecting GitHub is the runner's, once for every board: Status >
   Git in the runner window. Then the board's Settings names the repository.
4. **Secrets** (only if a project needs API keys or deploy credentials).
   Explain the store in two lines: encrypted on this Mac, each use approved
   by them. It needs `sops` (on demand, below; `age` is already there). They
   add the values in the board's Settings > Secrets; show them how a command
   uses one with the `factiii-secrets` skill.
5. **Keeping it on.** If the runner should answer while they are away: the
   optional rows of Set up this computer (in the Factiii app menu): start
   after a restart, keep the Mac awake, log in automatically.
6. **Wrap up.** List what is set, what was skipped, and how to come back to
   it (ask for this walk-through again, or Status in the runner window).

## Tools on demand

Only when the step or feature that needs it comes up, and only after a yes.

| Tool | Needed for | How (macOS) |
| --- | --- | --- |
| git | a repository, Code sessions | `xcode-select --install`: macOS's own dialog installs the Command Line Tools (about 1 GB, a few minutes, no password). Check with `xcode-select -p`. `/usr/bin/git` before that only opens the same dialog. |
| sops | the secrets store | `brew install sops` if `brew` is there. Else the official release: `sops-v<version>.darwin.<arm64\|amd64>` from github.com/getsops/sops/releases, checked against that release's `sops-v<version>.checksums.txt` with `shasum -a 256` before it is moved to `~/.local/bin/sops` and made executable. A mismatch: stop and say so. |
| Ollama | Local AI (private models on this Mac) | Status > Features > Local AI adds it through Homebrew. Without Homebrew: the official app, ollama.com/download (Ollama.dmg, drag to Applications, open it once). Then the model step in Status picks a model that fits this Mac. |
| Tailscale | reaching this Mac when Factiii is down, or from their other machines | The person installs it: the Mac App Store or tailscale.com/download, then signs in with their own account. You only check `tailscale status` afterwards. |
| Xcode | iOS builds and the iOS simulator | The person installs it from the Mac App Store (many GB, a long download), then opens Xcode once to accept its license and add its components (macOS asks for their password). You check `xcodebuild -version` afterwards. |

Anything else a feature needs: `factiii-runner doctor` names it and the
command; say what it is for and ask before running it.
