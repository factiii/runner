import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

// The runner's ops-user setting (.specs/ops-user.md): `ops.json` in the
// runner dir, `{ "enabled": false, "runDir": "/private/var/factiii-ops-run" }`.
// OFF unless the file says otherwise. Read at daemon start; changing it takes
// a restart. macOS and Linux only: Windows' named pipe is not built yet, so
// there the setting always reads off.

export const OPS_FILE = 'ops.json';
export const OPS_USER = 'factiii-ops';
/** The group the normal user is in, which may reach the socket. */
export const OPS_GROUP = 'factiii';

/** The ops user's home: the stores, the clones, the servers. 0700. */
export function defaultOpsHome(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'linux') return '/var/lib/factiii-ops';
  if (platform === 'win32') return 'C:\\ProgramData\\Factiii\\ops';
  return '/private/var/factiii-ops';
}

/** The socket's dir, group-readable by `factiii`. 0750. */
export function defaultRunDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'linux') return '/run/factiii-ops';
  if (platform === 'win32') return '\\\\.\\pipe\\factiii-ops';
  return '/private/var/factiii-ops-run';
}

const settingsSchema = z.object({
  enabled: z.boolean().catch(false),
  runDir: z.string().min(1).catch(defaultRunDir())
});

export type OpsSettings = z.infer<typeof settingsSchema>;

export const OPS_OFF: OpsSettings = { enabled: false, runDir: defaultRunDir() };

/** The setting as this runner should use it. Anything unreadable is OFF. */
export function readOpsSettings(
  configDir: string,
  platform: NodeJS.Platform = process.platform
): OpsSettings {
  if (platform !== 'darwin' && platform !== 'linux') return OPS_OFF;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(configDir, OPS_FILE), 'utf-8'));
  } catch {
    return OPS_OFF;
  }
  const parsed = settingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : OPS_OFF;
}

export function writeOpsSettings(configDir: string, settings: OpsSettings): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, OPS_FILE),
    `${JSON.stringify(settingsSchema.parse(settings), null, 2)}\n`,
    { mode: 0o600 }
  );
}

/** Everything under the run dir, by name. */
export function opsRunPaths(runDir: string): {
  socket: string;
  peerDir: string;
  tokensDir: string;
  token: (slug: string) => string;
} {
  const tokensDir = path.join(runDir, 'boards');
  return {
    socket: path.join(runDir, 'ops.sock'),
    peerDir: path.join(runDir, 'peer'),
    tokensDir,
    token: (slug) => path.join(tokensDir, `${slug}.token`)
  };
}

/** Everything under the ops home, by name. */
export function opsHomePaths(opsHome: string): {
  config: string;
  board: (slug: string) => string;
  githubToken: (slug: string) => string;
  repos: string;
  servers: string;
} {
  return {
    config: path.join(opsHome, 'ops-config.json'),
    board: (slug) => path.join(opsHome, 'boards', slug),
    githubToken: (slug) => path.join(opsHome, 'boards', slug, 'github-token'),
    repos: path.join(opsHome, 'repos'),
    servers: path.join(opsHome, 'servers')
  };
}
