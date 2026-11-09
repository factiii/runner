import {
  type BoardAgentAction,
  RUNNER_ACCESS_LEVELS,
  type RunnerAccessLevel,
  type RunnerGrants,
  type RunnerDangerousGrants
} from '../../domains/electron';

// What a data channel may do on this runner (.specs/runner-member-access.md).
// The daemon asks here for every message; the rule lives in
// shared code so it can be tested without a peer connection.
//
// The owner gives each board member one level, per board. Each level
// includes the ones before it:
//
// - none: nothing. This is every member until the owner says otherwise.
// - api: list and call jobs, read their job logs, answer or lock the secrets
//   gate and submit an encrypted secret update - over the data channel and
//   through the server (CLI, app). No shell.
// - terminals: also terminals, card AI sessions and file writes. A terminal
//   or a card AI session is a shell as the runner user, and inside an unlock
//   window that user can reach the process holding the key.
// - screens: also the iOS Simulator's picture and input. (It once also gave
//   the runner's desktop view, removed 2026-10-25.)
//
// Beside the level, the owner may give a member one permission: Dangerous
// jobs. A job that jobs.json marks `dangerous` runs at once for a member
// with it; a member at API without it waits for the runner owner to approve
// that one call (owner-approval.ts). It is off for every member until the
// owner turns it on, and the owner never needs it.
//
// The levels live on the runner (access.json) and are enforced here, in the
// runner, because the data channel reaches the runner directly; the UI hiding
// a button proves nothing. The server only says who is connecting and which
// boards they belong to, so nothing it sends can raise a level.

/** What a channel has on one board: the owner, or a member's level there. */
export type ChannelLevel = 'owner' | RunnerAccessLevel;

/** A level off the wire or off disk. Anything that is not a level is none. */
export function parseAccessLevel(raw: unknown): RunnerAccessLevel {
  return RUNNER_ACCESS_LEVELS.find((level) => level === raw) ?? 'none';
}

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

/**
 * Parse a stored `access.json`, or the grants a runner reports. The only
 * shape that grants anything is `{ grants: { <board>: { <userId>: level } } }`.
 * Everything else reads as no grants, never as an error and never as access:
 * the two switches an older runner stored (`{ apiAccess, shareTerminals }`),
 * a level this build does not know, a user id that is empty.
 */
export function parseRunnerGrants(raw: unknown): RunnerGrants {
  if (!isRecord(raw) || !isRecord(raw.grants)) return {};
  const boards: [string, Record<string, RunnerAccessLevel>][] = [];
  for (const [spaceSlug, users] of Object.entries(raw.grants)) {
    if (spaceSlug === '' || !isRecord(users)) continue;
    const levels: [string, RunnerAccessLevel][] = [];
    for (const [userId, level] of Object.entries(users)) {
      const parsed = parseAccessLevel(level);
      if (userId !== '' && parsed !== 'none') levels.push([userId, parsed]);
    }
    // fromEntries defines own properties, so a board or a user called
    // "__proto__" is a key like any other.
    if (levels.length > 0) boards.push([spaceSlug, Object.fromEntries(levels)]);
  }
  return Object.fromEntries(boards);
}

/** The accounts a runner reports as let into its Vault, off
 *  `runner:access-state` (`{ grants, vault: [userId] }`). Anything malformed is
 *  nobody, as with the grants; a runner from before the Vault sends none. */
export function parseRunnerVaultMembers(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw.vault)) return [];
  return [
    ...new Set(
      raw.vault.filter(
        (id): id is string => typeof id === 'string' && /^\d{1,12}$/.test(id)
      )
    )
  ];
}

/** The level the owner gave `userId` on `spaceSlug`. None when the board or
 *  the user is not listed, and for a user with no id. */
