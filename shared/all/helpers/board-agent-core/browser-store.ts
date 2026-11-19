// The host side of a board's browser panel. See .specs/browser-panel.md.
//
// A tab of the Chrome an agent started for QA, streamed through Chrome's own
// DevTools protocol (`Page.startScreencast`) rather than captured off the
// screen: it needs no macOS permission, works headless or behind a locked
// screen, and never moves the real cursor. The frames are JPEG; `jpegstream`
// (apps/runner/native) puts them through the encoder the simulator uses, so
// what reaches the video track is the same H.264 stream.

import { z } from 'zod';

import type { BrowserCommand, BrowserTab } from '../../domains/electron';
import { BROWSER_KEY_CODES, BROWSER_TEXT_MAX } from '../browserKeys';
import { CdpClient, type CdpSocketFactory, nodeWebSocket } from './cdp-client';
import type { ExecTarget } from './exec';
import { buildNativeHelper } from './simulator-store';

/** A port an agent may have started Chrome on, and whose block it is in. */
export type BrowserPort = { port: number; sessionId: string };

/** Chrome only answers the debugging endpoints on a loopback Host. */
const HOST = '127.0.0.1';
/** Per port. Nothing listening refuses at once; this bounds a port that
 *  accepts and never answers. */
const LIST_TIMEOUT_MS = 800;
/** A `/json/list` longer than this is not one. */
const LIST_MAX_BYTES = 2_000_000;
/** How long a second press counts as a double click, and how near (px). */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 5;
/** JPEG frames waiting on the encoder's stdin before new ones are dropped:
 *  the encoder only ever wants the newest. */
const MAX_QUEUED_BYTES = 8_000_000;
const JPEG_QUALITY = 80;
/** Screencast frames are scaled to fit this box. Only the width is asked
 *  for; the height just has to be out of the way. */
const MAX_FRAME_HEIGHT = 4096;

// ── Payloads, parsed where they arrive (as simulator-store.ts does) ──

/** Clamped, not rejected: a pointer a fraction outside the picture is a
 *  rounding artefact, not a bad message. */
const ratio = z
  .number()
  .finite()
  .catch(0)
  .transform((n) => Math.min(1, Math.max(0, n)));
/** A wheel's distance as a ratio of the viewport, a few screens at most. */
const wheelRatio = z
  .number()
  .finite()
  .catch(0)
  .transform((n) => Math.min(4, Math.max(-4, n)));

const browserInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pointer'),
    phase: z.enum(['down', 'move', 'up']),
    x: ratio,
    y: ratio,
    button: z.enum(['left', 'middle', 'right']).catch('left')
  }),
  z.object({
    type: z.literal('wheel'),
    x: ratio,
    y: ratio,
    dx: wheelRatio,
    dy: wheelRatio
  }),
  z.object({
    type: z.literal('key'),
    code: z.string().max(32),
    key: z.string().max(32),
    down: z.boolean()
  }),
  // Capped like the simulator's: a pasted file is not typing.
  z.object({ type: z.literal('text'), text: z.string().max(BROWSER_TEXT_MAX) })
]);
type ParsedInput = z.infer<typeof browserInputSchema>;

const browserAttachSchema = z.object({
  id: z.string().max(128),
  /** The picture's width in pixels; Chrome only ever scales down. */
  width: z
    .number()
    .int()
    .catch(1280)
    .transform((n) => Math.min(4096, Math.max(160, n))),
  fps: z
    .number()
    .int()
    .catch(30)
    .transform((n) => Math.min(60, Math.max(1, n))),
  bitrate: z
    .number()
    .int()
    .catch(2_500_000)
    .transform((n) => Math.min(20_000_000, Math.max(100_000, n)))
});
type BrowserAttachOptions = z.infer<typeof browserAttachSchema>;

// ── Targets ──

/** Chrome's own target ids are hex; bounded and plain so one can sit in a
 *  URL path. */
