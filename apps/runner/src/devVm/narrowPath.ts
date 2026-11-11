import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

// The narrow path (.specs/dev-vm.md): the one way from the dev VM to the Mac.
// A socket on the Mac, forwarded into the VM over ssh (tunnel.ts) to the path
// sessions already use for `factiii-secrets` (FACTIII_SECRETS_SOCK), so the
// plugin's programs need no change. It speaks the secrets bridge's protocol
// (secrets-bridge.ts: one NDJSON request line first), reads that line, and
// either refuses it or hands the connection, untouched, to the space's real
// bridge socket.
//
// What passes: the board MCP, `factiii-runner job` (list, call, status,
// cancel), git's credential helper (the board's GitHub token, the same token
// the VM already holds as GH_TOKEN) and key NAMES (`list`). What does not:
// `run`, which executes a command on the Mac with secrets in its env (from the
// VM that is branch code on the Mac: use a job), and `tunnel-token`, which is
// the runner's own access token. Plus one op of its own, `simctl`, a short
// allowlist of simulator commands (simctlArgs).
//
// Token-checked here, before anything on the Mac sees the request: the token
// must be the space's (the one every session it spawned carries). The bridge
// checks it again downstream.

/** Ops passed through to the space's bridge. */
export const NARROW_OPS: ReadonlySet<string> = new Set([
  'board-mcp',
  'job-list',
  'job-call',
  'job-status',
  'job-cancel',
  'git-credential',
  'list'
]);

export const REFUSED_RUN =
  'factiii-secrets run is not on the dev VM’s narrow path: it would run a command on the Mac. Ask for a job instead (factiii-runner job list).';
export const REFUSED_TUNNEL =
  'Public previews from the dev VM are not wired yet (.specs/dev-vm.md, "Previews").';
export const REFUSED_TOKEN =
  'The dev VM’s narrow path takes only a token this runner gave a session.';

/** The longest first line taken. A board-mcp request is small; this is a
 *  broken or hostile client. */
const MAX_REQUEST_LINE = 64 * 1024;

export type SimctlRunner = (
  args: string[]
) => Promise<{ code: number; output: string; png?: Buffer }>;

const UDID = /^(booted|[0-9A-Fa-f-]{36})$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
/** Where an openurl may point: this Mac's localhost (Metro, forwarded from
 *  the VM) over http or Expo's scheme, or a dev client's own scheme
 *  (`exp+<slug>://...`, which carries the Metro URL inside it). */
const OPEN_URL =
  /^((https?|exp):\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/|$)|exp\+[a-z0-9-]+:\/\/)/;

/** The simctl argv a VM request may run, or the reason it may not. */
export function simctlArgs(args: unknown): string[] | { error: string } {
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
    return { error: 'simctl args must be strings.' };
  }
  const a = args as string[];
  const [verb, device, value] = a;
  if (verb === 'list') {
    if (a.length === 3 && a[1] === 'devices' && a[2] === '-j') return a;
    return { error: 'Only "list devices -j".' };
  }
  if (!device || !UDID.test(device)) {
    return { error: 'The device is "booted" or a simulator UDID.' };
  }
  if (verb === 'io') {
    if (a.length === 3 && value === 'screenshot') return a;
    return { error: 'Only "io <device> screenshot".' };
  }
  if (a.length !== 3 || !value) return { error: `${verb} takes one value.` };
  if (verb === 'openurl') {
    if (value.length > 4096 || !OPEN_URL.test(value)) {
      return {
        error:
          'openurl opens only this Mac’s localhost (Metro) or a dev client’s exp+<app>:// link.'
      };
    }
    return a;
  }
  if (verb === 'launch' || verb === 'terminate') {
    if (!BUNDLE_ID.test(value)) return { error: 'Not a bundle id.' };
    return a;
  }
  return { error: `simctl ${verb} is not on the narrow path.` };
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}

