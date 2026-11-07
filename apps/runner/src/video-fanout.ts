// The runner's video stream, pushed to one peer: whoever holds it
// (screen-holder.ts). Kept apart from the daemon so the rule "a non-holder
// gets no frames" can be tested with a stand-in track.

/** One peer's video track. `L` identifies the link it belongs to. */
export type VideoSink<L> = {
  link: L;
  track: {
    isOpen(): boolean;
    sendMessageBinary(packet: Buffer): unknown;
  };
  packetizer: {
    packetize(accessUnit: Uint8Array, capturedAt: number): Uint8Array[];
  };
};

/**
 * One access unit to the open tracks of `holder`, and to no other link's.
 * True when at least one took it. With no holder nothing is sent: frames an
 * encoder still produces after its viewer went reach nobody.
 */
export function sendFrameToHolder<L>(
  sinks: Set<VideoSink<L>>,
  holder: L | null,
  accessUnit: Uint8Array,
  capturedAt: number
): boolean {
  let delivered = false;
  if (holder === null) return delivered;
  for (const sink of sinks) {
    if (sink.link !== holder) continue;
    if (!sink.track.isOpen()) continue;
    // No queue guard here, deliberately. A data channel is reliable and
    // ordered, so a slow reader makes the sender buffer without bound — but a
    // media track is RTP over UDP, where the socket drops rather than queues,
    // and the encoder's own bitrate ceiling is what limits the rate. (Track
    // has no `bufferedAmount` at run time either: the .d.ts declares one, and
    // it is a DataChannel method.) Real congestion control, if it is ever
    // wanted, is `requestBitrate` driven by RTCP.
    // Per sink: sequence numbers are per-stream, so a shared packetizer would
    // hand every peer a stream full of gaps.
    // A track can close between the check above and any packet of this frame,
    // and `sendMessageBinary` throws when it does. This runs inside the
    // helper's stdout handler, so an escaping throw takes the whole runner
    // down — drop the sink and carry on instead.
    try {
      for (const packet of sink.packetizer.packetize(accessUnit, capturedAt)) {
        sink.track.sendMessageBinary(Buffer.from(packet));
      }
      delivered = true;
    } catch (err) {
      sinks.delete(sink);
      console.log(
        '[simulator] dropped a closed track:',
        err instanceof Error ? err.message : err
      );
      continue;
    }
  }
  return delivered;
}