export function grantedLevel(
  grants: RunnerGrants,
  spaceSlug: string,
  userId: string
): RunnerAccessLevel {
  if (!userId || !spaceSlug || !Object.hasOwn(grants, spaceSlug)) return 'none';
  const users = grants[spaceSlug];
  return Object.hasOwn(users, userId)
    ? parseAccessLevel(users[userId])
    : 'none';
}

/** The boards on which the owner gave `userId` a level, by the grants alone.
 *  Whether the user still belongs to each board is the server's to check. */
export function boardsGrantedTo(
  grants: RunnerGrants,
  userId: string
): string[] {
  return Object.keys(grants).filter(
    (spaceSlug) => grantedLevel(grants, spaceSlug, userId) !== 'none'
  );
}

/** `grants` with one member moved on one board. None removes the entry. */
export function withGrant(
  grants: RunnerGrants,
  spaceSlug: string,
  userId: string,
  level: RunnerAccessLevel
): RunnerGrants {
  const users = Object.entries(
    Object.hasOwn(grants, spaceSlug) ? grants[spaceSlug] : {}
  ).filter(([id]) => id !== userId);
  if (level !== 'none') users.push([userId, level]);
  const boards = Object.entries(grants).filter(([slug]) => slug !== spaceSlug);
  if (users.length > 0) boards.push([spaceSlug, Object.fromEntries(users)]);
  return Object.fromEntries(boards);
}

/**
 * Parse the Dangerous jobs permission off a stored `access.json`, or off what
 * a runner reports: `{ dangerous: { <board>: [userId, ...] } }`. Null when there is
 * no `dangerous` field at all (a file or a runner from before the permission), so
 * the server can tell "nobody has it" from "this runner does not say". Every
 * malformed part is dropped, never read as the permission.
 */
export function parseRunnerDangerousGrants(
  raw: unknown
): RunnerDangerousGrants | null {
  if (!isRecord(raw) || !Object.hasOwn(raw, 'dangerous')) return null;
  if (!isRecord(raw.dangerous)) return {};
  const boards: [string, string[]][] = [];
  for (const [spaceSlug, users] of Object.entries(raw.dangerous)) {
    if (spaceSlug === '' || !Array.isArray(users)) continue;
    const ids = [
      ...new Set(
        users.filter((id): id is string => typeof id === 'string' && id !== '')
      )
    ];
    if (ids.length > 0) boards.push([spaceSlug, ids]);
  }
  return Object.fromEntries(boards);
}

/** Whether the owner let `userId` run dangerous jobs on `spaceSlug` without
 *  asking. Only with the API level there too: a member whose level was taken
 *  away keeps nothing, whatever is left in the list. */
export function dangerousGranted(
  grants: RunnerGrants,
  dangerous: RunnerDangerousGrants | null | undefined,
  spaceSlug: string,
  userId: string
): boolean {
  if (
    !dangerous ||
    !userId ||
    !spaceSlug ||
    !Object.hasOwn(dangerous, spaceSlug)
  ) {
    return false;
  }
  return (
    dangerous[spaceSlug].includes(userId) &&
    levelAtLeast(grantedLevel(grants, spaceSlug, userId), 'api')
  );
}

/** `dangerous` with one member's permission on one board turned on or off. */
export function withDangerousGrant(
  dangerous: RunnerDangerousGrants,
  spaceSlug: string,
  userId: string,
  allowed: boolean
): RunnerDangerousGrants {
  const users = (
    Object.hasOwn(dangerous, spaceSlug) ? dangerous[spaceSlug] : []
  ).filter((id) => id !== userId);
  if (allowed) users.push(userId);
  const boards = Object.entries(dangerous).filter(
    ([slug]) => slug !== spaceSlug
  );
  if (users.length > 0) boards.push([spaceSlug, users]);
  return Object.fromEntries(boards);
}

/** Whether `level` reaches `needed`. An unknown level reaches nothing. */
export function levelAtLeast(
  level: ChannelLevel,
  needed: RunnerAccessLevel
): boolean {
  if (level === 'owner') return true;
  const have = RUNNER_ACCESS_LEVELS.indexOf(level);
  return have >= 0 && have >= RUNNER_ACCESS_LEVELS.indexOf(needed);
}

