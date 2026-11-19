---
name: board-sessions
description: See, start, message, read and end the other agent sessions (Chat and Code) on your boards, with the factiii-board MCP's session tools. TRIGGER when the user asks to spin up another agent or session, hand a task to a new agent, check on or talk to another session, see what other agents are doing, or end/clean up sessions.
license: ISC
---

# board-sessions

The `factiii-board` MCP server has tools the runner answers itself, for the
sessions it holds. Your own session:

- `session_card`, `link_card { postId }`, `unlink_card`: the card this
  session works on.
- `set_work_path { path }`: point this session's IDE at another folder.

Every other session on the boards you can use, on this runner and on the
other runners (and the desktop app on your computer) you can reach, through
Factiii's server:

- `list_runners`: this runner first, then each other one online, with its
  `id` (what `runner` takes: `r12`, `desktop:5`), the boards you reach there,
  what it offers (`os`, `tart` VMs, the iOS `simulator`, a `gpu`), and
  whether its owner lets sessions be started there from other runners.
- `list_sessions { board? }`: board, runner (where it runs) and runnerName,
  id, title, state (starting, working, idle, needs you, error), mode (Chat or
  Code), linked card, and here also worktree and which session started it.
- `start_session { mode, message, board?, title?, cardId?, baseBranch?,
  runner? }`: `code` gets its own worktree and branch named after `title`
  (required); `chat` runs in the board's workspace. `message` is its task; it
  goes in once the workspace is ready. Returns the new id. With `runner`, it
  starts on that runner, if its owner allowed starts from other runners, and
  runs with that runner's own permissions.
- `message_session { session, text, board?, runner? }`: lands in its inbox
  and goes in once any turn in progress ends; it never interrupts one. A
  session on an offline runner gets it when that runner is back (held 7
  days, then expired). Says whether it was delivered or is waiting, and why
  it waits: on a turn, its terminal not open yet, or a CLI that has not
  reported what it is doing. `expiresIn` (minutes, a session on this runner
  only) drops it if it still waits after that long: set it when you would
  otherwise do the work another way.
- `cancel_message { message }`: takes back a message of yours that is still
  waiting on this runner (the id `message_session` returned). Do this before
  you do the work yourself, or the session does it again when the message
  goes in.
- `read_session { session, board?, runner?, limit?, wait? }`: its recent
  transcript and, for Code, branch, dirty files, ahead/behind and unpushed
  commits. `wait` (seconds, up to 600) waits for its turn to end and adds its
  final answer as `summary`.
- `end_session { session, board?, discard?, deleteBranch? }`: stops a session
  on this runner and removes its worktree. The branch is kept unless
  `deleteBranch: true`.

## Rules the runner enforces

- You can do only what the person your session acts for could do by hand on
  that board. A session you start acts for the same person.
- At most 5 sessions started this way run at once on a board. End one you no
  longer need before starting another.
- `end_session` refuses a worktree with uncommitted files or commits no
  remote has. Ask the session to commit and push (`message_session`), check
  with `read_session`, then end it. Pass `discard: true` only when the user
  said the work may be lost.
- You cannot end your own session this way.
- A message is at most 16,000 characters, at most 30 a minute, and never
  holds a secret (a token, a key, a password): it is refused. No secrets
  cross between runners; a session reads its own runner's.
- On another runner you reach only the boards its owner gave you Shell on
  (all of them on your own runners).
- Every start, message and end is in the runner's audit log under your
  session's id; a message or start to another runner is in both runners'.

## Working with them

- Ask before starting a session the user did not ask for, and say what it
  will do. Link it to the card it works on (`cardId`).
- A new session needs a while to start: poll `list_sessions` or
  `read_session` instead of messaging it at once.
- Do not wait in a tight loop. Check back after a minute or two, or use
  `read_session { wait: 600 }` to wait for its answer in one call.
- To hand work to another machine ("open a Tart VM, run X, report back"):
  `list_runners`, `start_session { runner, board, mode: "chat", message }`,
  then `read_session { runner, board, session, wait: 600 }` for the result.
