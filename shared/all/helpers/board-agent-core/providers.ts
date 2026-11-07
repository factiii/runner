import type { AgentProvider } from '../../domains/electron';

export type { AgentProvider };

// The env var older runners' codex entries for the OneDrive index read their
// bearer from. Nothing sets it now; the default-home cleanup matches it to
// recognise those entries.
export const MCP_TOKEN_ENV = 'FACTIII_ONEDRIVE_MCP_TOKEN';
/** The session's one local credential: what `factiii-secrets` and the board
 *  MCP program (`factiii-board-mcp`) present on the space's secrets socket
 *  (secrets-gate.ts). There is no separate board token variable. */
export const SECRETS_TOKEN_ENV = 'FACTIII_SECRETS_TOKEN';

// The names a space's MCP entries had in the CLIs' config. Per space: the CLIs
// share one host-level config, so a fixed name would have each space overwrite
// the last one's entry. Nothing registers them now; shared by the two
// cleanups that remove them (provisionMcpLane and default-home-cleanup.ts),
// so the two cannot drift.

/** A space slug as it appears in an MCP entry name. */
export const mcpNameSlug = (spaceSlug: string): string =>
  spaceSlug.replace(/[^a-zA-Z0-9_-]/g, '_');

/** The claude entry name the runner OneDrive index (removed) registered. */
export const oneDriveMcpName = (spaceSlug: string): string =>
  `factiii-onedrive-${mcpNameSlug(spaceSlug)}`;

/** The name the board lane had when each space registered its own entry, in
 *  the person's default homes (default-home-cleanup.ts removes it there). */
export const legacyBoardMcpName = (spaceSlug: string): string =>
  `factiii-board-${mcpNameSlug(spaceSlug)}`;

/** Codex's table name for a claude entry name (`[mcp_servers.<this>]`). */
export const codexMcpName = (name: string): string => name.replace(/-/g, '_');

export type ProviderInfo = {
  label: string;
  /** CLI binary name, resolved from the host's PATH. */
  bin: string;
  /** Subdir of the space dir holding this provider's state. */
  /** Env var pointing the CLI at its state dir. */
  /** How to ask the CLI whether it is signed in. `field` names a boolean in
   *  its JSON output; without it, exiting 0 is the answer. */
  status: { command: string; field?: string };
  /** How to sign the CLI out. The CLI owns where the credentials live, so it
   *  is the only thing that can reliably clear them. */
  logoutCommand: string;
};

export const PROVIDERS: Record<AgentProvider, ProviderInfo> = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    status: { command: 'claude auth status --json', field: 'loggedIn' },
    logoutCommand: 'claude auth logout'
  },
  codex: {
    label: 'Codex',
    bin: 'codex',
    // Prints "Not logged in" and exits 1; no JSON mode.
    status: { command: 'codex login status' },
    logoutCommand: 'codex logout'
  }
};

/** Coerce a stored config value into a provider; anything unknown is claude
 *  (the default for configs written before the provider field existed). */
export function resolveProvider(value?: string): AgentProvider {
  return value === 'codex' ? 'codex' : 'claude';
}
