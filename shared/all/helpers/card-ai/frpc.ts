import { createHash } from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

import type { ExposedPort } from '../../domains/electron';
import type { ExecTarget } from '../board-agent-core/exec';
import { retireBundledSkill } from '../board-agent-core/host-skills';
import { SECRETS_BIN } from '../board-agent-core/plugin';
import { secretsSocketPath } from '../board-agent-core/secrets-bridge';
import { frpcExposeScript, frpcUnexposeScript } from './scripts';

const FRP_SERVER_ADDR = 'dev.factiii.com';
const FRP_SERVER_PORT = 7443;
const FRP_DOMAIN_SUFFIX = 'dev.factiii.com';
/** Hex characters of the task id's hash in a preview's host. The frps is
 *  shared by every runner, so the tag keeps two `app` tunnels apart; 6 hex is
 *  16.7M values, ample for the tunnels live at once. */
const PREVIEW_TAG_LENGTH = 6;

/** The short, stable tag a task's previews carry: `app-<tag>.dev.factiii.com`
 *  rather than the whole task id (`bare-mvy10lba-fox5w6-1793549419772-app`). */
export function previewTag(taskId: string): string {
  return createHash('sha256').update(taskId).digest('hex').slice(0, PREVIEW_TAG_LENGTH);
}

/** Session-local layout. Everything lives under the target's root so nothing
 *  needs root and two spaces on one host cannot collide. */
function frpcPaths(target: ExecTarget) {
  const { root, bin } = target.paths;
  return {
    binDir: bin,
    binary: `${bin}/frpc`,
    expose: `${bin}/factiii-expose`,
    unexpose: `${bin}/factiii-unexpose`,
    envFile: `${root}/.factiii-frp-env`,
    runDir: `${root}/.frpc`
  };
}

/** The vendored binary for THIS host. No `uname` round trip: the target is
 *  this machine now, so node already knows. */
function vendoredBinaryName(): string {
  const cpu = process.arch === 'x64' ? 'amd64' : process.arch;
  return `frpc-${process.platform}-${cpu}`;
}

/** Stage the vendored frpc binary into the session's bin dir. */
async function installFrpcBinary(target: ExecTarget): Promise<void> {
  const p = frpcPaths(target);
  const binaryName = vendoredBinaryName();
  const src = path.join(__dirname, '..', 'vendor', binaryName);
  if (!existsSync(src)) {
    throw new Error(
      `Vendored frpc missing (${src}). Run apps/runner/scripts/fetch-frpc.sh.`
    );
  }
  // Already staged: a 16MB base64 round trip per session start is pure waste.
  const staged = await fs.stat(p.binary).catch(() => null);
  const source = await fs.stat(src);
  if (staged?.size === source.size) return;
  await fs.mkdir(p.binDir, { recursive: true });
  await fs.copyFile(src, p.binary);
  await fs.chmod(p.binary, 0o755);
}

/** The skill's name, which is also its directory under the skills root. */
export const EXPOSE_SKILL_NAME = 'share-a-port';

const FENCE = '```';

/**
 * What the agents were told about the harness staged below, by runners that
 * installed it as a global skill.
 *
 * `factiii-expose` has been on their PATH all along and neither CLI has ever
 * used it, because nothing told them it exists. A skill is how this runner
 * teaches a capability, and one skill covers every case: the skills root is
 * shared by both CLIs, and a bare terminal and a runner-driven card both run on
 * this host under this HOME.
 *
 * The skill now has one source, the factiii plugin
 * (apps/runner/plugin/factiii/skills/share-a-port/SKILL.md), which has moved
 * on from this text. This copy is kept only so retireBundledSkill can tell an
 * untouched install from an edited one: it must stay byte for byte what
 * shipped, so never edit it - edit the plugin's copy.
 */
export const EXPOSE_SKILL_MD = [
  '---',
  `name: ${EXPOSE_SKILL_NAME}`,
  'description: Give a port running in this workspace a public HTTPS URL, with factiii-expose. TRIGGER when the user asks to share, expose, preview or publish a local server, wants a link to something running on localhost, or needs an external service to reach a local port.',
  '---',
  '',
  `# ${EXPOSE_SKILL_NAME}`,
  '',
  'This workspace can put a local port on the public internet. Both commands are',
  'already on your PATH; nothing needs installing.',
  '',
  '## Share a port',
  '',
  FENCE + 'bash',
  'factiii-expose <port> <name>   # e.g. factiii-expose 3000 app',
  FENCE,
  '',
  'It prints the public URL and returns straight away - the tunnel runs in the',
  'background and lives until the session ends or you stop it.',
  '',
  '- `<name>` may hold letters, numbers and dashes only.',
  '- Re-running it with the same name replaces that tunnel rather than opening a',
  '  second one, so it is safe to repeat.',
  '- Start the server FIRST. A URL for a port nothing is listening on answers',
  '  with an error, which reads to the user like a broken tunnel.',
  '',
  '## Stop sharing',
  '',
  FENCE + 'bash',
  'factiii-unexpose <name>',
  FENCE,
  '',
  '## Before you share',
  '',
  'The URL is public and unauthenticated: anyone holding the link reaches',
  'whatever that port serves. Do not expose a service that fronts real',
  'credentials, customer data, or a database. If you are unsure whether the user',
  'wants something reachable from outside, ask first.',
  '',
  'Always tell the user the URL you got back. They can also see every live',
  "tunnel, and stop any of them, in the card's Task Manager panel.",
  ''
].join('\n');

/** The env file's lines. No credential: frps wants the runner's access
 *  token, and `factiii-expose` asks the runner for it when it opens a tunnel
 *  (scripts.ts). Writing this file also removes the token an earlier runner
 *  version put in it. */
