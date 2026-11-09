import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'fs';
import net from 'net';
import path from 'path';

// Blocks of TCP ports an agent may bind, as $FACTIII_PORTS. Every session
// (terminal, chat or card) gets a block of its own, and each board one more
// for shells with no session (board jobs, setup). Two sessions handed the
// same block had one's docker containers take the other's preview ports.
//
// One registry for every board on this host: the spaces' parent dir
// (`~/.factiii-runner` on a runner) holds `port-blocks.json`, so no block
// overlaps another board's either. On disk, so a block survives a runner
// restart and a resumed session keeps its ports. Ended sessions release theirs
// (card-session.ts teardownSession) for a later session to reuse.

export const PORTS_PER_BLOCK = 6;

const REGISTRY_FILE = 'port-blocks.json';

/** Tries per block before giving up: a port can be taken between the probe
 *  that found it and the write that records it. */
const MAX_ATTEMPTS = 5;

/** Free ports a block may skip over (taken by another block) before the
 *  allocation is called a failure, so a full registry cannot spin forever. */
const MAX_PROBES = 500;

/** `session` is '' for the board's own block. */
type BlockEntry = { space: string; session: string; ports: number[] };

type Registry = { blocks: BlockEntry[] };

export type AllocateOpts = {
  /** A candidate port. Default: one the OS hands out as free. */
  nextPort?: () => Promise<number>;
  /** Whether nothing listens on `port`. Default: binds it to check. */
  isFree?: (port: number) => Promise<boolean>;
};

function registryPath(spaceDir: string): string {
  return path.join(path.dirname(path.resolve(spaceDir)), REGISTRY_FILE);
}

function isPortList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((p) => Number.isInteger(p) && p > 0 && p < 65536)
  );
}

function readRegistry(spaceDir: string): Registry {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(registryPath(spaceDir), 'utf-8')
    );
    const blocks =
      raw && typeof raw === 'object' && 'blocks' in raw
        ? (raw as { blocks: unknown }).blocks
        : null;
    if (!Array.isArray(blocks)) return { blocks: [] };
    return {
      blocks: blocks.filter(
        (b): b is BlockEntry =>
          !!b &&
          typeof b === 'object' &&
          typeof (b as BlockEntry).space === 'string' &&
          typeof (b as BlockEntry).session === 'string' &&
          isPortList((b as BlockEntry).ports)
      )
    };
  } catch {
    // None yet, or unreadable: nothing is recorded.
    return { blocks: [] };
  }
}

/** Atomic (temp file, then rename), so a reader never sees half a registry.
 *  Drops the blocks of boards whose dir is gone: nothing is left to free them. */
function writeRegistry(spaceDir: string, registry: Registry): void {
  const file = registryPath(spaceDir);
  const blocks = registry.blocks.filter((b) => existsSync(b.space));
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ blocks }, null, 2), 'utf-8');
  renameSync(tmp, file);
}

function findBlock(
  registry: Registry,
  space: string,
  session: string
): BlockEntry | undefined {
  return registry.blocks.find(
    (b) => b.space === space && b.session === session
  );
}

/** Every port some block holds, except the one being (re)allocated. */
function takenPorts(
  registry: Registry,
  except?: { space: string; session: string }
): Set<number> {
  const taken = new Set<number>();
  for (const b of registry.blocks) {
    if (except && b.space === except.space && b.session === except.session) {
      continue;
    }
    for (const p of b.ports) taken.add(p);
  }
  return taken;
}

/** A port the OS says is free right now. */
function osFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close(() => reject(new Error('Failed to get a free port')));
      }
    });
  });
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/** Free on loopback and on every interface: docker publishes on 0.0.0.0, and
 *  a loopback-only bind can still succeed beside it. */
async function portIsFree(port: number): Promise<boolean> {
  return (await canBind(port, '0.0.0.0')) && (await canBind(port, '127.0.0.1'));
}

/** Record `session`'s block (or the board's, for ''), allocating one that
 *  overlaps no other block and is free now. An existing block is kept as it
 *  is: a resumed session keeps its ports. */
