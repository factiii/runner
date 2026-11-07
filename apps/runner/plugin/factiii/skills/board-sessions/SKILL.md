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

Every other session on the boards you can use on this runner:

- `list_sessions { board? }`: board, runner, id, title, state (starting,
  working, idle, needs you, error), mode (Chat or Code), linked card,
  worktree, and which session started it if an agent did.
- `start_session { mode, message, board?, title?, cardId?, baseBranch? }`:
  `code` gets its own worktree and branch named after `title` (required);
  `chat` runs in the board's workspace. `message` is its task; it goes in once
  the workspace is ready. Returns the new id.
- `message_session { session, text, board? }`: its next chat message.
- `read_session { session, board?, limit? }`: its recent transcript and, for
  Code, branch, dirty files, ahead/behind and unpushed commits.
- `end_session { session, board?, discard?, deleteBranch? }`: stops it and
  removes its worktree. The branch is kept unless `deleteBranch: true`.

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
- Only this runner's sessions: another runner's are not listed or reachable.
- Every start, message and end is in the runner's audit log under your
  session's id.

## Working with them

- Ask before starting a session the user did not ask for, and say what it
  will do. Link it to the card it works on (`cardId`).
- A new session needs a while to start: poll `list_sessions` or
  `read_session` instead of messaging it at once.
- Do not wait in a tight loop. Check back after a minute or two.