const TARGET_ID = /^[A-Za-z0-9-]{1,64}$/;

/** `<port>:<target id>`, or null when it is not that shape. */
export function parseTabId(id: string): { port: number; target: string } | null {
  const at = id.indexOf(':');
  if (at < 1) return null;
  const port = Number(id.slice(0, at));
  const target = id.slice(at + 1);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!TARGET_ID.test(target)) return null;
  return { port, target };
}

/** A page a person would look at: not DevTools itself, an extension's
 *  background page or a worker. */
function isWatchable(type: unknown, url: string): boolean {
  if (type !== 'page') return false;
  return !/^(devtools|chrome-extension|chrome-untrusted):/i.test(url);
}

/** One port's `/json/list` body as tabs. Anything that is not Chrome's
 *  answer (a dev server's 404 page, JSON of another shape) is no tabs. */
export function parseTargets(
  at: BrowserPort,
  body: string,
  attachedId: string | null
): BrowserTab[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const tabs: BrowserTab[] = [];
  for (const entry of parsed as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.id !== 'string' || !TARGET_ID.test(t.id)) continue;
    const url = typeof t.url === 'string' ? t.url : '';
    if (!isWatchable(t.type, url)) continue;
    const id = `${at.port}:${t.id}`;
    tabs.push({
      id,
      port: at.port,
      // Display strings only; bounded so a hostile page title cannot fill
      // the wire.
      title: (typeof t.title === 'string' ? t.title : '').slice(0, 200),
      url: url.slice(0, 500),
      sessionId: at.sessionId,
      attached: id === attachedId
    });
  }
  return tabs;
}

// ── Input mapping ──

/** The tab's viewport in CSS pixels, from the last screencast frame. */
export type BrowserViewport = { width: number; height: number };

/** A 0..1 ratio of the picture as a point in the viewport, in CSS pixels:
 *  what `Input.dispatchMouseEvent` takes. */
export function ratioToPixels(
  x: number,
  y: number,
  viewport: BrowserViewport
): { x: number; y: number } {
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return {
    x: Math.min(viewport.width - 1, Math.floor(clamp(x) * viewport.width)),
    y: Math.min(viewport.height - 1, Math.floor(clamp(y) * viewport.height))
  };
}

/** CDP's modifier bits. */
const MODIFIER_BITS: Record<string, number> = {
  AltLeft: 1,
  AltRight: 1,
  ControlLeft: 2,
  ControlRight: 2,
  ShiftLeft: 8,
  ShiftRight: 8
};
const CONTROL = 2;

/** The modifier mask for the keys held now. */
export function modifierMask(held: Iterable<string>): number {
  let mask = 0;
  for (const code of held) mask |= MODIFIER_BITS[code] ?? 0;
  return mask;
}

/**
 * One key event as `Input.dispatchKeyEvent` params, or null for a key the
 * panel does not pass through.
 *
 * A key that types a character goes down as `keyDown` with its `text`, which
 * is what makes Chrome insert it; anything else (arrows, a Ctrl chord) as
 * `rawKeyDown`, which only fires the key handlers.
 */
export function keyEventParams(
  command: { code: string; key: string; down: boolean },
  modifiers: number,
  repeat: boolean
): Record<string, unknown> | null {
  const virtualKey = BROWSER_KEY_CODES[command.code];
  if (virtualKey === undefined) return null;
  const base = {
    code: command.code,
    key: command.key,
    // No `nativeVirtualKeyCode`: on a Mac that is the hardware key code, a
    // different numbering, and Chrome matches its own shortcuts on it. Sent
    // as the Windows code, a lone Shift opened chrome://help.
    windowsVirtualKeyCode: virtualKey,
    modifiers
  };
  if (!command.down) return { type: 'keyUp', ...base };

  let text = '';
  if (command.code === 'Enter') text = '\r';
  else if ([...command.key].length === 1 && !(modifiers & CONTROL)) {
    text = command.key;
  }
  return text
    ? {
        type: 'keyDown',
        ...base,
        text,
        unmodifiedText: text,
        autoRepeat: repeat
      }
    : { type: 'rawKeyDown', ...base, autoRepeat: repeat };
}

