import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { BrowserStore } from '@shared/all/helpers/board-agent-core/browser-store';
import type { ExecTarget } from '@shared/all/helpers/board-agent-core/exec';

// The browser panel against a real Chrome (.specs/browser-panel.md): a
// headless Chromium this test starts itself, on a free loopback port and a
// throwaway profile, and closes again. It lists the tab, attaches, takes
// screencast frames through the real encoder, and clicks and types into the
// page.
//
// Skipped where there is no Chromium (set FACTIII_TEST_CHROMIUM to one, or
// install Playwright's) or no VideoToolbox (not a Mac).

const NATIVE = path.join(__dirname, '..', 'native');

function findChromium(): string | null {
  const named = process.env.FACTIII_TEST_CHROMIUM;
  if (named) return fs.existsSync(named) ? named : null;
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  let builds: string[];
  try {
    builds = fs
      .readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  } catch {
    return null;
  }
  for (const build of builds) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac']) {
      for (const app of ['Google Chrome for Testing', 'Chromium']) {
        const binary = path.join(
          cache,
          build,
          arch,
          `${app}.app`,
          'Contents',
          'MacOS',
          app
        );
        if (fs.existsSync(binary)) return binary;
      }
    }
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** As much of an ExecTarget as the store uses, on this machine. */
function hostTarget(bin: string): ExecTarget {
  return {
    paths: { bin },
    sh: (cmd: string) =>
      new Promise<string>((resolve, reject) =>
        execFile('/bin/sh', ['-c', cmd], (err, stdout, stderr) =>
          err ? reject(new Error(stderr || err.message)) : resolve(stdout)
        )
      ),
    spawn: async (argv: string[]) =>
      spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] })
  } as unknown as ExecTarget;
}

async function until<T>(
  what: string,
  read: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 15_000
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// A button over the top-left quarter, a text field under it. Both report
// through the title, which `/json/list` carries back.
const PAGE =
  'data:text/html,' +
  encodeURIComponent(
    `<title>start</title><body style="margin:0;background:#fff">
     <button style="position:fixed;left:0;top:0;width:50vw;height:50vh"
       onclick="document.title='clicked'">go</button>
     <input style="position:fixed;left:0;top:60vh;width:50vw;height:20vh"
       oninput="document.title='typed:'+this.value">
     <div style="height:400vh"></div>
     <script>addEventListener('scroll',()=>{document.title='scrolled:'+(scrollY>0)})</script>
     </body>`
  );

const chromium = findChromium();
const skip =
  process.platform !== 'darwin'
    ? 'the encoder is VideoToolbox: macOS only'
    : !chromium
      ? 'no Chromium found (set FACTIII_TEST_CHROMIUM)'
      : false;

describe('browser panel against a real headless Chromium', { skip }, () => {
  let tmp = '';
  let chrome: ChildProcess | null = null;
  let store: BrowserStore | null = null;

  after(async () => {
    store?.destroy();
    if (chrome && chrome.exitCode === null) {
      const gone = new Promise((r) => chrome?.once('exit', r));
      chrome.kill('SIGKILL');
      await gone;
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  it('lists the tab, streams it, and clicks, types and scrolls in it', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-'));
    const port = await freePort();
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    chrome = spawn(
      chromium as string,
      [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${path.join(tmp, 'profile')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=800,600',
        PAGE
      ],
      { stdio: 'ignore' }
    );

    const units: Uint8Array[] = [];
    store = new BrowserStore(
      () => hostTarget(bin),
      (unit) => units.push(Uint8Array.from(unit)),
      NATIVE,
      {
        // The Chrome's port and one nothing listens on, as a session block
        // mostly is.
        ports: () => [
          { port, sessionId: 'session-1' },
          { port: port === 65535 ? port - 1 : port + 1, sessionId: 'session-1' }
        ]
      }
    );
    const s = store;
    const pages = async () => (await s.list()).map((t) => t.url.slice(0, 14));
    const title = async () => (await s.list())[0]?.title;

    // 1. The tab is listed, by a scan of the ports.
    const tab = await until('the tab to be listed', async () =>
      (await s.list({ scan: true })).find((t) => t.title === 'start')
    );
    assert.equal(tab.port, port);
    assert.equal(tab.sessionId, 'session-1');
    assert.match(tab.url, /^data:text\/html/);
    assert.equal(tab.attached, false);

    // 2. Attached, its screencast comes out of the encoder as H.264.
    await s.attach({ id: tab.id, width: 800, fps: 30, bitrate: 2_500_000 });
    await until('an encoded frame', () => units.length > 0);
    const first = units[0];
    // Annex-B, and a keyframe opens with its SPS (NAL type 7).
    assert.deepEqual([...first.subarray(0, 4)], [0, 0, 0, 1]);
    assert.equal(first[4] & 0x1f, 7);
    assert.equal((await s.list())[0].attached, true);

    // 3. A click, by ratio, lands on the button.
    await s.input({ type: 'pointer', phase: 'down', x: 0.25, y: 0.25 });
    await s.input({ type: 'pointer', phase: 'up', x: 0.25, y: 0.25 });
    await until('the click to reach the page', async () =>
      (await title()) === 'clicked'
    );

    // 4. Keys type into the field the next click focuses; text is inserted.
    await s.input({ type: 'pointer', phase: 'down', x: 0.25, y: 0.7 });
    await s.input({ type: 'pointer', phase: 'up', x: 0.25, y: 0.7 });
    await s.input({ type: 'key', code: 'ShiftLeft', key: 'Shift', down: true });
    await s.input({ type: 'key', code: 'KeyH', key: 'H', down: true });
    await s.input({ type: 'key', code: 'KeyH', key: 'H', down: false });
    await s.input({ type: 'key', code: 'ShiftLeft', key: 'Shift', down: false });
    await s.input({ type: 'key', code: 'KeyI', key: 'i', down: true });
    await s.input({ type: 'key', code: 'KeyI', key: 'i', down: false });
    await until('the keys to type', async () => (await title()) === 'typed:Hi');
    await s.input({ type: 'text', text: ' there' });
    await until('the text to insert', async () =>
      (await title()) === 'typed:Hi there'
    );
    await s.input({ type: 'key', code: 'Backspace', key: 'Backspace', down: true });
    await s.input({ type: 'key', code: 'Backspace', key: 'Backspace', down: false });
    await until('Backspace to delete', async () =>
      (await title()) === 'typed:Hi ther'
    );

    // 5. A wheel scrolls the page.
    await s.input({ type: 'wheel', x: 0.75, y: 0.5, dx: 0, dy: 0.5 });
    await until('the wheel to scroll', async () =>
      (await title()) === 'scrolled:true'
    );

    // No key reached Chrome itself: a shortcut would have opened a tab.
    assert.deepEqual(await pages(), ['data:text/html']);

    // 6. Frames kept coming the whole time: a keyframe a second at least.
    assert.ok(units.length > 10, `only ${units.length} frames`);

    // 7. Detached, the encoder stops.
    s.detach();
    await new Promise((r) => setTimeout(r, 300));
    const after = units.length;
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(units.length, after);
    assert.equal((await s.list())[0].attached, false);
  });
});
