// The runner's Git connections (.specs/runner-setup.md "Git connections"):
// GitHub accounts held once at the runner root, each with the git identity
// its commits carry. A board holds no token of its own any more, only which
// connection it uses (CardAIConfig.gitConnectionId) and which repository.
//
// Pure: the store's shape, how a board's settings resolve against it, and
// the one-time move of every board's own token into it. The runner keeps
// the store sealed beside the boards (apps/runner/src/gitConnections.ts);
// git-connections.test.ts covers everything here.

import type {
  GitConnectionChoice,
  GitConnectionView,
  TerminalDefault
} from '../../domains/electron';
import { isGithubOAuthAppToken } from './github-auth';
import type { CardAIConfig } from './session';

export type StoredGitConnection = {
  id: string;
  label: string;
  /** The GitHub account; '' while unknown (saved offline). */
  login: string;
  token: string;
  gitName: string;
  gitEmail: string;
  source: 'oauth' | 'token';
  createdAt: number;
};

export type GitConnectionStore = {
  version: 1;
  connections: StoredGitConnection[];
};

export const EMPTY_GIT_STORE: GitConnectionStore = {
  version: 1,
  connections: []
};

/** What a token's account is, as GitHub answers it; null when it could not
 *  be asked (offline, revoked). */
export type GitIdentity = { login: string; name: string; email: string };

/** A store read off disk, whatever an older or damaged file holds. */
export function normalizeGitStore(raw: unknown): GitConnectionStore {
  const list =
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { connections?: unknown }).connections)
      ? (raw as { connections: unknown[] }).connections
      : [];
  const connections: StoredGitConnection[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Partial<StoredGitConnection>;
    if (typeof c.id !== 'string' || !c.id || typeof c.token !== 'string') {
      continue;
    }
    connections.push({
      id: c.id,
      label: typeof c.label === 'string' ? c.label : '',
      login: typeof c.login === 'string' ? c.login : '',
      token: c.token,
      gitName: typeof c.gitName === 'string' ? c.gitName : '',
      gitEmail: typeof c.gitEmail === 'string' ? c.gitEmail : '',
      source: c.source === 'oauth' ? 'oauth' : 'token',
      createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0
    });
  }
  return { version: 1, connections };
}

/** The name a connection shows: the one its owner gave it, else its
 *  account, with its email when the store holds that account twice (two
 *  identities on one account). */
export function connectionLabel(
  store: GitConnectionStore,
  c: StoredGitConnection
): string {
  if (c.label) return c.label;
  if (!c.login) return `GitHub token ····${c.token.slice(-4)}`;
  const twice = store.connections.filter((o) => o.login === c.login).length > 1;
  return twice && c.gitEmail ? `@${c.login} (${c.gitEmail})` : `@${c.login}`;
}

/**
 * A board's settings as every caller reads them: with a connection picked,
 * its token and identity; with none ('') no token at all, whatever an older
 * runner left in the board's file; not moved yet (absent), the board's own
 * fields, as before. A connection that is gone reads as none.
 */
export function resolveBoardGit(
  board: CardAIConfig,
  store: GitConnectionStore
): CardAIConfig {
  if (board.gitConnectionId === undefined) return board;
  const conn = board.gitConnectionId
    ? store.connections.find((c) => c.id === board.gitConnectionId)
    : undefined;
  return {
    ...board,
    githubToken: conn?.token ?? '',
    gitName: conn?.gitName ?? '',
    gitEmail: conn?.gitEmail ?? ''
  };
}

export function connectionChoices(
  store: GitConnectionStore
): GitConnectionChoice[] {
  return store.connections.map((c) => ({
    id: c.id,
    label: connectionLabel(store, c),
    login: c.login
  }));
}

export function connectionViews(
  store: GitConnectionStore,
  boards: Record<string, Pick<CardAIConfig, 'gitConnectionId'>>
): GitConnectionView[] {
  return store.connections.map((c) => ({
    id: c.id,
    label: connectionLabel(store, c),
    login: c.login,
    gitName: c.gitName,
    gitEmail: c.gitEmail,
    tokenHint: c.token ? `····${c.token.slice(-4)}` : '',
    source: c.source,
    boards: Object.entries(boards)
      .filter(([, b]) => b.gitConnectionId === c.id)
      .map(([slug]) => slug)
      .sort(),
    createdAt: c.createdAt
  }));
}

/**
 * Add a token to the store, or find where it already is. One account is one
 * connection: the same token, or (when its account is known) the same
 * account with the same identity, is the connection already there. A new
 * token for an account already held replaces that connection's token (a
 * fresh sign-in), unless `keepToken` (the move of old boards, where the
 * connection's own token is the one to keep).
 *
 * Returns the new store and the connection's id. The store passed in is not
 * changed.
 */