/** Reads of the board, open from the API level up. None of these returns a
 *  credential (getConfig reports only whether each connection exists). */
const MEMBER_READ_ACTIONS: ReadonlySet<BoardAgentAction> =
  new Set<BoardAgentAction>([
    'getConfig',
    'boardSession',
    'boardSessions',
    'cardSessions',
    'cardSession',
    'setupStatus',
    'environmentStatus',
    'deployStatus',
    'deployRunState',
    'deploySecretsStatus'
  ]);

/** Jobs and the encrypted secret inbox: the API level. */
const MEMBER_API_ACTIONS: ReadonlySet<BoardAgentAction> =
  new Set<BoardAgentAction>([
    // Jobs: by name, never a command.
    'jobsList',
    'jobsCall',
    'jobStatus',
    // A member's own calls only: the engine filters jobsActive and checks
    // jobCancel against who started the call.
    'jobsActive',
    'jobCancel',
    // Encrypted updates: listing shows names only, approving needs the password.
    'secretsInboxList',
    'secretsInboxAnswer'
  ]);

/** The secrets gate. Answering needs the password, and locking only takes
 *  access away. A job opens the gate, so the API level allows it. */
const MEMBER_GATE_ACTIONS: ReadonlySet<BoardAgentAction> =
  new Set<BoardAgentAction>([
    'secretsAuthState',
    'secretsAuthAnswer',
    'secretsLock'
  ]);

/** The simulator: the Screens level. */
const SCREEN_ACTIONS: ReadonlySet<BoardAgentAction> = new Set<BoardAgentAction>(
  [
    'simulatorList',
    'simulatorStatus',
    'simulatorAttach',
    'simulatorDetach',
    'simulatorInput'
  ]
);

/** Owner-only on every runner, whatever the level: each one reaches past a
 *  board - the audit log names every member, the levels decide what members
 *  may do, and the password guards every space's key. */
