// A small Chrome DevTools Protocol client for the browser panel
// (.specs/browser-panel.md): one WebSocket to one target, commands answered
// by id, events by method name. Nothing else of the protocol is needed, so no
// dependency is taken for it.

/** As much of a WebSocket as this uses. Node has one as a global from 22;
 *  typed here because the runner's Node types predate it, and so a test can
 *  hand in a stand-in. */
export type CdpSocket = {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: { data?: unknown }) => void
  ): void;
};
export type CdpSocketFactory = (url: string) => CdpSocket;

export const NO_WEBSOCKET =
  'The browser panel needs Node 22 or newer on the runner.';

/** Node's own WebSocket. Throws on a Node without one (20, 21). */
export const nodeWebSocket: CdpSocketFactory = (url) => {
  const Ctor = (
    globalThis as { WebSocket?: new (url: string) => CdpSocket }
  ).WebSocket;
  if (!Ctor) throw new Error(NO_WEBSOCKET);
  return new Ctor(url);
};

/** A command with no answer after this long failed: the tab hung or went. */
const COMMAND_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;

type Pending = {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CdpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<
    string,
    (params: Record<string, unknown>) => void
  >();
  private closed = false;
  private onClosed: (() => void) | null = null;

  private constructor(private socket: CdpSocket) {
    socket.addEventListener('message', (event) => this.receive(event.data));
    socket.addEventListener('close', () => this.ended());
    socket.addEventListener('error', () => this.ended());
  }

  /** Resolves once the socket is open. */
  static connect(
    url: string,
    factory: CdpSocketFactory = nodeWebSocket
  ): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      let socket: CdpSocket;
      try {
        socket = factory(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // already closed
        }
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => fail('The tab did not answer.'),
        CONNECT_TIMEOUT_MS
      );
      socket.addEventListener('error', () =>
        fail('Could not connect to the tab.')
      );
      socket.addEventListener('close', () => fail('The tab is closed.'));
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      });
    });
  }

  /** One handler per event name; a second replaces the first. */
  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    this.handlers.set(method, handler);
  }

  /** Called once, when the socket ends for any reason but `close()`. */
  onClose(handler: () => void): void {
    this.onClosed = handler;
  }

  send(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('The tab is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no answer.`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Fire and forget: an input event or an ack whose answer nothing reads.
   *  A failure is dropped, as a lost pointer move would be. */
  post(method: string, params: Record<string, unknown> = {}): void {
    void this.send(method, params).catch(() => {});
  }

  close(): void {
    this.onClosed = null;
    this.ended();
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: { message?: unknown };
    };
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) {
        waiting.reject(
          new Error(String(message.error.message ?? 'The tab refused it.'))
        );
      } else {
        waiting.resolve(asRecord(message.result));
      }
      return;
    }
    if (typeof message.method !== 'string') return;
    // An event handler runs inside the socket's message callback, where an
    // escaping throw would take the runner down with the frame.
    try {
      this.handlers.get(message.method)?.(asRecord(message.params));
    } catch {
      // A broken handler drops the event; the connection stays.
    }
  }

  private ended(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('The tab is closed.'));
    }
    this.pending.clear();
    const handler = this.onClosed;
    this.onClosed = null;
    handler?.();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}
