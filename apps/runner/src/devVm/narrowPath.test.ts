import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  type NarrowPath,
  REFUSED_RUN,
  REFUSED_TOKEN,
  REFUSED_TUNNEL,
  simctlArgs,
  startNarrowPath
} from './narrowPath';

const TOKEN = 'space-token-1234';

/** One request line, the first reply line. */
function ask(sock: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    let buf = '';
    conn.on('error', reject);
    conn.on('connect', () => conn.write(`${JSON.stringify(request)}\n`));
    conn.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        conn.destroy();
        resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      }
    });
  });
}

describe('narrow path', () => {
  let dir: string;
  let narrow: NarrowPath;
  let upstream: net.Server;
  const seen: string[] = [];
  const simCalls: string[][] = [];

  before(async () => {
    // Short: a socket path is capped at 104 bytes on macOS.
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'np-'));
    const upPath = path.join(dir, 'up.sock');
    // The real bridge, standing in: echoes every later line, so a
    // pass-through that keeps its connection (board-mcp) is visible.
    upstream = net.createServer((c) => {
      let first = true;
      c.on('data', (d) => {
        for (const line of d.toString().split('\n').filter(Boolean)) {
          if (first) {
            first = false;
            seen.push(String((JSON.parse(line) as { op: string }).op));
            c.write(`${JSON.stringify({ type: 'upstream', line: JSON.parse(line) })}\n`);
          } else {
            c.write(`${JSON.stringify({ type: 'echo', line })}\n`);
          }
        }
      });
    });
    await new Promise<void>((r) => upstream.listen(upPath, r));
    narrow = await startNarrowPath({
      listenPath: path.join(dir, 'n.sock'),
      upstreamPath: upPath,
      spaceToken: () => TOKEN,
      simctl: async (args) => {
        simCalls.push(args);
        return { code: 0, output: 'ok', png: args[0] === 'io' ? Buffer.from('PNG') : undefined };
      }
    });
  });

  after(async () => {
    await narrow.close();
    upstream.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const sock = () => path.join(dir, 'n.sock');

  it('refuses run and tunnel-token whatever the token', async () => {
    assert.deepEqual(await ask(sock(), { op: 'run', command: 'id', token: TOKEN }), {
      type: 'error',
      message: REFUSED_RUN
    });
    assert.deepEqual(await ask(sock(), { op: 'tunnel-token', token: TOKEN }), {
      type: 'error',
      message: REFUSED_TUNNEL
    });
    assert.equal((await ask(sock(), { op: 'something', token: TOKEN })).type, 'error');
    assert.deepEqual(seen, []);
  });

  it('refuses an allowed op with a token that is not the space’s', async () => {
    for (const token of ['', 'nope', `${TOKEN}x`]) {
      assert.deepEqual(await ask(sock(), { op: 'job-list', token }), {
        type: 'error',
        message: REFUSED_TOKEN
      });
    }
    assert.deepEqual(seen, []);
  });

  it('hands an allowed op to the bridge untouched', async () => {
    const reply = await ask(sock(), { op: 'git-credential', token: TOKEN });
    assert.deepEqual(reply, { type: 'upstream', line: { op: 'git-credential', token: TOKEN } });
    assert.deepEqual(seen, ['git-credential']);
  });

  it('keeps a board-mcp connection open both ways', async () => {
    const lines = await new Promise<string[]>((resolve, reject) => {
      const conn = net.createConnection(sock());
      const got: string[] = [];
      let buf = '';
      conn.on('error', reject);
      // The first frame rides in the same write as the request, as the
      // plugin's board MCP may send it.
      conn.on('connect', () =>
        conn.write(`${JSON.stringify({ op: 'board-mcp', token: TOKEN })}\n{"frame":1}\n`)
      );
      conn.on('data', (d) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          got.push(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (got.length === 2) conn.write('{"frame":2}\n');
          if (got.length === 3) {
            conn.destroy();
            resolve(got);
          }
        }
      });
    });
    assert.equal(JSON.parse(lines[0]!).type, 'upstream');
    assert.deepEqual(JSON.parse(lines[1]!), { type: 'echo', line: '{"frame":1}' });
    assert.deepEqual(JSON.parse(lines[2]!), { type: 'echo', line: '{"frame":2}' });
  });

  it('runs an allowed simctl command, and refuses the rest', async () => {
    const shot = await ask(sock(), { op: 'simctl', token: TOKEN, args: ['io', 'booted', 'screenshot'] });
    assert.deepEqual(shot, { type: 'simctl', code: 0, output: 'ok', png: Buffer.from('PNG').toString('base64') });
    const bad = await ask(sock(), { op: 'simctl', token: TOKEN, args: ['spawn', 'booted', 'sh'] });
    assert.equal(bad.type, 'error');
    assert.equal((await ask(sock(), { op: 'simctl', token: 'x', args: ['list', 'devices', '-j'] })).type, 'error');
    assert.deepEqual(simCalls, [['io', 'booted', 'screenshot']]);
  });
});

describe('simctlArgs', () => {
  it('takes the allowlist', () => {
    for (const args of [
      ['list', 'devices', '-j'],
      ['openurl', 'booted', 'http://localhost:8081'],
      ['openurl', 'booted', 'exp://127.0.0.1:8081/--/home'],
      ['openurl', 'booted', 'exp+factiii://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'],
      ['launch', 'booted', 'com.factiii.app'],
      ['terminate', '0D2C9F2E-1C1B-4E5B-9E4A-111111111111', 'com.factiii.app'],
      ['io', 'booted', 'screenshot']
    ]) {
      assert.deepEqual(simctlArgs(args), args);
    }
  });

  it('refuses everything else', () => {
    for (const args of [
      ['spawn', 'booted', '/bin/sh'],
      ['openurl', 'booted', 'https://evil.example'],
      ['openurl', 'booted', 'http://localhost.evil.example/'],
      ['openurl', 'booted', 'file:///etc/passwd'],
      ['launch', 'booted', 'not a bundle'],
      ['launch', '../x', 'com.a.b'],
      ['io', 'booted', 'recordVideo'],
      ['list'],
      ['openurl', 'booted', 'http://localhost:1', 'extra'],
      'list',
      [1, 2]
    ]) {
      assert.ok(!Array.isArray(simctlArgs(args)), JSON.stringify(args));
    }
  });
});
