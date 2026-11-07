// A minimal tRPC-over-HTTP client for the laptop CLI. The runner package ships
// as one esbuild bundle with no @trpc/client, and auth.ts already speaks the
// wire format by hand, so this does the same: SuperJSON envelopes
// (`{ json: ... }`) over GET for queries and POST for mutations.

import path from 'path';

import { runnerDir } from '@shared/all/helpers/board-agent-core/runner-dir';
import { RUNNER_IP_CHALLENGE_REQUIRED } from '@shared/all/validators';

import { boardLabel, findBoard, type KnownBoard } from '../boardRegistry';

const DEFAULT_SERVER = 'https://api.factiii.com';

/** Must match RUNNER_CLI_TOKEN_HEADER in apps/server/src/helpers/runnerCliAuth.ts. */
export const RUNNER_CLI_TOKEN_HEADER = 'x-factiii-runner-cli-token';

/** Every server procedure the CLI calls, in one place, so a rename on the
 *  server is a one-line change here. */
export const PROCEDURES = {
  startLogin: 'runnerCli.startLogin',
  pollLogin: 'runnerCli.pollLogin',
  // Runner pairing by code (`factiii-runner setup`).
  startPairing: 'runners.startPairing',
  pollPairing: 'runners.pollPairing',
  revokeSelf: 'runnerJobs.revokeSelf',
  runners: 'runnerJobs.runners',
  list: 'runnerJobs.list',
  // The server named it "run": tRPC reserves "call" as a procedure name.
  call: 'runnerJobs.run',
  status: 'runnerJobs.status',
  cancel: 'runnerJobs.cancel',
  recipient: 'runnerJobs.recipient',
  submitSecret: 'runnerJobs.submitSecret',
  audit: 'runnerJobs.audit',
  // Caller IP pin (.specs/runner-secrets-gate.md): the gate alone, a
  // challenge for this address, and its answer.
  checkAddress: 'runnerJobs.checkAddress',
  ipChallenge: 'runnerJobs.ipChallenge',
  verifyIp: 'runnerJobs.verifyIp'
} as const;

/** A tRPC error the server returned, with its code (e.g. UNAUTHORIZED). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The server refused because this terminal's address is not the one pinned
 *  to the account. `confirmAddress` (ipPin.ts) is the way through. */
export function isNewAddress(err: unknown): boolean {
  return err instanceof ApiError && err.message === RUNNER_IP_CHALLENGE_REQUIRED;
}

export type Api = {
  query<T>(path: string, input: unknown): Promise<T>;
  mutation<T>(path: string, input: unknown): Promise<T>;
};

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

type Envelope = {
  result?: { data?: { json?: unknown } };
  error?: { json?: { message?: string; data?: { code?: string; httpStatus?: number } } };
};

async function unwrap<T>(
  res: Awaited<ReturnType<FetchLike>>,
  path: string
): Promise<T> {
  const raw = await res.text();
  let body: Envelope;
  try {
    body = JSON.parse(raw) as Envelope;
  } catch {
    throw new ApiError(
      `${path}: the server answered ${res.status} with a non-JSON body.`,
      'BAD_RESPONSE',
      res.status
    );
  }
  if (body.error || !res.ok) {
    const err = body.error?.json;
    throw new ApiError(
      err?.message ?? `${path} failed (${res.status}).`,
      err?.data?.code ?? 'UNKNOWN',
      err?.data?.httpStatus ?? res.status
    );
  }
  return body.result?.data?.json as T;
}

