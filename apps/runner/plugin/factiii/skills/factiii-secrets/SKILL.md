---
name: factiii-secrets
description: Run a command that needs this workspace's stored secrets, with factiii-secrets. TRIGGER when a command needs an API token, deploy credential, database URL or any other secret value, when writing or revising a deploy skill, or whenever an environment variable a step needs appears to be missing.
license: ISC
---

# factiii-secrets

This machine keeps the workspace's secrets in an encrypted store the owner
manages. You never hold those values, and you never need to: one command runs
anything that needs them.

```bash
factiii-secrets run --key NAME -- <command...>
```

It is already on your PATH. Nothing needs installing, and nothing needs
setting up before you use it.

## What actually happens

You run the command. It blocks. The owner gets a prompt wherever they are -
web or phone - naming your session, the exact command, and the keys you asked
for, and enters their password to authorize it.
The runner then decrypts the store for that one command, runs it with **only
those keys** in its environment, and hands you back its output with every
secret value replaced by `[REDACTED]`. `factiii-secrets` exits with the
command's own exit code, so `&&`, `||` and `set -e` all behave normally.

The values reach the command and stop there. They are never in your
environment, never in your context, and never in anything you can read.

## Naming the keys

`--key` is how a command says what it needs. Only the keys you name are
injected; the rest of the store stays shut. **A command that names no key gets
no secrets** - the wrapper does nothing for it.

Name one key per flag, repeat the flag, or pass a comma-separated list. All
three of these ask for the same two keys:

```bash
factiii-secrets run --key AWS_ACCESS_KEY_ID --key AWS_SECRET_ACCESS_KEY -- ...
factiii-secrets run --key=AWS_ACCESS_KEY_ID --key=AWS_SECRET_ACCESS_KEY -- ...
factiii-secrets run --key AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY -- ...
```

Every `--key` must come BEFORE the `--`. After it, the words are the command's
own, so a command with a `--key` flag of its own is safe.

## Files: keys, certificates, whole .env files

Some secrets are files, not one-line values: an SSH key, a `.p8` or `.p12`,
a server's whole `.env`. Ask for those with `--file`. The runner writes each
one to a private temp file (mode 0600) and puts its PATH in `$NAME`:

```bash
factiii-secrets run --file DEPLOY_SSH_KEY -- ssh -i "$DEPLOY_SSH_KEY" deploy@host ./release.sh
factiii-secrets run --key EXPO_TOKEN --file ASC_API_KEY_P8 -- ./scripts/submit-ios.sh
```

`--file` works like `--key`: repeat it or pass a comma-separated list, and put
it before the `--`. The file exists only while the command runs; the runner
deletes it when the command ends, so do not copy it anywhere or look for it
afterwards. `factiii-secrets list` shows file secrets as `set, file (--file)`.

## Using it

Write the command exactly as you would without the wrapper, referencing
secrets as ordinary `$NAME` variables, and name every key it will read:

```bash
factiii-secrets run --key VERCEL_TOKEN -- vercel deploy --prod --token "$VERCEL_TOKEN"
factiii-secrets run --key DATABASE_URL -- psql "$DATABASE_URL" -f migrations/latest.sql
factiii-secrets run --key NPM_TOKEN --key GH_TOKEN -- ./scripts/publish.sh
```

Quote the variables. They expand on the runner's side, once the values are
present - not in your shell, where they are empty.

A script reads keys its command line never mentions - that last example. Name
what the SCRIPT reads, not what you can see in the command. Get it wrong and
the variable is simply empty inside the script; the runner tells you which
name it could not find.

Wrap **only** the commands that need a secret. Everything else - builds,
tests, git, file edits - runs normally, unwrapped, and stays fast because it
needs no authorization.

```bash
factiii-secrets list
```

prints the key NAMES this workspace has, whether the store actually holds a
value for each, whether the deploy contract declares it, and what each one is
FOR:

```
DATABASE_URL   set, declared     Primary Postgres URL
               The database migrations run against. Points at prod.
EXPO_TOKEN     not set, declared Expo access token
               Authenticates the EAS CLI for mobile builds and submits.
OLD_TOKEN      set, undeclared
```

Never their values; there is no command that prints a value, on purpose.

Read this before guessing. It answers both "what is the key called" - a
guessed name gets you an empty variable, not the value - and "which key does
this step actually need", which the name alone often does not say. A key with
no description is simply one nobody has described yet; ask the owner rather
than inferring a purpose from the name.

## Every command asks, even when the runner is "unlocked"

A shared runner can be unlocked for a while (the app shows "Unlocked by …
until …"). That window lets the runner's **jobs** run without a new prompt. It
does not cover you: every `factiii-secrets run` from a terminal or a card
session still asks a password holder, every time. Do not wait for, rely on,
or ask anyone to open a window to avoid the prompt.

**A job does ride the window.** Before a free command, check
`factiii-runner job --list`: if a job does the same thing (a deploy, a GitHub
release step, a log read), call it instead. Inside an open window it runs with
no prompt, and when the runner is locked one password opens the window for the
jobs after it too. If no job fits and the step will come back (a release
step, a recurring read), say so: offer the user the choice of approving this
one command, or adding a job to the repo's job list so it never asks inside a
window again.

That prompt is the gate, so the runner tells your CLI to let the command
through without its own check: an allow rule in Claude's user settings, and
`$CODEX_HOME/rules/factiii.rules` for Codex. Both are in the runner's own
homes (`$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`), not in `~/.claude` or `~/.codex`,
so they apply to runner sessions only. Keep the command plain so the rule
matches. Codex still asks about a command that has `$(...)`, a redirect or a
`$VARIABLE` in it, and anything chained before or after with `&&`, `;` or `|`
gets the CLI's normal check.

## Things that will waste your time

- **Do not check whether these variables are set.** They are unset in your
  shell by design and will stay that way for the whole session. `env`,
  `printenv`, `test -n "$TOKEN"` and echo-checks all tell you nothing.
- **Do not report them as missing or stop over them.** An unset declared
  variable is the security model working. Route the command through
  `factiii-secrets run --key <NAME>` and it gets what it needs.
- **Do not ask the owner to export them,** write them to a `.env`, or put them
  in a shell profile or CI config. They are already stored; that is what this
  command reads.
- **Never print a value.** If output somehow contains one, do not repeat it.

## Exit codes

- The command's own exit code, when it ran.
- `77` - the owner declined to authorize it. That is an answer, not a fault:
  adapt or stop and explain where things stand. Do not retry the same command.
- `3` - nothing ran. No store is reachable here, or the runner went away.

It works from any session the runner started - a terminal, a card session, a
release - not only during a deploy. A caller the runner did NOT start is
refused before the owner is ever prompted, so running the CLI from a shell of
your own does not work, and no amount of retrying changes that.

## Writing a deploy skill

A repo's deploy skill declares every key it needs in
`.agents/skills/deploy/required-variables.json`, then wraps each step that
needs one in `factiii-secrets run --key <NAME> -- …`, naming exactly the keys
that step reads. Declare a key exactly when a command uses it: never declare
one the skill does not use, never use one it does not declare. A step asks for
the keys IT needs, not for every key the skill declares - that per-step scope
is what the owner sees and authorizes. Put no secret value, and no key
material, in any file.
