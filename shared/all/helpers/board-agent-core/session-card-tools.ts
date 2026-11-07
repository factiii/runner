// The board MCP's session tools: link_card, unlink_card and session_card,
// and set_work_path, which points the session's IDE at the folder its agent
// works in; on a runner, also the hypervisor tools (session-hypervisor.ts),
// which reach the other sessions on the boards it serves. Answered by the runner itself, not the server: the runner holds
// the sessions, and a card link is the session's, not the card's. Everything else
// still goes to the server (board-mcp-relay.ts); this sits in front of it,
// answering its own calls and adding them to the server's tool list.
//
// Which session is asking comes from the bridge (`factiii-board-mcp` sends
// FACTIII_SESSION, which the runner sets on each session it starts). The
// space token proves the caller is one of this runner's sessions, not which;
// FACTIII_SESSION_TOKEN, also set on each session (exec.ts sessionToken),
// proves which: a token that is not the named session's is refused before
// this is reached (space-core.ts). A caller that sends no token (a session
// started before it) is `verified: false`. It keeps link_card and the rest
// on the session it names, which is no more than it can already do to the
// board's cards, but the hypervisor tools act for nobody: the board's lowest
// level, not the owner (session-hypervisor.ts). .specs/card-sessions.md
// "Session tools (answered by the runner)".

import type { BoardMcpChannel, BoardMcpRelay } from './board-mcp-relay';
import { isCardPostId } from './boardTerminal';
import {
  callHypervisorTool,
  HYPERVISOR_TOOL_NAMES,
  HYPERVISOR_TOOLS,
  type HypervisorHost
} from './session-hypervisor';

/** A board's sessions as these tools see them. */
export type SessionLinks = {
  /** The session's card (sessionCardId): a postId, null when it has none,
   *  undefined when there is no such session. */
  card: (session: string) => string | null | undefined;
  /** Link to `cardId`, or unlink with ''. False when there is no such
   *  session. */
  link: (session: string, cardId: string) => boolean;
  /** Point the session's IDE at the project `dir` is in. Throws for a
   *  folder that is not one, or not in the space. */
  workPath: (
    session: string,
    dir: string
  ) => Promise<{ path: string; git: boolean }>;
};

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TOOLS = [
  {
    name: 'session_card',
    description:
      'Which card this session is linked to, if any. A session (a chat or a code session on a runner) can be linked to one card on its board; the link is changed with link_card and unlink_card.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'link_card',
    description:
      'Link this session to a card on its board, replacing any link it had: the card then lists this session, and this session works on that card. postId is the card uuid from list_cards or search_cards.',
    inputSchema: {
      type: 'object',
      properties: { postId: { type: 'string', format: 'uuid' } },
      required: ['postId'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  {
    name: 'set_work_path',
    description:
      'Point this session’s IDE (its file tree, editor and Source Control) at the folder you are working in, when you move to another worktree or checkout. It follows the folder you work in by itself; call this when it should show somewhere else. path is absolute, inside the board’s space; the IDE opens the project (git top) it is in.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  {
    name: 'unlink_card',
    description:
      'Remove this session’s link to its card. The session and the card both stay; only the link goes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, openWorldHint: false }
  }
] as const;

const LOCAL = new Set<string>(TOOLS.map((t) => t.name));

const UNKNOWN_SESSION =
  'This session is not one the runner knows. It may have started before card links existed: restart its terminal, then try again.';

/** What a call answers: its text, and whether it failed. */
async function callSessionTool(
  links: SessionLinks,
  session: string,
  name: string,
  args: Loose
): Promise<{ text: string; isError: boolean }> {
  const current = session ? links.card(session) : undefined;
  if (current === undefined) return { text: UNKNOWN_SESSION, isError: true };
  if (name === 'set_work_path') {
    const dir = typeof args.path === 'string' ? args.path : '';
    try {
      const work = await links.workPath(session, dir);
      return {
        text: `The IDE now shows ${work.path}${work.git ? ', with Source Control' : ''}.`,
        isError: false
      };
    } catch (err) {
      return {
        text: err instanceof Error ? err.message : String(err),
        isError: true
      };
    }
  }
  if (name === 'session_card') {
    return {
      text: current
        ? `This session is linked to card ${current}.`
        : 'This session is not linked to a card.',
      isError: false
    };
  }
  if (name === 'unlink_card') {
    links.link(session, '');
    return {
      text: current
        ? `Unlinked this session from card ${current}.`
        : 'This session was not linked to a card.',
      isError: false
    };
  }
  const postId = typeof args.postId === 'string' ? args.postId : '';
  if (!isCardPostId(postId)) {
    return { text: 'postId must be a card uuid.', isError: true };
  }
  links.link(session, postId);
  return { text: `Linked this session to card ${postId}.`, isError: false };
}

/**
 * Put the session tools in front of the relay `open` makes. `tools/list`
 * answers from the server get them appended; `tools/call` for one of them is
 * answered here and never reaches the server. With `hypervisor` (a runner
 * that lends its boards: the daemon) the hypervisor tools come too
 * (session-hypervisor.ts), for the session `session` on board `slug`.
 */
export function withSessionCardTools(opts: {
  open: (channel: BoardMcpChannel) => BoardMcpRelay;
  channel: BoardMcpChannel;
  session: string;
  /** The caller proved `session` with its session token. */
  verified: boolean;
  links: SessionLinks;
  hypervisor?: { host: HypervisorHost; slug: string } | null;
}): BoardMcpRelay {
  const { channel, session, verified, links } = opts;
  const hypervisor = opts.hypervisor ?? null;
  const tools = hypervisor ? [...TOOLS, ...HYPERVISOR_TOOLS] : [...TOOLS];
  // Ids of tools/list requests on their way to the server.
  const listing = new Set<unknown>();
  const relay = opts.open({
    ...channel,
    send: (message) => {
      if (isObject(message) && listing.delete(message.id)) {
        const result = message.result;
        if (isObject(result) && Array.isArray(result.tools)) {
          channel.send({
            ...message,
            result: { ...result, tools: [...result.tools, ...tools] }
          });
          return;
        }
      }
      channel.send(message);
    }
  });

  const receive = (message: unknown): void => {
    // A batch, one at a time: some of it may be answered here.
    if (Array.isArray(message)) {
      message.forEach(receive);
      return;
    }
    if (isObject(message) && message.method === 'tools/list') {
      if (message.id !== undefined) listing.add(message.id);
    } else if (
      isObject(message) &&
      message.method === 'tools/call' &&
      isObject(message.params) &&
      typeof message.params.name === 'string' &&
      (LOCAL.has(message.params.name) ||
        (hypervisor && HYPERVISOR_TOOL_NAMES.has(message.params.name)))
    ) {
      const params = message.params;
      const id = message.id;
      const name = params.name as string;
      const args = isObject(params.arguments) ? params.arguments : {};
      const answer =
        hypervisor && HYPERVISOR_TOOL_NAMES.has(name)
          ? callHypervisorTool(
              hypervisor.host,
              { slug: hypervisor.slug, session, verified },
              name,
              args
            )
          : callSessionTool(links, session, name, args);
      void answer
        .catch((err: unknown) => ({
          text: err instanceof Error ? err.message : String(err),
          isError: true
        }))
        .then(({ text, isError }) =>
        channel.send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }], isError }
        })
      );
      return;
    }
    relay.receive(message);
  };

  return { receive, close: () => relay.close() };
}