export function createApi(opts: {
  serverUrl: string;
  token?: string | null;
  fetchImpl?: FetchLike;
}): Api {
  const base = `${opts.serverUrl.replace(/\/$/, '')}/trpc`;
  const doFetch: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'ngrok-skip-browser-warning': 'true'
  };
  // Only the server's runnerJobs procedures read this header, which keeps the
  // CLI token to jobs (apps/server/src/helpers/runnerCliAuth.ts).
  if (opts.token) headers[RUNNER_CLI_TOKEN_HEADER] = opts.token;

  return {
    async query<T>(path: string, input: unknown): Promise<T> {
      const q = encodeURIComponent(JSON.stringify({ json: input }));
      const res = await doFetch(`${base}/${path}?input=${q}`, {
        method: 'GET',
        headers
      });
      return unwrap<T>(res, path);
    },
    async mutation<T>(path: string, input: unknown): Promise<T> {
      const res = await doFetch(`${base}/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ json: input })
      });
      return unwrap<T>(res, path);
    }
  };
}

/** `--server`, else FACTIII_API_URL, else production. */
export function resolveServer(flag?: string): string {
  return (flag || process.env.FACTIII_API_URL || DEFAULT_SERVER).replace(
    /\/$/,
    ''
  );
}

/**
 * The runner folder a session runs under: its secrets socket is
 * `<runner dir>/<board>/state/secrets.sock`. Read from the socket path first,
 * so a session of a second runner (FACTIII_RUNNER_DIR) finds its own runner
 * even when that variable did not reach it.
 */
function sessionRunnerDir(env: NodeJS.ProcessEnv): string {
  const sock = env.FACTIII_SECRETS_SOCK;
  return sock ? path.dirname(path.dirname(path.dirname(sock))) : runnerDir(env);
}

/**
 * The board this terminal runs for, as the runner knows it now. A terminal
 * keeps the env it was started with, so after the space is renamed its
 * FACTIII_SPACE is the old slug: the runner's spaces.json, by FACTIII_SPACE_ID
 * (or by that old slug), has the slug the server takes today and the name to
 * show. Undefined outside a runner session, or for a board the runner has no
 * record of.
 */
export function sessionBoard(env: NodeJS.ProcessEnv = process.env): KnownBoard | undefined {
  const id = Number(env.FACTIII_SPACE_ID);
  const slug = env.FACTIII_SPACE || undefined;
  if (!slug && !(id > 0)) return undefined;
  return findBoard(sessionRunnerDir(env), { id: id > 0 ? id : undefined, slug });
}

/** How the CLI names a space to the person running it: the space's name when
 *  this machine's runner knows it (boardLabel), else the slug. */
export function describeSpace(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  return boardLabel(localBoard(slug, env), slug);
}

/** The board this machine's runner keeps under `slug` (now or before), when
 *  there is one. */
export function localBoard(slug: string, env: NodeJS.ProcessEnv = process.env): KnownBoard | undefined {
  return findBoard(sessionRunnerDir(env), { slug });
}

/** `--space`, else this terminal's board (FACTIII_SPACE_ID, then
 *  FACTIII_SPACE, each resolved to the slug it has now). Throws with a remedy
 *  when neither is set. */
export function resolveSpace(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (flag) return flag;
  const space = sessionBoard(env)?.slug || env.FACTIII_SPACE;
  if (!space) {
    throw new Error(
      'No space given. Pass --space <slug> or set FACTIII_SPACE.'
    );
  }
  return space;
}

/** A runner open to the caller on a space, as `runnerJobs.runners` lists it. */
export type OpenRunner = {
  runnerId: number;
  name: string;
  owned: boolean;
  online: boolean;
};

/** `--runner`, else FACTIII_RUNNER: a runner's id or its name. Throws with a
 *  remedy when neither is set. The server never picks a runner. Exported for
 *  its test. */
export function resolveRunnerRef(flag?: string): string {
  const ref = (flag || process.env.FACTIII_RUNNER || '').trim();
  if (!ref) {
    throw new Error(
      'No runner given. Pass --runner <name or id> or set FACTIII_RUNNER. List the runners open to you with "factiii-runner runners".'
    );
  }
  return ref;
}

/** The id for a `--runner` value among the runners open to the caller. A
 *  number is an id. A name must match exactly one runner; two runners with
 *  one name need the id. Exported for its test. */
export function pickRunner(ref: string, runners: OpenRunner[]): number {
  // Another person's runner is listed only while it is connected, so "not
  // open to you" is also what an offline shared runner looks like.
  const list = `${
    runners.length
      ? runners.map((r) => `${r.runnerId} (${r.name})`).join(', ')
      : 'none'
  }. A shared runner shows only while it is online`;
  if (/^[0-9]+$/.test(ref)) {
    const id = Number(ref);
    if (runners.some((r) => r.runnerId === id)) return id;
    throw new Error(`Runner ${ref} is not open to you on this space. Open to you: ${list}.`);
  }
  const named = runners.filter(
    (r) => r.name.toLowerCase() === ref.toLowerCase()
  );
  if (named.length === 1) return named[0].runnerId;
  if (named.length > 1) {
    throw new Error(
      `${named.length} runners are named "${ref}". Pass its id: ${named.map((r) => r.runnerId).join(', ')}.`
    );
  }
  throw new Error(`No runner named "${ref}" is open to you on this space. Open to you: ${list}.`);
}

/** The runners open to the caller on a space. */
export async function fetchRunners(
  api: Pick<Api, 'query'>,
  spaceSlug: string
): Promise<OpenRunner[]> {
  const { runners } = await api.query<{ runners: OpenRunner[] }>(
    PROCEDURES.runners,
    { spaceSlug }
  );
  return runners;
}

/** `--runner` / FACTIII_RUNNER resolved to a runner id on this space. */
export async function resolveRunner(
  api: Pick<Api, 'query'>,
  spaceSlug: string,
  flag?: string
): Promise<number> {
  return pickRunner(resolveRunnerRef(flag), await fetchRunners(api, spaceSlug));
}

/** The Keychain account for a server: its host (with port, if any). */
export function serverAccount(serverUrl: string): string {
  return new URL(serverUrl).host;
}
