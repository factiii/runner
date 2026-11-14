import {
  type ProtocolHello,
  RUNNER_FEATURES,
  RUNNER_PROTOCOL,
  type ServerFeature,
  serverFeaturesOf
} from '@shared/all/domains/runnerProtocol';

// What this runner knows of the server it is connected to
// (.specs/versioning.md "Protocol"). On every connect the runner sends
// `runner:hello` and waits for the server's answer. A feature the server
// said it lacks is turned off here (the event is not sent, the call refused
// with words) instead of an ack that times out. No answer in time is not an
// answer: the server stays unknown (everything goes as before the
// handshake) and is asked again, so a slow ack never reads as a server from
// before the handshake. Only a server that answered without a feature is
// one that lacks it (`lacks`), which is what the tunnel credential needs:
// the access token goes to frpc only for a server that said it has no
// `tunnelToken`.

/** How long the runner waits for the server's answer to `runner:hello`. */
export const SERVER_HELLO_TIMEOUT_MS = 10_000;
/** How long after a hello with no answer it is asked again; doubled each
 *  time, up to SERVER_HELLO_RETRY_MAX_MS. */
export const SERVER_HELLO_RETRY_MS = 30_000;
export const SERVER_HELLO_RETRY_MAX_MS = 5 * 60_000;

/** A relay call refused because the server does not carry it. */
export const SERVER_NO_SESSION_RELAY =
  "Factiii's server does not carry sessions across runners yet.";

/** What this runner says in `runner:hello` and on each heartbeat. */
export function runnerHello(version: string): { version: string } & ProtocolHello {
  return { version, protocol: RUNNER_PROTOCOL, features: [...RUNNER_FEATURES] };
}

export type ServerPeer = {
  /** Say hello on a fresh connection and keep the answer. With no answer in
   *  time it is said again later (SERVER_HELLO_RETRY_MS), on this
   *  connection only. */
  greet(): Promise<void>;
  /** The connection dropped: nothing known until the next hello. */
  reset(): void;
  /** Whether to use `feature`. Before the server has answered (or while
   *  disconnected) it is true: the runner does what it did before the
   *  handshake, which an older server ignores. */
  has(feature: ServerFeature): boolean;
  /** Whether the server answered and said it lacks `feature`. False while
   *  nothing is known: for what must never be done on a guess. */
  lacks(feature: ServerFeature): boolean;
  /** What the server said it supports, or null before it answered. */
  known(): ServerFeature[] | null;
};

export function createServerPeer(deps: {
  /** Emit `runner:hello` and resolve the server's answer; rejects on the
   *  ack timeout. */
  hello: () => Promise<unknown>;
  log?: (line: string) => void;
  /** The first wait before a hello is said again (tests pass their own). */
  retryMs?: number;
}): ServerPeer {
  let features: ServerFeature[] | null = null;
  // A hello from a connection that has since dropped must not land on the
  // next one.
  let generation = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryWait = deps.retryMs ?? SERVER_HELLO_RETRY_MS;
  const clearRetry = () => {
    if (retry) clearTimeout(retry);
    retry = null;
  };
  const peer: ServerPeer = {
    async greet() {
      clearRetry();
      const mine = ++generation;
      let answer: unknown;
      let answered = true;
      try {
        answer = await deps.hello();
      } catch {
        answered = false;
      }
      if (mine !== generation) return;
      if (!answered) {
        deps.log?.(
          `[protocol] the server did not answer the handshake in time: asking again in ${Math.round(retryWait / 1000)} s. Until then nothing is turned off, and no tunnel gets this runner's token.`
        );
        retry = setTimeout(() => {
          retry = null;
          if (mine === generation) void peer.greet();
        }, retryWait);
        (retry as { unref?: () => void }).unref?.();
        retryWait = Math.min(retryWait * 2, SERVER_HELLO_RETRY_MAX_MS);
        return;
      }
      features = serverFeaturesOf(answer);
      deps.log?.(
        `[protocol] the server supports: ${features.join(', ') || 'nothing new'}.`
      );
    },
    reset() {
      generation += 1;
      features = null;
      clearRetry();
      retryWait = deps.retryMs ?? SERVER_HELLO_RETRY_MS;
    },
    has(feature) {
      return features === null || features.includes(feature);
    },
    lacks(feature) {
      return features !== null && !features.includes(feature);
    },
    known() {
      return features ? [...features] : null;
    }
  };
  return peer;
}
