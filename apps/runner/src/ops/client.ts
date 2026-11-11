import net from 'node:net';

import { answerChallenge } from './peer';
import { OPS_UNREACHABLE, type OpsOp } from './protocol';

// The session half's end of the ops socket (.specs/ops-user.md). Each call is
// one connection: read the challenge, answer it with a file in the peer dir,
// send the request line, read the answer.

type Frame = Record<string, unknown> & { type?: unknown };

export type OpsClient = {
  call(op: Exclude<OpsOp, 'job-stream'>, body?: Record<string, unknown>): Promise<Frame>;
  /** `job-stream`: each frame until the connection ends. */
  stream(onFrame: (frame: Frame) => void, onEnd: (err?: Error) => void): { close: () => void };
};

export function opsClient(opts: {
  socketPath: string;
  peerDir: string;
  board: string;
  token: () => string;
  /** How long a one-shot call may take. Job calls return at once (the job
   *  queues); a cold first `job-list` clones, so this is generous. */
  timeoutMs?: number;
  answer?: (peerDir: string, nonce: string) => Promise<void>;
}): OpsClient {
  const answer = opts.answer ?? answerChallenge;

  /** Connect, prove who we are, send `request`; `onFrame` gets every line
   *  after the challenge. */
  const open = (
    request: Record<string, unknown>,
    onFrame: (frame: Frame) => void,
    onEnd: (err?: Error) => void
  ): net.Socket => {
    const conn = net.createConnection(opts.socketPath);
    let buffer = '';
    let challenged = false;
    let ended = false;
    const end = (err?: Error) => {
      if (ended) return;
      ended = true;
      onEnd(err);
    };
    conn.on('error', () => end(new Error(OPS_UNREACHABLE)));
    conn.on('close', () => end());
    conn.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let frame: Frame;
        try {
          frame = JSON.parse(line) as Frame;
        } catch {
          conn.destroy();
          end(new Error('The ops service sent a malformed line.'));
          return;
        }
        if (!challenged) {
          challenged = true;
          if (frame.type !== 'challenge' || typeof frame.nonce !== 'string') {
            conn.destroy();
            end(new Error('The ops service sent no challenge.'));
            return;
          }
          void answer(opts.peerDir, frame.nonce)
            .then(() => conn.write(`${JSON.stringify(request)}\n`))
            .catch((err: unknown) => {
              conn.destroy();
              end(err instanceof Error ? err : new Error(String(err)));
            });
          continue;
        }
        onFrame(frame);
      }
    });
    return conn;
  };

  return {
    call: (op, body = {}) =>
      new Promise<Frame>((resolve, reject) => {
        let answered: Frame | null = null;
        const conn = open(
          { ...body, op, board: opts.board, token: opts.token() },
          (frame) => {
            answered ??= frame;
          },
          (err) => {
            clearTimeout(timer);
            if (answered?.type === 'error') {
              reject(new Error(String(answered.message ?? 'The ops service refused.')));
            } else if (answered) {
              resolve(answered);
            } else {
              reject(err ?? new Error(OPS_UNREACHABLE));
            }
          }
        );
        const timer = setTimeout(() => conn.destroy(), opts.timeoutMs ?? 5 * 60_000);
      }),
    stream: (onFrame, onEnd) => {
      const conn = open(
        { op: 'job-stream', board: opts.board, token: opts.token() },
        onFrame,
        onEnd
      );
      return { close: () => conn.destroy() };
    }
  };
}
