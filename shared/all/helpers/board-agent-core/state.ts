import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import type {
  BoardSessionMessage,
  CardAIMode,
  CardAISessionPhase
} from '../../domains/electron';
import type { ExecTarget } from './exec';
import type { AgentProvider } from './providers';
import type { SessionStarter } from './session';

// Per-card state as one JSON file per record under the space's `state` dir,
// the source of truth across runner restarts. Files, not redis, so a board
// runs on a machine with nothing but git, tmux and an agent CLI; redis is an
// extra (live agent status in terminals, terminal-mode.ts). A runner from
// before kept these in its per-space redis (AOF), and `ensureStateStore`
// copies them over once. The redis transport stays for that and for the
// status channel: redis-cli over the space's ExecTarget, on a UNIX SOCKET
// with --port 0: on a shared host, spaces collided on 6379.

// One row per live card; worktreePath is empty for surfaces with no working tree.
export type CardRecord = {
  postId: string;
  taskId: string;
  mode: CardAIMode;
  phase: CardAISessionPhase;
  provider: AgentProvider;
  worktreePath: string;
  /** Provider CLI conversation id, for `--resume` / terminal takeover. */
  agentSessionId: string;
  /** The card a terminal session is linked to (SessionSummary.cardId).
   *  Absent from records written before links. */
  cardId?: string;
  /** BaseSession.startedBy and startedVia, kept so a restart still knows
   *  who a session acts for and that an agent started it. Absent from
   *  records written before them. */
  startedBy?: SessionStarter;
  startedVia?: string;
  taskTitle: string;
  targetBranch: string;
  startedAt: number;
  /** Original task prompt + any parked question, so the pipeline can be
   *  auto-resumed from its recorded phase after a runner restart. */
  prompt: string;
  pendingQuestion: string;
};

// Ids become file names (and, for the one-time copy, redis-cli argv). postIds
// are DB ids, but sanitize defensively so a stray value can't escape the dir.
function safeId(id: string): string {
  const clean = String(id).replace(/[^a-zA-Z0-9_.:-]/g, '');
  if (!clean || /^\.+$/.test(clean)) {
    throw new Error('Invalid card id for state store.');
  }
  return clean;
}

/** The kinds of record, each a dir of `<id>.json` under the store. The dir
 *  listing is the index, so there is no second list to fall out of step. */
type Kind = 'card' | 'ask';

function storeDir(target: ExecTarget): string {
  return path.join(target.paths.state, 'store');
}

function recordPath(target: ExecTarget, kind: Kind, id: string): string {
  return path.join(storeDir(target), kind, `${safeId(id)}.json`);
}

/** Write through a temp file and rename, so a crash mid-write leaves the old
 *  record rather than half of a new one. */
async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tmp, file);
}

/** A file's text, or null when it is not there. */
async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

/** Every record of one kind. One that will not parse is dropped, as an
 *  unreadable index entry was. */
async function listRecords<T>(target: ExecTarget, kind: Kind): Promise<T[]> {
  const dir = path.join(storeDir(target), kind);
  const names = await fs.readdir(dir).catch((): string[] => []);
  const records: T[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      records.push(JSON.parse((await readText(file)) ?? '') as T);
    } catch {
      await fs.rm(file, { force: true });
    }
  }
  return records;
}

/** This space's redis socket. */
export function redisSocketPath(target: ExecTarget): string {
  return `${target.paths.state}/redis.sock`;
}

/** redis-cli on the space's target; trims the trailing newline it adds. */
async function redisCli(target: ExecTarget, args: string): Promise<string> {
  const out = await target.sh(
    `redis-cli -s ${redisSocketPath(target)} ${args}`
  );
  return out.replace(/\n$/, '');
}

/**
 * Start this space's redis-server if it isn't already up. Idempotent - safe to
 * call on every ensure/reattach. AOF on, RDB off. Throws where redis-server is
 * not installed: it is an extra, so callers read that as "no live agent
 * status", never as a failed setup.
 */