const BUTTON_BITS = { left: 1, right: 2, middle: 4 } as const;

// ── The store ──

type Video = {
  id: string;
  options: BrowserAttachOptions;
  cdp: CdpClient;
  encoder: ChildLike;
  viewport: BrowserViewport | null;
  /** Keys the tab believes are down. */
  held: Set<string>;
  pressed: 'left' | 'middle' | 'right' | null;
  lastDown: { at: number; x: number; y: number; count: number } | null;
};

export type BrowserStoreDeps = {
  /** The board's ports: its sessions' blocks and its own. Read per call. */
  ports: () => BrowserPort[];
  fetch?: typeof fetch;
  socket?: CdpSocketFactory;
  now?: () => number;
};

export class BrowserStore {
  private video: Video | null = null;
  /** Counts attaches, so one that was overtaken while it connected can tell. */
  private attachSeq = 0;
  /** Ports that answered as Chrome on the last scan. */
  private chromePorts = new Set<number>();
  /** The encoder helper, once built. */
  private binary: string | null = null;

  /**
   * @param target Resolved per call, never held (as SimulatorStore).
   * @param emit   One H.264 access unit, Annex-B.
   */
  constructor(
    private target: () => ExecTarget,
    private emit: (accessUnit: Uint8Array, capturedAt: number) => void,
    /** Where the helpers' sources live; empty means no encoder here. */
    private nativeDir: string,
    private deps: BrowserStoreDeps
  ) {}

  /** The tabs of every Chrome with a debugging port on one of the board's
   *  ports. `scan` asks every port; otherwise only those that were Chrome on
   *  the last scan, so a dev server is not asked on every refresh. */
  async list(raw: { scan?: boolean } = {}): Promise<BrowserTab[]> {
    const all = this.deps.ports();
    const scan = raw.scan === true;
    const ask = scan ? all : all.filter((p) => this.chromePorts.has(p.port));
    const found = await Promise.all(
      ask.map(async (at) => ({ at, tabs: await this.tabsOn(at) }))
    );
    if (scan) this.chromePorts.clear();
    const tabs: BrowserTab[] = [];
    for (const { at, tabs: onPort } of found) {
      if (onPort === null) {
        this.chromePorts.delete(at.port);
        continue;
      }
      this.chromePorts.add(at.port);
      tabs.push(...onPort);
    }
    return tabs;
  }

