import type { BoardAgentAction } from './electron';

// The versioned protocol between the apps, the server and the runner
// (.specs/versioning.md "Protocol"). Each side announces what it supports when
// it connects; a feature the other side lacks is turned off cleanly (hidden,
// skipped, or refused with words the person can act on) instead of failing
// on a strict schema, an unknown action or an ack that never comes.
//
// - Runner → apps: the `runner-info` frame on every channel open carries
//   `protocol` and `features`.
// - App → runner: a `client-hello` frame right after the link opens. A runner
//   from before it ignores the frame (it reads `dispatch` frames only).
// - Runner ↔ server: `runner:hello` (acked with the server's own hello), and
//   `features` on every `runner:heartbeat`. A server from before it never
//   acks: no answer in time leaves the server unknown (everything as before
//   the handshake) and the runner asks again (serverPeer.ts); an answer that
//   is not a hello is `LEGACY_SERVER_FEATURES`.
//
// A name a side does not know is dropped (it is newer than this side), never
// an error. A runner that announces nothing is from before the handshake: its
// features are read off its version (`LEGACY_RUNNER_SINCE`).

/** The wire's own version. It changes only with a runner major version; every
 *  1.x side speaks 1. */
export const RUNNER_PROTOCOL = 1;

/** What a runner can do that an app or the server must know before using it.
 *  Add a name when a release adds an action, a payload field or a socket
 *  event a peer may call; never rename or remove one inside 1.x. */
export const RUNNER_FEATURES = [
  /** `runner:routine-due` (0.40.0). */
  'routines',
  /** Git connections at the runner root (0.41.0). */
  'gitConnections',
  /** Member levels None / Jobs / Shell (0.42.0). */
  'memberLevels',
  /** The Vault key actions: status, setup, unlock, lock, change (0.42.0). */
  'vaultKey',
  /** `aiPromptInfo`, and `images` on `aiPrompt` (0.42.0). */
  'aiPromptImages',
  /** The Activity tab's actions (card 9b50ee2e). */
  'activity',
  /** `simulatorBoot`, `simulatorCatalog`, `simulatorCreate`. */
  'simulatorBoot',
  /** `runner:session-op`: sessions across runners (card 6336db91). */
  'sessionOps',
  /** Reads the app's `client-hello`. */
  'clientHello',
  /** Updates itself when a release is out, and rolls back a release that
   *  fails to start (selfUpdate.ts, supervisor.ts). */
  'autoUpdate',
  /** Hands a tunnel's frpc a frp-only credential (`runner:tunnel-token`),
   *  never its access token, so the server may give it a short-lived one. */
  'tunnelCredential',
  /** `autoUpdateGet` / `autoUpdateSet`: Software > "Update automatically"
   *  and the last update's outcome (runnerAutoUpdate.ts). */
  'autoUpdateSetting',
  /** `vaultErase`: erase a Vault whose key is lost. */
  'vaultErase'
] as const;
export type RunnerFeature = (typeof RUNNER_FEATURES)[number];

/** What the server can do that a runner must know before relying on it. */
export const SERVER_FEATURES = [
  /** `runner:sessions` and `runner:session-relay` (card 6336db91). */
  'sessionRelay',
  /** `runner:job-stopped`, which tells a job's starter (Activity). */
  'jobStopped',
  /** `runner:tunnel-token`: a frp-only credential for `factiii-expose`, so a
   *  tunnel no longer holds the runner's access token. */
  'tunnelToken'
] as const;
export type ServerFeature = (typeof SERVER_FEATURES)[number];

/** A server whose answer to `runner:hello` is not a hello: none of the
 *  above. (No answer at all is unknown, not this: serverPeer.ts.) */
export const LEGACY_SERVER_FEATURES: readonly ServerFeature[] = [];

/** What an app can do that a runner may need to know. None yet: the list is
 *  here so a 1.x runner can gate a frame on it without a new handshake. */
export const CLIENT_FEATURES: readonly string[] = [];

/** For a runner from before the handshake (it sends no `features`): the
 *  release each feature came in. A feature not listed here came after the
 *  handshake, so such a runner lacks it. */
const LEGACY_RUNNER_SINCE: Partial<Record<RunnerFeature, string>> = {
  routines: '0.40.0',
  gitConnections: '0.41.0',
  memberLevels: '0.42.0',
  vaultKey: '0.42.0',
  aiPromptImages: '0.42.0'
};

/** The runner action that needs a feature, for the app's gate before it
 *  sends one (shared/utils/helpers/runnerPeer.ts). An action not listed is
 *  as old as the handshake. */
