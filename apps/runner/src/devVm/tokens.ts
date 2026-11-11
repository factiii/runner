import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { shQuote, VM_TOKEN_DIR } from './ssh';

// Logins in memory only (.specs/dev-vm.md). The sign-ins stay on the Mac, in
// the runner's own homes; the VM is handed what a session needs, on tmpfs:
//   gh      GH_TOKEN: the board's GitHub token.
//   Claude  CLAUDE_CODE_OAUTH_TOKEN: a long-lived `claude setup-token` token
//           the owner stores once (settings.ts). Nothing is refreshed or
//           written back.
//   Codex   its auth.json, on the tmpfs Codex home. Codex refreshes it in
//           place, so it is copied back to the Mac when it changes.
// Pushed on every VM start and every session start (devVm.ts).

/** Runs a remote command line in the VM as `user`, with `input` on stdin. */
export type VmExec = (
  user: 'admin' | 'session',
  command: string,
  input?: string
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type SpaceTokens = {
  GH_TOKEN?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
};

/** One `NAME='value'` line per token, for VM_ENV_BIN to source. A value that
 *  cannot be a token (a newline, a NUL) is left out rather than written. */
export function tokenEnvFile(tokens: SpaceTokens): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (typeof value !== 'string') continue;
    const clean = value.trim();
    if (!clean || /[\0\r\n]/.test(clean)) continue;
    lines.push(`${name}=${shQuote(clean)}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export function tokenFilePath(slug: string): string {
  return `${VM_TOKEN_DIR}/${slug}.env`;
}

/** Write a space's token file in the VM: through stdin, never argv, and
 *  renamed into place so a session never sources half of one. */
export async function pushSpaceTokens(
  exec: VmExec,
  slug: string,
  tokens: SpaceTokens
): Promise<void> {
  const file = tokenFilePath(slug);
  const tmp = `${file}.tmp`;
  const res = await exec(
    'session',
    `umask 077 && cat > ${shQuote(tmp)} && mv -f ${shQuote(tmp)} ${shQuote(file)}`,
    tokenEnvFile(tokens)
  );
  if (res.code !== 0) {
    throw new Error(`Could not push tokens into the dev VM: ${res.stderr.trim()}`);
  }
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** An auth.json worth keeping: JSON with a tokens object. Anything else (a
 *  half-written file, a signed-out Codex) is never copied back over the
 *  Mac's sign-in. */
function usableCodexAuth(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { tokens?: unknown }).tokens === 'object' &&
      (parsed as { tokens?: unknown }).tokens !== null
    );
  } catch {
    return false;
  }
}

function lastRefresh(text: string): number {
  try {
    const value = (JSON.parse(text) as { last_refresh?: unknown }).last_refresh;
    return typeof value === 'string' ? Date.parse(value) || 0 : 0;
  } catch {
    return 0;
  }
}

/** What the last sync left on both sides, so a change can be told apart
 *  from the copy the runner put there itself. */
export type CodexSyncState = { lastHash: string | null };

export type CodexSyncResult = 'pushed' | 'pulled' | 'same' | 'none';

/**
 * Keep the Mac's and the VM's Codex auth.json the same. Whichever side
 * changed since the last sync wins; when both did, the one Codex refreshed
 * later (`last_refresh`). The Mac's copy is written 0600 and renamed into
 * place.
 */
export async function syncCodexAuth(opts: {
  exec: VmExec;
  hostPath: string;
  vmPath: string;
  state: CodexSyncState;
}): Promise<CodexSyncResult> {
  const { exec, hostPath, vmPath, state } = opts;
  const host = await fs.readFile(hostPath, 'utf-8').catch(() => null);
  const read = await exec('session', `cat ${shQuote(vmPath)} 2>/dev/null`);
  const vm = read.code === 0 && read.stdout ? read.stdout : null;
  if (host === null && vm === null) return 'none';
  const hostHash = host === null ? null : hash(host);
  const vmHash = vm === null ? null : hash(vm);
  if (hostHash === vmHash) {
    state.lastHash = hostHash;
    return 'same';
  }
  const vmChanged = vm !== null && vmHash !== state.lastHash;
  const hostChanged = host !== null && hostHash !== state.lastHash;
  const pull =
    vmChanged &&
    usableCodexAuth(vm) &&
    (!hostChanged || host === null || lastRefresh(vm) > lastRefresh(host));
  if (pull) {
    await fs.mkdir(path.dirname(hostPath), { recursive: true });
    const tmp = `${hostPath}.devvm.tmp`;
    await fs.writeFile(tmp, vm, { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmp, hostPath);
    state.lastHash = vmHash;
    return 'pulled';
  }
  if (host === null) return 'none';
  const tmp = `${vmPath}.tmp`;
  const res = await exec(
    'session',
    `umask 077 && mkdir -p "$(dirname ${shQuote(vmPath)})" && cat > ${shQuote(tmp)} && mv -f ${shQuote(tmp)} ${shQuote(vmPath)}`,
    host
  );
  if (res.code !== 0) {
    throw new Error(`Could not push the Codex sign-in into the dev VM: ${res.stderr.trim()}`);
  }
  state.lastHash = hostHash;
  return 'pushed';
}
