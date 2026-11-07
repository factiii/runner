// Chunked-message framing for WebRTC data channels — SCTP per-message limits
// vary across implementations (Chrome 256KB, node-datachannel ~16KB), so we
// always frame messages above MAX_INLINE_BYTES into small chunks and
// reassemble on the receiver.

const MAX_INLINE_BYTES = 14_000;

type ChunkFrame = { __c: string; __i: number; __n: number; d: string };

let chunkCounter = 0;
function nextChunkId(): string {
  return `c-${++chunkCounter}-${Date.now()}`;
}

export function chunkWire(wire: string): string[] {
  if (wire.length <= MAX_INLINE_BYTES) return [wire];
  const id = nextChunkId();
  const total = Math.ceil(wire.length / MAX_INLINE_BYTES);
  const frames: string[] = [];
  for (let i = 0; i < total; i++) {
    const start = i * MAX_INLINE_BYTES;
    const slice = wire.slice(start, start + MAX_INLINE_BYTES);
    const frame: ChunkFrame = { __c: id, __i: i, __n: total, d: slice };
    frames.push(JSON.stringify(frame));
  }
  return frames;
}

type Reassembler = {
  feed(raw: string): string | null;
};

export function makeChunkReassembler(): Reassembler {
  const buffers = new Map<string, { received: string[]; total: number }>();
  return {
    feed(raw: string): string | null {
      if (!raw.startsWith('{"__c"')) return raw;
      let frame: ChunkFrame;
      try {
        frame = JSON.parse(raw) as ChunkFrame;
      } catch {
        return raw;
      }
      if (
        typeof frame.__c !== 'string' ||
        typeof frame.__i !== 'number' ||
        typeof frame.__n !== 'number' ||
        typeof frame.d !== 'string'
      ) {
        return raw;
      }

      let buf = buffers.get(frame.__c);
      if (!buf) {
        buf = { received: new Array(frame.__n) as string[], total: frame.__n };
        buffers.set(frame.__c, buf);
      }
      buf.received[frame.__i] = frame.d;

      for (let i = 0; i < buf.total; i++) {
        if (buf.received[i] === undefined) return null;
      }

      buffers.delete(frame.__c);
      return buf.received.join('');
    }
  };
}
