import { execFile } from 'child_process';
import QRCode from 'qrcode';
import readline from 'readline';

import { ApiError, createApi, PROCEDURES, type Api } from './remote/api';

export function prompt(msg: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(msg, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Use execFile (no shell) so a malicious server-supplied URL can't smuggle
// shell metachars and execute on the runner host.
function openBrowser(url: string): void {
  if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else if (process.platform === 'win32') {
    // `start` is a cmd builtin; `cmd /c start "" <url>` invokes it without a shell.
    execFile('cmd', ['/c', 'start', '""', url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

type Paired = {
  token: string;
  /** Absent when the server paired this runner with an access token alone. */
  refreshToken?: string;
  runnerName: string;
};

export type StartPairing = {
  deviceCode: string;
  userCode: string;
  approveUrl: string;
  /** Seconds between polls the server asks for. */
  interval?: number;
  /** Seconds the code stays valid. */
  expiresIn?: number;
};

type PollPairing = {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  token?: string;
  refreshToken?: string;
};

export type PairingIo = {
  out: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  open: (url: string) => void;
  now?: () => number;
};

const DEFAULT_PAIRING_WINDOW_MS = 10 * 60 * 1000;

/** The approve link as a QR code, in terminal characters. Empty if it could
 *  not be drawn: the link and the code are printed under it anyway. */
export async function renderQr(url: string): Promise<string> {
  try {
    return await QRCode.toString(url, { type: 'terminal', small: true });
  } catch {
    return '';
  }
}

/** Starts a pairing by code. */
export function startPairing(
  api: Api,
  runnerName: string,
  platform: string
): Promise<StartPairing> {
  return api.mutation<StartPairing>(PROCEDURES.startPairing, {
    name: runnerName,
    platform
  });
}

/** Shows the QR code, the short code and the link, then polls until the
 *  pairing is approved, denied or expired. Server side: `runners.*Pairing`
 *  in apps/server/src/routers/runners.ts. */
export async function pairByCode(
  api: Api,
  start: StartPairing,
  io: PairingIo
): Promise<{ token: string; refreshToken?: string }> {
  const now = io.now ?? Date.now;
  const deadline =
    now() + (start.expiresIn ? start.expiresIn * 1000 : DEFAULT_PAIRING_WINDOW_MS);
  const intervalMs = Math.max(1, start.interval ?? 3) * 1000;

  io.out('\n=== Approve this runner ===\n\n');
  io.out('Scan the QR code with your phone, or approve on the page that opens.\n\n');
  const qr = await renderQr(start.approveUrl);
  if (qr) io.out(`${qr}\n`);
  io.out(`  Code: ${start.userCode}\n`);
  io.out(`  Link: ${start.approveUrl}\n\n`);
  io.out('Check the code on the approve page matches this one.\n');
  io.out('Waiting for approval...\n');
  io.open(start.approveUrl);

  let warned = false;
  while (now() < deadline) {
    await io.sleep(intervalMs);
    let res: PollPairing;
    try {
      res = await api.mutation<PollPairing>(PROCEDURES.pollPairing, {
        deviceCode: start.deviceCode
      });
    } catch (err) {
      // A dropped connection, a 5xx or a 429 is worth waiting out; the code
      // is still good until the deadline.
      const transient =
        !(err instanceof ApiError) ||
        err.httpStatus >= 500 ||
        err.httpStatus === 429;
      if (!transient) throw err;
      if (!warned) io.out('Could not reach the server. Still waiting...\n');
      warned = true;
      continue;
    }
    if (res.status === 'pending') continue;
    if (res.status === 'approved' && res.token) {
      return { token: res.token, refreshToken: res.refreshToken };
    }
    if (res.status === 'denied') {
      throw new Error('Pairing denied. Run factiii-runner setup again to retry.');
    }
    break;
  }
  throw new Error('The pairing code expired. Run factiii-runner setup again.');
}

export async function pairWithBrowser(
  serverUrl: string,
  opts: {
    /** The runner's name, instead of asking for it. */
    name?: string;
    /** Factiii Desktop: one JSON line with the approve link instead of the
     *  QR code and the browser, which Desktop opens in its own signed-in
     *  window. */
    json?: boolean;
  } = {}
): Promise<Paired> {
  const runnerName = opts.name?.trim() || (await prompt('Runner name (e.g., "mac-mini-office"): '));
  if (!runnerName) throw new Error('Runner name is required.');

  const api = createApi({ serverUrl });
  const start = await startPairing(api, runnerName, process.platform);
  const io: PairingIo = opts.json
    ? {
        out: () => undefined,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        open: (url) =>
          process.stdout.write(`${JSON.stringify({ type: 'approve', url, code: start.userCode })}\n`)
      }
    : {
        out: (text) => process.stdout.write(text),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        open: openBrowser
      };
  const paired = await pairByCode(api, start, io);
  return { ...paired, runnerName };
}
