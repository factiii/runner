// Host-run (runner/desktop) GitHub device-code OAuth. PUBLIC client (client_id, no secret); the access token
// stays host-local in the space config. The Factiii server never stores it and
// sees it at one moment only: on disconnect the runner sends it to
// `github.revokeToken` so the server can revoke it at GitHub, which takes the
// OAuth App's client secret, and that secret cannot ship in a runner
// (revokeGithubTokenViaServer, below).
//
// Why device flow and not a web redirect: the runner has no browser and no
// callback URL of its own, and a redirect flow would have to round-trip the
// token through the server. Device flow keeps the credential on the machine
// that actually runs git.

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_BASE = 'https://api.github.com';

// `repo` covers private clone + push, which is what the card sessions do.
// GitHub has no narrower classic scope that still allows private writes.
// `workflow` is what lets a push change files under .github/workflows; without
// it GitHub refuses the whole push, so a session could not ship a CI change.
// A connection made before this was added keeps its old scopes until the
// owner reconnects GitHub.
const GITHUB_SCOPES = 'repo workflow read:user user:email';

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface GithubDeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** Begin the device-code flow: returns the code + URL to show the user. */
export async function startGithubDeviceCode(
  clientId: string
): Promise<GithubDeviceCodeStart> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({ client_id: clientId, scope: GITHUB_SCOPES })
  });
  if (!res.ok) {
    throw new Error(`GitHub device-code start failed: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };
  if (data.error || !data.device_code || !data.user_code) {
    // The most common cause by far: "Device flow" isn't ticked on the OAuth
    // App, which GitHub reports as device_flow_disabled.
    throw new Error(
      data.error_description ||
        data.error ||
        'GitHub returned no device code. Is device flow enabled on the OAuth App?'
    );
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri || 'https://github.com/login/device',
    expiresIn: data.expires_in ?? 900,
    interval: data.interval ?? 5
  };
}

export type GithubPollResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'declined' }
  | { status: 'error'; message: string }
  | { status: 'complete'; accessToken: string };

/** One poll tick: pending / slow_down keep polling, anything else ends it. */
export async function pollGithubDeviceCode(
  clientId: string,
  deviceCode: string
): Promise<GithubPollResult> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: DEVICE_CODE_GRANT
    })
  });
  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (data.access_token) {
    return { status: 'complete', accessToken: data.access_token };
  }
  switch (data.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return { status: 'slow_down' };
    case 'expired_token':
      return { status: 'expired' };
    case 'access_denied':
      return { status: 'declined' };
    default:
      return {
        status: 'error',
        message:
          data.error_description || data.error || 'GitHub sign-in failed.'
      };
  }
}

// ── API helpers (used to populate the repo/branch pickers) ──

async function githubApi<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!res.ok) {
    throw new Error(
      `GitHub ${path} failed (${res.status}): ${await res.text()}`
    );
  }
  return (await res.json()) as T;
}

export interface GithubIdentity {
  login: string;
  name: string;
  email: string;
}

/**
 * Who the token belongs to, for the "Connected as @x" line and to seed the
 * git author. The public profile email is often null, so fall back to the
 * primary verified address, then to GitHub's noreply form (which always
 * works as a commit author and leaks nothing).
 */
export async function fetchGithubIdentity(
  token: string
): Promise<GithubIdentity> {
  const user = await githubApi<{
    login: string;
    name: string | null;
    email: string | null;
    id: number;
  }>(token, '/user');

  let email = user.email ?? '';
  if (!email) {
    try {
      const emails = await githubApi<
        { email: string; primary: boolean; verified: boolean }[]
      >(token, '/user/emails');
      email =
        emails.find((e) => e.primary && e.verified)?.email ??
        emails.find((e) => e.verified)?.email ??
        '';
    } catch {
      // user:email scope may be absent; the noreply fallback still commits.
    }
  }
  if (!email) email = `${user.id}+${user.login}@users.noreply.github.com`;

  return { login: user.login, name: user.name || user.login, email };
}

export interface GithubRepo {
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
}

/**
 * Repos the token can write to, most-recently-pushed first. Read-only repos
 * are dropped: a card session has to be able to push its branch back, so
 * offering one would only fail later at commitAndPush.
 */
export async function listGithubRepos(token: string): Promise<GithubRepo[]> {
  const out: GithubRepo[] = [];
  // 3 pages is 300 repos - past that the search box matters more than
  // completeness, and each page is a round trip the picker waits on.
  for (let page = 1; page <= 3; page++) {
    const batch = await githubApi<
      {
        full_name: string;
        clone_url: string;
        default_branch: string;
        private: boolean;
        permissions?: { push?: boolean };
      }[]
    >(token, `/user/repos?per_page=100&sort=pushed&page=${page}`);
    for (const r of batch) {
      if (r.permissions && !r.permissions.push) continue;
      out.push({
        fullName: r.full_name,
        // Strip any embedded credentials; buildCloneUrl adds the token.
        cloneUrl: r.clone_url.replace(/\/\/[^@/]*@/, '//'),
        defaultBranch: r.default_branch,
        private: r.private
      });
    }
    if (batch.length < 100) break;
  }
  return out;
}

/** Branch names for the repo picker's branch dropdown. */
export async function listGithubBranches(
  token: string,
  fullName: string
): Promise<string[]> {
  const branches = await githubApi<{ name: string }[]>(
    token,
    `/repos/${fullName}/branches?per_page=100`
  );
  return branches.map((b) => b.name);
}

// ── Disconnect: revoke the token at GitHub, through the Factiii server ──

/** What became of the token at GitHub when a board disconnected it. */
export type GithubRevokeOutcome =
  /** GitHub no longer accepts it: revoked now, or it was already invalid. */
  | 'revoked'
  /** Nobody could be asked: the server holds no client secret, or this host
   *  is not a paired runner. */
  | 'not-configured'
  /** The server or GitHub refused or could not be reached. */
  | 'failed';

/** Asks the server to revoke one token. Never throws. Injected into the
 *  engine by the host (BoardAgentEngineOptions.revokeGithubToken). */
export type GithubTokenRevoker = (token: string) => Promise<GithubRevokeOutcome>;

// Tokens an OAuth App mints, which is all the server's app credentials can
// revoke. A pasted personal access token (`ghp_`, `github_pat_`) is not ours:
// GitHub answers "not found" for it exactly as for a dead token, which would
// read as revoked while it stays valid. So it is never sent.
const OAUTH_APP_TOKEN_PREFIX = 'gho_';

export function isGithubOAuthAppToken(token: string): boolean {
  return token.startsWith(OAUTH_APP_TOKEN_PREFIX);
}

const REVOKE_TIMEOUT_MS = 15_000;
const REVOKE_OUTCOMES: readonly GithubRevokeOutcome[] = [
  'revoked',
  'not-configured',
  'failed'
];

/**
 * The runner's revoker: one POST to the server's `github.revokeToken`, with
 * the runner's access token in the same header the board MCP's routes take.
 * Never throws and never reports why it failed:
 * the request body is the token, and an error could quote it.
 */
export async function revokeGithubTokenViaServer(
  serverUrl: string,
  runnerToken: string | undefined,
  token: string
): Promise<GithubRevokeOutcome> {
  if (!serverUrl || !runnerToken) return 'not-configured';
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, '')}/trpc/github.revokeToken`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // authGuard rejects a request with no user agent outright.
          'user-agent': 'factiii-runner',
          'x-factiii-bot-token': runnerToken
        },
        // The server's tRPC runs a superjson transformer, so input arrives
        // under `json`; a plain string needs no meta.
        body: JSON.stringify({ json: { token } }),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS)
      }
    );
    if (!res.ok) return 'failed';
    const body = (await res.json()) as {
      result?: { data?: { json?: { status?: unknown } } };
    };
    const status = body.result?.data?.json?.status;
    return REVOKE_OUTCOMES.find((outcome) => outcome === status) ?? 'failed';
  } catch {
    return 'failed';
  }
}