export const OWNER_ONLY_ACTIONS: ReadonlySet<BoardAgentAction> =
  new Set<BoardAgentAction>([
    'auditRead',
    'auditClear',
    // The machine's sleep: runner-wide, so the owner's (daemon.ts).
    'keepAwakeSet',
    'runnerAccessSet',
    // A member's dangerous job call waits on the runner owner, and only the
    // owner sees or answers it (owner-approval.ts). The engine checks the
    // actor's id against the owner's too. The relay may carry both: neither
    // holds a password or a value.
    'dangerousApprovalState',
    'dangerousApprovalAnswer',
    // What needs the owner on this runner (the attention badge). Owner only:
    // it names missing keys. The relay may carry it: it returns names and
    // booleans, never a password or a value.
    'attention',
    // The runner's always-on service is the machine's, not a board's: it
    // writes a login item for the runner user. Names and booleans; the relay
    // may carry it.
    'serviceStatus',
    'serviceInstall',
    'serviceRemove',
    // The runner's parts install and remove software on the machine, for
    // every board at once. Names and booleans; the relay may carry them.
    'partsList',
    'partsAct',
    // Who is linked to the runner, terminals other people started, the
    // machine's services and public links (.specs/runner-window.md "Remote
    // connections"): it names every member and board, so the owner's alone,
    // runner-wide. Names, ports and counts; the relay may carry it.
    'runnerConnections',
    // A service's, the embedder's or a terminal tab's last lines. Raw output
    // can hold a secret, but a terminal's output already rides the relay
    // (rawUseAllowed, and the refusal's own "terminals still work here"),
    // and the owner could print the same log in one, so the relay may carry
    // it too.
    'runnerLogs',
    // An extra of the environment (redis, OrbStack, …): software on the
    // machine, like a part. A password it needs travels by setupAuthorize.
    'environmentInstall',
    // Free up space deletes what the runner made on the machine. A dry run
    // lists names and sizes; a run is refused on the relay
    // (relaySecretsRefusal).
    'machineCleanup',
    // Nuke erases the whole runner (nuke.ts): the owner's alone, by id too
    // (runnerNuke.ts nukeRefusal), and never on the relay.
    'runnerNuke',
    'secretsChangePassword',
    'secretsExportBackup',
    'secretsOpenBackup',
    'secretsImportBackupPlan',
    'secretsImportBackupApply',
    'deploySecretsSetFile',
    'deploySecretsUnsetFile',
    'secretFileEnvKeys',
    'secretFileEnvSet',
    'secretFileEnvUnset',
    // The owner's phone vault, held runner-wide (.specs/mobile-vault.md "Runner backup").
    // It belongs to no board, so no board's members may write, list, read or
    // delete one, whatever their level. The relay may carry it: it is the same
    // package the cloud backup already uploads (ciphertext plus the
    // passphrase-wrapped key), and the passphrase never travels with it.
    'vaultBackupWrite',
    'vaultBackupList',
    'vaultBackupReadChunk',
    'vaultBackupDelete',
    // The Vault's members are the owner's to choose (vault/access.ts).
    'vaultShareSet',
    // Oakbox > Account > Backend's models (LOCAL_AI_ACTIONS): answered before
    // any board, owner only there too.
    'localAiList',
    'localAiAct',
    'localAiSearch',
    // Factiii's AI features on the runner (RUNNER_AI_ACTIONS): the owner's
    // CLIs and models, and their subscription, answer it.
    'aiPrompt',
    // Whether the runner's Claude and Codex are signed in, for Oakbox's
    // sign-ins with no board (RUNNER_SIGNIN_ACTIONS). Only ever runner-wide.
    'cliSignins',
    // The runner's Git connections (Status > Git): its owner's GitHub
    // accounts, which every board picks from. Runner-wide. A list carries no
    // token; a pasted one is refused on the relay (relaySecretsRefusal).
    'gitConnections',
    'gitConnectionAct',
    // Categorize on the runner (VAULT_ACTIONS): its run spends the owner's
    // machine and, with Claude or Codex, their sign-in. The Vault refuses a
    // member too (vault/access.ts).
    'vaultCategorizeStatus',
    'vaultCategorizeStart',
    'vaultCategorizeCancel',
    // A runner file's page and the notes kept from runner Ask answers
    // (VAULT_ACTIONS): the owner's reading of their own Vault. The Vault
    // refuses a member too (vault/access.ts).
    'vaultFilePost',
    'vaultNotes',
    'vaultNoteDelete',
    // Move to…: files from one of the runner's stores to the other
    // (VAULT_ACTIONS), which decides what AI may read them.
    'vaultMove'
  ]);

/** The runner's Vault (.specs/runner-vault.md "Actions"). The daemon answers
 *  these before any board, for the owner and the vault members the owner let
 *  in, and never on a relayed link: vault files travel device to runner only. */
export const VAULT_ACTIONS: ReadonlySet<BoardAgentAction> =
  new Set<BoardAgentAction>([
    'vaultStatus',
    // The shared vault router (.specs/vault-router.md → Transports): its
    // procedures, one action, the same members and the same refusal.
    'vaultRpc',
    // The same four as vaultRpc's, which is what every client calls today.
    'vaultFiles',
    'vaultSearch',
    'vaultUploadStart',
    'vaultWrite',
    'vaultDownload',
    'vaultRead',
    'vaultDelete',
    'vaultShareSet',
    // Oakbox Ask with the runner's own model reads the Vault, so it is a
    // Vault action: members per access.ts, never on the relay.
    'vaultAskModels',
    'vaultAsk',
    'vaultAskPoll',
    'vaultAskCancel',
    // Its chats live in the Vault's database, on the runner only.
    'vaultChats',
    'vaultChat',
    'vaultChatDelete',
    // Categorize reads every file and writes its tags in the Vault's
    // database: never on the relay. The owner's alone (OWNER_ONLY_ACTIONS).
    'vaultCategorizeStatus',
    'vaultCategorizeStart',
    'vaultCategorizeCancel',
    // A file's text and tags, and the notes kept in the Vault's database:
    // never on the relay. The owner's alone (OWNER_ONLY_ACTIONS).
    'vaultFilePost',
    'vaultNotes',
    'vaultNoteDelete',
    // Move to… between the Vault and Runner Storage: a copy, then the
    // original deleted. Never on the relay. The owner's alone.
    'vaultMove'
  ]);