export function upsertGitConnection(
  store: GitConnectionStore,
  input: {
    token: string;
    identity: GitIdentity | null;
    gitName?: string;
    gitEmail?: string;
    keepToken?: boolean;
  },
  make: { newId: () => string; now: number }
): { store: GitConnectionStore; id: string; created: boolean } {
  const token = input.token.replace(/\s/g, '');
  const login = input.identity?.login ?? '';
  const gitName = input.gitName || input.identity?.name || '';
  const gitEmail = input.gitEmail || input.identity?.email || '';

  const byToken = store.connections.find((c) => c.token === token);
  if (byToken) {
    // Learnt the account it belongs to since it was saved offline.
    if (login && !byToken.login) {
      return {
        store: replace(store, { ...byToken, login }),
        id: byToken.id,
        created: false
      };
    }
    return { store, id: byToken.id, created: false };
  }

  const byAccount = login
    ? store.connections.find(
        (c) => c.login === login && sameIdentity(c, { gitName, gitEmail })
      )
    : undefined;
  if (byAccount) {
    if (input.keepToken) return { store, id: byAccount.id, created: false };
    return {
      store: replace(store, {
        ...byAccount,
        token,
        source: isGithubOAuthAppToken(token) ? 'oauth' : 'token'
      }),
      id: byAccount.id,
      created: false
    };
  }

  const id = make.newId();
  const conn: StoredGitConnection = {
    id,
    // Named by its account until its owner names it (connectionLabel).
    label: '',
    login,
    token,
    gitName,
    gitEmail,
    source: isGithubOAuthAppToken(token) ? 'oauth' : 'token',
    createdAt: make.now
  };
  return {
    store: { version: 1, connections: [...store.connections, conn] },
    id,
    created: true
  };
}

/** Empty on either side matches: an identity not set is not a different
 *  one. */
function sameIdentity(
  a: { gitName: string; gitEmail: string },
  b: { gitName: string; gitEmail: string }
): boolean {
  const eq = (x: string, y: string) => !x || !y || x === y;
  return (
    eq(a.gitName, b.gitName) &&
    eq(a.gitEmail.toLowerCase(), b.gitEmail.toLowerCase())
  );
}

function replace(
  store: GitConnectionStore,
  conn: StoredGitConnection
): GitConnectionStore {
  return {
    version: 1,
    connections: store.connections.map((c) => (c.id === conn.id ? conn : c))
  };
}

/**
 * The move to root connections, for every board not moved yet (no
 * gitConnectionId): a board with a token of its own is pointed at the
 * connection for that token's account, created when there is none; one
 * without a token is left as it is (nothing to move, and a token saved
 * later by an older client is moved then).
 *
 * This plan changes no board's fields: they are deleted afterwards, and
 * only once the connection is verified as the same account
 * (planOwnGitCleanup).
 * Idempotent: a moved board is skipped, and a token already held is found
 * by its value, so a second run changes nothing.
 *
 * `identities` is GitHub's answer per token, asked beforehand (an answer is
 * a network call; this stays pure). A token GitHub did not answer for still
 * moves, as a connection of its own with no account, which a later run
 * merges when GitHub answers.
 */
export function planGitMigration(
  boards: Record<string, CardAIConfig>,
  store: GitConnectionStore,
  identities: Record<string, GitIdentity | null>,
  make: { newId: () => string; now: number }
): {
  store: GitConnectionStore;
  /** The boards to point at a connection, by slug. */
  moved: Record<string, string>;
} {
  let next = store;
  const moved: Record<string, string> = {};
  // Sorted, so which board's identity names a shared connection does not
  // depend on directory order.
  for (const slug of Object.keys(boards).sort()) {
    const board = boards[slug]!;
    if (board.gitConnectionId !== undefined) continue;
    const token = board.githubToken?.replace(/\s/g, '') ?? '';
    if (!token) continue;
    const res = upsertGitConnection(
      next,
      {
        token,
        identity: identities[token] ?? null,
        gitName: board.gitName,
        gitEmail: board.gitEmail,
        keepToken: true
      },
      make
    );
    next = res.store;
    moved[slug] = res.id;
  }
  return { store: next, moved };
}

/**
 * Connections saved before their account was known, merged into the
 * connection for the same account and identity once it is: the boards on
 * the duplicate move to the one kept, and the duplicate goes. The kept one
 * is the oldest. Returns the boards to repoint (slug to id).
 */