  /** Null when the port is not a Chrome debugging port (or nothing listens). */
  private async tabsOn(at: BrowserPort): Promise<BrowserTab[] | null> {
    const doFetch = this.deps.fetch ?? fetch;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LIST_TIMEOUT_MS);
    try {
      const res = await doFetch(`http://${HOST}:${at.port}/json/list`, {
        signal: abort.signal,
        // A dev server that redirects must not send the runner elsewhere.
        redirect: 'error'
      });
      if (!res.ok) return null;
      const body = await res.text();
      if (body.length > LIST_MAX_BYTES) return null;
      // Chrome's answer is a JSON array, even with no tabs.
      if (!body.trimStart().startsWith('[')) return null;
      return parseTargets(at, body, this.video?.id ?? null);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Start pushing a tab's frames. Idempotent for the same options while the
   *  tab is open; anything else replaces what was attached. */
  async attach(raw: BrowserAttachOptions): Promise<void> {
    const options = browserAttachSchema.parse(raw);
    const where = parseTabId(options.id);
    if (!where) throw new Error('That is not a tab of this board’s browser.');
    // Only a port of this board: the id comes off the wire, and the runner
    // must not be talked into driving another board's Chrome, or anything
    // else on this machine that speaks the protocol.
    if (!this.deps.ports().some((p) => p.port === where.port)) {
      throw new Error('That tab is not on one of this board’s ports.');
    }
    const current = this.video;
    if (
      current &&
      current.options.id === options.id &&
      current.options.width === options.width &&
      current.options.fps === options.fps &&
      current.options.bitrate === options.bitrate
    ) {
      return;
    }
    this.detach();
    const seq = ++this.attachSeq;

    // Built from the port and id, never taken from `/json/list`: what answers
    // on the port chooses that field.
    const cdp = await CdpClient.connect(
      `ws://${HOST}:${where.port}/devtools/page/${where.target}`,
      this.deps.socket ?? nodeWebSocket
    );
    let encoder: ChildLike;
    try {
      encoder = await this.startEncoder(options);
    } catch (err) {
      cdp.close();
      throw err;
    }
    // A detach or another attach came in while this one connected.
    if (seq !== this.attachSeq) {
      cdp.close();
      encoder.kill('SIGKILL');
      return;
    }

    const video: Video = {
      id: options.id,
      options,
      cdp,
      encoder,
      viewport: null,
      held: new Set(),
      pressed: null,
      lastDown: null
    };
    this.video = video;
    const end = () => {
      if (this.video === video) this.detach();
    };
    cdp.onClose(end);
    encoder.on('exit', end);

    cdp.on('Page.screencastFrame', (frame) => {
      if (this.video !== video) return;
      // Unacknowledged, Chrome sends no further frame.
      cdp.post('Page.screencastFrameAck', { sessionId: frame.sessionId });
      const meta = (frame.metadata ?? {}) as Record<string, unknown>;
      const width = Number(meta.deviceWidth);
      const height = Number(meta.deviceHeight);
      if (width >= 1 && height >= 1) video.viewport = { width, height };
      if (typeof frame.data !== 'string') return;
      const stdin = encoder.stdin;
      if (!stdin || stdin.writableLength > MAX_QUEUED_BYTES) return;
      const jpeg = Buffer.from(frame.data, 'base64');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(jpeg.length);
      stdin.write(header);
      stdin.write(jpeg);
    });

    try {
      await cdp.send('Page.enable');
      // A tab behind another paints nothing, so it would attach and stay
      // black. This raises it within its own Chrome.
      await cdp.send('Page.bringToFront').catch(() => undefined);
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: JPEG_QUALITY,
        maxWidth: options.width,
        maxHeight: MAX_FRAME_HEIGHT,
        everyNthFrame: 1
      });
    } catch (err) {
      end();
      throw err;
    }
  }

  private async startEncoder(options: BrowserAttachOptions): Promise<ChildLike> {
    // Once per run: the build check sources a login shell.
    this.binary ??= await buildNativeHelper(
      this.target(),
      this.nativeDir,
      'jpegstream'
    ).catch((err: unknown) => {
      throw new Error(
        'The browser panel needs a Mac runner with Xcode’s command line tools: ' +
          (err instanceof Error ? err.message : String(err))
      );
    });
    const proc = await this.target().spawn([
      this.binary,
      '--fps',
      String(options.fps),
      // Chrome already scaled the frame to the width asked for.
      '--width',
      '0',
      '--bitrate',
      String(options.bitrate)
    ]);
    // A write after the helper went must not become an unhandled error.
    proc.stdin?.on('error', () => undefined);

    // [4-byte BE length][Annex-B payload], as simstream writes. A chunk
    // boundary lands anywhere in that, so hold a tail until a unit is whole.
    let buffered: Uint8Array = new Uint8Array(0);
    proc.stdout?.on('data', (chunk: Uint8Array) => {
      if (this.video?.encoder !== proc) return;
      const merged = new Uint8Array(buffered.length + chunk.length);
      merged.set(buffered);
      merged.set(chunk, buffered.length);
      buffered = merged;
      for (;;) {
        if (buffered.length < 4) return;
        const length = new DataView(
          buffered.buffer,
          buffered.byteOffset,
          buffered.length
        ).getUint32(0);
        if (buffered.length < 4 + length) return;
        const unit = buffered.subarray(4, 4 + length);
        buffered = buffered.subarray(4 + length);
        // In the helper's stdout handler, where an escaping throw ends the
        // process rather than the frame.
        try {
          this.emit(unit, Date.now());
        } catch {
          // A broken sink drops frames; the capture keeps running.
        }
      }
    });
    return proc;
  }

  /** Stop the screencast and the encoder: nobody watching, nothing to encode. */
  detach(): void {
    this.attachSeq++;
    const video = this.video;
    if (!video) return;
    this.video = null;
    // Lift what the tab believes is held, or a Shift that was down when the
    // panel closed stays down for the agent's next click.
    const modifiers = modifierMask(video.held);
    for (const code of video.held) {
      const params = keyEventParams({ code, key: '', down: false }, modifiers, false);
      if (params) video.cdp.post('Input.dispatchKeyEvent', params);
    }
    video.cdp.post('Page.stopScreencast');
    video.cdp.close();
    video.encoder.kill('SIGKILL');
  }

  /** One input event, to the attached tab only. Dropped before the first
   *  frame: until then nothing says how big the viewport is. */
  async input(raw: BrowserCommand): Promise<void> {
    const command: ParsedInput = browserInputSchema.parse(raw);
    const video = this.video;
    if (!video) throw new Error('Open a tab first.');
    const modifiers = modifierMask(video.held);

    if (command.type === 'text') {
      if (command.text) {
        video.cdp.post('Input.insertText', { text: command.text });
      }
      return;
    }
    if (command.type === 'key') {
      const repeat = command.down && video.held.has(command.code);
      if (command.down) video.held.add(command.code);
      else video.held.delete(command.code);
      // A modifier counts for its own event too, as a real keyboard's does.
      const params = keyEventParams(
        command,
        command.down ? modifierMask(video.held) : modifiers,
        repeat
      );
      if (params) video.cdp.post('Input.dispatchKeyEvent', params);
      return;
    }

    if (!video.viewport) return;
    const point = ratioToPixels(command.x, command.y, video.viewport);
    if (command.type === 'wheel') {
      video.cdp.post('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...point,
        deltaX: command.dx * video.viewport.width,
        deltaY: command.dy * video.viewport.height,
        modifiers
      });
      return;
    }

    if (command.phase === 'move') {
      video.cdp.post('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        ...point,
        button: video.pressed ?? 'none',
        buttons: video.pressed ? BUTTON_BITS[video.pressed] : 0,
        modifiers
      });
      return;
    }
    if (command.phase === 'down') {
      const now = (this.deps.now ?? Date.now)();
      const last = video.lastDown;
      const again =
        last !== null &&
        now - last.at <= MULTI_CLICK_MS &&
        Math.abs(last.x - point.x) <= MULTI_CLICK_PX &&
        Math.abs(last.y - point.y) <= MULTI_CLICK_PX;
      const count = again ? last.count + 1 : 1;
      video.lastDown = { at: now, ...point, count };
      video.pressed = command.button;
      video.cdp.post('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...point,
        button: command.button,
        buttons: BUTTON_BITS[command.button],
        clickCount: count,
        modifiers
      });
      return;
    }
    const button = video.pressed ?? command.button;
    video.pressed = null;
    video.cdp.post('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button,
      buttons: 0,
      clickCount: video.lastDown?.count ?? 1,
      modifiers
    });
  }

  destroy(): void {
    this.detach();
  }
}

/** Inferred rather than imported from `child_process` (as simulator-store). */
type ChildLike = Awaited<ReturnType<ExecTarget['spawn']>>;