async function allocateBlock(
  spaceDir: string,
  session: string,
  opts: AllocateOpts = {}
): Promise<number[]> {
  const space = path.resolve(spaceDir);
  const nextPort = opts.nextPort ?? osFreePort;
  const isFree = opts.isFree ?? portIsFree;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const before = readRegistry(spaceDir);
    const held = findBlock(before, space, session);
    if (held) return held.ports;
    const taken = takenPorts(before);
    const picked: number[] = [];
    for (let probes = 0; picked.length < PORTS_PER_BLOCK; probes++) {
      if (probes >= MAX_PROBES) {
        throw new Error('No free ports left for a new port block.');
      }
      const port = await nextPort();
      if (taken.has(port) || picked.includes(port)) continue;
      if (!(await isFree(port))) continue;
      picked.push(port);
    }
    // Read again and write in one synchronous step: another allocation on
    // this process may have recorded a block while the probes ran.
    const now = readRegistry(spaceDir);
    const raced = findBlock(now, space, session);
    if (raced) return raced.ports;
    const nowTaken = takenPorts(now);
    if (picked.some((p) => nowTaken.has(p))) continue;
    now.blocks.push({ space, session, ports: picked });
    // writeRegistry drops blocks of boards whose dir is gone.
    mkdirSync(space, { recursive: true });
    writeRegistry(spaceDir, now);
    return picked;
  }
  throw new Error('Could not reserve a port block: ports kept being taken.');
}

/** The session's own block, allocating it on first call. */
export function allocateSessionPorts(
  spaceDir: string,
  sessionId: string,
  opts?: AllocateOpts
): Promise<number[]> {
  if (!sessionId) throw new Error('A session port block needs a session id.');
  return allocateBlock(spaceDir, sessionId, opts);
}

/** The session's recorded block, or [] when it has none (one started before
 *  blocks were per session, or a board-level shell). Sync, like stateEnv. */
export function readSessionPorts(
  spaceDir: string,
  sessionId: string
): number[] {
  if (!sessionId) return [];
  const held = findBlock(
    readRegistry(spaceDir),
    path.resolve(spaceDir),
    sessionId
  );
  return held ? held.ports : [];
}

/** FACTIII_PORTS for the session, to lay over the board's in stateEnv; empty
 *  when the session has no block of its own. */
export function sessionPortsEnv(
  spaceDir: string,
  sessionId: string
): Record<string, string> {
  const ports = readSessionPorts(spaceDir, sessionId);
  return ports.length ? { FACTIII_PORTS: ports.join(',') } : {};
}

/** Every session of this board with a block, by session id. */
export function sessionPortBlocks(spaceDir: string): Map<string, number[]> {
  const space = path.resolve(spaceDir);
  const out = new Map<string, number[]>();
  for (const b of readRegistry(spaceDir).blocks) {
    if (b.space === space && b.session) out.set(b.session, b.ports);
  }
  return out;
}

/** Free the session's block for a later session. No-op without one. */
export function releaseSessionPorts(spaceDir: string, sessionId: string): void {
  if (!sessionId) return;
  const space = path.resolve(spaceDir);
  const registry = readRegistry(spaceDir);
  const blocks = registry.blocks.filter(
    (b) => !(b.space === space && b.session === sessionId)
  );
  if (blocks.length === registry.blocks.length) return;
  writeRegistry(spaceDir, { blocks });
}

/** Free the blocks of this board's sessions that `live` says are gone: ones
 *  lost from memory and record without an End (a crash, an older runner). */
export function pruneSessionPorts(
  spaceDir: string,
  live: (sessionId: string) => boolean
): void {
  const space = path.resolve(spaceDir);
  const registry = readRegistry(spaceDir);
  const blocks = registry.blocks.filter(
    (b) => b.space !== space || !b.session || live(b.session)
  );
  if (blocks.length === registry.blocks.length) return;
  writeRegistry(spaceDir, { blocks });
}

/** Keep `ports` as the board's block when they overlap no other block, and
 *  record them so no session block takes them. False when they overlap (two
 *  boards allocated before the registry existed got the same ports). */
export function claimBoardPorts(spaceDir: string, ports: number[]): boolean {
  const space = path.resolve(spaceDir);
  const registry = readRegistry(spaceDir);
  const taken = takenPorts(registry, { space, session: '' });
  if (ports.some((p) => taken.has(p))) return false;
  const held = findBlock(registry, space, '');
  if (held && held.ports.join(',') === ports.join(',')) return true;
  const blocks = registry.blocks.filter(
    (b) => !(b.space === space && b.session === '')
  );
  blocks.push({ space, session: '', ports });
  writeRegistry(spaceDir, { blocks });
  return true;
}

/** A new board block, replacing any it had. */
export async function allocateBoardPorts(
  spaceDir: string,
  opts?: AllocateOpts
): Promise<number[]> {
  const space = path.resolve(spaceDir);
  const registry = readRegistry(spaceDir);
  if (findBlock(registry, space, '')) {
    writeRegistry(spaceDir, {
      blocks: registry.blocks.filter(
        (b) => !(b.space === space && b.session === '')
      )
    });
  }
  return allocateBlock(spaceDir, '', opts);
}
