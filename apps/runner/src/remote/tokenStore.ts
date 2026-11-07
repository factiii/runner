import { spawnSync } from 'child_process';

// The laptop CLI's login token lives in the macOS login Keychain, never in a
// plaintext file. Service `factiii-runner-cli`, account = the server host, so a
// dev login (localhost:5001) and a prod login sit side by side.
//
// `security add-generic-password -w <token>` would put the token in argv,
// where any local user can read it from the process list. `security -i` reads
// its commands from stdin instead, so the write goes through stdin. Reads
// print the token on stdout, which is a pipe to this process only.

export const TOKEN_SERVICE = 'factiii-runner-cli';

/** `security` exits 44 (errSecItemNotFound) for an absent item. */
const SEC_ITEM_NOT_FOUND = 44;

/** Characters a token may hold. Anything else could break out of the quoted
 *  argument in the `security -i` command line, so it is refused, not escaped. */
const TOKEN_SAFE = /^[A-Za-z0-9._~+/=-]+$/;
const ACCOUNT_SAFE = /^[A-Za-z0-9.:-]+$/;

export type Exec = (
  bin: string,
  args: string[],
  input?: string
) => { status: number | null; stdout: string };

const defaultExec: Exec = (bin, args, input) => {
  const res = spawnSync(bin, args, {
    input,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout ?? '' };
};

function assertMac(): void {
  if (process.platform !== 'darwin') {
    throw new Error(
      'The factiii-runner CLI login stores its token in the macOS Keychain, so it needs macOS.'
    );
  }
}

function assertAccount(account: string): void {
  if (!ACCOUNT_SAFE.test(account)) {
    throw new Error(`Refusing an unusual server host: ${account}`);
  }
}

export function readToken(account: string, exec: Exec = defaultExec): string | null {
  assertMac();
  assertAccount(account);
  const res = exec('security', [
    'find-generic-password',
    '-s',
    TOKEN_SERVICE,
    '-a',
    account,
    '-w'
  ]);
  if (res.status === SEC_ITEM_NOT_FOUND) return null;
  if (res.status !== 0) {
    throw new Error(
      'The login Keychain refused the read. Unlock it (security unlock-keychain) and try again.'
    );
  }
  const token = res.stdout.trim();
  return token || null;
}

export function writeToken(
  account: string,
  token: string,
  exec: Exec = defaultExec
): void {
  assertMac();
  assertAccount(account);
  if (!TOKEN_SAFE.test(token)) {
    throw new Error('The server returned a token with unexpected characters.');
  }
  // -U updates the item in place when it already exists.
  const command =
    `add-generic-password -U -s "${TOKEN_SERVICE}" -a "${account}" ` +
    `-w "${token}"\n`;
  exec('security', ['-i'], command);
  // `security -i` can exit 0 after a failed command, so read it back.
  if (readToken(account, exec) !== token) {
    throw new Error(
      'The login Keychain did not keep the token. Unlock it (security unlock-keychain) and log in again.'
    );
  }
}

/** Returns false when there was nothing to delete. */
export function deleteToken(account: string, exec: Exec = defaultExec): boolean {
  assertMac();
  assertAccount(account);
  const res = exec('security', [
    'delete-generic-password',
    '-s',
    TOKEN_SERVICE,
    '-a',
    account
  ]);
  if (res.status === SEC_ITEM_NOT_FOUND) return false;
  if (res.status !== 0) {
    throw new Error('The login Keychain refused the delete.');
  }
  return true;
}
