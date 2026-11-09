import type {
  GitConnectionActPayload,
  GitConnectionSignin,
  GitConnectionsState
} from '@shared/all/domains/electron';
import {
  connectionChoices,
  connectionViews,
  EMPTY_GIT_STORE,
  type GitConnectionStore,
  type GitIdentity,
  mergeDuplicateConnections,
  normalizeGitStore,
  ownTokensToVerify,
  planGitMigration,
  planOwnGitCleanup,
  upsertGitConnection
} from '@shared/all/helpers/board-agent-core/git-connections';
import {
  fetchGithubIdentity,
  type GithubRevokeOutcome,
  isGithubOAuthAppToken,
  pollGithubDeviceCode,
  startGithubDeviceCode
} from '@shared/all/helpers/board-agent-core/github-auth';
import type { CardAIConfig } from '@shared/all/helpers/board-agent-core';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_DIR } from './paths';
import { readSecureJson, writeSecureJson } from './secureFile';

// The runner's Git connections (.specs/runner-setup.md "Git connections"):
// GitHub accounts held once, at the runner root, sealed under the machine
// keychain key like each board's own file (agent-adapter.ts). Boards point
// at one by id; agent-adapter.ts resolves a board's token and identity from
// it. The pure rules are in board-agent-core/git-connections.ts.
//
// `.creds` at the root, like a board's: credentials never sit where a skill
// or a terminal might list them.

export function gitConnectionsPath(): string {
  return path.join(CONFIG_DIR, '.creds', 'git-connections.json');
}

export function readGitStore(): GitConnectionStore {
  const file = gitConnectionsPath();
  if (!fs.existsSync(file)) return EMPTY_GIT_STORE;
  return normalizeGitStore(readSecureJson<unknown>(file));
}

export function writeGitStore(store: GitConnectionStore): void {
  fs.mkdirSync(path.dirname(gitConnectionsPath()), { recursive: true });
  writeSecureJson(gitConnectionsPath(), store);
}

export const newConnectionId = (): string =>
  `git-${crypto.randomBytes(6).toString('hex')}`;

/** What the move and the dedupe need of the boards: read each one's own
 *  file (not resolved), and point one at a connection. agent-adapter.ts
 *  passes these in, so this file never imports it. */
export type BoardFiles = {
  slugs: () => string[];
  readRaw: (slug: string) => CardAIConfig;
  setConnection: (slug: string, id: string) => void;
  /** Delete the board's old githubToken, gitName and gitEmail from its own
   *  file, only while it still points at connection `id`. */
  clearOwnGit: (slug: string, id: string) => void;
};

/** GitHub's answer for a token, or null when it could not be had. Bounded:
 *  a start with no network must not hang. */
async function identityOf(token: string): Promise<GitIdentity | null> {
  try {
    return await Promise.race([
      fetchGithubIdentity(token),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))
    ]);
  } catch {
    return null;
  }
}

/**
 * Move every board's own token into the root connections, de-duplicated by
 * account, and merge connections whose account has since become known
 * (planGitMigration, mergeDuplicateConnections). Run at every start and
 * after a token is saved: idempotent, so a run with nothing to do writes
 * nothing.
 *
 * GitHub is asked first, then everything else is synchronous - read, plan,
 * write the store, then point the boards - so nothing else in this process
 * writes in between, and a board never points at a connection not on disk.
 * Last, a board on a verified connection of its old token's own account has
 * its old githubToken, gitName and gitEmail deleted (planOwnGitCleanup), so
 * no stale token stays on disk; one GitHub could not vouch for keeps them
 * until a later start. An older runner put back then needs GitHub
 * reconnected.
 */