/** Oakbox > Account > Backend's models (.specs/runner-vault-ask.md "Oakbox's
 *  backend: setup, sign-ins, models"). The daemon answers these before any board, for the owner only:
 *  a pull fills the machine's disk and a remove deletes a model every board's
 *  Ask may be using, and a search is what picks the pull. Never on a relayed
 *  link, like the Vault they serve. */
export const LOCAL_AI_ACTIONS: ReadonlySet<BoardAgentAction> =
  new Set<BoardAgentAction>(['localAiList', 'localAiAct', 'localAiSearch']);

/** Factiii's AI features run on the owner's runner (.specs/oakbox.md
 *  "Backend" → AI features): a recording's title, and the like. The daemon
 *  answers them before any board, for the owner only, on their own Claude,
 *  Codex or Ollama. Never on a relayed link: the prompt is the person's words,
 *  and running it on the runner is the point of not sending it to Factiii. */
export const RUNNER_AI_ACTIONS: ReadonlySet<BoardAgentAction> =
  new Set<BoardAgentAction>(['aiPrompt']);

/** Claude's and Codex's sign-ins (.specs/runner-vault-ask.md "Oakbox's backend: setup, sign-ins, models").
 *  With a board they are that board's engine's, as factiii.com sends them.
 *  With none (an empty spaceSlug) the daemon answers them runner-wide, for
 *  Oakbox: owner only, and never on a relayed link, since Claude's carries
 *  the code that signs the machine in. Both write the runner's one pair of
 *  CLI homes (agent-homes.ts). */
export const RUNNER_SIGNIN_ACTIONS: ReadonlySet<BoardAgentAction> =
  new Set<BoardAgentAction>([
    'cliSignins',
    'claudeLoginStart',
    'claudeLoginCode',
    'claudeLoginCancel',
    'claudeLogout',
    'codexLoginStart',
    'codexLoginCancel',
    'codexLogout'
  ]);

/** The lowest level that may run `action`, or 'owner' for the owner's own. */
function levelNeeded(action: BoardAgentAction): ChannelLevel {
  if (OWNER_ONLY_ACTIONS.has(action)) return 'owner';
  // A member's app asks for its own level to know what to hide, and a member
  // whose level was just taken away must be able to learn that.
  if (action === 'runnerAccessGet') return 'none';
  if (SCREEN_ACTIONS.has(action)) return 'screens';
  if (
    MEMBER_READ_ACTIONS.has(action) ||
    MEMBER_GATE_ACTIONS.has(action) ||
    MEMBER_API_ACTIONS.has(action)
  ) {
    return 'api';
  }
  // Everything else is a shell, a card AI session, a file write or a setting
  // of the board.
  return 'terminals';
}

/** Whether a channel at `level` on a board may run `action` there. */
export function actionAllowed(
  level: ChannelLevel,
  action: BoardAgentAction
): boolean {
  if (level === 'owner') return true;
  const needed = levelNeeded(action);
  return needed !== 'owner' && levelAtLeast(level, needed);
}

