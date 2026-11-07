import {
  type AgentState,
  type BoardAgentActionMap,
  type CardAISessionSummary,
  RUNNER_ACCESS_LEVELS,
  type RunnerAccessLevel,
  type RunnerAccessState,
  type RunnerGrants,
  type RunnerDangerousGrants
} from '@shared/all/domains/electron';
import type {
  ClientToServerEvents,
  RTCIceCandidateInit,
  RTCSessionDescriptionInit,
  RunnerScope,
  RunnerSessionEndPhase,
  ServerToClientEvents
} from '@shared/all/domains/socket';
import { agentSettledPhase } from '@shared/all/domains/socket';
import {
  type ActionContext,
  BoardAgentEngine,
  createEventSink,
} from '@shared/all/helpers/board-agent-core';
import type { HypervisorHost } from '@shared/all/helpers/board-agent-core/session-hypervisor';
import {
  actionAllowed,
  type ChannelLevel,
  channelLevel,
  type ChannelTransport,
  grantedLevel,
  levelAtLeast,
  ownerIdFromRunnerToken,
  parseVouchedScope,
  dangerousGranted,
  rawUseAllowed,
  RELAY_REFUSES_SECRETS,
  type RelayedCall,
  relayedCallRefusal,
  relaySecretsRefusal,
  VAULT_ACTIONS,
  LOCAL_AI_ACTIONS,
  RUNNER_AI_ACTIONS,
  RELAY_SIGNIN_REFUSAL,
  RUNNER_SIGNIN_ACTIONS,
  refusal,
  type VouchedScope,
  withGrant,
  withDangerousGrant
} from '@shared/all/helpers/board-agent-core/runner-access';
import {
  decideScreenUse,
  type ScreenHold,
  screenHolderView,
  screenUse
} from '@shared/all/helpers/board-agent-core/screen-holder';
import {
  chunkWire,
  makeChunkReassembler
} from '@shared/all/helpers/wireChunk';
import {
  keepAwakeSetSchema,
  RUNNER_NO_SUCH_JOB_CALL,
  RUNNER_SLEEP_MAX_SESSIONS,
  type RunnerSleepSnapshot
} from '@shared/all/validators';
import { randomBytes } from 'crypto';
import fs from 'fs';
import {
  type DataChannel as NDCDataChannel,
  DescriptionType,
  type IceServer,
  PeerConnection,
  type Direction,
  type Track,
  Video,
  type RelayType
} from 'node-datachannel';
import {
  H264Packetizer,
  negotiatedH264PayloadType,
  negotiatedMid
} from '@shared/all/helpers/board-agent-core/rtp-h264';
import path from 'path';
import { io, type Socket } from 'socket.io-client';

import { type ExecTarget, hostTarget } from '@shared/all/helpers/board-agent-core/exec';
import { revokeGithubTokenViaServer } from '@shared/all/helpers/board-agent-core/github-auth';
import { runnerDir } from '@shared/all/helpers/board-agent-core/runner-dir';
import { TerminalManager } from '@shared/all/helpers/terminal-ai/terminal';

import {
  credentialStoreStatus,
  getConfiguredConnections,
  listConfiguredSlugs,
  localConfigProvider
} from './agent-adapter';
import {
  readRunnerConfig,
  type RunnerConfig,
  writeRunnerConfig
} from './config';
import {
  readRunnerGrants,
  readRunnerDangerousGrants,
  writeRunnerGrants
} from './access';
import { boardLabel, describeBoard, knownBoards, noteBoard, rekeyBoard } from './boardRegistry';
import { removeDesktopViewLeftovers } from './cleanup';
import { createDaemonNuke, type DaemonNuke } from './daemonNuke';
import { keepLogLimited } from './logLimit';
import { machineNukeHost, stopTmuxSessionsIn, unpairOverSocket } from './nukeHost';
import { watchProcessCount } from './processWatch';
import { KeepAwake } from './keepAwake';
import { LidHold, readThermal } from './lidHold';
import { run } from './machine';
import { machineHealth, runningServices } from './machineHealthIo';
import { createRunnerConnections, personOf, type RunnerConnectionsHost } from './runnerConnections';
import { CONFIG_DIR, safeSlug } from './paths';
import { serverReadiness } from './serverReadinessIo';
import { startStatusHeartbeat } from './statusPage';
import { promptPassword } from './promptPassword';
import {
  createTokenKeeper,
  heartbeatIntervalMs,
  RUNNER_TOKEN_REFRESH_ACK_TIMEOUT_MS,
  takeRefreshToken
} from './runnerToken';
import {
  currentVersion,
  installLatest,
  isRelaunchAfterUpdate,
  RESTART_FOR_UPDATE
} from './selfUpdate';
import type { LocalAiTags } from './localAiTags';
import type { PartsManager } from './partsManager';
import { type CliSignins, machineCliSignins } from './cliSignins';
import { createLocalAiTags, createPartsManager } from './runnerParts';
import { type AiPromptEngines, answerAiPrompt } from './vault/aiPrompt';
import { machineAskEngines } from './vault/askEngines';
import { machineCategorizeEngines } from './vault/categorizeEngine';
import { createDaemonVault, type DaemonVault } from './vault/daemonVault';
import { vaultEmbedder } from './vault/embedder';
import { runnerServiceHost } from './runnerService';
import { serviceLogFile } from './service';
import {
  convertVaultFilesAndReport,
  runSecureAction,
  SECURE_ACTIONS
} from './secureActions';
import {
  SecureStoreError,
  type SecureStoreStatus,
  unlock
} from './secureStore';
import {
  isFirstStartOfVersion,
  shouldPromptForUnlock,
  watchForUnlock
} from './unlockPrompt';
import {
  runVaultBackupAction,
  VAULT_BACKUP_ACTIONS,
  VaultBackupStore
} from './vaultBackupStore';
import { sendFrameToHolder, type VideoSink } from './video-fanout';

/** How often a runner that started locked looks for an unlock done outside it
 *  (`factiii-runner password` in another process). Only while it is locked. */
const EXTERNAL_UNLOCK_POLL_MS = 5_000;
/** How long the runner waits for the server to name its boards on connect.
 *  A server from before `runner:board-names` never answers. */
const BOARD_NAMES_ACK_TIMEOUT_MS = 10_000;

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

type RunnerOfferData = {
  fromSocketId: string;
  offer: RTCSessionDescriptionInit;
  // Correlation id from the dialling peer, relayed by the server. Sent back on
  // the link report so all three sides of a handshake share one key.
  linkId?: string;
  // Server-vouched: which boards this connection may see/control (owner = all).
  scope?: RunnerScope;
  // Minted by the server and sent with the offer, because the runner has no
  // session of its own to ask with. Absent on an older server.
  iceServers?: {
    urls: string | string[];
    username?: string;
    credential?: string;
  }[];
};

/** One client's link, whatever carries it: a WebRTC data channel, or frames
 *  relayed through the server socket for networks that block WebRTC. Shaped
 *  after node-datachannel's DataChannel, which satisfies it as it is. */
type Wire = {
  sendMessage(frame: string): boolean;
  onOpen(cb: () => void): void;
  onMessage(cb: (msg: string | Buffer) => void): void;
  onClosed(cb: () => void): void;
};

// Per-channel access from the offer's server-vouched scope. A link with no
// scope is refused (parseVouchedScope); it used to be the legacy owner path
// (pre-sharing, only the owner could connect) and got full access.
// `userId` + `name` are who is on the other end, for the unlock window and the
// audit log; an older server sends neither, and '' / 'Owner' stand in.
// One object per link, so it also names the link: the holder of the video
// stream is the scope object of the peer that attached.
type ChannelScope = VouchedScope;

/** What a dispatch needs to know about access. The levels and the video
 *  hold live in startDaemon; a dispatch only asks. */
type ChannelAccess = {
  /** What this channel has on a board (runner-access.ts). */
  level: (scope: ChannelScope, spaceSlug: unknown) => ChannelLevel;
  /** The board's access as this channel may see it. */
  state: (scope: ChannelScope, spaceSlug: string) => RunnerAccessState;
  /** Whether this channel runs dangerous jobs on a board without the
   *  owner's approval per call. */
  dangerous: (scope: ChannelScope, spaceSlug: unknown) => boolean;
  /** Move one member on one board. Owner only; the caller checked. */
  set: (spaceSlug: string, payload: unknown, ctx: ActionContext) => void;
  /** One attach, input or detach on the video stream (screen-holder.ts). */
  screen: (
    scope: ChannelScope,
    spaceSlug: string,
    request: NonNullable<ReturnType<typeof screenUse>>
  ) => { run: boolean; refusal?: string };
  /** An attach of `kind` that started nothing: give the stream back, unless
   *  this link holds something else since. */
  screenFailed: (scope: ChannelScope, kind: ScreenHold<ChannelScope>['kind']) => void;
};

// ── Vault backups (.specs/mobile-vault.md "Runner backup") ──
// The owner's phone vault, held runner-wide in `vault-backups/`. Nothing is
// created on disk until the first package arrives.
const vaultBackups = new VaultBackupStore(CONFIG_DIR);

/** The actor and road for an action arriving on this channel. `dangerous` is
 *  whether the channel runs dangerous jobs on the action's board without
 *  the owner's approval per call. */
function channelContext(scope: ChannelScope, dangerous = false): ActionContext {
  return {
    actor: {
      userId: scope.userId,
      name: scope.name || (scope.role === 'owner' ? 'Owner' : 'A member')
    },
    via: 'data-channel',
    role: scope.role,
    dangerous
  };
}

/** libdatachannel takes ICE servers as its own objects, not the browser's
 *  `{ urls, username, credential }`. Packing the credentials into a
 *  `turn:user:pass@host` URL instead looked equivalent and was not: the runner
 *  received the servers, logged them, and then gathered host and srflx only —
 *  it never allocated a relay, because the percent-encoded password in the
 *  userinfo never authenticated. Building the objects leaves nothing to parse
 *  and nothing to encode.
 *
 *  Falls back to STUN when the server sends nothing — an older server, or one
 *  with no TURN credentials configured. STUN alone cannot cross a NAT that maps
 *  per destination, which is why a phone on cellular could not reach a runner at
 *  home, but it still connects everything sharing a network. */
