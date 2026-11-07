// The host side of a space's simulator panel. See .specs/simulator-panel.md.
//
// The helpers in `apps/runner/native/` are compiled here rather than shipped:
// the private frameworks they bind to move between Xcode versions.

import { z } from 'zod';

import type { SimulatorDevice, SimulatorInput } from '../../domains/electron';
import type { ExecTarget } from './exec';

type Helper = 'simstream' | 'simhid';

const FRAMEWORKS: Record<Helper, string> = {
  simstream:
    '-framework Foundation -framework IOSurface -framework VideoToolbox ' +
    '-framework CoreMedia -framework CoreVideo',
  simhid: '-framework Foundation -framework AppKit'
};

function shEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// These payloads arrive off the wire, where TypeScript is gone. The helpers are
// C: `simhid` sends whatever it is given straight at a selector, so a number
// where a string belongs kills it, and `simstream` runs every argument through
// `atoi` and hands the result to VideoToolbox. Parsing here, at the boundary
// that spawns them, is what keeps a malformed message a rejected message.

/** A udid as `simctl` writes them. Bounded rather than pinned to a UUID: it is
 *  an opaque identifier, and only its shape needs to be sane. */
const udid = z.string().trim().min(1).max(128);
/** Clamped, not rejected: the panels already clamp, and a pointer a fraction
 *  outside the frame is a rounding artefact, not a bad message. */
const ratio = z
  .number()
  .finite()
  .catch(0)
  .transform((n) => Math.min(1, Math.max(0, n)));

const simulatorInputSchema = z.intersection(
  z.object({ udid }),
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('touch'),
      phase: z.enum(['down', 'move', 'up']),
      x: ratio,
      y: ratio
    }),
    z.object({ type: z.literal('tap'), x: ratio, y: ratio }),
    // Capped because the helper types it a keystroke at a time, sleeping
    // between them: an unbounded string is minutes of a device typing.
    z.object({ type: z.literal('text'), text: z.string().max(2000) }),
    // The keyboard page of the USB HID usage table, `a` to right-GUI. The
    // helper hands the code to the message builder as it comes.
    z.object({
      type: z.literal('key'),
      code: z.number().int().min(4).max(231),
      down: z.boolean()
    }),
    z.object({
      type: z.literal('button'),
      button: z.enum(['HOME', 'LOCK', 'SIRI', 'SIDE', 'APPLE_PAY'])
    }),
    z.object({
      type: z.literal('biometric'),
      kind: z.enum(['face', 'touch']),
      match: z.boolean()
    })
  ])
);

/** Only ever built inside this file; the wire shape lives in the action map. */
type SimulatorAttachOptions = {
  udid: string;
  /** Encoded width in pixels; the helper only ever scales down. 0 means native. */
  width: number;
  fps: number;
  /** Ceiling in bits per second. Uncapped, a full-screen scroll costs ~9Mbps. */
  bitrate: number;
};

/** Bounds are the encoder's, not the panel's: a client asking for 10000fps at a
 *  gigabit is asking the Mac to melt, and VideoToolbox would take it. 0 width
 *  stays legal — the helper reads it as "native". */
