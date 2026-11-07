import os from 'os';

import { PROCEDURES, serverAccount, type Api } from './api';
import { deleteToken, readToken, writeToken, type Exec } from './tokenStore';

// Device login: the CLI asks the server for a one-time code, the user approves
// it on the web while signed in to their own Factiii account, and the CLI
// polls until the server hands back a user-scoped CLI token. The token goes
// straight into the Keychain. Server side: apps/server/src/routers/runnerCli.ts.

type StartLogin = {
  deviceCode: string;
  userCode: string;
  approveUrl: string;
  /** Seconds between polls the server asks for. */
  interval?: number;
  /** Seconds the code stays valid. */
  expiresIn?: number;
};

type PollLogin = {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  token?: string | null;
  user?: { id: number; username: string | null; name: string | null };
};

export type LoginIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  exec?: Exec;
  now?: () => number;
};

const DEFAULT_LOGIN_WINDOW_MS = 10 * 60 * 1000;

export async function login(api: Api, serverUrl: string, io: LoginIo): Promise<number> {
  const start = await api.mutation<StartLogin>(PROCEDURES.startLogin, {
    // Shown on the approve page and in the token list; the server caps it at 64.
    label: (os.hostname() || 'factiii-runner CLI').slice(0, 64)
  });
  const now = io.now ?? Date.now;
  const deadline =
    now() + (start.expiresIn ? start.expiresIn * 1000 : DEFAULT_LOGIN_WINDOW_MS);
  const intervalMs = Math.max(1, start.interval ?? 2) * 1000;

  io.out('\nApprove this login in your browser, signed in to Factiii:\n\n');
  io.out(`  ${start.approveUrl}\n\n`);
  io.out(`Code: ${start.userCode}\n\nWaiting for approval...\n`);

  while (now() < deadline) {
    await io.sleep(intervalMs);
    const res = await api.mutation<PollLogin>(PROCEDURES.pollLogin, {
      deviceCode: start.deviceCode
    });
    if (res.status === 'pending') continue;
    if (res.status === 'approved' && res.token) {
      writeToken(serverAccount(serverUrl), res.token, io.exec);
      const who = res.user?.username || res.user?.name;
      io.out(
        `\nLogged in to ${serverAccount(serverUrl)}${who ? ` as ${who}` : ''}. ` +
          'The token is in your login Keychain.\n'
      );
      return 0;
    }
    io.err(res.status === 'denied' ? '\nLogin denied.\n' : '\nThe login code expired. Run login again.\n');
    return 1;
  }
  io.err('\nThe login code expired. Run login again.\n');
  return 1;
}

/** Revoke the token on the server (runnerJobs.revokeSelf), then delete it
 *  from the Keychain. The local item goes even when the revoke fails (server
 *  unreachable, token already dead), and the user is told which happened. */
export async function logout(
  makeApi: (token: string) => Api,
  serverUrl: string,
  io: Pick<LoginIo, 'out' | 'err' | 'exec'>
): Promise<number> {
  const account = serverAccount(serverUrl);
  const token = readToken(account, io.exec);
  if (!token) {
    io.out(`Not logged in to ${account}.\n`);
    return 0;
  }
  let revoked = true;
  try {
    await makeApi(token).mutation(PROCEDURES.revokeSelf, {});
  } catch (e) {
    revoked = false;
    io.err(
      `The server revoke did not happen (${e instanceof Error ? e.message : String(e)}). ` +
        'If the token is still live, revoke it in Factiii Settings.\n'
    );
  }
  deleteToken(account, io.exec);
  io.out(
    revoked
      ? `Logged out of ${account}. The token is revoked on the server and deleted from the Keychain.\n`
      : `Deleted the token for ${account} from the Keychain.\n`
  );
  return 0;
}