/** What the server vouched for on one link, once checked. */
export type VouchedScope =
  | { role: 'owner'; userId: string; name: string }
  | {
      role: 'member';
      spaceSlugs: string[];
      userId: string;
      name: string;
      /** The server found them in the runner owner's shared vault, and the
       *  runner reported them as let into its Vault. Both halves are checked
       *  again on the runner (apps/runner/src/vault/access.ts). */
      vault?: boolean;
    };

/** The scope a link arrived with, or null when it is missing or not one the
 *  runner can act on. A link with no scope used to be served as the owner (the
 *  pre-sharing path, when only the owner could connect), which let any server
 *  that left it out hand every peer full control. The runner serves nothing
 *  on a link it has no answer for. Only who and which boards are read: a
 *  level the server adds to a scope is never looked at. */
export function parseVouchedScope(raw: unknown): VouchedScope | null {
  if (!raw || typeof raw !== 'object') return null;
  const scope = raw as Record<string, unknown>;
  const userId = typeof scope.userId === 'string' ? scope.userId : '';
  const name = typeof scope.name === 'string' ? scope.name : '';
  if (scope.role === 'owner') return { role: 'owner', userId, name };
  if (scope.role !== 'member' || !Array.isArray(scope.spaceSlugs)) return null;
  const spaceSlugs = scope.spaceSlugs.filter(
    (slug): slug is string => typeof slug === 'string'
  );
  // A vault-only member names no board: they come for the Vault alone.
  return {
    role: 'member',
    spaceSlugs,
    userId,
    name,
    vault: scope.vault === true
  };
}

/**
 * What the channel behind `scope` has on `spaceSlug`. A member needs both
 * halves: the server says they belong to the board, and the owner gave them a
 * level there. The server's half can only take access away.
 */
export function channelLevel(
  scope: VouchedScope,
  grants: RunnerGrants,
  spaceSlug: unknown
): ChannelLevel {
  if (scope.role === 'owner') return 'owner';
  if (typeof spaceSlug !== 'string' || !scope.spaceSlugs.includes(spaceSlug)) {
    return 'none';
  }
  return grantedLevel(grants, spaceSlug, scope.userId);
}

/** Channel traffic that is not an action: a terminal's keystrokes, the
 *  self-update control, and the video track (the simulator). A terminal is a
 *  shell, so it needs the Terminals level; the video needs Screens. The self-update restarts the
 *  runner (and every job, window and session on it) on a new version, so it
 *  is the owner's alone, whatever the level. */
export type RawChannelUse = 'terminal' | 'runner-control' | 'video';

export function rawUseAllowed(
  level: ChannelLevel,
  use: RawChannelUse
): boolean {
  if (level === 'owner') return true;
  if (use === 'runner-control') return false;
  return levelAtLeast(level, use === 'video' ? 'screens' : 'terminals');
}

const LEVEL_NAMES: Record<RunnerAccessLevel, string> = {
  none: 'None',
  api: 'API',
  terminals: 'Terminals',
  screens: 'Screens'
};

/** The refusal a member sees. Names the level the action needs, so nobody
 *  hunts for a bug. */
export function refusal(action: BoardAgentAction): string {
  const needed = levelNeeded(action);
  return needed === 'owner'
    ? `Only the owner of this runner can do "${action}".`
    : `"${action}" needs the ${LEVEL_NAMES[needed]} level on this runner. Its owner sets your level in Runner Settings.`;
}

// ── The transport a channel rides, and what a relayed one may not carry ──

/** How a client link reaches the runner: a WebRTC data channel the server
 *  never sees inside, or frames relayed through the server's socket. The
 *  client picks the relay on its own once every WebRTC path fails, so the
 *  user may not know which one they are on. */
export type ChannelTransport = 'webrtc' | 'socket';

/** The code on a refusal from `relaySecretsRefusal`, and the first word of
 *  its message, so a client can tell it from any other error string. */
export const RELAY_REFUSES_SECRETS = 'RELAY_REFUSES_SECRETS';