export function frpcEnvLines(taskId: string): string[] {
  return [
    `FACTIII_FRP_SERVER=${FRP_SERVER_ADDR}`,
    `FACTIII_FRP_PORT=${FRP_SERVER_PORT}`,
    `FACTIII_FRP_DOMAIN=${FRP_DOMAIN_SUFFIX}`,
    `FACTIII_TASK_ID=${taskId}`,
    `FACTIII_FRP_TAG=${previewTag(taskId)}`
  ];
}

/** Stage `factiii-expose` / `factiii-unexpose` plus the env they read. The
 *  agent calls e.g. `factiii-expose 3000 app`; each spawns its own frpc so
 *  tunnels come and go independently. paths.bin is on the agent's PATH. */
export async function installFrpcHarness(params: {
  target: ExecTarget;
  taskId: string;
}): Promise<void> {
  const { target, taskId } = params;
  const p = frpcPaths(target);

  await installFrpcBinary(target);

  const envLines = frpcEnvLines(taskId);

  const scriptPaths = {
    envFile: p.envFile,
    runDir: p.runDir,
    secretsBin: `${p.binDir}/${SECRETS_BIN}`,
    secretsSock: secretsSocketPath(target.paths.root)
  };
  await target.writeFile(p.expose, frpcExposeScript(scriptPaths));
  await target.writeFile(p.unexpose, frpcUnexposeScript(scriptPaths));
  await target.sh(`chmod +x '${p.expose}' '${p.unexpose}'`);
  await target.writeFile(p.envFile, envLines.join('\n') + '\n');

  // The plugin ships the skill now (see EXPOSE_SKILL_MD), so the copy older
  // runners wrote into the global root only made it show twice. Best effort:
  // a session whose cleanup fails still has a working harness, and the skill
  // is listed twice, as before.
  await retireBundledSkill({
    name: EXPOSE_SKILL_NAME,
    content: EXPOSE_SKILL_MD
  }).catch(() => undefined);
}

/** Field separator for the rows `listLiveTunnels` prints. A pipe cannot occur
 *  in a tunnel name (validated [a-zA-Z0-9-]), a port, or the URL built from
 *  them - and it keeps the shell below free of backslashes, which a template
 *  literal would eat before the shell ever saw them. */
const ROW_SEP = '|';

/**
 * Parse the rows `listLiveTunnels` prints: name, local port, public URL, and
 * the owner when `factiii-expose` recorded one.
 *
 * Separate from the shell that produces them so the parsing is testable, and
 * so a malformed row is dropped rather than rendered as a tunnel to nowhere.
 */
export function parseTunnelRows(raw: string): LiveTunnel[] {
  const tunnels: LiveTunnel[] = [];
  for (const line of raw.split('\n')) {
    const [name, port, url, owner] = line.trim().split(ROW_SEP);
    if (!name || !url) continue;
    const localPort = Number(port);
    if (!Number.isInteger(localPort) || localPort <= 0) continue;
    tunnels.push({ name, port: localPort, url, ...(owner ? { owner } : {}) });
  }
  return tunnels;
}

/** A tunnel plus whoever opened it: a tmux pane id (`%12`) when the command
 *  ran in a terminal, a tmux session name when the Ports panel ran it. Absent
 *  for a tunnel opened by a `factiii-expose` that predates the record. */
type LiveTunnel = ExposedPort & { owner?: string };

/**
 * The tunnels actually running for this space, read from disk rather than from
 * anything we remembered.
 *
 * `factiii-expose` is a script on the agent's PATH: the terminal and the agent
 * can both run it without telling us, and a runner restart forgets whatever we
 * stored. What is true is on disk - a .toml naming the port and subdomain, and
 * a .pid whose process is still alive. A dead pid means the tunnel is gone, so
 * it is skipped rather than reported as public.
 */
export async function listLiveTunnels(
  target: ExecTarget
): Promise<LiveTunnel[]> {
  const p = frpcPaths(target);
  // Runs under `sh`, not the login shell: this parses its own output, and
  // profile chatter on stdout would become a row.
  const script = [
    `set -a; . '${p.envFile}' 2>/dev/null || true; set +a`,
    `cd '${p.runDir}' 2>/dev/null || exit 0`,
    'for pidfile in *.pid; do',
    '  [ -e "$pidfile" ] || continue',
    '  name=$(basename "$pidfile" .pid)',
    '  pid=$(cat "$pidfile" 2>/dev/null)',
    '  [ -n "$pid" ] || continue',
    // The tunnel is whatever frpc is still running; a stale pid file is not one.
    '  kill -0 "$pid" 2>/dev/null || continue',
    '  [ -f "$name.toml" ] || continue',
    `  port=$(sed -n 's/^localPort = *//p' "$name.toml" | head -1)`,
    `  sub=$(sed -n 's/^subdomain = *//p' "$name.toml" | tr -d '"' | head -1)`,
    '  [ -n "$port" ] && [ -n "$sub" ] || continue',
    // https, matching what factiii-expose prints: the runner Mac's nginx
    // terminates TLS for *.dev.factiii.com. Showing http:// here made the
    // Ports panel disagree with the URL the agent had just handed the user.
    '  owner=$(cat "$name.owner" 2>/dev/null || true)',
    `  echo "$name${ROW_SEP}$port${ROW_SEP}https://$sub.$FACTIII_FRP_DOMAIN${ROW_SEP}$owner"`,
    'done'
  ].join('\n');
  const out = await target.run(['sh', '-c', script]).catch(() => '');
  return parseTunnelRows(out).sort((a, b) => a.port - b.port);
}
