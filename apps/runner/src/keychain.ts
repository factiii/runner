import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import { keychainAccount } from '@shared/all/helpers/board-agent-core/runner-dir';
import path from 'path';

import { CONFIG_DIR } from './paths';

// The runner's at-rest encryption key, bound to the machine's OS user. Read
// unattended, so unlike deploy secrets nothing can prompt per read.
// No plaintext fallback. BETA on Linux/Windows; only macOS is tested.

const SERVICE = 'factiii-runner';
// `config-encryption-key` for the default dir; its own account for a
// FACTIII_RUNNER_DIR runner, so a dev runner never touches the real key.
const ACCOUNT = keychainAccount();

// Windows has no keychain CLI, so the key is DPAPI-wrapped on disk. That ties
// the ciphertext to the logged-in user, the same property the others give.
const DPAPI_KEY_FILE = path.join(CONFIG_DIR, 'config-key.dpapi');

type KeychainBackend = 'macos-keychain' | 'libsecret' | 'dpapi';

/** What the settings panel needs to explain a keychain problem to the owner:
 *  the backend we tried, what went wrong, and the exact commands that fix it. */
export type KeychainStatus = {
  available: boolean;
  backend: KeychainBackend;
  /** Missing binary, when that's the cause. Empty otherwise. */
  missingTool: string;
  /** One-line problem statement. Empty when available. */
  problem: string;
  /** Copy-pasteable remedy, may be multi-line. Empty when available. */
  fix: string;
};

function run(bin: string, args: string[], input?: string): string {
  return execFileSync(bin, args, {
    encoding: 'utf-8',
    input,
    stdio: input === undefined ? ['ignore', 'pipe', 'ignore'] : undefined
  });
}

/** Conflating these destroys data: only "no such item" licenses minting, since
 *  minting over an unreachable key orphans everything encrypted under it. */
type KeyLookup =
  | { state: 'found'; key: Buffer }
  | { state: 'missing' }
  | { state: 'error' };

/** `security` exits 44 (errSecItemNotFound) for a genuinely absent item. */
const SEC_ITEM_NOT_FOUND = 44;

function exitCodeOf(err: unknown): number | null {
  const status = (err as { status?: number | null }).status;
  return typeof status === 'number' ? status : null;
}

