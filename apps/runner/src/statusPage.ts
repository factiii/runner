import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { toolDirs } from '@shared/all/helpers/board-agent-core/host-env';
import type { RunnerHealthLevel } from '@shared/all/domains/electron';

import { CONFIG_DIR } from './paths';
import { readBootJson, writeBootJson } from './secureFile';

// Heartbeats to status.factiii.com (apps/status), the page that watches
// Factiii from outside it: so a runner shows there, and an alert goes out
// when it stops, even with Factiii's own servers down. Off until the owner
// sets it with `factiii-runner status-page set <url>`. The token lives with
// the runner's other boot secrets (secureFile.ts), never in a log line.

export type StatusPageConfig = { url: string; token: string };

const FILE = path.join(CONFIG_DIR, 'status-page.json');
/** The page counts a runner down after 6 quiet minutes. */
const BEAT_MS = 2 * 60_000;
/** Machine health is many processes; its level is read this often at most. */
const LEVEL_EVERY_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;

export function readStatusPage(): StatusPageConfig | null {
  const saved = readBootJson<Partial<StatusPageConfig>>(FILE);
  return saved?.url && saved.token
    ? { url: saved.url, token: saved.token }
    : null;
}

export function writeStatusPage(config: StatusPageConfig | null): void {
  writeBootJson(FILE, config ?? {});
}

/** `https://status.factiii.com` or a path under it: the heartbeat URL. */
export function heartbeatUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol !== 'https:')
    throw new Error('The status page must be https.');
  url.pathname = '/heartbeat';
  url.search = '';
  return url.toString();
}

/** How an admin on the tailnet reaches this machine when Factiii is down:
 *  shown only on the page's /admin, behind Cloudflare Access. */
export type Tailnet = { name: string | null; ip: string | null; user: string };

/** This machine's MagicDNS name and Tailscale address from
 *  `tailscale status --json`; null when it is not on a tailnet. */
export function tailnetFromStatus(json: string, user: string): Tailnet | null {
  let status: {
    BackendState?: string;
    Self?: { DNSName?: string; TailscaleIPs?: string[] };
  };
  try {
    status = JSON.parse(json);
  } catch {
    return null;
  }
  if (status.BackendState !== 'Running' || !status.Self) return null;
  const name = status.Self.DNSName?.replace(/\.$/, '') || null;
  const ip =
    status.Self.TailscaleIPs?.find((a) => a.startsWith('100.')) ?? null;
  return name || ip ? { name, ip, user } : null;
}

// Read only: the runner never installs or starts Tailscale (Factiii Desktop
// does). The service's PATH may lack Homebrew, so the usual places are tried,
// in the toolchain's order (host-env.ts toolDirs), then the Mac app.
const tailscaleBins = () => [
  ...toolDirs().map((dir) => path.join(dir, 'tailscale')),
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
];

async function readTailnet(): Promise<Tailnet | null> {
  for (const bin of tailscaleBins()) {
    const out = await new Promise<string | null>((resolve) => {
      execFile(bin, ['status', '--json'], { timeout: 5000 }, (err, stdout) =>
        resolve(err ? null : stdout)
      );
    });
    if (out !== null) return tailnetFromStatus(out, os.userInfo().username);
  }
  return null;
}

/** One beat. Resolves the HTTP status, or throws when it never answered. */
export async function sendBeat(
  config: StatusPageConfig,
  body: {
    runner: string;
    version: string;
    level: RunnerHealthLevel;
    tailnet?: Tailnet | null;
  }
): Promise<number> {
  const res = await fetch(heartbeatUrl(config.url), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  return res.status;
}

/** Beat every BEAT_MS while configured. The file is read each time, so
 *  `status-page set` and `off` take effect without a restart. Returns a stop. */
export function startStatusHeartbeat(opts: {
  runnerName: () => string;
  version: string;
  level: () => Promise<RunnerHealthLevel>;
}): () => void {
  let level: RunnerHealthLevel = 'ok';
  let levelAt = 0;
  let tailnet: Tailnet | null = null;
  let warned = false;
  const beat = async () => {
    const config = readStatusPage();
    if (!config) return;
    if (Date.now() - levelAt > LEVEL_EVERY_MS) {
      level = await opts.level().catch(() => level);
      tailnet = await readTailnet().catch(() => tailnet);
      levelAt = Date.now();
    }
    try {
      const status = await sendBeat(config, {
        runner: opts.runnerName(),
        version: opts.version,
        level,
        tailnet
      });
      if (status !== 200 && !warned) {
        console.warn(
          `[status-page] ${config.url} answered ${status} to the heartbeat.`
        );
        warned = true;
      }
      if (status === 200) warned = false;
    } catch (err) {
      if (!warned) {
        console.warn(
          '[status-page] heartbeat failed:',
          err instanceof Error ? err.message : err
        );
        warned = true;
      }
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), BEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}