export async function ensureRedis(target: ExecTarget): Promise<void> {
  try {
    const pong = await redisCli(target, 'ping');
    if (pong.trim() === 'PONG') return;
  } catch {
    // not up yet
  }
  const stateDir = target.paths.state;
  // --port 0 disables TCP entirely, so two spaces can never reach each other's
  // store. unixsocketperm 700: the socket is only for this owner.
  await target.sh(
    `mkdir -p ${stateDir} && redis-server --daemonize yes --appendonly yes ` +
      `--save '' --dir ${stateDir} --port 0 ` +
      `--unixsocket ${redisSocketPath(target)} --unixsocketperm 700`
  );
  // Poll until it binds; a failed start must surface here, not later as
  // mysteriously empty state. Sleep in this process, not in another exec.
  for (let i = 0; i < 20; i += 1) {
    try {
      if ((await redisCli(target, 'ping')).trim() === 'PONG') return;
    } catch {
      // still starting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('redis-server did not come up.');
}

// Written once what a runner from before kept in redis is in files, so the
// copy runs once per space.
const MIGRATED_MARKER = '.from-redis';

// The digest the user last said "skip for this version" to. Here rather than a
// file of its own elsewhere: this store already survives a reboot and is
// already per space, and one value does not earn a second persistence
// mechanism.
const TERMINAL_ACK_FILE = 'terminal-ack';

/**
 * Make the store's dir, and copy in what a runner from before kept in this
 * space's redis: card records, Board AI conversations and the terminal ack.
 * Only while that redis answers (call `ensureRedis` first where it is
 * installed); a record already in a file wins over its redis copy.
 * Best-effort: a failed copy is tried again next time and never fails setup.
 */
export async function ensureStateStore(target: ExecTarget): Promise<void> {
  const dir = storeDir(target);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const marker = path.join(dir, MIGRATED_MARKER);
  if ((await readText(marker)) !== null) return;
  try {
    if ((await redisCli(target, 'ping')).trim() !== 'PONG') return;
  } catch {
    return; // no redis here, or none started: nothing to copy yet
  }
  try {
    const copy = async (kind: Kind, index: string) => {
      const ids = (await redisCli(target, `SMEMBERS ${index}`))
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const id of ids) {
        const file = recordPath(target, kind, id);
        if ((await readText(file)) !== null) continue;
        const raw = await redisCli(target, `GET ${kind}:${safeId(id)}`);
        if (raw) await writeAtomic(file, raw);
      }
    };
    await copy('card', 'cards');
    await copy('ask', 'asks');
    const ackFile = path.join(dir, TERMINAL_ACK_FILE);
    const ack = await redisCli(target, 'GET terminal:ack');
    if (ack && (await readText(ackFile)) === null) {
      await writeAtomic(ackFile, ack);
    }
    await writeAtomic(marker, String(Date.now()));
  } catch {
    // Tried again on the next setup or reattach.
  }
}

/** Empty when nothing was acked and when the store is unreadable — both mean
 *  "ask", which costs a prompt rather than silently skipping one. */
export async function getTerminalAck(target: ExecTarget): Promise<string> {
  const raw = await readText(path.join(storeDir(target), TERMINAL_ACK_FILE));
  return raw?.trim() ?? '';
}

export async function setTerminalAck(
  target: ExecTarget,
  digest: string
): Promise<void> {
  await writeAtomic(path.join(storeDir(target), TERMINAL_ACK_FILE), digest);
}

/** Upsert a card record. */
export async function putCard(
  target: ExecTarget,
  record: CardRecord
): Promise<void> {
  await writeAtomic(
    recordPath(target, 'card', record.postId),
    JSON.stringify(record)
  );
}

/** Merge a partial update into an existing record (no-op if it's gone). */
export async function patchCard(
  target: ExecTarget,
  postId: string,
  patch: Partial<CardRecord>
): Promise<void> {
  const current = await getCard(target, postId);
  if (!current) return;
  await putCard(target, { ...current, ...patch });
}

/** Read one card record, or null if absent/unparseable. */
export async function getCard(
  target: ExecTarget,
  postId: string
): Promise<CardRecord | null> {
  const raw = await readText(recordPath(target, 'card', postId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CardRecord;
  } catch {
    return null;
  }
}

/** Every live card record, for daemon rehydration and the jobs panel. */
export function listCards(target: ExecTarget): Promise<CardRecord[]> {
  return listRecords<CardRecord>(target, 'card');
}

/** Drop a card record. */
export async function deleteCard(
  target: ExecTarget,
  postId: string
): Promise<void> {
  await fs.rm(recordPath(target, 'card', postId), { force: true });
}

// ── Board AI conversations ──

/** One Board AI conversation: its transcript and the CLI thread that resumes
 *  it. Kept here so it outlives the panel, a runner restart, and being set
 *  aside for a new conversation. */
export type AskRecord = {
  id: string;
  title: string;
  /** "List > Card title" when the conversation is about one card. */
  topic: string;
  /** Fixed by the first question; a claude session and a codex thread are
   *  not interchangeable. */
  provider?: AgentProvider;
  /** Provider CLI conversation id, for `--resume`. */
  sessionId: string | null;
  messages: BoardSessionMessage[];
  /** Set aside: out of the open tabs, still in the history. */
  archived: boolean;
  createdAt: number;
  updatedAt: number;
};

/** Upsert a conversation. */
export async function putAsk(
  target: ExecTarget,
  record: AskRecord
): Promise<void> {
  await writeAtomic(recordPath(target, 'ask', record.id), JSON.stringify(record));
}

/** Every stored conversation. One whose record is unreadable is dropped. */
export function listAsks(target: ExecTarget): Promise<AskRecord[]> {
  return listRecords<AskRecord>(target, 'ask');
}

export async function deleteAsk(target: ExecTarget, id: string): Promise<void> {
  await fs.rm(recordPath(target, 'ask', id), { force: true });
}