export const RELAY_SECRETS_REFUSAL = `${RELAY_REFUSES_SECRETS}: this link is relayed through Factiii’s server, which could read what it carries. A password or a secret value only travels on a direct WebRTC link. Jobs, terminals and reads still work here.`;

export const RELAY_VAULT_REFUSAL = `${RELAY_REFUSES_SECRETS}: this link is relayed through Factiii’s server, which could read what it carries. Vault files only travel on a direct link to your runner.`;

export const RELAY_LOCAL_AI_REFUSAL = `${RELAY_REFUSES_SECRETS}: this link is relayed through Factiii’s server. Models are managed only on a direct link to your runner.`;

export const RELAY_AI_PROMPT_REFUSAL = `${RELAY_REFUSES_SECRETS}: this link is relayed through Factiii’s server. Your runner runs AI only on a direct link, so the words never pass through Factiii.`;

export const RELAY_SIGNIN_REFUSAL = `${RELAY_REFUSES_SECRETS}: this link is relayed through Factiii’s server. Claude and Codex are signed in only on a direct link to your runner.`;

export const RELAY_CLEANUP_REFUSAL = `${RELAY_REFUSES_SECRETS}: this link is relayed through Factiii’s server. Free up space deletes files on your runner, so it only runs on a direct link.`;

export const RELAY_NUKE_REFUSAL = `${RELAY_REFUSES_SECRETS}: this link is relayed through Factiii’s server. A nuke erases everything on your runner, so it only runs on a direct link.`;

/** Actions whose payload always carries a password or a secret value in
 *  plaintext. The invariant (.specs/runner-secrets-gate.md) is that the
 *  password never passes through the server; a relayed link is the server. */
export const RELAY_REFUSED_ACTIONS: ReadonlySet<BoardAgentAction> =
  new Set<BoardAgentAction>([
    'deploySecretsInit',
    'deploySecretsList',
    'deploySecretsSet',
    'deploySecretsUnset',
    'deploySecretsSetFile',
    'deploySecretsUnsetFile',
    'secretFileEnvKeys',
    'secretFileEnvSet',
    'secretFileEnvUnset',
    'setupAuthorize',
    'secretsChangePassword',
    'secretsExportBackup',
    'secretsOpenBackup',
    'secretsImportBackupPlan',
    'secretsImportBackupApply',
    'secureUnlock'
  ]);

const nonEmptyString = (value: unknown): boolean =>
  typeof value === 'string' && value !== '';

/**
 * The refusal for `action` with `payload` on a channel of `transport`, or
 * null. A direct channel is never refused here. On the relay, every action
 * in RELAY_REFUSED_ACTIONS is, and so is one that carries a password or a
 * token only sometimes: a gate or inbox answer WITH a password (a deny
 * carries none and may pass), and setConfig WITH a GitHub token. An
 * encrypted secret update (`secret-submit`) never comes this way: it is a
 * server-relayed call that already arrives as ciphertext to the runner's key.
 * Enforced here, in the runner, because the client hiding a field proves
 * nothing.
 */
export function relaySecretsRefusal(
  transport: ChannelTransport,
  action: BoardAgentAction,
  payload: unknown
): string | null {
  if (transport !== 'socket') return null;
  if (RELAY_REFUSED_ACTIONS.has(action)) return RELAY_SECRETS_REFUSAL;
  if (VAULT_ACTIONS.has(action)) return RELAY_VAULT_REFUSAL;
  if (LOCAL_AI_ACTIONS.has(action)) return RELAY_LOCAL_AI_REFUSAL;
  if (RUNNER_AI_ACTIONS.has(action)) return RELAY_AI_PROMPT_REFUSAL;
  const p = (payload ?? {}) as Record<string, unknown>;
  if (
    (action === 'secretsAuthAnswer' || action === 'secretsInboxAnswer') &&
    nonEmptyString(p['password'])
  ) {
    return RELAY_SECRETS_REFUSAL;
  }
  if (action === 'setConfig' && nonEmptyString(p['githubToken'])) {
    return RELAY_SECRETS_REFUSAL;
  }
  if (action === 'gitConnectionAct' && p['op'] === 'addToken') {
    return RELAY_SECRETS_REFUSAL;
  }
  if (action === 'machineCleanup' && p['confirm'] === true) {
    return RELAY_CLEANUP_REFUSAL;
  }
  // Not a secret, but it erases every one, and its plan names every board:
  // a server that relays the link must never reach it, plan or run.
  if (action === 'runnerNuke') return RELAY_NUKE_REFUSAL;
  return null;
}

