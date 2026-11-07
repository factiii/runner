import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AskTools } from './ask';

// The Vault as MCP tools, for Claude and Codex answering an Ask turn
// (.specs/runner-vault-ask.md "Ask with a runner's model"): the cloud Ask's file
// tools, as one definition in shared/all (helpers/researchTools.ts) has them,
// run over the runner's own database (askTools.ts). One server per turn, on
// loopback, behind a random bearer token, bound to the asking person's Vault
// access (VaultAsk hands in the tools already scoped). It lives as long as
// the turn. The CLIs reach it as a streamable-HTTP MCP server: each request
// is one JSON-RPC message, answered with one JSON body; there is no SSE
// stream, so GET is refused (the spec's way of saying so).

export const VAULT_MCP_NAME = 'factiii-vault';

/** The tools as Claude names them, for `--allowedTools`. */
export const vaultMcpAllowedTools = (tools: string[]): string =>
  tools.map((tool) => `mcp__${VAULT_MCP_NAME}__${tool}`).join(',');

/** `tools`: the names this turn's server offers, for the CLIs' allow
 *  lists. */
export type VaultMcp = { url: string; token: string; tools: string[]; close: () => void };

/** Requests past this are refused: a search or read is a few hundred bytes,
 *  a save up to RUNNER_NOTE_BODY_CHARS of HTML, escaped. */
const MAX_BODY = 256 * 1024;

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
};

async function answer(tools: AskTools, msg: RpcRequest): Promise<unknown> {
  switch (msg.method) {
    case 'initialize':
      return {
        // The client's own version: this server speaks only tools.
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: VAULT_MCP_NAME, version: '1.0.0' }
      };
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: tools.defs.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input_schema,
          // Only save_research writes; a client that weighs approvals by
          // these sees the rest only read.
          annotations: { readOnlyHint: tool.name !== 'save_research', openWorldHint: false }
        }))
      };
    case 'tools/call': {
      const text = await tools.call(String(msg.params?.name), msg.params?.arguments ?? {});
      return { content: [{ type: 'text', text }], isError: text.startsWith('Tool failed:') };
    }
    default:
      throw Object.assign(new Error(`Method not found: ${String(msg.method)}`), { code: -32601 });
  }
}

/** Serve `tools` on loopback until `close`. */
export async function startVaultMcp(tools: AskTools): Promise<VaultMcp> {
  const token = randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    const reply = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401);
    if (req.method !== 'POST') return reply(405);
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
      if (raw.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      let msg: RpcRequest;
      try {
        msg = JSON.parse(raw) as RpcRequest;
      } catch {
        return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      // A notification (no id) wants no answer.
      if (msg.id === undefined || msg.id === null) return reply(202);
      answer(tools, msg).then(
        (result) => reply(200, { jsonrpc: '2.0', id: msg.id, result }),
        (err: Error & { code?: number }) =>
          reply(200, { jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    tools: tools.defs.map((tool) => tool.name),
    close: () => {
      server.close();
      server.closeAllConnections();
    }
  };
}