export type NarrowPath = { close: () => Promise<void> };

/**
 * Serve one space's narrow path at `listenPath` (on the Mac; tunnel.ts puts
 * it in the VM). `upstreamPath` is the space's real bridge socket.
 * `spaceToken` is read per request, so a rotated token counts at once.
 */
export async function startNarrowPath(opts: {
  listenPath: string;
  upstreamPath: string;
  spaceToken: () => string;
  simctl?: SimctlRunner;
}): Promise<NarrowPath> {
  await fs.mkdir(path.dirname(opts.listenPath), {
    recursive: true,
    mode: 0o700
  });
  await fs.rm(opts.listenPath, { force: true });
  const live = new Set<net.Socket>();

  const server = net.createServer((conn) => {
    live.add(conn);
    conn.on('close', () => live.delete(conn));
    conn.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let decided = false;

    const refuse = (message: string) => {
      decided = true;
      conn.end(`${JSON.stringify({ type: 'error', message })}\n`);
    };

    const onData = (chunk: Buffer) => {
      if (decided) return;
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        if (buffer.length > MAX_REQUEST_LINE) refuse('Request too long.');
        return;
      }
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(buffer.subarray(0, newline).toString('utf-8'));
      } catch {
        refuse('Malformed request.');
        return;
      }
      const op = typeof request.op === 'string' ? request.op : '';
      if (op === 'run') return refuse(REFUSED_RUN);
      if (op === 'tunnel-token') return refuse(REFUSED_TUNNEL);
      if (op !== 'simctl' && !NARROW_OPS.has(op)) {
        return refuse(`${op || 'That'} is not on the dev VM’s narrow path.`);
      }
      const token = typeof request.token === 'string' ? request.token : '';
      if (!sameToken(token, opts.spaceToken())) return refuse(REFUSED_TOKEN);
      decided = true;
      conn.off('data', onData);
      // Hold what arrives while the upstream connects: with no listener and
      // no pipe yet, a flowing stream would drop it. pipe() resumes it.
      conn.pause();
      if (op === 'simctl') {
        void serveSimctl(conn, request.args, opts.simctl);
        return;
      }
      pipeUpstream(conn, opts.upstreamPath, buffer);
    };
    conn.on('data', onData);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.listenPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  await fs.chmod(opts.listenPath, 0o600).catch(() => undefined);

  return {
    close: async () => {
      for (const conn of live) conn.destroy();
      live.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(opts.listenPath, { force: true });
    }
  };
}

/** Hand the connection to the real bridge: what was read so far first, then
 *  both directions as they come (board-mcp keeps the connection open). */
function pipeUpstream(conn: net.Socket, upstreamPath: string, head: Buffer): void {
  const up = net.createConnection(upstreamPath);
  up.on('error', () => {
    if (!conn.destroyed) {
      conn.end(
        `${JSON.stringify({ type: 'error', message: 'The runner is not serving this board right now.' })}\n`
      );
    }
  });
  up.once('connect', () => {
    up.write(head);
    conn.pipe(up);
    up.pipe(conn);
  });
  conn.on('close', () => up.destroy());
  up.on('close', () => conn.end());
}

async function serveSimctl(
  conn: net.Socket,
  rawArgs: unknown,
  simctl: SimctlRunner | undefined
): Promise<void> {
  const reply = (message: Record<string, unknown>) =>
    conn.end(`${JSON.stringify(message)}\n`);
  if (!simctl) {
    reply({ type: 'error', message: 'This runner has no simulator.' });
    return;
  }
  const args = simctlArgs(rawArgs);
  if (!Array.isArray(args)) {
    reply({ type: 'error', message: args.error });
    return;
  }
  try {
    const result = await simctl(args);
    reply({
      type: 'simctl',
      code: result.code,
      output: result.output,
      ...(result.png ? { png: result.png.toString('base64') } : {})
    });
  } catch (err) {
    reply({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    });
  }
}