export function mergeDuplicateConnections(
  store: GitConnectionStore,
  boards: Record<string, Pick<CardAIConfig, 'gitConnectionId'>>
): { store: GitConnectionStore; repoint: Record<string, string> } {
  const kept: StoredGitConnection[] = [];
  const dropped = new Map<string, string>();
  const byAge = [...store.connections].sort(
    (a, b) => a.createdAt - b.createdAt
  );
  for (const c of byAge) {
    const twin = c.login
      ? kept.find((k) => k.login === c.login && sameIdentity(k, c))
      : undefined;
    if (twin) dropped.set(c.id, twin.id);
    else kept.push(c);
  }
  if (!dropped.size) return { store, repoint: {} };
  const repoint: Record<string, string> = {};
  for (const [slug, b] of Object.entries(boards)) {
    const to = b.gitConnectionId ? dropped.get(b.gitConnectionId) : undefined;
    if (to) repoint[slug] = to;
  }
  return {
    store: {
      version: 1,
      connections: store.connections.filter((c) => !dropped.has(c.id))
    },
    repoint
  };
}

/**
 * The boards whose old per-board GitHub fields (githubToken, gitName,
 * gitEmail) can go from their own file, so no stale token stays on disk
 * (Jon, 2026-11-09). Only a board that points at a VERIFIED connection (its
 * account known, a token held) whose account is the old token's own: the
 * same token by value, or GitHub said the old token is that account. An old
 * token GitHub did not answer for (offline, revoked) is kept until it does.
 * A board with no old token and only an old name or email left goes too.
 *
 * Idempotent: a cleaned board has nothing left to clean. The cost: an older
 * runner put back on the machine finds no token and needs GitHub
 * reconnected (.specs/runner-setup.md "Git connections").
 */
export function planOwnGitCleanup(
  boards: Record<string, CardAIConfig>,
  store: GitConnectionStore,
  identities: Record<string, GitIdentity | null>
): string[] {
  const out: string[] = [];
  for (const slug of Object.keys(boards).sort()) {
    const board = boards[slug]!;
    if (!board.gitConnectionId) continue;
    const own = board.githubToken?.replace(/\s/g, '') ?? '';
    if (!own && !board.gitName && !board.gitEmail) continue;
    const conn = store.connections.find((c) => c.id === board.gitConnectionId);
    if (!conn || !conn.login || !conn.token) continue;
    if (own && own !== conn.token) {
      const login = identities[own]?.login ?? '';
      if (login.toLowerCase() !== conn.login.toLowerCase()) continue;
    }
    out.push(slug);
  }
  return out;
}

/** The old tokens planOwnGitCleanup needs GitHub's answer for: a moved
 *  board's own token that is not its connection's by value. */
export function ownTokensToVerify(
  boards: Record<string, CardAIConfig>,
  store: GitConnectionStore
): string[] {
  const out = new Set<string>();
  for (const board of Object.values(boards)) {
    if (!board.gitConnectionId) continue;
    const own = board.githubToken?.replace(/\s/g, '') ?? '';
    const conn = store.connections.find((c) => c.id === board.gitConnectionId);
    if (own && conn && own !== conn.token) out.add(own);
  }
  return [...out];
}

// ── New terminals ──

/** A board's own command is one line a person typed in its settings. */
export const TERMINAL_COMMAND_MAX = 500;

/** A board that never picked what its new terminals start gets Claude Code
 *  (Jon, 2026-11-09); so does a value this runner does not know. */
export function resolveTerminalDefault(value: unknown): TerminalDefault {
  return value === 'claude' ||
    value === 'codex' ||
    value === 'command' ||
    value === 'shell'
    ? value
    : 'claude';
}

/** A custom command as saved: one line, trimmed, within the limit. Throws
 *  for one that is not. */
export function cleanTerminalCommand(raw: string): string {
  const command = raw.trim();
  if (/[\r\n\0]/.test(command)) {
    throw new Error('The command for new terminals must be one line.');
  }
  if (command.length > TERMINAL_COMMAND_MAX) {
    throw new Error(
      `The command for new terminals is limited to ${TERMINAL_COMMAND_MAX} characters.`
    );
  }
  return command;
}

/**
 * What a new terminal's first tab runs before its shell, by the board's
 * default, or null for a plain shell. A command with no text is a shell.
 * The custom command runs as typed: whoever may change it may already type
 * anything into a terminal on the board.
 */
export function terminalBootCommand(
  config: Pick<CardAIConfig, 'terminalDefault' | 'terminalCommand'>,
  launch: { claude: string; codex: string }
): string | null {
  switch (resolveTerminalDefault(config.terminalDefault)) {
    case 'claude':
      return launch.claude;
    case 'codex':
      return launch.codex;
    case 'command':
      return config.terminalCommand?.trim() || null;
    default:
      return null;
  }
}