export async function reconcileGitConnections(
  boards: BoardFiles,
  /** GitHub's answer for a token; a test passes its own. */
  identify: (token: string) => Promise<GitIdentity | null> = identityOf
): Promise<{ moved: number; merged: number; cleaned: number }> {
  const tokens = new Set<string>();
  const firstRaws: Record<string, CardAIConfig> = {};
  for (const slug of boards.slugs()) {
    const raw = safeRead(boards, slug);
    if (raw) firstRaws[slug] = raw;
    if (raw && raw.gitConnectionId === undefined && raw.githubToken) {
      tokens.add(raw.githubToken.replace(/\s/g, ''));
    }
  }
  const firstStore = readGitStore();
  // Connections saved before their account was known get asked again.
  for (const c of firstStore.connections) {
    if (!c.login) tokens.add(c.token);
  }
  // A moved board's old token that is not its connection's: whose it is
  // decides whether it may be deleted.
  for (const t of ownTokensToVerify(firstRaws, firstStore)) tokens.add(t);
  const identities: Record<string, GitIdentity | null> = {};
  for (const token of tokens) identities[token] = await identify(token);

  // ── Synchronous from here ──
  const raws: Record<string, CardAIConfig> = {};
  for (const slug of boards.slugs()) {
    const raw = safeRead(boards, slug);
    if (raw) raws[slug] = raw;
  }
  let store = readGitStore();
  const before = JSON.stringify(store);
  // Learn the accounts of connections saved offline.
  for (const c of store.connections) {
    const id = identities[c.token];
    if (!c.login && id) {
      store = upsertGitConnection(
        store,
        { token: c.token, identity: id },
        { newId: newConnectionId, now: Date.now() }
      ).store;
    }
  }
  const plan = planGitMigration(raws, store, identities, {
    newId: newConnectionId,
    now: Date.now()
  });
  const pointed: Record<string, Pick<CardAIConfig, 'gitConnectionId'>> = {};
  for (const [slug, raw] of Object.entries(raws)) {
    pointed[slug] = {
      gitConnectionId: plan.moved[slug] ?? raw.gitConnectionId
    };
  }
  const merged = mergeDuplicateConnections(plan.store, pointed);
  const repoint = { ...plan.moved, ...merged.repoint };

  if (JSON.stringify(merged.store) !== before) writeGitStore(merged.store);
  for (const [slug, id] of Object.entries(repoint)) {
    boards.setConnection(slug, id);
  }

  // The store and the pointers are on disk: the old fields can go.
  const after: Record<string, CardAIConfig> = {};
  for (const [slug, raw] of Object.entries(raws)) {
    after[slug] = {
      ...raw,
      gitConnectionId: repoint[slug] ?? raw.gitConnectionId
    };
  }
  const clean = planOwnGitCleanup(after, merged.store, identities);
  let cleaned = 0;
  for (const slug of clean) {
    try {
      boards.clearOwnGit(slug, after[slug]!.gitConnectionId!);
      cleaned++;
    } catch {
      // Locked or the disk refused: the next start tries again.
    }
  }
  return {
    moved: Object.keys(plan.moved).length,
    merged: Object.keys(merged.repoint).length,
    cleaned
  };
}

function safeRead(boards: BoardFiles, slug: string): CardAIConfig | null {
  try {
    return boards.readRaw(slug);
  } catch {
    // Locked or undecryptable: not this run's to move. The next start
    // tries again.
    return null;
  }
}

/** A token an older client saved on a board (a pasted PAT, a board-level
 *  GitHub sign-in): into the root store at once, by its value; its account
 *  is learnt by the next reconcile. Returns the connection's id. */
export function saveTokenConnection(
  token: string,
  identity: { gitName: string; gitEmail: string }
): string {
  const store = readGitStore();
  const res = upsertGitConnection(
    store,
    { token, identity: null, ...identity },
    { newId: newConnectionId, now: Date.now() }
  );
  if (res.store !== store) writeGitStore(res.store);
  return res.id;
}

export const gitConnectionChoices = () => connectionChoices(readGitStore());

export function gitConnectionToken(id: string): string | null {
  return readGitStore().connections.find((c) => c.id === id)?.token ?? null;
}

// ── Status > Git: the owner's actions, runner-wide ──

type SigninFlow = {
  state: GitConnectionSignin;
  cancelled: boolean;
};

/**
 * The daemon's handler for `gitConnections` and `gitConnectionAct`. One
 * GitHub sign-in at a time, polled here; the app reads its state with every
 * list (a runner-wide link gets no events).
 */
