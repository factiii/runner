// The runner's half of the board MCP, as a session on this runner reaches it
// (.specs/runner-link.md, "Runner credential service").
//
// The board's tools live on the server (`<serverUrl>/mcp/board`, MCP over
// streamable HTTP, POST only) and take the runner's ACCESS token as their
// bearer. A session must not hold that token: it is refreshed while the
// session lives. So the agent's MCP server is a small stdio program
// (`factiii-board-mcp`, in the plugin) that speaks to the runner over the
// space's secrets socket, and THIS is what answers it: one relay per socket
// connection, which turns each JSON-RPC message from the agent into one POST
// with the access token as it is at that moment, and each answer back into
// JSON-RPC messages.
//
// No listener, no port, no URL and no bearer on the session's side: the gate
// is the socket's file mode plus the session token every socket op carries.

/** What the relay writes to the agent's side of the socket. */
export type BoardMcpChannel = {
  /** One JSON-RPC message for the agent. */
  send: (message: unknown) => void;
  /** A line for the bridge program's stderr. Never a token, never a body. */
  log: (text: string) => void;
};

export type BoardMcpRelay = {
  /** One JSON-RPC message (or batch) from the agent. Never throws. */
  receive: (message: unknown) => void;
  /** The agent's side is gone: stop every call that is still open. */
  close: () => void;
};

export type BoardMcpRelayOptions = {
  /** The server's board MCP endpoint, in full. */
  upstream: string;
  /** The runner's access token, read for EACH message, so a refresh is used
   *  by the next call with no restart of anything. */
  accessToken: () => string | undefined;
  channel: BoardMcpChannel;
};

/** JSON-RPC "server error": the call never reached a tool. */
const UPSTREAM_ERROR = -32000;
/** How much of the server's own error text goes into an error message. */
const MAX_ERROR_TEXT = 200;

type JsonRpcId = string | number;
type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const idOf = (value: Loose): JsonRpcId | null =>
  typeof value.id === 'string' || typeof value.id === 'number'
    ? value.id
    : null;

/**
 * Read an SSE body as it arrives and hand over each event's data the moment
 * its blank line is in. Nothing waits for the end of the stream: a tool call
 * that reports progress shows it while it runs.
 */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const drain = (): void => {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end === -1) return;
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) onData(data);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
    drain();
  }
  // A last event the server did not close with a blank line.
  buffer += '\n\n';
  drain();
}

export function openBoardMcpRelay(opts: BoardMcpRelayOptions): BoardMcpRelay {
  const { channel } = opts;
  const inFlight = new Set<AbortController>();
  // Ids of `initialize` requests, to read the negotiated version off the
  // answer: later POSTs name it, as the MCP HTTP transport asks.
  const initializeIds = new Set<JsonRpcId>();
  let protocolVersion: string | null = null;
  // The server's session, when it keeps one (`Mcp-Session-Id` on an answer).
  let sessionId: string | null = null;
  let closed = false;

  const headers = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'user-agent': 'factiii-runner-board-mcp',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {})
  });

  /** Answer every request still waiting with a JSON-RPC error. A message
   *  that asked for no answer (a notification) gets a log line instead. */
  const fail = (ids: Iterable<JsonRpcId>, text: string): void => {
    if (closed) return;
    let answered = false;
    for (const id of ids) {
      answered = true;
      channel.send({
        jsonrpc: '2.0',
        id,
        error: { code: UPSTREAM_ERROR, message: text }
      });
    }
    if (!answered) channel.log(text);
  };

  /** Pass on what the server sent, and note which requests it answered. */
  const deliver = (payload: unknown, waiting: Set<JsonRpcId>): void => {
    if (closed) return;
    for (const item of Array.isArray(payload) ? payload : [payload]) {
      if (isObject(item) && item.method === undefined) {
        const id = idOf(item);
        if (id !== null) {
          waiting.delete(id);
          if (initializeIds.delete(id) && isObject(item.result)) {
            const version = item.result.protocolVersion;
            if (typeof version === 'string') protocolVersion = version;
          }
        }
      }
      channel.send(item);
    }
  };

  const relay = async (message: unknown): Promise<void> => {
    // The requests in this message: each must get exactly one answer.
    const waiting = new Set<JsonRpcId>();
    for (const item of Array.isArray(message) ? message : [message]) {
      if (!isObject(item) || typeof item.method !== 'string') continue;
      const id = idOf(item);
      if (id === null) continue;
      waiting.add(id);
      if (item.method === 'initialize') initializeIds.add(id);
    }

    const token = opts.accessToken();
    if (!token) {
      fail(waiting, 'This runner has no access token right now.');
      return;
    }
    const controller = new AbortController();
    inFlight.add(controller);
    try {
      const res = await fetch(opts.upstream, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(message),
        signal: controller.signal
      });
      const session = res.headers.get('mcp-session-id');
      if (session) sessionId = session;

      if (!res.ok) {
        const said = (await res.text().catch(() => ''))
          .replace(/\s+/g, ' ')
          .slice(0, MAX_ERROR_TEXT);
        // Said once and not tried again: a refused token does not get better
        // by asking, and the runner's own refresh is what replaces it.
        fail(
          waiting,
          res.status === 401
            ? `The server refused this runner's token (HTTP 401). ${said}`.trim()
            : `The board server answered HTTP ${res.status}. ${said}`.trim()
        );
        return;
      }
      const type = res.headers.get('content-type') ?? '';
      if (res.body && type.includes('text/event-stream')) {
        await readSse(res.body, (data) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            channel.log('The board server sent an event that is not JSON.');
            return;
          }
          deliver(parsed, waiting);
        });
      } else if (type.includes('application/json')) {
        const text = await res.text();
        if (text.trim()) deliver(JSON.parse(text), waiting);
      } else {
        // 202 Accepted to a notification, or nothing to read.
        await res.body?.cancel().catch(() => undefined);
      }
      // The answer ended and a request is still open: say so, or the agent
      // waits for it until its own timeout.
      if (waiting.size > 0) {
        fail(waiting, 'The board server ended its answer without a result.');
      }
    } catch (err) {
      fail(
        waiting,
        `The board server could not be reached: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      inFlight.delete(controller);
    }
  };

  return {
    receive: (message) => {
      if (closed) return;
      void relay(message);
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const controller of inFlight) controller.abort();
      inFlight.clear();
      // End the server's session, when it gave one. Today's server keeps
      // none (it answers each POST on its own), so this sends nothing.
      const token = opts.accessToken();
      if (sessionId && token) {
        void fetch(opts.upstream, {
          method: 'DELETE',
          headers: headers(token)
        }).catch(() => undefined);
      }
    }
  };
}