// ── Calls relayed by the server (no data channel) ──

/** What the server relays on a runner's socket, by the event it arrives on. */
export type RelayedCall =
  | 'job-list'
  | 'job-call'
  | 'secret-submit'
  | 'recipient-request'
  | 'audit-read';

export const NO_API_ACCESS =
  'The owner of this runner has not given you API access on this board.';

/**
 * Whether a call of `job` must wait for the runner owner's approval, by the
 * Dangerous jobs permission alone (the level is checked before this). False
 * for a job that is not marked dangerous, and for the owner, a session on
 * the runner or a member with the permission (`mayRunDangerous`). Never a
 * refusal: the call waits instead (owner-approval.ts).
 */
export function needsOwnerApproval(
  job: { dangerous?: boolean } | undefined,
  mayRunDangerous: boolean
): boolean {
  return job?.dangerous === true && !mayRunDangerous;
}

export const OWNER_ONLY =
  'Only the owner of this runner can read its audit log.';

/**
 * Whether the runner accepts a server-relayed call from `actorUserId` on
 * `spaceSlug`. The server checks too; this is the runner not relying on it
 * alone.
 *
 * - The audit log is the owner's, whatever the level.
 * - Everything else needs the API level on that board, unless the actor IS
 *   the owner.
 * - A job marked `dangerous` from a member without the Dangerous jobs
 *   permission is not refused: the job runner holds it for the owner's
 *   approval, on the definition it runs (needsOwnerApproval), whichever road
 *   the call took.
 *
 * An unknown owner id (a token that carries none) matches nobody, so the
 * check fails closed rather than open. Returns the refusal, or null.
 */
export function relayedCallRefusal(opts: {
  call: RelayedCall;
  grants: RunnerGrants;
  spaceSlug: string;
  ownerUserId: string | null;
  actorUserId: string;
}): string | null {
  const isOwner =
    opts.ownerUserId !== null &&
    opts.ownerUserId !== '' &&
    String(opts.actorUserId) === opts.ownerUserId;
  if (opts.call === 'audit-read') return isOwner ? null : OWNER_ONLY;
  if (isOwner) return null;
  const level = grantedLevel(opts.grants, opts.spaceSlug, opts.actorUserId);
  return levelAtLeast(level, 'api') ? null : NO_API_ACCESS;
}

/**
 * The owner's user id from the runner's own pairing token. The server signs
 * `{ type: 'runner', runnerId, userId }` (apps/server/src/routers/runners.ts)
 * with `userId` = the owner. The runner holds this token as its credential,
 * so reading its payload needs no verification: it is not a claim from a
 * caller. Null when the token is not a JWT or carries no user.
 */
export function ownerIdFromRunnerToken(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf-8')
    ) as { userId?: unknown };
    const id = json.userId;
    return typeof id === 'number' || (typeof id === 'string' && id !== '')
      ? String(id)
      : null;
  } catch {
    return null;
  }
}

/** The runner's own id from the same pairing token (`runnerId`), for the
 *  desktop app to name the runner it paired (`factiii-runner status`). Null
 *  when the token is not a JWT or carries none. */
export function runnerIdFromRunnerToken(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf-8')
    ) as { runnerId?: unknown };
    const id = Number(json.runnerId);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}
