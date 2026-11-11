import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { readBootJson, writeBootJson } from '../secureFile';

// The runner's dev VM setting (.specs/dev-vm.md): `devvm.json` in the runner
// dir, `{ "enabled": false, "profile": "default" }`. OFF unless the file says
// otherwise, and only ever on a Mac: on any other OS sessions run on the host
// exactly as before. Read at daemon start; changing it takes a restart.

export const DEV_VM_FILE = 'devvm.json';
/** The Claude token for the VM: keychain-wrapped, like the pairing config. */
export const DEV_VM_TOKENS_FILE = 'devvm-tokens.json';

const settingsSchema = z.object({
  enabled: z.boolean().catch(false),
  profile: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/)
    .catch('default')
});

export type DevVmSettings = z.infer<typeof settingsSchema>;

export const DEV_VM_OFF: DevVmSettings = { enabled: false, profile: 'default' };

/** The setting as this runner should use it. Anything unreadable is OFF. */
export function readDevVmSettings(
  configDir: string,
  platform: NodeJS.Platform = process.platform
): DevVmSettings {
  if (platform !== 'darwin') return DEV_VM_OFF;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(configDir, DEV_VM_FILE), 'utf-8'));
  } catch {
    return DEV_VM_OFF;
  }
  const parsed = settingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEV_VM_OFF;
}

export function writeDevVmSettings(configDir: string, settings: DevVmSettings): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, DEV_VM_FILE),
    `${JSON.stringify(settingsSchema.parse(settings), null, 2)}\n`,
    { mode: 0o600 }
  );
}

const tokensSchema = z.object({ claudeToken: z.string().catch('') });

/** The stored `claude setup-token` token, or '' when none was stored. */
export function readClaudeVmToken(configDir: string): string {
  const raw = readBootJson<unknown>(path.join(configDir, DEV_VM_TOKENS_FILE));
  const parsed = tokensSchema.safeParse(raw);
  return parsed.success ? parsed.data.claudeToken.trim() : '';
}

export function writeClaudeVmToken(configDir: string, token: string): void {
  writeBootJson(path.join(configDir, DEV_VM_TOKENS_FILE), {
    claudeToken: token.trim()
  });
}