const simulatorAttachSchema = z.object({
  udid,
  width: z
    .number()
    .int()
    .catch(0)
    .transform((n) => (n === 0 ? 0 : Math.min(4096, Math.max(160, n)))),
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

export class SimulatorStore {
  private video: { proc: ChildLike; options: SimulatorAttachOptions } | null =
    null;
  /**
   * One input process per device: the helper is bound to the udid it was
   * spawned with. Holds the *promise*, not the process — spawning is async and
   * a drag fires several events at once, so storing the result let each of them
   * see an empty slot and start its own helper.
   */
  private hid = new Map<string, Promise<ChildLike>>();
  private built = new Set<Helper>();

  /**
   * @param target Resolved per call, never held — the space's exec target is
   *               rebuilt as the space provisions.
   * @param emit   One H.264 access unit, Annex-B.
   */
  constructor(
    private target: () => ExecTarget,
    private emit: (accessUnit: Uint8Array, capturedAt: number) => void,
    /** Where the helpers' `.m` sources live, resolved by the runner against its
     *  own install. Empty means the panel is unavailable. */
    private nativeDir: string
  ) {}

  /** Running simulators only — a shutdown one has no display to attach to.
   *
   *  `run`, not `sh`: the watcher asks this every few seconds while a session
   *  window is open, and `sh` sources a whole login profile per call. */
  async list(): Promise<SimulatorDevice[]> {
    const out = await this.target()
      .run(['xcrun', 'simctl', 'list', 'devices', 'available', '-j'])
      .catch(() => '');
    if (!out.trim()) return [];

    let parsed: {
      devices?: Record<string, { udid: string; name: string; state: string }[]>;
    };
    try {
      parsed = JSON.parse(out) as typeof parsed;
    } catch {
      return [];
    }

    const devices: SimulatorDevice[] = [];
    for (const [runtime, entries] of Object.entries(parsed.devices ?? {})) {
      for (const entry of entries) {
        if (entry.state !== 'Booted') continue;
        devices.push({
          udid: entry.udid,
          name: entry.name,
          // "com.apple.CoreSimulator.SimRuntime.iOS-26-4" reads badly in a 190px
          // panel; the tail is the part anyone recognises.
          runtime: runtime.split('.').pop()?.replace(/-/g, ' ') ?? runtime
        });
      }
    }
    return devices.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A set rather than "the first one": with two up, picking by sort order
   *  makes the auto-open land on an arbitrary device and never fire again. */
  async status(): Promise<{ booted: string[] }> {
    return { booted: (await this.list()).map((d) => d.udid) };
  }

  /** Start pushing frames. Idempotent for the same options; different ones
   *  restart the encoder, whose output size is fixed at session start. */
  async attach(raw: SimulatorAttachOptions): Promise<void> {
    const options = simulatorAttachSchema.parse(raw);
    if (this.video) {
      const current = this.video.options;
      if (
        current.udid === options.udid &&
        current.width === options.width &&
        current.fps === options.fps &&
        current.bitrate === options.bitrate
      ) {
        return;
      }
      this.detach();
    }

    const binary = await this.build('simstream');
    const proc = await this.target().spawn([
      binary,
      options.udid,
      '--fps',
      String(options.fps),
      '--width',
      String(options.width),
      '--bitrate',
      String(options.bitrate)
    ]);
    this.video = { proc, options };

    // The helper writes [4-byte BE length][Annex-B payload]. A chunk boundary
    // lands anywhere in that, so hold a tail until a unit is whole.
    let buffered: Uint8Array = new Uint8Array(0);
    proc.stdout?.on('data', (chunk: Uint8Array) => {
      if (this.video?.proc !== proc) return;
      const merged = new Uint8Array(buffered.length + chunk.length);
      merged.set(buffered);
      merged.set(chunk, buffered.length);
      buffered = merged;

      for (;;) {
        if (buffered.length < 4) return;
        const view = new DataView(
          buffered.buffer,
          buffered.byteOffset,
          buffered.length
        );
        const length = view.getUint32(0);
        if (buffered.length < 4 + length) return;
        const unit = buffered.subarray(4, 4 + length);
        buffered = buffered.subarray(4 + length);

        // This runs in the helper's stdout handler, where an escaping throw
        // ends the process rather than the frame.
        try {
          this.emit(unit, Date.now());
        } catch {
          // A broken sink drops frames; the capture keeps running.
        }
      }
    });

    proc.on('exit', () => {
      if (this.video?.proc === proc) this.video = null;
    });
  }

  /** Stop encoding: nobody watching, nothing to encode. */
  detach(): void {
    const proc = this.video?.proc;
    this.video = null;
    proc?.kill('SIGKILL');
  }

  /** One input event. Touch carries 0..1 ratios: the HID layer normalises
   *  against the screen, so nothing here needs the device's size. */
  async input(raw: SimulatorInput): Promise<void> {
    const command = simulatorInputSchema.parse(raw);
    let pending = this.hid.get(command.udid);
    if (!pending) {
      pending = this.build('simhid').then(async (binary) => {
        const proc = await this.target().spawn([binary, command.udid]);
        proc.on('exit', () => {
          if (this.hid.get(command.udid) === pending) {
            this.hid.delete(command.udid);
          }
        });
        return proc;
      });
      this.hid.set(command.udid, pending);
      // A failed spawn must not leave a rejected promise cached, or every later
      // event for this device fails without ever retrying.
      pending.catch(() => this.hid.delete(command.udid));
    }
    const hid = await pending;
    if (hid.exitCode !== null) {
      this.hid.delete(command.udid);
      return;
    }
    hid.stdin?.write(`${JSON.stringify(command)}\n`);
  }

  destroy(): void {
    this.detach();
    for (const pending of this.hid.values()) {
      void pending.then((hid) => hid.kill()).catch(() => {});
    }
    this.hid.clear();
  }

  /** Compile if missing or stale. `clang` ships with the Xcode a simulator
   *  already requires, so this adds no dependency. */
  private async build(helper: Helper): Promise<string> {
    if (!this.nativeDir) {
      throw new Error('This runner has no simulator helpers installed.');
    }
    const source = `${this.nativeDir}/${helper}.m`;
    // Built beside the space rather than into the package: an npm install is
    // not writable on every host, and the binary is per-Xcode anyway.
    const binary = `${this.target().paths.bin}/${helper}`;
    if (this.built.has(helper)) return binary;

    await this.target().sh(
      `if [ ! -x ${shEscape(binary)} ] || [ ${shEscape(source)} -nt ${shEscape(binary)} ]; then
         clang -fobjc-arc -Wno-objc-method-access -Wno-deprecated-declarations \
           ${FRAMEWORKS[helper]} -o ${shEscape(binary)} ${shEscape(source)}
       fi`
    );
    this.built.add(helper);
    return binary;
  }
}

/** Inferred rather than imported from `child_process`: this module also
 *  compiles under the web and mobile tsconfigs, which resolve no node builtins. */
type ChildLike = Awaited<ReturnType<ExecTarget['spawn']>>;
