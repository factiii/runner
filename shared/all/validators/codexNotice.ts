// The one-time notice before someone's first headless Codex run on a runner
// (.specs/codex-permissions.md "The new-user notice"; Jon 2026-11-11, q43).
// Card AI, board chat, releases and skill runs on Codex run with no sandbox
// and no approval prompts, for members as well as the owner, and every
// person is told so once, per runner, before the first such run. The runner holds who has
// seen it and refuses the run until they have; the app asks, records the
// answer, and starts the run again.

/** The actions whose Codex run the runner holds for the notice (engine.ts
 *  `codexNoticeNeeded`): card AI, board chat (`ask`), a release and a skill
 *  run, and a session's chat turn on a board set to Full access. The app
 *  starts only these again after the person continues. */
export const CODEX_NOTICE_ACTIONS: ReadonlySet<string> = new Set([
  'cardExecute',
  'ask',
  'deployRunStart',
  'skillRunStart',
  'bareChatSend'
]);

export const CODEX_NOTICE_TITLE = 'Codex runs without a sandbox here';

/** Plain text: what Codex does on this runner, before the person's first
 *  run of it. */
export const CODEX_NOTICE_MESSAGE =
  "Codex runs without a sandbox or approval prompts on this runner. Card AI, board chat, releases and skill runs on Codex (and a session's chat, on a board set to Full access) can run any command as this computer's user, like Claude in a terminal. Secrets still go through the runner's job gate. This shows once.";

export const CODEX_NOTICE_CONTINUE = 'Continue';

/** The runner's refusal of a Codex run for someone who has not seen the
 *  notice. One string the app matches (`isCodexNoticeRequired`), as
 *  `VAULT_OLLAMA_ONLY` is; an app too old to ask shows it as it is. */
export const CODEX_NOTICE_REQUIRED =
  'Codex runs without a sandbox or approval prompts on this runner. Continue past that notice once in the Factiii app (update the app if it does not ask), then start again.';

/** What a Cancel on the notice leaves the run with. */
export const CODEX_NOTICE_CANCELLED =
  'Codex did not start: on this runner it runs only after you continue past its notice.';

/** Is this error the runner holding a run for the notice? */
export const isCodexNoticeRequired = (
  message: string | null | undefined
): boolean => message?.startsWith(CODEX_NOTICE_REQUIRED) ?? false;
