// "Vault": one strict definition, worded the same in Oakbox and Factiii
// (.specs/vault.md "\"Vault\": one strict definition", Jon, 2026-11-11). The
// one copy both apps read: Oakbox's Account > Backend (the Vault default,
// DEFAULT_LOCATIONS) on web and phone, and Factiii's runner Vault part
// (VaultPartDetail) on web and phone. Nothing else in copy is called a Vault
// (rule 1): Factiii's servers are Cloud, the runner's other store is Runner
// Cloud, and the phone's 2FA store is the Authenticator.

/** What the Vault is, in the user's words. Keep it in step with vault.md. */
export const VAULT_DEFINITION =
  'Your Vault is for truly private things. It lives on your own computer (your runner), encrypted. Nobody else can see it, and it is never shared. It never leaves your computer, except to answer you when you open it. Only private AI on that computer (Ollama) can read it; no AI service or AI app can.';

/** Backups of the runner's disk and the Vault (Jon, 2026-11-11; .specs/vault.md
 *  "Encryption and the Vault key" → Backups): the quiet line every Vault
 *  settings panel shows, web and phone, Oakbox and Factiii. Ciphertext only;
 *  the key is never in a backup. */
export const VAULT_BACKUP_NOTE =
  'Backups (Time Machine, a synced folder) may keep your Vault: they hold only its encrypted files, never your Vault key.';

/** "I forgot my Vault key" (.specs/vault.md "Erase a Vault whose key is
 *  lost"), the same words on every panel: what goes, what stays, and what
 *  an old backup is worth now. */
export const VAULT_ERASE_TITLE = 'Erase your Vault and start over?';
export const vaultEraseBody = (runnerName: string): string =>
  `Without its Vault key nobody can open your Vault, Factiii included. Erasing deletes every file, note and chat in the Vault on ${runnerName}, and its key, for good. Runner Cloud and the Cloud are not touched. Backups made with the old key stay unreadable. You can then encrypt a new, empty Vault.`;
export const VAULT_ERASE_LINK = 'Forgot your Vault key?';
export const VAULT_ERASE_CONFIRM = 'Erase my Vault';

/** The same line while the Vault is not encrypted yet. */
export const VAULT_BACKUP_PLAIN_NOTE =
  'Not encrypted yet: keep it out of backups that leave this computer until you encrypt it.';

/** The idle minutes a Vault settings panel offers, before the runner locks
 *  it (VAULT_LOCK_IDLE_MINUTES is the default): web and phone, Oakbox and
 *  Factiii. */
export const VAULT_IDLE_CHOICES = [5, 15, 30, 60, 240] as const;

const MINUTES_PER_HOUR = 60;

/** The choices with the saved value among them, shortest first. */
export const vaultIdleChoices = (current: number): number[] =>
  [...new Set<number>([...VAULT_IDLE_CHOICES, current])].sort((a, b) => a - b);

/** "15 minutes", "1 hour", "4 hours". */
export const vaultIdleLabel = (minutes: number): string => {
  if (minutes < MINUTES_PER_HOUR) return `${minutes} minutes`;
  const hours = minutes / MINUTES_PER_HOUR;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
};