export function createGitConnectionsHost(deps: {
  boards: BoardFiles;
  /** Revoke an OAuth App token at GitHub, through the Factiii server. */
  revokeToken: (token: string) => Promise<GithubRevokeOutcome>;
  /** After any change: re-report what connections the runner has. */
  onChanged: () => void;
}) {
  let flow: SigninFlow = { state: { status: 'idle' }, cancelled: false };

  const state = (): GitConnectionsState => {
    const boards: Record<string, Pick<CardAIConfig, 'gitConnectionId'>> = {};
    for (const slug of deps.boards.slugs()) {
      const raw = safeRead(deps.boards, slug);
      if (raw) boards[slug] = { gitConnectionId: raw.gitConnectionId };
    }
    return {
      connections: connectionViews(readGitStore(), boards),
      signin: flow.state
    };
  };

  /** A token whose account is known, into the store. */
  const keep = (token: string, identity: GitIdentity): string => {
    const res = upsertGitConnection(
      readGitStore(),
      { token, identity },
      {
        newId: newConnectionId,
        now: Date.now()
      }
    );
    writeGitStore(res.store);
    deps.onChanged();
    return res.id;
  };

  const poll = async (
    mine: SigninFlow,
    clientId: string,
    deviceCode: string,
    interval: number,
    expiresIn: number
  ): Promise<void> => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const deadline = Date.now() + expiresIn * 1000;
    let wait = Math.max(interval, 5);
    while (Date.now() < deadline && !mine.cancelled) {
      await sleep(wait * 1000);
      if (mine.cancelled) return;
      let res;
      try {
        res = await pollGithubDeviceCode(clientId, deviceCode);
      } catch {
        continue; // transient; keep trying until the code expires
      }
      if (res.status === 'pending') continue;
      if (res.status === 'slow_down') {
        wait += 5;
        continue;
      }
      if (res.status === 'complete') {
        const identity = await identityOf(res.accessToken);
        if (!identity) {
          mine.state = {
            status: 'error',
            message:
              'GitHub signed in, but did not say which account. Try again.'
          };
          return;
        }
        const id = keep(res.accessToken, identity);
        mine.state = {
          status: 'complete',
          connectionId: id,
          login: identity.login
        };
        return;
      }
      mine.state =
        res.status === 'error'
          ? { status: 'error', message: res.message }
          : { status: res.status };
      return;
    }
    if (!mine.cancelled) mine.state = { status: 'expired' };
  };

  const act = async (
    p: GitConnectionActPayload
  ): Promise<GitConnectionsState> => {
    switch (p.op) {
      case 'signinStart': {
        flow.cancelled = true;
        const start = await startGithubDeviceCode(p.clientId);
        const mine: SigninFlow = {
          state: {
            status: 'pending',
            userCode: start.userCode,
            verificationUri: start.verificationUri,
            expiresAt: Date.now() + start.expiresIn * 1000
          },
          cancelled: false
        };
        flow = mine;
        void poll(
          mine,
          p.clientId,
          start.deviceCode,
          start.interval,
          start.expiresIn
        );
        return state();
      }
      case 'signinCancel':
        flow.cancelled = true;
        flow = { state: { status: 'idle' }, cancelled: false };
        return state();
      case 'addToken': {
        const token = p.token.replace(/\s/g, '');
        if (!token) throw new Error('Paste a GitHub token first.');
        const identity = await identityOf(token);
        if (!identity) {
          throw new Error(
            'GitHub did not accept that token. Check it and its scopes.'
          );
        }
        keep(token, identity);
        return state();
      }
      case 'update': {
        const store = readGitStore();
        const conn = store.connections.find((c) => c.id === p.id);
        if (!conn)
          throw new Error('That Git connection is not on this runner.');
        const next = {
          ...conn,
          label:
            p.label !== undefined ? p.label.trim().slice(0, 80) : conn.label,
          gitName: p.gitName !== undefined ? p.gitName.trim() : conn.gitName,
          gitEmail: p.gitEmail !== undefined ? p.gitEmail.trim() : conn.gitEmail
        };
        writeGitStore({
          version: 1,
          connections: store.connections.map((c) => (c.id === p.id ? next : c))
        });
        deps.onChanged();
        return state();
      }
      case 'remove': {
        const current = state();
        const view = current.connections.find((c) => c.id === p.id);
        if (!view)
          throw new Error('That Git connection is not on this runner.');
        // A board on it would lose its git without a word: it moves first.
        if (view.boards.length) {
          throw new Error(
            `Still used by ${view.boards.join(', ')}. Pick another connection on ${
              view.boards.length === 1 ? 'that board' : 'those boards'
            } first.`
          );
        }
        const store = readGitStore();
        const conn = store.connections.find((c) => c.id === p.id)!;
        writeGitStore({
          version: 1,
          connections: store.connections.filter((c) => c.id !== p.id)
        });
        deps.onChanged();
        // Revoked after it is forgotten here: a failed revoke still leaves
        // the runner without it. A pasted token is not the OAuth App's to
        // revoke (isGithubOAuthAppToken).
        if (isGithubOAuthAppToken(conn.token)) {
          await deps.revokeToken(conn.token).catch(() => 'failed');
        }
        return state();
      }
    }
  };

  return { state, act };
}

export type GitConnectionsHost = ReturnType<typeof createGitConnectionsHost>;