export const ACTION_FEATURE: Partial<Record<BoardAgentAction, RunnerFeature>> =
  {
    runnerActivity: 'activity',
    runnerJobHistory: 'activity',
    runnerJobLog: 'activity',
    runnerJobStop: 'activity',
    runnerActivitySettings: 'activity',
    simulatorBoot: 'simulatorBoot',
    simulatorCatalog: 'simulatorBoot',
    simulatorCreate: 'simulatorBoot',
    aiPromptInfo: 'aiPromptImages',
    vaultKeyStatus: 'vaultKey',
    vaultKeySetupStart: 'vaultKey',
    vaultKeySetup: 'vaultKey',
    vaultUnlock: 'vaultKey',
    vaultLock: 'vaultKey',
    vaultKeySettings: 'vaultKey',
    vaultKeyChangeStart: 'vaultKey',
    vaultKeyChange: 'vaultKey',
    vaultErase: 'vaultErase',
    autoUpdateGet: 'autoUpdateSetting',
    autoUpdateSet: 'autoUpdateSetting'
  };

/** One side's announcement, as read off the wire. */
export type ProtocolHello = { protocol: number; features: string[] };

const MAX_FEATURES = 200;
const MAX_FEATURE_CHARS = 64;

/** A peer's hello, or null when it sent none (a side from before the
 *  handshake). Never throws: whatever the other side sent, at worst it reads
 *  as "announced nothing". */
export function parseHello(raw: unknown): ProtocolHello | null {
  if (!raw || typeof raw !== 'object') return null;
  const { protocol, features } = raw as {
    protocol?: unknown;
    features?: unknown;
  };
  if (!Array.isArray(features)) return null;
  return {
    protocol:
      typeof protocol === 'number' && Number.isInteger(protocol) && protocol > 0
        ? protocol
        : RUNNER_PROTOCOL,
    features: features
      .slice(0, MAX_FEATURES)
      .filter(
        (f): f is string =>
          typeof f === 'string' && f.length > 0 && f.length <= MAX_FEATURE_CHARS
      )
  };
}

/** The names both sides know: `announced` filtered to `known`. */
export function negotiate<F extends string>(
  known: readonly F[],
  announced: readonly string[]
): F[] {
  const said = new Set(announced);
  return known.filter((name) => said.has(name));
}

const parseSemver = (version: string): [number, number, number] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** `a` is the same release as `b` or newer. */
export function versionAtLeast(a: string, b: string): boolean {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return true;
}

/** What a runner supports: what it announced, else what its version had
 *  (a runner from before the handshake). No version and no announcement
 *  (nothing heard yet) is null: the caller does what it did before. */
export function runnerFeaturesOf(
  version: string | null | undefined,
  announced: unknown
): RunnerFeature[] | null {
  const hello = parseHello(announced);
  if (hello) return negotiate(RUNNER_FEATURES, hello.features);
  if (!version) return null;
  return RUNNER_FEATURES.filter((name) => {
    const since = LEGACY_RUNNER_SINCE[name];
    return since !== undefined && versionAtLeast(version, since);
  });
}

/** What the server supports, from its answer to `runner:hello`. No answer
 *  (a server from before it) is the legacy set. */
export function serverFeaturesOf(answer: unknown): ServerFeature[] {
  const hello = parseHello(answer);
  return hello
    ? negotiate(SERVER_FEATURES, hello.features)
    : [...LEGACY_SERVER_FEATURES];
}

/** The words for an action the runner is too old for. */
export function runnerTooOld(version: string | null | undefined): string {
  return `This runner${version ? ` (v${version})` : ''} is too old for this. Update the runner to use it.`;
}

/** Why `action` may not go to a runner with `features`, or null when it may.
 *  Unknown features (nothing heard yet) never refuse. */
export function actionRefusal(
  action: string,
  features: readonly RunnerFeature[] | null,
  version?: string | null
): string | null {
  if (!features) return null;
  const needs = ACTION_FEATURE[action as BoardAgentAction];
  if (!needs || features.includes(needs)) return null;
  return runnerTooOld(version);
}

/** The runner's `runner-info` frame. */
export function runnerInfoFrame(version: string): {
  type: 'runner-info';
  version: string;
  protocol: number;
  features: RunnerFeature[];
} {
  return {
    type: 'runner-info',
    version,
    protocol: RUNNER_PROTOCOL,
    features: [...RUNNER_FEATURES]
  };
}

/** The app's `client-hello` frame. */
export function clientHelloFrame(): {
  type: 'client-hello';
  protocol: number;
  features: string[];
} {
  return {
    type: 'client-hello',
    protocol: RUNNER_PROTOCOL,
    features: [...CLIENT_FEATURES]
  };
}