function toRtcIceServers(
  servers?: { urls: string | string[]; username?: string; credential?: string }[]
): (string | IceServer)[] {
  const fallback: (string | IceServer)[] = ['stun:stun.l.google.com:19302'];
  if (!servers?.length) return fallback;

  const out: (string | IceServer)[] = [];
  for (const server of servers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      // stun: needs no credentials, so its URL form is unambiguous.
      const turn = /^(turns?):([^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/.exec(
        url
      );
      if (!turn || !server.username || !server.credential) {
        out.push(url);
        continue;
      }
      const [, scheme, hostname, port, transport] = turn;
      // libjuice speaks TURN over UDP only, and keeps just two TURN servers
      // after shuffling whatever it is handed. Cloudflare offers six endpoints,
      // four of them TCP or TLS, so passing them all through meant the two it
      // kept were both unusable roughly 40% of the time and it allocated no
      // relay at all. The server sends UDP only (iceServers.ts
      // toRunnerIceServers); this keeps a TCP or TLS entry from ever reaching
      // libjuice whatever it is handed.
      if (scheme === 'turns' || transport === 'tcp') continue;
      out.push({
        hostname: hostname!,
        port: Number(port ?? 3478),
        username: server.username,
        password: server.credential,
        // A string literal, not the RelayType member: it is a `const enum`,
        // so it is erased at compile time and has no runtime object to read —
        // `RelayType.TurnUdp` threw, which killed the offer handler before it
        // could answer and made every connection fail, not just the relayed
        // ones. The enum's value is exactly this string.
        relayType: 'TurnUdp' as RelayType
      });
    }
  }
  return out.length > 0 ? out : fallback;
}

/** The owner, for actions that reach the runner with no channel (a gate
 *  opened by the owner's own terminal, a job a session on this runner calls).
 *  The id comes from the runner's pairing token at startup (startDaemon); the
 *  name from the first owner channel the server vouches for. */
let ownerActor: { userId: string; name: string } = {
  userId: '',
  name: 'Owner'
};

/** Null when the server vouched for nothing the runner can act on; the
 *  caller refuses the link. */
function toChannelScope(raw: RunnerScope | undefined): ChannelScope | null {
  const scope = parseVouchedScope(raw);
  if (!scope) return null;
  const { userId, name } = scope;
  if (scope.role === 'owner') {
    if (name) ownerActor = { userId: ownerActor.userId || userId, name };
    // An older server vouches for no id; the owner is still the owner.
    return { role: 'owner', userId: userId || ownerActor.userId, name };
  }
  return scope;
}

/** Offered for H.264, then replaced by whatever the answer settles on — the
 *  browser numbers the codecs and does not use this one. */
const SIMULATOR_PAYLOAD_TYPE = 96;
/** What `simstream` encodes: High profile. Preferred when the far end offers a
 *  matching packetization-mode=1 type, but not required — browsers key their
 *  decoder off the SPS rather than this. */
const SIMULATOR_PROFILE = 'f4001f';
const SIMULATOR_SSRC = 0x5157_4d31;

type RunnerIceCandidateData = {
  fromSocketId: string;
  candidate: RTCIceCandidateInit;
};


type DispatchMessage = {
  type: 'dispatch';
  action: keyof BoardAgentActionMap;
  spaceSlug: string;
  // Stable board id (optional for older clients).
  spaceId?: number;
  payload: unknown;
  requestId: string;
};

type ResultMessage = {
  type: 'result';
  requestId: string;
  result?: unknown;
  error?: string;
  /** A typed reason beside the message, for refusals a client acts on
   *  (RELAY_REFUSES_SECRETS). */
  code?: string;
};

type EventMessage = {
  type: 'event';
  spaceSlug: string;
  /** The space's name as the runner last heard it, for an app that lists
   *  work across boards (Running jobs, Settings → Runners). Absent for a
   *  board it knows no name for, and from older runners. */
  spaceName?: string;
  event: string;
  payload: unknown;
};

/** Ask for the old connection password on the terminal, when - and only when -
 *  there is still a file an older runner locked behind it and a person started
 *  this process (shouldPromptForUnlock); it is the last time. Three attempts,
 *  then carry on: the app is the other way in, and it needs us online. */
async function promptForUnlockOnTty(): Promise<void> {
  const status = credentialStoreStatus();
  // Either sign that an update, not a person, started this process. Both are
  // read every time: the second one records the version as it answers.
  const marked = isRelaunchAfterUpdate();
  const newVersion = isFirstStartOfVersion(CONFIG_DIR, currentVersion());
  const relaunchedAfterUpdate = marked || newVersion;
  if (
    !shouldPromptForUnlock({
      // passwordSupported is true in exactly that case (credentialStoreStatus).
      needsUnlock: status.passwordSupported,
      isTTY: Boolean(process.stdin.isTTY),
      relaunchedAfterUpdate
    })
  ) {
    if (status.passwordSupported && relaunchedAfterUpdate) {
      // announceSecureState prints the problem and the ways to unlock next.
      console.log(
        '\n[secure] First start after an update, so not waiting at this terminal for the connection password. Connecting now.'
      );
    }
    return;
  }

  console.log(`\n${status.problem}`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const password = await promptPassword('Connection password: ');
    if (!password) break;
    try {
      unlock(password);
      console.log('Unlocked.\n');
      return;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
    }
  }
  console.log(
    'Starting with those connections locked. Unlock from Runner Settings → Secrets in the app.\n'
  );
}

/** Print the credential store's state, at startup and on every unlock/lock, so
 *  the runner's console always says why work is or isn't possible. */
function announceSecureState(): void {
  const status = credentialStoreStatus();
  if (status.ready) {
    console.log(
      `[secure] Connections encrypted at rest (${status.keyStore}).`
    );
    return;
  }
  // Deliberately loud and actionable: this is the whole point of refusing the
  // plaintext fallback. The same text reaches the app via secureStatus.
  console.error(`\n[secure] ${status.problem}`);
  if (status.fix) console.error(`${status.fix}\n`);
}

/** Start the runner daemon: Socket.io to the server for signaling, then WebRTC
 *  data channels from UI clients — or, for a runner in socket mode, links
 *  relayed over that same socket. */
export async function startDaemon(config: RunnerConfig): Promise<void> {
  // First, before anything reads `config`: the refresh token comes off the
  // object and lives in the token keeper only (see `tokenKeeper` below). From
  // here on `config` holds nothing a session, a tunnel or the index service
  // must not see.
  const refreshTokenAtStart = takeRefreshToken(config);
  // Here, in the worker: the supervisor sits in spawnSync and can run no timer.
  keepLogLimited(serviceLogFile(CONFIG_DIR));
  watchProcessCount();
  // Once, after an update from a runner that had the desktop view.
  for (const line of removeDesktopViewLeftovers({ runnerDir: CONFIG_DIR })) {
    console.log(`[cleanup] ${line}`);
  }
  console.log(`Connecting to ${config.serverUrl} as "${config.runnerName}"...`);

  // Who owns this runner, from its own pairing token: the server-relayed job
  // and secret calls compare their actor against it (runner-access.ts).
  const ownerUserId = ownerIdFromRunnerToken(config.authToken);
  if (ownerUserId) ownerActor = { ...ownerActor, userId: ownerUserId };

  // ── Member levels (.specs/runner-member-access.md) ──
  // One level per board and member, local to this runner (access.ts,
  // runner-access.ts). The server never sets one. Every check reads this at
  // the moment of use, so a change counts for the member's next message.
  let grants: RunnerGrants = readRunnerGrants(CONFIG_DIR, ownerUserId);
  // Who runs dangerous jobs without the owner's approval per call, from the
  // same file.
  let dangerousGrants: RunnerDangerousGrants = readRunnerDangerousGrants(
    CONFIG_DIR,
    ownerUserId
  );
  const levelOn = (scope: ChannelScope, spaceSlug: unknown): ChannelLevel =>
    channelLevel(scope, grants, spaceSlug);
  /** Owner, or a member of `spaceSlug` the owner let run dangerous jobs
   *  without asking. Anyone else's call waits for the owner's approval. */
  const dangerousOn = (scope: ChannelScope, spaceSlug: unknown): boolean =>
    scope.role === 'owner' ||
    (typeof spaceSlug === 'string' &&
      scope.spaceSlugs.includes(spaceSlug) &&
      dangerousGranted(grants, dangerousGrants, spaceSlug, scope.userId));
  /** Owner, or a member with at least `needed` on some board they belong to.
   *  For traffic that names no board. */
  const reaches = (scope: ChannelScope, needed: RunnerAccessLevel): boolean =>
    scope.role === 'owner' ||
    scope.spaceSlugs.some((slug) => levelAtLeast(levelOn(scope, slug), needed));

  // With a TTY, ask here. Under systemd/launchd there is none: connect anyway
  // and let the owner unlock from the app.
  await promptForUnlockOnTty();

  convertVaultFilesAndReport();
  announceSecureState();

  const socket: TypedSocket = io(config.serverUrl, {
    auth: {
      runnerToken: config.authToken
    },
    autoConnect: false
  });

  const engines = new Map<string, BoardAgentEngine>();
  // The board MCP's hypervisor tools (session-hypervisor.ts): every board
  // this runner serves, and what the person a session acts for may do on
  // each by hand: the owner everything, a member their level there, read
  // from the grants at each call.
  const hypervisor: HypervisorHost = {
    runner: config.runnerName,
    owner: () => ({ ...ownerActor, role: 'owner' }),
    boards: () => [...engines.keys()],
    board: (slug) => engines.get(slug)?.hypervisorBoard() ?? null,
    level: (starter, slug) =>
      starter.role === 'owner'
        ? 'owner'
        : grantedLevel(grants, slug, starter.userId)
  };
  // One always-on service per runner, whichever board's engine is asked.
  const runnerService = runnerServiceHost();
  // The runner's parts, likewise runner-wide; their installs run in this
  // process, in the background.
  // Keep-awake (keepAwake.ts) is the machine's, so runner-wide; health
  // carries it with "Ready to be a server". Automatic mode reads the work
  // below (runnerWork) on its timer, which first fires after everything here
  // is set up. Just before automatic or While plugged in lets go, the server
  // gets a "going to sleep" frame with what this runner was doing
  // (sleepSnapshot), so the apps show it Asleep, not Offline, once the
  // socket drops; a hold taken again says it is awake after all. Not
  // connected then (Wi-Fi gone): no frame, and it shows Offline. On a
  // laptop those two modes also hold the lid closed (lidHold.ts), through
  // the grant Factiii Desktop sets up; with none, caffeinate only.
  const keepAwake = new KeepAwake(path.join(CONFIG_DIR, 'keepawake.json'), {
    lid:
      process.platform === 'darwin'
        ? new LidHold({ marker: path.join(CONFIG_DIR, 'lid-hold') })
        : undefined,
    thermal: () => readThermal(),
    work: () => runnerWork(),
    onSleep: (reason) => {
      if (!socket.connected) return;
      console.log(`[keep-awake] Letting the Mac sleep (${reason}); told the server.`);
      socket.emit('runner:going-to-sleep', sleepSnapshot(reason));
    },
    onWake: () => {
      if (socket.connected) socket.emit('runner:awake');
    }
  });
  const runnerParts = createPartsManager(() => serverReadiness(run, keepAwake));
  // Oakbox > Account > Backend's models, runner-wide like the parts.
  const localAiTags = createLocalAiTags();
  // The Vault's embedder (vault/embedder.ts): started on the first call,
  // stopped after ten quiet minutes. The Vault's ingest uses it.
  const embedder = vaultEmbedder(CONFIG_DIR, 10 * 60_000);
  // The models Ask and Categorize run on (vault/askEngines.ts).
  const askEngines = machineAskEngines();
  // Claude's and Codex's sign-ins with no board, for Oakbox (cliSignins.ts):
  // on the host target Ask runs them on, in the runner's one pair of CLI
  // homes, so every board's cached sign-in follows.
  const cliSignins = machineCliSignins(hostTarget(CONFIG_DIR), (cli, signedIn) => {
    for (const engine of engines.values()) engine.signinChanged(cli, signedIn);
  });
  // The Vault, runner-wide too (vault/daemonVault.ts). Who the owner let in
  // goes to the server beside the grants, which vouches only those of them
  // who are in the owner's shared vault on Factiii.
  const vault = createDaemonVault(
    CONFIG_DIR,
    ownerUserId,
    () => {
      if (socket.connected) {
        socket.emit('runner:access-state', { grants, vault: vault.members() });
      }
      // Taken out: a link with nothing else on this runner goes.
      for (const [scope, close] of [...linkClosers]) {
        if (scope.role !== 'owner' && !mayConnect(scope)) close();
      }
    },
    embedder,
    askEngines,
    machineCategorizeEngines(askEngines)
  );
  // Board events fan out only to channels scoped to that board, so a shared
  // member never receives another board's activity.
  const channelScopes = new Map<Wire, ChannelScope>();
  /** Each open link's opaque id, transport and when it opened, for the
   *  owner's Remote connections (runnerConnections.ts). Set and cleared with
   *  channelScopes. */
  const linkInfo = new Map<
    Wire,
    { id: string; transport: ChannelTransport; connectedAt: number }
  >();
  /** How to end each open link, by its scope object. A member with no level
   *  left on any board is cut off at once, not at their next reload. */
  const linkClosers = new Map<ChannelScope, () => void>();
  /** A member with no level on any board the server named gets no link at
   *  all: the server should not have relayed it, and the runner does not rely
   *  on that. */
  const mayConnect = (scope: ChannelScope): boolean =>
    reaches(scope, 'api') ||
    (scope.role === 'member' && scope.vault === true && vault.isMember(scope.userId));
  void vault.load().catch((err: unknown) => {
    console.error(`[vault] could not read who is let in: ${err instanceof Error ? err.message : String(err)}`);
  });

  /** One engine serves a space, but a track belongs to one peer, so frames fan
   *  out here. One peer gets them: the holder of the stream. The holder needs
   *  the Screens level, and a second viewer gets no frames at all
   *  (screen-holder.ts). */
  type SimulatorSink = VideoSink<ChannelScope> & {
    track: Track;
    packetizer: H264Packetizer;
  };
  const simulatorSinks = new Set<SimulatorSink>();
  let warnedNoSink = false;

  // ── Who has the video stream (screen-holder.ts) ──
  // One holder for the machine: there is one encoder, and each peer has one
  // video track, which the simulator uses.
  let screenHold: ScreenHold<ChannelScope> | null = null;

  /** Tell every channel that may watch who has the stream. A channel is told
   *  whether the holder is its own link, never which board they are on. */
  const tellScreenHolder = () => {
    for (const [dc, scope] of channelScopes) {
      if (!reaches(scope, 'screens')) continue;
      const frame = JSON.stringify({
        type: 'runner-screen-holder',
        holder: screenHolderView(screenHold, scope)
      });
      for (const part of chunkWire(frame)) {
        try {
          dc.sendMessage(part);
        } catch {
          // peer may have disconnected
        }
      }
    }
  };

  /** End the hold and stop its capture, so the next person can attach. */
  const releaseScreen = () => {
    const hold = screenHold;
    if (!hold) return;
    screenHold = null;
    engines.get(hold.spaceSlug)?.simulatorDetach();
    tellScreenHolder();
  };

  /** The hold ends with the holder's link, and with their Screens level. */
  const releaseScreenIfGone = (gone?: ChannelScope) => {
    if (!screenHold) return;
    const lost = !rawUseAllowed(
      levelOn(screenHold.link, screenHold.spaceSlug),
      'video'
    );
    if (screenHold.link === gone || lost) releaseScreen();
  };

  /** One access unit to the holder's track, while they hold `kind` and still
   *  have the level for it. True when the track took it. */
  const sendVideoFrame = (
    kind: ScreenHold<ChannelScope>['kind'],
    accessUnit: Uint8Array,
    capturedAt: number
  ): boolean => {
    if (!simulatorSinks.size) {
      if (!warnedNoSink) {
        warnedNoSink = true;
        console.log('[simulator] frames produced but no track is registered');
      }
      return false;
    }
    if (!screenHold || screenHold.kind !== kind) return false;
    // Read again per frame: the level may have gone since the attach.
    if (
      !rawUseAllowed(levelOn(screenHold.link, screenHold.spaceSlug), 'video')
    ) {
      return false;
    }
    return sendFrameToHolder(
      simulatorSinks,
      screenHold.link,
      accessUnit,
      capturedAt
    );
  };

  const sendSimulatorFrame = (accessUnit: Uint8Array, capturedAt: number) => {
    sendVideoFrame('simulator', accessUnit, capturedAt);
  };
  // terminal sessions are per-channel: terminal output is not multi-device sync.
  const terminalByChannel = new WeakMap<Wire, TerminalManager>();

  // The owner's Remote connections (runnerConnections.ts): every open link,
  // every board's terminals, the embedder, the machine's services. Read at
  // each ask; nothing here is kept for it but the link ids above.
  const runnerConnections = createRunnerConnections({
    ownerUserId,
    links: () =>
      [...channelScopes].flatMap(([dc, scope]) => {
        const info = linkInfo.get(dc);
        if (!info) return [];
        return [
          {
            ...info,
            scope,
            terminals: terminalByChannel.get(dc)?.openCount ?? 0
          }
        ];
      }),
    boards: () => engines.entries(),
    embedder,
    vaultIngest: () => vault.ingest(),
    services: () => runningServices(run),
    run
  });

  // Look up a card's exec target, but only across boards this channel has the
  // Terminals level on - so a member can't attach a shell to a board where
  // the owner gave them less, or to another board's workspace.
  const findCardTargetInScope = (
    scope: ChannelScope,
    postId: string
  ): ExecTarget | null => {
    for (const [spaceSlug, engine] of engines) {
      if (!rawUseAllowed(levelOn(scope, spaceSlug), 'terminal')) continue;
      const target = engine.getCardTarget(postId);
      if (target) return target;
    }
    return null;
  };

  // The card's agent cwd (its worktree), scoped like the session
  // lookup, so the terminal cds to where a --resume can find the CLI thread.
  const findCardWorkdirInScope = (
    scope: ChannelScope,
    postId: string
  ): string | null => {
    for (const [spaceSlug, engine] of engines) {
      if (!rawUseAllowed(levelOn(scope, spaceSlug), 'terminal')) continue;
      const wd = engine.getCardWorkspacePath(postId);
      if (wd) return wd;
    }
    return null;
  };

  // Runner-wide messages (e.g. self-update status) — every channel that has a
  // level somewhere, no board.
  const broadcastToAll = (msg: string) => {
    const frames = chunkWire(msg);
    for (const [dc, scope] of channelScopes) {
      if (!reaches(scope, 'api')) continue;
      for (const frame of frames) {
        try {
          dc.sendMessage(frame);
        } catch {
          // peer may have disconnected
        }
      }
    }
  };

  // Phases that end a run for the user: finished, or parked waiting on them.
  // The server turns these into a push when nobody has the card open.
  const END_PHASES = new Set<RunnerSessionEndPhase>([
    'complete',
    'done',
    'error',
    'awaiting-input',
    'bare-review'
  ]);

  // A pipeline run's phases while its agent works (automatic keep-awake).
  const WORKING_PHASES = new Set<string>([
    'starting',
    'research',
    'implement',
    'review'
  ]);

  // postId → last phase seen; only a CHANGE into an end phase is a finish.
  // The first summary reads as state, so a restart doesn't buzz about old news.
  const lastPhase = new Map<string, string>();

  // postId → last agent state seen, under the same first-sighting rule. A
  // terminal holds `bare-active` for its whole life, so a pipeline phase never
  // marks the moment its agent stops — this map is what does.
  const lastAgentState = new Map<string, AgentState | undefined>();

  /** The end phase this summary just crossed into, or null if nothing settled.
   *  Both maps are written on every summary, including the ones that report
   *  nothing, so "changed" keeps meaning changed-since-the-last-summary. */
  const settledEndPhase = (
    postId: string,
    s: Partial<CardAISessionSummary>
  ): RunnerSessionEndPhase | null => {
    const phase = s.phase ?? '';
    const previousPhase = lastPhase.get(postId);
    lastPhase.set(postId, phase);

    const previousState = lastAgentState.get(postId);
    lastAgentState.set(postId, s.agentState);

    if (
      previousPhase !== undefined &&
      previousPhase !== phase &&
      END_PHASES.has(phase as RunnerSessionEndPhase)
    ) {
      return phase as RunnerSessionEndPhase;
    }
    // Teardown emits a summary with no phase and no agent state, which resets
    // both maps — so a terminal killed mid-run stays silent, and a later
    // session on the same postId starts its own story.
    return agentSettledPhase(previousState, s.agentState);
  };

  // Shared-runner job calls running now, across boards (onJobState /
  // onJobEnd), for automatic keep-awake. A call waiting on a person is not
  // work.
  const runningJobCalls = new Set<string>();

  /** The runner's work right now, for automatic keep-awake: sessions whose
   *  agent is working (the factiii plugin's state) or whose pipeline is in a
   *  working phase, from the summaries above; and jobs, from the Running
   *  jobs rows (deploys, installs, indexing) and the job calls running. A
   *  plain shell with no AI in it is not counted. */
  const runnerWork = (): { sessions: number; jobs: number } => {
    let sessions = 0;
    for (const [postId, phase] of lastPhase) {
      if (
        lastAgentState.get(postId) === 'working' ||
        WORKING_PHASES.has(phase)
      ) {
        sessions++;
      }
    }
    let jobs = runningJobCalls.size;
    for (const engine of engines.values()) {
      jobs += engine.activity.list().filter((a) => a.state === 'working').length;
    }
    return { sessions, jobs };
  };

  // postId → the board and title its last summary named, and when, for the
  // "going to sleep" snapshot. Its phase and agent state are the maps above.
  const sessionSeen = new Map<
    string,
    { spaceSlug: string; title: string; at: number }
  >();

  /** What the server keeps while this runner sleeps: its sessions (newest
   *  first; titles and states only), jobs, when it last had work, and its
   *  power. A terminal torn down (no phase, no agent state) is left out. */
  const sleepSnapshot = (
    reason: RunnerSleepSnapshot['reason']
  ): RunnerSleepSnapshot => {
    const sessions = [...sessionSeen]
      .flatMap(([postId, seen]) => {
        const phase = lastPhase.get(postId) ?? '';
        const agentState = lastAgentState.get(postId) ?? null;
        if (!phase && !agentState) return [];
        return [
          {
            spaceSlug: seen.spaceSlug.slice(0, 128),
            postId: postId.slice(0, 64),
            title: seen.title.slice(0, 200),
            phase: phase.slice(0, 32),
            agentState,
            at: seen.at
          }
        ];
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, RUNNER_SLEEP_MAX_SESSIONS);
    return {
      reason,
      version: currentVersion().slice(0, 32),
      sessions,
      jobs: runnerWork().jobs,
      lastWorkAt: keepAwake.lastWork(),
      battery: keepAwake.power(),
      keepAwake: keepAwake.state().ac ? 'ac' : 'auto'
    };
  };

  const reportSettledSession = (spaceSlug: string, payload: unknown): void => {
    const s = payload as Partial<CardAISessionSummary> | null;
    if (!s || typeof s.postId !== 'string') return;
    sessionSeen.set(s.postId, {
      spaceSlug,
      title: s.taskTitle || 'Card',
      at: Date.now()
    });
    const phase = settledEndPhase(s.postId, s);
    if (!phase) return;
    try {
      socket.emit('runnerSessionFinished', {
        spaceSlug,
        postId: s.postId,
        taskTitle: s.taskTitle || 'Card',
        phase
      });
    } catch {
      // Offline runner: the job still finished locally, the phone just misses
      // this one. Nothing to retry against.
    }
  };

  // Board event — only channels with a level on this board receive it.
  // `ownerMsg`: what the runner's owner gets instead, when it differs (a
  // session summary with who started it, withStartedBy).
  const broadcastToBoard = (spaceSlug: string, msg: string, ownerMsg?: string) => {
    const frames = chunkWire(msg);
    const ownerFrames = ownerMsg === undefined ? frames : chunkWire(ownerMsg);
    for (const [dc, scope] of channelScopes) {
      if (levelOn(scope, spaceSlug) === 'none') continue;
      for (const frame of scope.role === 'owner' ? ownerFrames : frames) {
        try {
          dc.sendMessage(frame);
        } catch {
          // peer may have disconnected
        }
      }
    }
  };

  // What the runner knows of each board (spaces.json), held here because
  // every event frame reads it. Refreshed whenever seeBoard records a change.
  let boards = knownBoards(CONFIG_DIR);
  const boardOf = (slug: string) =>
    boards.find((b) => b.slug === slug) ?? boards.find((b) => b.was?.includes(slug));
  /** How the runner names a board to a person: its space name, slug after. */
  const boardName = (slug: string): string => boardLabel(boardOf(slug), slug);
  /** The slug the server knows a board by today. An engine keeps the slug it
   *  was made with, and that is a former one after a rename. */
  const liveSlug = (slug: string): string => boardOf(slug)?.slug ?? slug;

  /** Ask the server for the id, slug and name of every board this runner
   *  keeps (`runner:board-names`). A board renamed while the runner was away
   *  comes back under its new slug and moves like any rename. A server too
   *  old to answer leaves things as they are. */
  async function askBoardNames(): Promise<void> {
    const spaceSlugs = [...new Set([...listConfiguredSlugs(), ...boards.map((b) => b.slug)])];
    if (!spaceSlugs.length || !socket.connected) return;
    try {
      const reply = await socket
        .timeout(BOARD_NAMES_ACK_TIMEOUT_MS)
        .emitWithAck('runner:board-names', { spaceIds: boards.map((b) => b.id), spaceSlugs });
      if ('error' in reply) return;
      for (const board of reply.boards) seeBoard(board.id, board.slug, board.name);
    } catch {
      // No answer: an older server. The id on the next message still finds
      // a renamed board.
    }
  }

  /** A message named board `spaceId` as `spaceSlug`. When that is a new slug
   *  for a board this runner knows, its folder has moved (boardRegistry.ts);
   *  move its member levels with it and tell the server, which checks them. */
  function seeBoard(spaceId: number | undefined, spaceSlug: string, spaceName?: string): void {
    if (spaceId === undefined) return;
    // Most messages name a board exactly as it is already known: nothing to
    // write, and no file read on every dispatch.
    const known = boards.find((b) => b.id === spaceId);
    if (known?.slug === spaceSlug && (!spaceName?.trim() || known.name === spaceName.trim())) return;
    const renamed = noteBoard(CONFIG_DIR, spaceId, spaceSlug, spaceName);
    boards = knownBoards(CONFIG_DIR);
    if (!renamed) return;
    console.log(
      `[boards] ${boardName(spaceSlug)} was ${renamed.from}. Its folder and member levels moved with it.`
    );
    const nextGrants = rekeyBoard(grants, renamed);
    const nextDangerous = rekeyBoard(dangerousGrants, renamed);
    if (!ownerUserId || (nextGrants === grants && nextDangerous === dangerousGrants)) return;
    writeRunnerGrants(CONFIG_DIR, ownerUserId, nextGrants, nextDangerous);
    grants = nextGrants;
    dangerousGrants = nextDangerous;
    if (socket.connected) socket.emit('runner:access-state', { grants, vault: vault.members() });
  }

  function getEngine(spaceSlug: string, spaceId?: number): BoardAgentEngine {
    seeBoard(spaceId, spaceSlug);
    let engine = engines.get(spaceSlug);
    if (!engine) {
      const send = (event: string, data: unknown) => {
        const msg: EventMessage = {
          type: 'event',
          spaceSlug,
          // Read per frame: a rename names the board anew at once.
          spaceName: boardOf(spaceSlug)?.name,
          event,
          payload: data
        };
        if (event.endsWith(':session-update')) {
          const forOwner = withStartedBy(data, engines.get(spaceSlug), ownerActor);
          broadcastToBoard(
            spaceSlug,
            JSON.stringify(msg),
            JSON.stringify({ ...msg, payload: forOwner })
          );
          reportSettledSession(spaceSlug, data);
        } else {
          broadcastToBoard(spaceSlug, JSON.stringify(msg));
        }
      };

      engine = new BoardAgentEngine({
        // Shipped as source and compiled per host: the private frameworks the
        // simulator helpers bind to move between Xcode versions.
        nativeDir: path.join(__dirname, '..', 'native'),
        runnerService,
        runnerParts,
        spaceSlug,
        // Stable board id, carried so a slug rename doesn't lose the board's
        // identity. Sessions get it as FACTIII_SPACE_ID, which the CLI looks
        // up for the board's slug and name now. An engine built at startup
        // has no message to take it from, so it comes from spaces.json.
        spaceId: spaceId ?? boards.find((b) => b.slug === spaceSlug)?.id,
        emitter: createEventSink(send, spaceSlug),
        onSimulatorFrame: sendSimulatorFrame,
        // One encoder for the machine. Every peer has a single video track, so
        // a second space attaching would put two H.264 streams on it —
        // different SPS, independent sequence numbers and timestamps — and
        // neither would decode.
        onSimulatorAttach: () => {
          for (const [slug, other] of engines) {
            if (slug !== spaceSlug) other.simulatorDetach();
          }
        },
        // Re-report connection facts after any config write so the UI badges
        // update when a token is added or cleared.
        configProvider: {
          ...localConfigProvider,
          writeConfig(slug, cfg) {
            localConfigProvider.writeConfig(slug, cfg);
            reportConnections();
          },
        },
        // Read at each use: the token is refreshed while the engine lives. No
        // session gets a copy: the board MCP is relayed by the engine over the
        // secrets socket, and a tunnel asks for it over that same socket.
        runnerToken: () => config.authToken,
        // Board MCP is server-hosted: the engine's relay posts to this base URL.
        serverUrl: config.serverUrl,
        // Disconnecting GitHub revokes the token at GitHub through the server,
        // which holds the OAuth App secret. The access token is read at the
        // call, as above.
        revokeGithubToken: (token) =>
          revokeGithubTokenViaServer(config.serverUrl, config.authToken, token),
        // Shared-runner jobs report to the server, which relays to the caller
        // and buffers the log. Offline: the call still runs, and its state
        // stays readable through jobStatus.
        onJobLog: (callId, seq, text) => {
          if (socket.connected) socket.emit('runner:job-log', { callId, seq, text });
        },
        // Phases of a call the server relayed, so its row can say "waiting
        // for approval". Calls from a channel or a session here have no row.
        onJobState: (callId, state, via) => {
          if (state === 'running') runningJobCalls.add(callId);
          else runningJobCalls.delete(callId);
          if (via === 'api' && socket.connected) {
            socket.emit('runner:job-state', { callId, state });
          }
        },
        onJobEnd: (callId, state, exitCode) => {
          runningJobCalls.delete(callId);
          if (socket.connected) {
            socket.emit('runner:job-end', { callId, state, exitCode });
          }
        },
        // A session on this runner that calls a job acts as the owner.
        ownerActor: () => ownerActor,
        hypervisor,
        // Only this id may approve a member's dangerous job call.
        runnerOwnerId: ownerUserId,
        // A member's dangerous job call waits on the owner: ask the server
        // to push the owner. An older server ignores it; the call still
        // waits, then ends denied.
        onDangerousApproval: (request) => {
          if (!socket.connected) return;
          // The slug the server knows the board by now: this engine may be
          // one from before a rename, and the server finds the board by it.
          socket.emit('runner:dangerous-approval', {
            spaceSlug: liveSlug(spaceSlug),
            requestId: request.id,
            actor: request.caller,
            job: request.job
          });
        },
        // Only a board with a member on it asks the server to push
        // approvers: without one no member calls jobs, and the owner sees
        // the prompt in the app.
        onGateOpen: (request) => {
          // Member levels move to the new slug on a rename (seeBoard).
          const live = liveSlug(spaceSlug);
          if (!Object.hasOwn(grants, live) || !socket.connected) return;
          socket.emit('runner:gate-open', {
            spaceSlug: live,
            requestId: request.id,
            actor: request.caller ?? ownerActor,
            job: request.job ?? null,
            keys: request.keys,
            inbox: Boolean(request.inbox)
          });
        }
      });
      engines.set(spaceSlug, engine);
      // First touch after (re)start: reattach the workspace and rehydrate
      // in-flight cards. Fire-and-forget, so dispatch isn't blocked on it.
      void engine.reattachAndHydrate();
    }
    return engine;
  }

  // Build every space's engine at startup so interrupted card work resumes
  // without waiting for a client (see reattachAndHydrate).
  for (const slug of listConfiguredSlugs()) {
    getEngine(slug);
  }

  // Report which private connections exist here - the fact only, never the
  // token. Best-effort: a dropped report self-heals on the next connect.
  const reportConnections = (): void => {
    void getConfiguredConnections()
      .then((connections) => socket.emit('runnerConnections', { connections }))
      .catch(() => {
        // socket not ready, or a probe failed — the next connect handler
        // re-reports
      });
  };

  // Push the credential-store state to every open panel: unlocking from one
  // device must light up the others rather than leave them on a stale padlock.
  const broadcastSecure = (status: SecureStoreStatus): void => {
    broadcastToAll(JSON.stringify({ type: 'runner-secure', status }));
    reportConnections();
  };

  // Started with connections locked. The unlock comes from the app (handled
  // in this process) or from `factiii-runner password` (another process, which
  // rewrites the files on disk and cannot tell us), so watch for the files
  // becoming readable rather than for either event: say so on the console,
  // and tell every open client. The watch ends with the lock.
  if (credentialStoreStatus().passwordSupported) {
    watchForUnlock(
      () => credentialStoreStatus().passwordSupported,
      () => {
        announceSecureState();
        broadcastSecure(credentialStoreStatus());
      },
      EXTERNAL_UNLOCK_POLL_MS
    );
  }

  /** Give one member a level on one board, audit it there, and cut that
   *  member off anything they lose: their open terminals and the video stream
   *  go now, not at reconnect. Only that member on that board moves. */
  const setGrant = (
    spaceSlug: string,
    payload: unknown,
    ctx: ActionContext
  ): void => {
    if (!ownerUserId) {
      throw new Error(
        'This runner does not know its owner, so it cannot give access. Pair it again with "factiii-runner connect".'
      );
    }
    const change = (payload ?? {}) as {
      userId?: unknown;
      level?: unknown;
      dangerous?: unknown;
    };
    const userId = typeof change.userId === 'string' ? change.userId : '';
    const level = RUNNER_ACCESS_LEVELS.find((l) => l === change.level);
    const dangerous = typeof change.dangerous === 'boolean' ? change.dangerous : undefined;
    // An older app sends the two switches. Nothing in them names a member, so
    // nothing changes.
    if (
      !userId ||
      (!level && dangerous === undefined) ||
      typeof spaceSlug !== 'string' ||
      !spaceSlug
    ) {
      throw new Error(
        'This runner gives access one member at a time. Update the app to change it.'
      );
    }
    if (userId === ownerUserId) {
      throw new Error('The owner of this runner already has everything.');
    }
    if (!level) {
      setDangerousGrant(spaceSlug, userId, dangerous === true, ctx);
      return;
    }
    const before = grantedLevel(grants, spaceSlug, userId);
    if (before === level) return;
    const next = withGrant(grants, spaceSlug, userId, level);
    // None takes the Dangerous jobs permission with it: it counts only with
    // the API level, and a member given a level again starts without it.
    const dropsDangerous = level === 'none' && dangerousListed(spaceSlug, userId);
    const nextDangerous = dropsDangerous
      ? withDangerousGrant(dangerousGrants, spaceSlug, userId, false)
      : dangerousGrants;
    writeRunnerGrants(CONFIG_DIR, ownerUserId, next, nextDangerous);
    grants = next;
    dangerousGrants = nextDangerous;
    // The server refuses a job call and a link early by this; the runner
    // still checks on its own (relayedCallRefusal, channelLevel).
    if (socket.connected) socket.emit('runner:access-state', { grants, vault: vault.members() });
    const detail = `user ${userId} on ${boardName(spaceSlug)}: ${before} -> ${level}${
      dropsDangerous ? '; dangerous jobs on -> off' : ''
    }`;
    console.log(`[access] ${detail}.`);
    void getEngine(spaceSlug).auditRunnerEvent('shared-change', detail, ctx);

    for (const [dc, scope] of channelScopes) {
      if (scope.role === 'owner' || scope.userId !== userId) continue;
      // A terminal names no board once it is open, so a member who lost the
      // Terminals level here loses every terminal on this link. One on a
      // board where they still have the level can be opened again.
      if (
        levelAtLeast(before, 'terminals') &&
        !levelAtLeast(level, 'terminals')
      ) {
        terminalByChannel.get(dc)?.destroyAll();
      }
    }
    tellMemberAccess(userId, spaceSlug);
    releaseScreenIfGone();
    // No level left on any board: the link itself goes.
    for (const [scope, close] of [...linkClosers]) {
      if (scope.role !== 'owner' && scope.userId === userId && !mayConnect(scope)) {
        close();
      }
    }
    // Someone who just got Screens learns who has the stream.
    tellScreenHolder();
  };

  /** Whether `userId` is on the Dangerous jobs list of `spaceSlug`, by the
   *  list alone (the level is not looked at). */
  const dangerousListed = (spaceSlug: string, userId: string): boolean =>
    Object.hasOwn(dangerousGrants, spaceSlug) &&
    dangerousGrants[spaceSlug].includes(userId);

  /** Turn one member's Dangerous jobs permission on one board on or off,
   *  and audit it there. Nothing else moves: their level, terminals and
   *  video stay as they are. */
  const setDangerousGrant = (
    spaceSlug: string,
    userId: string,
    allowed: boolean,
    ctx: ActionContext
  ): void => {
    if (!ownerUserId) return;
    if (allowed && !levelAtLeast(grantedLevel(grants, spaceSlug, userId), 'api')) {
      throw new Error(
        'Give this member the API level first: dangerous jobs are API calls.'
      );
    }
    if (dangerousListed(spaceSlug, userId) === allowed) return;
    const next = withDangerousGrant(dangerousGrants, spaceSlug, userId, allowed);
    writeRunnerGrants(CONFIG_DIR, ownerUserId, grants, next);
    dangerousGrants = next;
    const detail = `user ${userId} on ${boardName(spaceSlug)}: dangerous jobs ${
      allowed ? 'off -> on' : 'on -> off'
    }`;
    console.log(`[access] ${detail}.`);
    void getEngine(spaceSlug).auditRunnerEvent('shared-change', detail, ctx);
    tellMemberAccess(userId, spaceSlug);
  };

  /** The member's app learns its new access on this board without asking. */
  const tellMemberAccess = (userId: string, spaceSlug: string): void => {
    for (const [dc, scope] of channelScopes) {
      if (scope.role === 'owner' || scope.userId !== userId) continue;
      const frame = JSON.stringify({
        type: 'event',
        spaceSlug,
        event: `board-agent:${spaceSlug}:runner-access`,
        payload: accessState(scope, spaceSlug)
      });
      for (const part of chunkWire(frame)) {
        try {
          dc.sendMessage(part);
        } catch {
          // peer may have disconnected
        }
      }
    }
  };

  const accessState = (
    scope: ChannelScope,
    spaceSlug: string
  ): RunnerAccessState => {
    if (scope.role !== 'owner') {
      const level = levelOn(scope, spaceSlug);
      return {
        level: level === 'owner' ? 'none' : level,
        grants: {},
        dangerousGrants: []
      };
    }
    return {
      level: 'screens',
      grants: Object.hasOwn(grants, spaceSlug) ? { ...grants[spaceSlug] } : {},
      // Only members who still have a level: None already dropped the rest.
      dangerousGrants: Object.hasOwn(dangerousGrants, spaceSlug)
        ? dangerousGrants[spaceSlug].filter((id) =>
            dangerousGranted(grants, dangerousGrants, spaceSlug, id)
          )
        : []
    };
  };

  const channelAccess: ChannelAccess = {
    level: levelOn,
    state: accessState,
    dangerous: dangerousOn,
    set: setGrant,
    screen: (scope, spaceSlug, request) => {
      const decision = decideScreenUse(screenHold, {
        link: scope,
        userId: scope.userId,
        name: scope.name || (scope.role === 'owner' ? 'The owner' : 'A member'),
        spaceSlug,
        ...request,
        hasVideo: [...simulatorSinks].some(
          (sink) => sink.link === scope && sink.track.isOpen()
        )
      });
      const changed =
        decision.holder?.link !== screenHold?.link ||
        decision.holder?.kind !== screenHold?.kind;
      screenHold = decision.holder;
      if (changed) tellScreenHolder();
      return { run: decision.run, refusal: decision.refusal };
    },
    screenFailed: (scope, kind) => {
      // The answer can come after the same link attached the simulator: a
      // failed desktop attach must not take that hold away.
      if (screenHold?.link === scope && screenHold.kind === kind) {
        releaseScreen();
      }
    }
  };

  // ── Shared runner: server-relayed jobs, inbox, audit ──
  // The server checked board membership (and ownership, for the audit read)
  // before sending any of these; `actor` is what it vouches for. The runner
  // still refuses a space it does not serve, so a slug can never conjure an
  // engine, and a job is still a name resolved against the default branch.

  const knownEngine = (spaceSlug: string, spaceId?: number): BoardAgentEngine => {
    // First, so a board renamed while this runner was offline is found
    // under its new slug.
    seeBoard(spaceId, spaceSlug);
    if (!listConfiguredSlugs().includes(spaceSlug)) {
      throw new Error('This runner does not serve that space.');
    }
    return getEngine(spaceSlug, spaceId);
  };
  /** The actor on an event whose declared shape does not carry one yet
   *  (recipient, audit read). Missing = no actor, which fails closed. */
  const relayedActor = (data: object): { userId: string } | undefined => {
    const actor = (data as { actor?: { userId?: unknown } }).actor;
    return actor && actor.userId !== undefined
      ? { userId: String(actor.userId) }
      : undefined;
  };
  /** Below the API level on that board = owner only; the audit log is always
   *  owner only. Throws the refusal, so every handler's catch acks it. */
  const assertRelayed = (
    call: RelayedCall,
    spaceSlug: string,
    actor: { userId: string } | undefined
  ): void => {
    const refused = relayedCallRefusal({
      call,
      grants,
      spaceSlug,
      ownerUserId,
      actorUserId: String(actor?.userId ?? '')
    });
    if (refused) throw new Error(refused);
  };
  const ackError = (err: unknown) => ({
    error: err instanceof Error ? err.message : String(err)
  });
  /** `spaceSlug` names the board a job call runs on, for the Dangerous
   *  jobs permission there; without it a member's dangerous job call waits
   *  for the owner. */
  const apiContext = (
    actor: { userId: string; name: string },
    spaceSlug?: string
  ): ActionContext => ({
    actor: { userId: String(actor.userId), name: actor.name },
    via: 'api',
    role:
      ownerUserId !== null && String(actor.userId) === ownerUserId
        ? 'owner'
        : 'member',
    dangerous:
      spaceSlug !== undefined &&
      dangerousGranted(grants, dangerousGrants, spaceSlug, String(actor.userId))
  });

  // Cancel by call id: the starter or the owner only (the engine checks).
  socket.on('runner:job-cancel', (data, ack) => {
    void (async () => {
      try {
        for (const engine of engines.values()) {
          if (!engine.hasJobCall(data.callId)) continue;
          ack(
            await engine.jobCancel(
              { callId: data.callId },
              apiContext(data.actor)
            )
          );
          return;
        }
        ack({ error: RUNNER_NO_SUCH_JOB_CALL });
      } catch (err) {
        ack(ackError(err));
      }
    })();
  });

  socket.on('runner:job-list', (data, ack) => {
    void (async () => {
      try {
        assertRelayed('job-list', data.spaceSlug, data.actor);
        ack(await knownEngine(data.spaceSlug, data.spaceId).jobsList());
      } catch (err) {
        ack(ackError(err));
      }
    })();
  });

  socket.on('runner:job-call', (data, ack) => {
    void (async () => {
      try {
        assertRelayed('job-call', data.spaceSlug, data.actor);
        // A dangerous job from a member without the permission waits for
        // the owner: the job runner decides on the definition it runs
        // (apiContext carries the permission).
        await knownEngine(data.spaceSlug, data.spaceId).jobsCall(
          { job: data.job, params: data.params },
          apiContext(data.actor, data.spaceSlug),
          data.callId
        );
        ack({ accepted: true });
      } catch (err) {
        ack(ackError(err));
      }
    })();
  });

  socket.on('runner:job-status-request', (data, ack) => {
    for (const engine of engines.values()) {
      if (!engine.hasJobCall(data.callId)) continue;
      ack(
        engine.jobStatus({ callId: data.callId, afterSeq: data.afterSeq })
      );
      return;
    }
    ack({ error: RUNNER_NO_SUCH_JOB_CALL });
  });

  socket.on('runner:secret-submit', (data, ack) => {
    void (async () => {
      try {
        assertRelayed('secret-submit', data.spaceSlug, data.actor);
        ack(
          await knownEngine(data.spaceSlug, data.spaceId).secretsInboxSubmit({
            submitId: data.submitId,
            key: data.key,
            kind: data.kind,
            ciphertext: data.ciphertext,
            actor: apiContext(data.actor).actor
          })
        );
      } catch (err) {
        ack(ackError(err));
      }
    })();
  });

  socket.on('runner:recipient-request', (data, ack) => {
    void (async () => {
      try {
        assertRelayed('recipient-request', data.spaceSlug, relayedActor(data));
        ack({ recipient: await knownEngine(data.spaceSlug, data.spaceId).secretsRecipient() });
      } catch (err) {
        ack(ackError(err));
      }
    })();
  });

  socket.on('runner:audit-read', (data, ack) => {
    void (async () => {
      try {
        assertRelayed('audit-read', data.spaceSlug, relayedActor(data));
        ack(await knownEngine(data.spaceSlug, data.spaceId).auditRead(data.query ?? {}));
      } catch (err) {
        ack(ackError(err));
      }
    })();
  });

  socket.on('connect', () => {
    console.log(`Connected. Runner "${config.runnerName}" is online.`);
    console.log('Waiting for connections from UI clients...\n');
    reportConnections();
    // The server keeps the last report per connection, so every (re)connect
    // says it again; until it does, the server treats every member as None.
    socket.emit('runner:access-state', { grants, vault: vault.members() });
    sendHeartbeat();
    void refreshToken(false);
    void askBoardNames();
  });

  // A space's name, and so its slug, changed on the server.
  socket.on('runner:space-renamed', ({ spaceId, slug, name }) => {
    seeBoard(spaceId, slug, name);
  });

  socket.on('disconnect', (reason: string) => {
    console.log(`Disconnected: ${reason}. Reconnecting...`);
    // The server drops every relayed link with the socket, and a client dials
    // a fresh one once it sees this runner come back.
    for (const link of socketLinks.values()) link.close();
  });

  socket.on('connect_error', (err: Error) => {
    console.error(`Connection error: ${err.message}`);
    // What the server says to an access token it cannot accept or refresh: a
    // bad signature, a refresh token left unused past its idle limit, a
    // legacy token on a runner that already holds a refresh token, or a token
    // chain the server ended because a replaced refresh token was used.
    if (err.message === 'invalid runner token') {
      console.error(
        'The server no longer accepts this runner\'s token. Pair it again with "factiii-runner connect".'
      );
    }
  });

  // ── Heartbeat and token refresh (.specs/runner-link.md, "Runner token") ──
  // The heartbeat tells the server this runner's version and that it is here;
  // the server stores both on the runner's row. A server from before the event
  // ignores it.
  const sendHeartbeat = (): void => {
    if (socket.connected) {
      socket.emit('runner:heartbeat', { version: currentVersion() });
    }
  };

  /** Trade the refresh token for a new access token and a new refresh token
   *  when the access token is due. `force` is the server saying the access
   *  token already expired, whatever this clock thinks. The new pair is saved
   *  the way the pairing saved the first one (writeRunnerConfig: the
   *  keychain-sealed config.json, on every platform), read back, confirmed to
   *  the server (`runner:token-saved`) and used for the next handshake. A
   *  failure changes nothing: the current token stays, and the next try is an
   *  hour away (RUNNER_TOKEN_REFRESH_RETRY_MS), or at once if the server says
   *  the token expired. The rules are in createTokenKeeper (runnerToken.ts). */
  const tokenKeeper = createTokenKeeper({
    config,
    refreshToken: refreshTokenAtStart,
    requestRefresh: (data) =>
      socket
        .timeout(RUNNER_TOKEN_REFRESH_ACK_TIMEOUT_MS)
        .emitWithAck('runner:token-refresh', data),
    requestSaved: (data) =>
      socket
        .timeout(RUNNER_TOKEN_REFRESH_ACK_TIMEOUT_MS)
        .emitWithAck('runner:token-saved', data),
    write: writeRunnerConfig,
    read: readRunnerConfig,
    onRefreshed: (reconnect) => {
      socket.auth = { runnerToken: config.authToken };
      // The connection was refresh-only. Come back with the new token.
      if (reconnect) socket.disconnect().connect();
    },
    log: (line) => console.log(line)
  });
  const refreshToken = async (force: boolean): Promise<void> => {
    if (!socket.connected) return;
    await tokenKeeper.run(force);
  };

  socket.on('runner:token-expired', () => {
    console.log('[token] The token expired. Asking the server for a new one...');
    void refreshToken(true);
  });

  const heartbeatTimer = setInterval(() => {
    sendHeartbeat();
    void refreshToken(false);
  }, heartbeatIntervalMs());
  // status.factiii.com, apart from Factiii's servers: off until the owner
  // sets it (statusPage.ts).
  const stopStatusBeat = startStatusHeartbeat({
    runnerName: () => config.runnerName,
    version: currentVersion(),
    level: async () => (await machineHealth(run)).level
  });

  /** Serve one client link: scope it, replay state on open, and dispatch what
   *  it sends. Shared by both transports — a WebRTC data channel and a link
   *  relayed over the server socket — which differ only in how a frame moves. */
  const attachChannel = (
    dc: Wire,
    scope: ChannelScope,
    peerId: string,
    /** Which transport carries it: the relay is the server, so a password
     *  or a secret value is refused on it (relaySecretsRefusal). */
    transport: ChannelTransport,
    /** Ends the whole link (the peer connection, or the relayed link). */
    closeLink: () => void,
    onGone?: () => void
  ) => {
    channelScopes.set(dc, scope);
    const linkId = randomBytes(8).toString('hex');
    linkInfo.set(dc, { id: linkId, transport, connectedAt: Date.now() });
    linkClosers.set(scope, closeLink);

    // Per-channel reassembler — large incoming messages (e.g. ask
    // payloads with full board context) arrive split into chunks.
    const reassembler = makeChunkReassembler();

    const sendToChannel = (msg: string) => {
      for (const frame of chunkWire(msg)) {
        try {
          dc.sendMessage(frame);
        } catch {
          // peer may have disconnected
        }
      }
    };

    // terminal produces a frame per stdout chunk; the manager chunks itself.
    const sendRawToChannel = (frame: string) => {
      try {
        dc.sendMessage(frame);
      } catch {
        // peer may have disconnected
      }
    };

    terminalByChannel.set(
      dc,
      new TerminalManager(
        sendRawToChannel,
        (postId) => findCardTargetInScope(scope, postId),
        (postId) => findCardWorkdirInScope(scope, postId)
      )
    );

    // Replay session state to whoever just connected: session-update only
    // fires on phase changes, so a mid-session refresh would see nothing.
    dc.onOpen(() => {
      // Tell the client which version this runner is on, so the board can
      // compare against npm's latest and offer an update if it's behind.
      sendToChannel(
        JSON.stringify({ type: 'runner-info', version: currentVersion() })
      );
      // And, to its owner, how its connection storage is doing - the same
      // frame an unlock broadcasts. It is how the app learns, with no settings
      // panel open, that this runner is waiting for its old password.
      if (scope.role === 'owner') {
        sendToChannel(
          JSON.stringify({
            type: 'runner-secure',
            status: credentialStoreStatus()
          })
        );
      }

      // Who has the video stream, for a panel that opens later.
      if (reaches(scope, 'screens')) {
        sendToChannel(
          JSON.stringify({
            type: 'runner-screen-holder',
            holder: screenHolderView(screenHold, scope)
          })
        );
      }

      for (const [spaceSlug, engine] of engines.entries()) {
        // Only replay boards this channel has a level on.
        if (levelOn(scope, spaceSlug) === 'none') continue;
        const sessions = engine.cardSessions();
        for (const summary of Object.values(sessions)) {
          const msg = JSON.stringify({
            type: 'event',
            spaceSlug,
            event: `board-agent:${spaceSlug}:session-update`,
            payload:
              scope.role === 'owner' ? withStartedBy(summary, engine, scope) : summary
          });
          sendToChannel(msg);
        }
        // Events only ever pushed on change - a waiting secrets prompt
        // above all (see connectReplay).
        for (const { event, payload } of engine.connectReplay()) {
          sendToChannel(
            JSON.stringify({
              type: 'event',
              spaceSlug,
              event: `board-agent:${spaceSlug}:${event}`,
              payload
            })
          );
        }
        // Same reason, for the non-session work: a client that connects
        // mid-deploy would otherwise see nothing until the next phase.
        for (const activity of engine.activity.list()) {
          sendToChannel(
            JSON.stringify({
              type: 'event',
              spaceSlug,
              event: `board-agent:${spaceSlug}:activity-update`,
              payload: activity
            })
          );
        }
      }
    });

    dc.onMessage((raw: string | Buffer) => {
      const rawStr = typeof raw === 'string' ? raw : raw.toString('utf-8');
      const msgStr = reassembler.feed(rawStr);
      if (msgStr === null) return;

      try {
        const parsed = JSON.parse(msgStr) as {
          type?: string;
          spaceSlug?: string;
          event?: string;
          payload?: unknown;
        };
        if (parsed.type === 'terminal') {
          // A terminal is a shell as the runner user: owner-only unless
          // the owner gave this member the Terminals level, whatever the
          // client offers to show. Which board is checked when it opens
          // (findCardTargetInScope).
          if (!reaches(scope, 'terminals')) return;
          const mgr = terminalByChannel.get(dc);
          if (mgr) {
            mgr.handle(
              parsed as unknown as Parameters<TerminalManager['handle']>[0]
            );
          }
          return;
        }
        if (
          parsed.type === 'runner-control' &&
          (parsed as { action?: string }).action === 'update'
        ) {
          // No board: the self-update is the owner's on all of them.
          const anyBoard = scope.role === 'owner' ? 'owner' : 'none';
          if (!rawUseAllowed(anyBoard, 'runner-control')) return;
          applyUpdateAndRestart();
          return;
        }
        if (
          parsed.type === 'broadcast' &&
          parsed.spaceSlug &&
          parsed.event
        ) {
          // Sender must have a level on this board, and the relay only
          // reaches other channels that have one.
          if (levelOn(scope, parsed.spaceSlug) === 'none') return;
          const eventMsg = JSON.stringify({
            type: 'event',
            event: `board-agent:${parsed.spaceSlug}:${parsed.event}`,
            payload: parsed.payload
          });
          const frames = chunkWire(eventMsg);
          for (const [other, otherScope] of channelScopes) {
            if (other === dc) continue;
            if (levelOn(otherScope, parsed.spaceSlug) === 'none') continue;
            for (const frame of frames) {
              try {
                other.sendMessage(frame);
              } catch {
                break;
              }
            }
          }
          return;
        }
      } catch {
        // fall through to dispatch handling
      }

      handleDataChannelMessage(
        msgStr,
        scope,
        transport,
        sendToChannel,
        broadcastToBoard,
        getEngine,
        broadcastSecure,
        channelAccess,
        vault,
        localAiTags,
        askEngines,
        runnerParts,
        cliSignins,
        keepAwake,
        nuke,
        {
          connections: () => runnerConnections.connections(linkId),
          logs: (payload) => runnerConnections.logs(payload)
        }
      );
    });

    dc.onClosed(() => {
      console.log(`Link closed with ${peerId}`);
      channelScopes.delete(dc);
      linkInfo.delete(dc);
      const mgr = terminalByChannel.get(dc);
      if (mgr) {
        mgr.destroyAll();
        terminalByChannel.delete(dc);
      }
      // A dropped link must not keep the screen: free it for the next person.
      // A peer's link is gone once its last channel is.
      if (![...channelScopes.values()].includes(scope)) {
        linkClosers.delete(scope);
        releaseScreenIfGone(scope);
      }
      onGone?.();
    });
  };

  // Socket-relay links, keyed `${fromSocketId}:${linkId}`: the transport for a
  // client on a network that blocks WebRTC. Every frame rides the server
  // socket; past that, a link is served exactly like a data channel. No
  // simulator video here — that needs a media track.
  const socketLinks = new Map<
    string,
    { feed: (frame: string) => void; close: () => void }
  >();

  socket.on('runnerSocketOpen', ({ fromSocketId, linkId, scope }) => {
    const key = `${fromSocketId}:${linkId}`;
    socketLinks.get(key)?.close();
    const channelScope = toChannelScope(scope);
    if (!channelScope) {
      console.error(
        `Refused socket link from ${fromSocketId}: the server sent no scope`
      );
      socket.emit('runnerSocketClose', { targetSocketId: fromSocketId, linkId });
      return;
    }
    if (!mayConnect(channelScope)) {
      console.error(
        `Refused socket link from ${fromSocketId}: no level on any board`
      );
      socket.emit('runnerSocketClose', { targetSocketId: fromSocketId, linkId });
      return;
    }
    console.log(`Socket link opened with ${fromSocketId}`);

    let open = true;
    let handleOpen = () => {};
    let handleMessage: (msg: string | Buffer) => void = () => {};
    let handleClosed = () => {};
    const wire: Wire = {
      sendMessage: (frame) => {
        if (!open) return false;
        socket.emit('runnerSocketData', {
          targetSocketId: fromSocketId,
          linkId,
          data: frame
        });
        return true;
      },
      onOpen: (cb) => {
        handleOpen = cb;
      },
      onMessage: (cb) => {
        handleMessage = cb;
      },
      onClosed: (cb) => {
        handleClosed = cb;
      }
    };
    const close = () => {
      if (!open) return;
      open = false;
      socketLinks.delete(key);
      handleClosed();
    };
    socketLinks.set(key, { feed: (frame) => handleMessage(frame), close });

    attachChannel(wire, channelScope, fromSocketId, 'socket', () => {
      socket.emit('runnerSocketClose', { targetSocketId: fromSocketId, linkId });
      close();
    });
    // Opened goes out first so the client has a channel before the replay
    // that handleOpen sends; the server relays both in order.
    socket.emit('runnerSocketOpened', { targetSocketId: fromSocketId, linkId });
    handleOpen();
  });

  socket.on('runnerSocketData', ({ fromSocketId, linkId, data }) => {
    socketLinks.get(`${fromSocketId}:${linkId}`)?.feed(data);
  });

  socket.on('runnerSocketClose', ({ fromSocketId, linkId }) => {
    socketLinks.get(`${fromSocketId}:${linkId}`)?.close();
  });

  socket.on('runnerOffer', (data: RunnerOfferData) => {
    console.log(`Received WebRTC offer from ${data.fromSocketId}`);

    // Access this connection gets, vouched by the server. Owner = all boards;
    // a shared member = only the boards on the offer's scope.
    const scope = toChannelScope(data.scope);
    if (!scope) {
      // Unanswered on purpose: the caller's own timeout ends it, the same as
      // an offer the server declined to relay.
      console.error(
        `Refused WebRTC offer from ${data.fromSocketId}: the server sent no scope`
      );
      return;
    }
    if (!mayConnect(scope)) {
      // Unanswered, as above.
      console.error(
        `Refused WebRTC offer from ${data.fromSocketId}: no level on any board`
      );
      return;
    }

    try {
      // Never let building this list cost the answer. A throw here used to
      // escape before the offer was answered, so the client waited out its
      // fifteen seconds — including clients on the same network that needed no
      // relay at all. Falling back to STUN loses relayed connections; throwing
      // lost every connection.
      let iceServers: (string | IceServer)[];
      try {
        iceServers = toRtcIceServers(data.iceServers);
      } catch (error) {
        console.error('[webrtc] ICE server list unusable, using STUN:', error);
        iceServers = ['stun:stun.l.google.com:19302'];
      }
      console.log(
        `[webrtc] ICE servers: ${iceServers
          // Never log the password — this line is what showed the credentials
          // were arriving, so it has to stay readable and safe.
          .map((u) =>
            typeof u === 'string'
              ? u
              : `${u.relayType}:${u.hostname}:${u.port} user=${u.username?.slice(0, 8)}…`
          )
          .join(', ')}`
      );
      const peer = new PeerConnection('runner', { iceServers });

      // What this side of the handshake managed, reported once it settles. The
      // runner used to be the only party that knew whether it had allocated a
      // relay, and it only said so on its own console — which nobody reads
      // until a link has already failed.
      const view = {
        local: new Set<string>(),
        remote: new Set<string>(),
        relays: 0,
        gathering: 'new',
        ice: 'new'
      };
      const candidateType = (candidate: string): string =>
        /\btyp (\w+)/.exec(candidate)?.[1] ?? 'unknown';
      let reported = false;
      const report = (outcome: 'connected' | 'failed') => {
        if (reported || !data.linkId) return;
        reported = true;
        // Which pair won, so the server can count how often a link lands on a
        // TURN relay. The runner is one end of every link, which makes this
        // the only reading for a phone — react-native-webrtc reports no pairs.
        // Candidate types and transport only: no address leaves the runner.
        let pair: { local: string; remote: string; protocol: string } | null =
          null;
        if (outcome === 'connected') {
          try {
            const selected = peer.getSelectedCandidatePair();
            if (selected) {
              pair = {
                local: selected.local.type,
                remote: selected.remote.type,
                protocol: selected.local.transportType
              };
            }
          } catch {
            // No nominated pair to read; the link is counted as unknown.
          }
        }
        socket.emit('runnerLinkReport', {
          linkId: data.linkId,
          peerSocketId: data.fromSocketId,
          outcome,
          pair,
          detail: [
            `ice=${view.ice} gathering=${view.gathering} relays=${view.relays}`,
            `local=${[...view.local].join(',') || 'none'}`,
            `remote=${[...view.remote].join(',') || 'none'}`,
            // Hostname and port only — the credential never leaves the runner.
            `turn=${iceServers
              .map((u) =>
                typeof u === 'string' ? u : `${u.relayType}:${u.hostname}:${u.port}`
              )
              .join(' ')}`
          ].join('\n')
        });
      };

      const iceCandidateHandler = (msg: RunnerIceCandidateData) => {
        if (msg.fromSocketId === data.fromSocketId) {
          console.log(`[webrtc] remote ICE candidate: ${msg.candidate.candidate.slice(0, 60)}...`);
          view.remote.add(candidateType(msg.candidate.candidate));
          peer.addRemoteCandidate(
            msg.candidate.candidate,
            msg.candidate.sdpMid || ''
          );
        }
      };
      socket.on('runnerIceCandidate', iceCandidateHandler);

      let iceHandlerActive = true;
      const detachIceHandler = () => {
        if (!iceHandlerActive) return;
        iceHandlerActive = false;
        socket.off('runnerIceCandidate', iceCandidateHandler);
      };

      peer.onStateChange((state: string) => {
        console.log(`[webrtc] peer state: ${state}`);
        view.ice = state;
        if (state === 'connected') report('connected');
        if (
          state === 'failed' ||
          state === 'closed' ||
          state === 'disconnected'
        ) {
          // Only a real failure is worth a report; a closed or disconnected
          // peer that already connected has nothing new to say.
          if (state === 'failed') report('failed');
          detachIceHandler();
        }
      });

      peer.onGatheringStateChange((state: string) => {
        console.log(`[webrtc] gathering state: ${state}`);
        view.gathering = state;
      });

      peer.onLocalCandidate((candidate: string, mid: string) => {
        console.log(`[webrtc] local ICE candidate: ${candidate.slice(0, 60)}...`);
        const type = candidateType(candidate);
        view.local.add(type);
        if (type === 'relay') view.relays += 1;
        socket.emit('runnerIceCandidate', {
          targetSocketId: data.fromSocketId,
          // 0 rather than null. A browser accepts a null index, but a mobile
          // client on the New Architecture passes this straight into codegen'd
          // JSI bindings that type-check it as a number, and null throws there —
          // rejecting every candidate we send and stranding the link at
          // checking. sdpMid identifies the m-line on its own, so the index is
          // redundant here anyway.
          candidate: { candidate, sdpMid: mid, sdpMLineIndex: 0 }
        });
      });

      // Must register callbacks BEFORE setRemoteDescription —
      // setting remote desc triggers answer generation immediately
      peer.onLocalDescription((sdp: string, _type: DescriptionType) => {
        // Only now is the payload type known. A packet stamped with one the far
        // end never mapped is dropped silently: a connected peer, a live track,
        // and no picture.
        const payloadType = negotiatedH264PayloadType(sdp, SIMULATOR_PROFILE);
        if (payloadType !== null) {
          simulatorSink?.packetizer.setPayloadType(payloadType);
        }
        // libdatachannel's answer carries no `a=ssrc:`, so the media id is the
        // only thing the receiver can demux on. Without it the packets arrive
        // and are discarded unattributed — verified against Chrome.
        const mid = negotiatedMid(sdp);
        if (mid) simulatorSink?.packetizer.setMidExtension(mid.id, mid.mid);
        console.log(`Sending answer to ${data.fromSocketId}`);
        socket.emit('runnerAnswer', {
          targetSocketId: data.fromSocketId,
          answer: { sdp, type: 'answer' as const }
        });
      });

      peer.onDataChannel((dc: NDCDataChannel) => {
        console.log(
          `Data channel "${dc.getLabel()}" opened with ${data.fromSocketId}`
        );
        attachChannel(
          dc,
          scope,
          data.fromSocketId,
          'webrtc',
          () => peer.close(),
          detachIceHandler
        );
      });

      // Before setRemoteDescription so the answer carries the video m-line. The
      // browser offers a recvonly transceiver at connect for exactly this, so
      // nothing ever renegotiates.
      let simulatorSink: SimulatorSink | null = null;
      if (!data.offer.sdp.includes('m=video')) {
        console.log('[simulator] offer has no video m-line; no track for this peer');
      }
      if (data.offer.sdp.includes('m=video')) {
        try {
          // The string, not `Direction.SendOnly`: that is a `const enum` in the
          // .d.ts, so it type-checks and is `undefined` at run time — esbuild
          // cannot inline a const enum imported from a declaration file. This is
          // the enum's own value, and getting it wrong fails silently: the
          // constructor throws, the catch below logs, and the panel just never
          // receives video.
          const media = new Video('sim', 'SendOnly' as Direction);
          media.addH264Codec(SIMULATOR_PAYLOAD_TYPE);
          media.addSSRC(SIMULATOR_SSRC, 'sim');
          const track = peer.addTrack(media);
          simulatorSink = {
            track,
            packetizer: new H264Packetizer({
              payloadType: SIMULATOR_PAYLOAD_TYPE,
              ssrc: SIMULATOR_SSRC
            }),
            link: scope
          };
          const sink = simulatorSink;
          simulatorSinks.add(sink);
          track.onClosed(() => {
            simulatorSinks.delete(sink);
            releaseScreenIfGone(scope);
          });
        } catch (err) {
          console.error('Could not add the simulator video track:', err);
        }
      }

      try {
        peer.setRemoteDescription(data.offer.sdp, DescriptionType.Offer);
      } catch (err) {
        detachIceHandler();
        console.error('Failed to set remote description:', err);
      }
    } catch (err) {
      console.error('Failed to handle WebRTC offer:', err);
    }
  });

  socket.connect();

  // Keep process alive and clean up on exit
  const cleanup = () => {
    for (const engine of engines.values()) {
      engine.destroy();
    }
    embedder.stop();
    // Lid closed off before exiting: the setting outlives the process.
    keepAwake.shutdown();
    clearInterval(heartbeatTimer);
    stopStatusBeat();
    socket.disconnect();
  };

  // Nuke this runner, from Runner Settings > Danger zone (daemonNuke.ts,
  // nuke.ts). Unpair on this live socket first, then the service, every
  // session, the keychain entry, the secrets and the folder; then exit, and
  // stay down. Frames go to the owner's links only.
  const nukeExec = (bin: string, args: string[]) => run(bin, args, { timeoutMs: 60_000 });
  const nuke = createDaemonNuke({
    dir: CONFIG_DIR,
    expectedDir: runnerDir(),
    ownerUserId,
    host: machineNukeHost({
      dir: CONFIG_DIR,
      exec: nukeExec,
      unpair: async () => {
        if (!socket.connected) {
          socket.disconnect();
          return unpairOverSocket(config.serverUrl, config.authToken);
        }
        const res = await socket
          .timeout(15_000)
          .emitWithAck('runner:unpair', {})
          .catch(() => {
            throw new Error(
              'The server did not answer the unpair. Nothing was erased. Remove this runner in Runner Settings on another device, then nuke again.'
            );
          });
        socket.disconnect();
        if ('error' in res) throw new Error(`The server refused the unpair: ${res.error}`);
        return [res.removed ? 'Unpaired and removed from Factiii.' : 'Already unpaired.'];
      },
      stopWork: async () => {
        // Engines first: their terminals, card sessions, simulator and screen
        // streams. Then keep-awake, then what is left on the tmux server.
        cleanup();
        keepAwake.set({ on: false, until: null });
        return [
          'Stopped every board’s sessions and the simulator stream.',
          'Keep-awake is off.',
          ...(await stopTmuxSessionsIn(CONFIG_DIR, nukeExec))
        ];
      },
      keepServiceRunning: async () =>
        runnerService ? (await runnerService.status()).thisRunner : false
    }),
    broadcast: (progress) => {
      const frames = chunkWire(JSON.stringify({ type: 'runner-nuke', progress }));
      for (const [dc, scope] of channelScopes) {
        if (scope.role !== 'owner') continue;
        for (const frame of frames) {
          try {
            dc.sendMessage(frame);
          } catch {
            // peer may have disconnected
          }
        }
      }
    },
    // A moment for the last frame to leave. Exit 0: the supervisor (and a
    // service, whose file is gone) does not relaunch it.
    exit: () => setTimeout(() => process.exit(0), 1500)
  });

  // Update approved: install, tell clients, then exit RESTART_FOR_UPDATE so
  // the supervisor relaunches on the new code. A failed install stays up.
  const applyUpdateAndRestart = () => {
    console.log('[update] update approved by a client — installing latest...');
    const status = (state: 'installing' | 'restarting' | 'failed') =>
      broadcastToAll(JSON.stringify({ type: 'runner-update', state }));

    status('installing');
    if (!installLatest()) {
      status('failed');
      return;
    }
    status('restarting');
    cleanup();
    process.exit(RESTART_FOR_UPDATE);
  };

  // Disconnected from Settings. Stop every job and exit; the supervisor only
  // relaunches on RESTART_FOR_UPDATE, so this stays down.
  socket.on('runnerRevoked', () => {
    // A nuke unpairs first and exits when its erase is done.
    if (nuke.running()) return;
    console.log(
      '\nThis runner was disconnected from your Factiii account. Stopping all jobs...'
    );
    cleanup();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  // Block forever: the supervisor exits when this resolves. Real exits go
  // through the handlers above.
  await new Promise<never>(() => {});
}

/** A session summary as the runner's owner sees it: with who started it
 *  (CardAISessionSummary.startedBy). Only ever sent on an owner's link; a
 *  member gets the summary as the engine made it. A session with no starter
 *  recorded counts as the owner's (session.ts startedBy). */
function withStartedBy(
  payload: unknown,
  engine: BoardAgentEngine | undefined,
  owner: { userId: string; name: string }
): unknown {
  if (!engine || !payload || typeof payload !== 'object') return payload;
  const summary = payload as Partial<CardAISessionSummary>;
  if (typeof summary.postId !== 'string') return payload;
  const starter = engine.sessionStarter(summary.postId) ?? { ...owner, role: 'owner' as const };
  return { ...summary, startedBy: personOf(starter) };
}

/** cardSessions and cardSession, as the owner gets them: each summary with
 *  who started it. Anything else as it is. */
function ownerSessionView(
  action: string,
  result: unknown,
  engine: BoardAgentEngine,
  owner: { userId: string; name: string }
): unknown {
  if (action === 'cardSession') return withStartedBy(result, engine, owner);
  if (action !== 'cardSessions' || !result || typeof result !== 'object') return result;
  return Object.fromEntries(
    Object.entries(result).map(([postId, summary]) => [
      postId,
      withStartedBy(summary, engine, owner)
    ])
  );
}

async function handleDataChannelMessage(
  raw: string,
  scope: ChannelScope,
  transport: ChannelTransport,
  sendToChannel: (msg: string) => void,
  broadcastToBoard: (spaceSlug: string, msg: string) => void,
  getEngine: (spaceSlug: string, spaceId?: number) => BoardAgentEngine,
  onSecureChange: (status: SecureStoreStatus) => void,
  access: ChannelAccess,
  vault: DaemonVault,
  localAiTags: LocalAiTags,
  /** The engines Factiii's AI features run on (vault/aiPrompt.ts). */
  aiEngines: AiPromptEngines,
  runnerParts: PartsManager,
  cliSignins: CliSignins,
  keepAwake: KeepAwake,
  nuke: DaemonNuke,
  /** The owner's Remote connections, bound to this link (its `you`). */
  connections: {
    connections: () => ReturnType<RunnerConnectionsHost['connections']>;
    logs: RunnerConnectionsHost['logs'];
  }
): Promise<void> {
  let msg: DispatchMessage;
  try {
    msg = JSON.parse(raw) as DispatchMessage;
  } catch {
    return;
  }

  if (msg.type !== 'dispatch') return;

  const { action, payload, requestId } = msg;
  const ts = () => new Date().toLocaleTimeString();
  const sendResult = (res: ResultMessage) =>
    sendToChannel(JSON.stringify(res));

  // First, before any role or board check: the password never passes through
  // the server, and a relayed link is the server. The client picks the relay
  // on its own when WebRTC fails, so the user may not know they are on one.
  const relayRefusal = relaySecretsRefusal(transport, action, payload);
  if (relayRefusal) {
    console.warn(`[${ts()}] ⃠ ${action} refused on a relayed link`);
    sendResult({
      type: 'result',
      requestId,
      error: relayRefusal,
      code: RELAY_REFUSES_SECRETS
    });
    return;
  }

  // The Vault is runner-wide and has its own members (vault/access.ts), so it
  // is answered before the per-board gate: a vault member may have no board.
  if (VAULT_ACTIONS.has(action)) {
    try {
      const result = await vault.handle(action, payload, scope);
      sendResult({ type: 'result', requestId, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${ts()}] ✗ ${action} FAILED: ${message}`);
      sendResult({ type: 'result', requestId, error: message });
    }
    return;
  }

  // Nuke: the whole runner, so runner-wide and the owner's alone, by id,
  // on a direct link, with the phrase exactly as typed (daemonNuke.ts checks
  // all three again, whatever the app showed).
  if (action === 'runnerNuke') {
    try {
      const result = await nuke.handle(payload, scope, transport);
      if (result.started) console.warn(`[${ts()}] ⚠ runner nuke started by ${scope.name}`);
      sendResult({ type: 'result', requestId, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${ts()}] ✗ ${action} FAILED: ${message}`);
      sendResult({ type: 'result', requestId, error: message });
    }
    return;
  }

  // Keep-awake: the machine's sleep, so runner-wide and the owner's alone,
  // whichever board asks.
  if (action === 'keepAwakeSet') {
    try {
      if (scope.role !== 'owner') {
        throw new Error('Only the owner of this runner can keep it awake.');
      }
      const parsed = keepAwakeSetSchema.safeParse(payload ?? {});
      if (!parsed.success) {
        throw new Error('Keep-awake needs on, and until (a time, or null).');
      }
      const result = keepAwake.set(parsed.data);
      sendResult({ type: 'result', requestId, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${ts()}] ✗ ${action} FAILED: ${message}`);
      sendResult({ type: 'result', requestId, error: message });
    }
    return;
  }

  // Oakbox > Account > Backend's models (localAiTags.ts): runner-wide, so
  // before the per-board gate, and the owner's alone. The relay was refused
  // above.
  if (LOCAL_AI_ACTIONS.has(action)) {
    try {
      if (scope.role !== 'owner') {
        throw new Error('Only the owner of this runner can manage its models.');
      }
      let result: unknown;
      if (action === 'localAiAct') result = await localAiTags.act(payload);
      else if (action === 'localAiSearch') result = await localAiTags.search(payload);
      else result = await localAiTags.list();
      sendResult({ type: 'result', requestId, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${ts()}] ✗ ${action} FAILED: ${message}`);
      sendResult({ type: 'result', requestId, error: message });
    }
    return;
  }

  // Factiii's AI features on this runner (vault/aiPrompt.ts): runner-wide,
  // the owner's alone, on their own Claude, Codex or Ollama. The relay was
  // refused above (RUNNER_AI_ACTIONS).
  if (RUNNER_AI_ACTIONS.has(action)) {
    try {
      if (scope.role !== 'owner') {
        throw new Error('Only the owner of this runner can run AI on it.');
      }
      const result = await answerAiPrompt(aiEngines, payload);
      sendResult({ type: 'result', requestId, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${ts()}] ✗ ${action} FAILED: ${message}`);
      sendResult({ type: 'result', requestId, error: message });
    }
    return;
  }

  // The runner's parts with no board: Oakbox > Account > Backend's Setup,
  // which has none to name. The same manager every board's engine asks, and
  // the owner's alone there too (OWNER_ONLY_ACTIONS). A board's own ask
  // still goes through its engine below.
  if ((action === 'partsList' || action === 'partsAct') && !msg.spaceSlug) {
    try {
      if (scope.role !== 'owner') {
        throw new Error('Only the owner of this runner can set it up.');
      }
      const result =
        action === 'partsAct' ? await runnerParts.act(payload) : await runnerParts.list();
      sendResult({ type: 'result', requestId, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${ts()}] ✗ ${action} FAILED: ${message}`);
      sendResult({ type: 'result', requestId, error: message });
    }
    return;
  }

  // Remote connections (runnerConnections.ts): who is linked, terminals other
  // people started, the embedder, services, public links, and one of their
  // logs. Runner-wide whether or not a board is named, and the owner's alone
  // (OWNER_ONLY_ACTIONS). The relay may carry both: a terminal's output
  // already does.
  if (action === 'runnerConnections' || action === 'runnerLogs') {
    try {
      if (scope.role !== 'owner') {
        throw new Error('Only the owner of this runner can see this.');
      }
      const result =
        action === 'runnerLogs'
          ? await connections.logs(payload)
          : await connections.connections();
      sendResult({ type: 'result', requestId, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${ts()}] ✗ ${action} FAILED: ${message}`);
      sendResult({ type: 'result', requestId, error: message });
    }
    return;
  }

  // Claude's and Codex's sign-ins with no board: Oakbox > Account > Backend's
  // (cliSignins.ts). The owner's alone, and only on a direct link: Claude's
  // carries the code that signs the machine in. A board's own sign-in still
  // goes through its engine below, as factiii.com sends it.
  if (RUNNER_SIGNIN_ACTIONS.has(action) && !msg.spaceSlug) {
    try {
      if (transport === 'socket') {
        sendResult({
          type: 'result',
          requestId,
          error: RELAY_SIGNIN_REFUSAL,
          code: RELAY_REFUSES_SECRETS
        });
        return;
      }
      if (scope.role !== 'owner') {
        throw new Error('Only the owner of this runner can sign it in.');
      }
      let result: unknown;
      if (action === 'cliSignins') result = await cliSignins.status();
      else if (action === 'claudeLoginStart') result = await cliSignins.claudeStart();
      else if (action === 'claudeLoginCode') result = cliSignins.claudeCode(payload);
      else if (action === 'codexLoginStart') result = await cliSignins.codexStart();
      else if (action === 'claudeLoginCancel') result = await cliSignins.cancel('claude');
      else if (action === 'codexLoginCancel') result = await cliSignins.cancel('codex');
      else if (action === 'claudeLogout') result = await cliSignins.signOut('claude');
      else result = await cliSignins.signOut('codex');
      sendResult({ type: 'result', requestId, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${ts()}] ✗ ${action} FAILED: ${message}`);
      sendResult({ type: 'result', requestId, error: message });
    }
    return;
  }

  // Credential-store ops are runner-wide, so they run before the per-board
  // gate — and are owner-only, since the store spans every board: a shared
  // member must not read another board's settings (secureActions.ts).
  if (SECURE_ACTIONS.has(action)) {
    try {
      if (scope.role !== 'owner') {
        throw new Error(
          'Only the owner of this runner can manage its credential store.'
        );
      }
      // What follows an unlock (the console, the clients) is the unlock
      // watch's to do, since it also has to follow one done outside the app.
      const status = runSecureAction(action, payload);
      sendResult({ type: 'result', requestId, result: status });
      if (action !== 'secureStatus') onSecureChange(status);
    } catch (err) {
      // Carry the remedy with the failure - "no keyring" is only actionable
      // if the caller also learns which package installs one.
      const message = err instanceof Error ? err.message : String(err);
      const fix = err instanceof SecureStoreError ? err.fix : '';
      sendResult({
        type: 'result',
        requestId,
        error: fix ? `${message}\n\n${fix}` : message
      });
    }
    return;
  }

  // What this channel may do on this board (runner-access.ts): a member gets
  // what the owner's level for them gives there, never a setting of the
  // runner. A board the server did not name, or one with no grant, is None.
  const level = access.level(scope, msg.spaceSlug);

  // Reject any board-scoped action for a board this channel has nothing on —
  // a member can only drive the boards the owner gave them a level on.
  if (level === 'none' && action !== 'runnerAccessGet') {
    console.warn(`[${ts()}] ⃠ ${action} denied for board "${describeBoard(CONFIG_DIR, msg.spaceSlug)}"`);
    const denied: ResultMessage = {
      type: 'result',
      requestId,
      error: 'Not authorized for this board on this runner'
    };
    sendToChannel(JSON.stringify(denied));
    return;
  }

  if (!actionAllowed(level, action)) {
    console.warn(`[${ts()}] ⃠ ${action} refused for a ${level} channel`);
    sendResult({ type: 'result', requestId, error: refusal(action) });
    return;
  }

  // The levels are the runner's, not an engine's: answered here.
  if (action === 'runnerAccessGet' || action === 'runnerAccessSet') {
    try {
      if (action === 'runnerAccessSet') {
        access.set(msg.spaceSlug, payload, channelContext(scope));
      }
      sendResult({
        type: 'result',
        requestId,
        result: access.state(scope, msg.spaceSlug)
      });
    } catch (err) {
      sendResult({
        type: 'result',
        requestId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return;
  }

  // The owner's vault backups are runner-wide too, and belong to no board
  // (vaultBackupStore.ts): they come with an empty board, on which only the
  // owner has a level. OWNER_ONLY_ACTIONS already turned a member away above,
  // whatever their level; the role is checked again here so this branch never
  // depends on that list staying complete.
  if (VAULT_BACKUP_ACTIONS.has(action)) {
    try {
      if (scope.role !== 'owner') {
        throw new Error(
          'Only the owner of this runner can reach its vault backups.'
        );
      }
      const result = runVaultBackupAction(vaultBackups, action, payload);
      // One line per package, not per chunk: a full-size one is over a
      // thousand writes.
      if (action === 'vaultBackupWrite') {
        const { name } =
          result as BoardAgentActionMap['vaultBackupWrite']['result'];
        if (name) console.log(`[${ts()}] ✓ vault backup stored: ${name}`);
      }
      if (action === 'vaultBackupDelete') {
        console.log(`[${ts()}] ✓ vault backup deleted`);
      }
      sendResult({ type: 'result', requestId, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${ts()}] ✗ ${action} FAILED: ${message}`);
      sendResult({ type: 'result', requestId, error: message });
    }
    return;
  }

  // One person at a time on the video stream. Decided here, in the runner: a
  // second viewer is refused before the engine hears of it.
  const screenRequest = screenUse(action);
  if (screenRequest) {
    const decision = access.screen(scope, msg.spaceSlug, screenRequest);
    if (!decision.run) {
      sendResult(
        decision.refusal
          ? { type: 'result', requestId, error: decision.refusal }
          : { type: 'result', requestId }
      );
      return;
    }
  }

  const engine = getEngine(msg.spaceSlug, msg.spaceId);

  console.log(`[${ts()}] ← ${action} (${requestId})`);

  const askLogSender = (entry: { type: string; content: string }) => {
    const event: EventMessage = {
      type: 'event',
      spaceSlug: msg.spaceSlug,
      event: `board-agent:${msg.spaceSlug}:log`,
      payload: entry
    };
    broadcastToBoard(msg.spaceSlug, JSON.stringify(event));
  };

  try {
    const result = await engine.dispatch(
      action,
      payload as BoardAgentActionMap[typeof action]['payload'],
      askLogSender,
      channelContext(scope, access.dangerous(scope, msg.spaceSlug))
    );
    console.log(`[${ts()}] → ${action} OK`);
    const response: ResultMessage = {
      type: 'result',
      requestId,
      result: scope.role === 'owner' ? ownerSessionView(action, result, engine, scope) : result
    };
    sendToChannel(JSON.stringify(response));
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[${ts()}] ✗ ${action} FAILED: ${errorMsg}`);
    if (screenRequest?.use === 'attach') {
      access.screenFailed(scope, screenRequest.kind);
    }
    const response: ResultMessage = {
      type: 'result',
      requestId,
      error: errorMsg
    };
    sendToChannel(JSON.stringify(response));
  }
}

