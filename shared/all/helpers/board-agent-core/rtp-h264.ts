// H.264 into RTP (RFC 6184): libdatachannel carries RTP but does not packetize.
// Mistakes here freeze the picture with no error anywhere, hence the tests.

/** Conservative enough to survive a tunnel or a VPN without IP fragmentation,
 *  which would defeat the point of fragmenting here. */
const MAX_PAYLOAD = 1200;
/** H.264's RTP clock is always 90kHz, whatever the frame rate. */
const CLOCK_HZ = 90_000;

const RTP_HEADER_BYTES = 12;
const FU_A = 28;

type RtpPacketizerOptions = {
  payloadType: number;
  ssrc: number;
};

/**
 * Turns Annex-B access units into RTP packets.
 *
 * Stateful: sequence numbers must be continuous across the whole stream, and a
 * gap is what tells the receiver a packet was lost.
 */
export class H264Packetizer {
  private sequence = Math.floor(Math.random() * 0xffff);
  private payloadType: number;
  private readonly ssrc: number;
  private midExtensionId = 0;
  private mid = '';

  constructor({ payloadType, ssrc }: RtpPacketizerOptions) {
    this.payloadType = payloadType;
    this.ssrc = ssrc;
  }

  /** Known only once the answer exists. A packet stamped with a type the far
   *  end never mapped is dropped silently. */
  setPayloadType(payloadType: number): void {
    this.payloadType = payloadType;
  }

  /** Required whenever the answer declares no `a=ssrc:` — libdatachannel's
   *  does not. Under BUNDLE the receiver demuxes on SSRC or this; with neither,
   *  packets reach the transport and are discarded unattributed. */
  setMidExtension(id: number, mid: string): void {
    this.midExtensionId = id;
    this.mid = mid;
  }

  /** Every packet of a frame shares a timestamp; only the last carries the
   *  marker bit, which is how the far end knows the frame is whole. */
  packetize(accessUnit: Uint8Array, timestampMs: number): Uint8Array[] {
    const timestamp = Math.round(timestampMs * (CLOCK_HZ / 1000)) >>> 0;
    const units = splitAnnexB(accessUnit);
    const packets: Uint8Array[] = [];

    units.forEach((nal, index) => {
      const last = index === units.length - 1;
      if (nal.length <= MAX_PAYLOAD) {
        packets.push(this.packet(nal, timestamp, last));
        return;
      }

      // FU-A: the NAL header is rebuilt across fragments — type into the FU
      // header, importance bits onto the indicator.
      const indicator = (nal[0] & 0xe0) | FU_A;
      const type = nal[0] & 0x1f;
      const body = nal.subarray(1);
      const perFragment = MAX_PAYLOAD - 2;

      for (let offset = 0; offset < body.length; offset += perFragment) {
        const chunk = body.subarray(offset, offset + perFragment);
        const first = offset === 0;
        const final = offset + perFragment >= body.length;
        const payload = new Uint8Array(chunk.length + 2);
        payload[0] = indicator;
        payload[1] = (first ? 0x80 : 0) | (final ? 0x40 : 0) | type;
        payload.set(chunk, 2);
        packets.push(this.packet(payload, timestamp, last && final));
      }
    });

    return packets;
  }

  private packet(
    payload: Uint8Array,
    timestamp: number,
    marker: boolean
  ): Uint8Array {
    const extension = this.midBlock();
    const packet = new Uint8Array(
      RTP_HEADER_BYTES + extension.length + payload.length
    );
    const view = new DataView(packet.buffer);
    packet[0] = 0x80 | (extension.length ? 0x10 : 0); // version 2, X bit
    packet[1] = (marker ? 0x80 : 0) | this.payloadType;
    view.setUint16(2, this.sequence);
    view.setUint32(4, timestamp);
    view.setUint32(8, this.ssrc);
    packet.set(extension, RTP_HEADER_BYTES);
    packet.set(payload, RTP_HEADER_BYTES + extension.length);
    this.sequence = (this.sequence + 1) & 0xffff;
    return packet;
  }

  /** The RFC 8285 one-byte extension carrying the media id, 4-byte padded. */
  private midBlock(): Uint8Array {
    if (!this.midExtensionId || !this.mid) return new Uint8Array(0);
    const value = new TextEncoder().encode(this.mid);
    const body = 1 + value.length; // id/len byte, then the value
    const padded = Math.ceil(body / 4) * 4;
    const block = new Uint8Array(4 + padded);
    const view = new DataView(block.buffer);
    view.setUint16(0, 0xbede); // one-byte extensions
    view.setUint16(2, padded / 4); // length in 32-bit words
    block[4] = (this.midExtensionId << 4) | (value.length - 1);
    block.set(value, 5);
    return block;
  }
}

/** Annex-B to its NAL units, tolerating both 3- and 4-byte start codes. */
function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let start = -1;

  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue;
    if (start >= 0) {
      // A 4-byte start code leaves a trailing zero on the previous unit.
      const end = i > start && data[i - 1] === 0 ? i - 1 : i;
      if (end > start) units.push(data.subarray(start, end));
    }
    start = i + 3;
    i += 2;
  }

  if (start >= 0 && start < data.length) units.push(data.subarray(start));
  return units;
}

/**
 * The H.264 payload type to send with, read out of an SDP. Two silent traps:
 * browsers number the codecs themselves (Chrome never offers 96), and half the
 * types they offer are `packetization-mode=0`, which discards FU-A fragments.
 * Mode 1 only, preferring a profile match.
 */
export function negotiatedH264PayloadType(
  sdp: string,
  profileLevelId?: string
): number | null {
  const video = sdp
    .split(/^m=/m)
    .find((section) => section.startsWith('video'));
  if (!video) return null;

  const h264 = new Set(
    [...video.matchAll(/^a=rtpmap:(\d+) H264\//gm)].map((m) => Number(m[1]))
  );
  if (!h264.size) return null;

  const fmtp = new Map<number, string>();
  for (const [, pt, params] of video.matchAll(/^a=fmtp:(\d+) (.+)$/gm)) {
    fmtp.set(Number(pt), params);
  }

  // The order after the transport on the m-line is the preference order.
  const offered = video.split('\n')[0].trim().split(/\s+/).slice(3).map(Number);
  const usable = offered.filter(
    (pt) => h264.has(pt) && /packetization-mode=1/.test(fmtp.get(pt) ?? '')
  );
  if (!usable.length) return null;

  if (profileLevelId) {
    const exact = usable.find((pt) =>
      (fmtp.get(pt) ?? '').includes(`profile-level-id=${profileLevelId}`)
    );
    if (exact !== undefined) return exact;
  }
  return usable[0];
}

/** The MID extension an SDP negotiated, for receivers with no `a=ssrc:` to
 *  map on instead. */
export function negotiatedMid(sdp: string): { id: number; mid: string } | null {
  const video = sdp
    .split(/^m=/m)
    .find((section) => section.startsWith('video'));
  if (!video) return null;
  const id = /^a=extmap:(\d+) urn:ietf:params:rtp-hdrext:sdes:mid/m.exec(video);
  const mid = /^a=mid:(\S+)/m.exec(video);
  if (!id || !mid) return null;
  return { id: Number(id[1]), mid: mid[1] };
}