function binaryPresent(bin: string): boolean {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(lookup, [bin], { stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// ── macOS: security(1) ──

function macRead(): KeyLookup {
  try {
    const out = run('security', [
      'find-generic-password',
      '-s',
      SERVICE,
      '-a',
      ACCOUNT,
      '-w'
    ]);
    const key = Buffer.from(out.trim(), 'base64');
    return key.length === 32 ? { state: 'found', key } : { state: 'error' };
  } catch (err) {
    // Only a clean "not found" licenses minting. A locked or unlocatable
    // keychain lands here with a different status and must not overwrite.
    return exitCodeOf(err) === SEC_ITEM_NOT_FOUND
      ? { state: 'missing' }
      : { state: 'error' };
  }
}

function macWrite(key: Buffer): void {
  // -U updates in place when the item already exists.
  run('security', [
    'add-generic-password',
    '-s',
    SERVICE,
    '-a',
    ACCOUNT,
    '-w',
    key.toString('base64'),
    '-U'
  ]);
}

// ── Linux: libsecret via secret-tool(1) ──

function linuxRead(): KeyLookup {
  let out: string;
  try {
    // stderr is kept: it is what tells an absent item from a broken keyring.
    out = execFileSync(
      'secret-tool',
      ['lookup', 'service', SERVICE, 'account', ACCOUNT],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    // An absent item is exit 1 with nothing printed (libsecret 0.20, Debian
    // 12; older builds exit 0, handled below). A broken keyring (no D-Bus
    // session, a locked login keyring) also exits 1, but says why on stderr.
    // Only the silent one licenses minting.
    const { stdout, stderr } = err as { stdout?: string; stderr?: string };
    const silent = !`${stdout ?? ''}${stderr ?? ''}`.trim();
    return exitCodeOf(err) === 1 && silent
      ? { state: 'missing' }
      : { state: 'error' };
  }
  // Some secret-tool builds exit 0 with empty output for an absent item.
  if (!out.trim()) return { state: 'missing' };
  const key = Buffer.from(out.trim(), 'base64');
  return key.length === 32 ? { state: 'found', key } : { state: 'error' };
}

function linuxWrite(key: Buffer): void {
  // secret-tool reads the value from stdin, so the key never appears in the
  // process list the way an argv-passed secret would.
  run(
    'secret-tool',
    ['store', '--label=Factiii Runner', 'service', SERVICE, 'account', ACCOUNT],
    `${key.toString('base64')}\n`
  );
}

// ── Windows: DPAPI via PowerShell ──

function winRead(): KeyLookup {
  let wrapped: string;
  try {
    wrapped = fs.readFileSync(DPAPI_KEY_FILE, 'utf-8').trim();
  } catch {
    // No wrapped key on disk yet: this is the one "mint a fresh one" case.
    return { state: 'missing' };
  }
  if (!wrapped) return { state: 'missing' };
  try {
    const out = run('powershell', [
      '-NoProfile',
      '-Command',
      // ConvertTo-SecureString reverses the DPAPI wrap; the plaintext is
      // marshalled back out as BSTR rather than printed by PowerShell itself.
      `$s = '${wrapped}' | ConvertTo-SecureString; ` +
        `[Runtime.InteropServices.Marshal]::PtrToStringAuto(` +
        `[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`
    ]);
    const key = Buffer.from(out.trim(), 'base64');
    return key.length === 32 ? { state: 'found', key } : { state: 'error' };
  } catch {
    // The wrapped key exists but DPAPI won't unwrap it (wrong Windows user,
    // roamed profile). Never overwrite it - that data is still someone's key.
    return { state: 'error' };
  }
}

function winWrite(key: Buffer): void {
  const out = run('powershell', [
    '-NoProfile',
    '-Command',
    `ConvertTo-SecureString -String '${key.toString('base64')}' ` +
      `-AsPlainText -Force | ConvertFrom-SecureString`
  ]);
  fs.mkdirSync(path.dirname(DPAPI_KEY_FILE), { recursive: true });
  fs.writeFileSync(DPAPI_KEY_FILE, `${out.trim()}\n`, { mode: 0o600 });
}

// ── Public surface ──

function keychainBackend(): KeychainBackend {
  switch (process.platform) {
    case 'darwin':
      return 'macos-keychain';
    case 'win32':
      return 'dpapi';
    default:
      return 'libsecret';
  }
}

function readKey(): KeyLookup {
  switch (process.platform) {
    case 'darwin':
      return macRead();
    case 'win32':
      return winRead();
    default:
      return linuxRead();
  }
}

function writeKey(key: Buffer): void {
  switch (process.platform) {
    case 'darwin':
      macWrite(key);
      return;
    case 'win32':
      winWrite(key);
      return;
    default:
      linuxWrite(key);
  }
}

/** Work out WHY the keychain is unusable so the UI can name the missing piece.
 *  Only called after acquisition failed, so it costs nothing when healthy. */
function diagnose(): KeychainStatus {
  const backend = keychainBackend();

  if (backend === 'libsecret') {
    if (!binaryPresent('secret-tool')) {
      return {
        available: false,
        backend,
        missingTool: 'secret-tool',
        problem:
          'libsecret’s "secret-tool" command is not installed, so there is nowhere to keep the encryption key.',
        fix: [
          'Install libsecret and a keyring daemon:',
          '  Debian/Ubuntu:  sudo apt install libsecret-tools gnome-keyring',
          '  Fedora/RHEL:    sudo dnf install libsecret gnome-keyring',
          '  Arch:           sudo pacman -S libsecret gnome-keyring',
          'Then restart the runner.'
        ].join('\n')
      };
    }
    return {
      available: false,
      backend,
      missingTool: '',
      problem:
        'secret-tool is installed but the keyring rejected the key — usually no D-Bus session, or a locked login keyring.',
      fix: [
        'Headless hosts need a D-Bus session with an unlocked keyring, e.g.:',
        "  dbus-run-session -- sh -c 'echo \"$KEYRING_PASSWORD\" | \\",
        '    gnome-keyring-daemon --unlock && factiii-runner start\'',
        'On a desktop session, unlock the login keyring and restart the runner.'
      ].join('\n')
    };
  }

  if (backend === 'dpapi') {
    if (!binaryPresent('powershell')) {
      return {
        available: false,
        backend,
        missingTool: 'powershell',
        problem:
          'powershell.exe was not found on PATH, so DPAPI cannot wrap the encryption key.',
        fix: [
          'PowerShell ships with Windows; make sure it is on PATH:',
          '  %SystemRoot%\\System32\\WindowsPowerShell\\v1.0',
          'Then restart the runner.'
        ].join('\n')
      };
    }
    return {
      available: false,
      backend,
      missingTool: '',
      problem:
        'PowerShell is available but DPAPI would not store the key for this user account.',
      fix: [
        'Run the runner as the same Windows user that owns',
        `  ${DPAPI_KEY_FILE}`,
        'or delete that file to re-create the key, then restart the runner.'
      ].join('\n')
    };
  }

  if (!binaryPresent('security')) {
    return {
      available: false,
      backend,
      missingTool: 'security',
      problem:
        'macOS’ "security" command was not found, so the login keychain is unreachable.',
      fix: [
        'Reinstall the Command Line Tools, then restart the runner:',
        '  xcode-select --install'
      ].join('\n')
    };
  }
  return {
    available: false,
    backend,
    missingTool: '',
    problem:
      'The login keychain is locked, unreachable, or refused access to the runner’s key.',
    fix: [
      'Unlock the login keychain, then restart the runner:',
      '  security unlock-keychain ~/Library/Keychains/login.keychain-db',
      'Over SSH this must be run inside the same login session as the runner.',
      'If macOS offers to "Reset To Defaults", DECLINE: that means the process',
      'is looking at the wrong home directory (check $HOME), not that your key',
      'is gone.'
    ].join('\n')
  };
}

// Resolved once per process. A failure is cached too (with its diagnosis) so a
// broken host doesn't shell out on every single config read.
let cached: { key: Buffer | null; status: KeychainStatus } | null = null;

const OK = (): KeychainStatus => ({
  available: true,
  backend: keychainBackend(),
  missingTool: '',
  problem: '',
  fix: ''
});

function resolve(): { key: Buffer | null; status: KeychainStatus } {
  if (cached) return cached;
  try {
    const existing = readKey();
    if (existing.state === 'found') {
      cached = { key: existing.key, status: OK() };
      return cached;
    }
    // Unreachable is not absent: minting here would orphan every file already
    // encrypted under the key we simply couldn't read.
    if (existing.state === 'error') {
      cached = { key: null, status: diagnose() };
      return cached;
    }

    const fresh = crypto.randomBytes(32);
    writeKey(fresh);
    // Read back rather than trusting the write: if the keyring silently
    // dropped it we want a diagnosis now, not undecryptable data later.
    const verify = readKey();
    if (verify.state !== 'found' || !verify.key.equals(fresh)) {
      cached = { key: null, status: diagnose() };
      return cached;
    }
    cached = { key: fresh, status: OK() };
    return cached;
  } catch {
    cached = { key: null, status: diagnose() };
    return cached;
  }
}

/** The machine-bound half of the key, created on first use. Null with no usable
 *  keychain; callers must NOT fall back to plaintext. */
export function getKeychainKey(): Buffer | null {
  return resolve().key;
}

/** Whether at-rest encryption is available, and if not, why and how to fix. */
export function keychainStatus(): KeychainStatus {
  return resolve().status;
}
