import { ApiError, isNewAddress, PROCEDURES, type Api } from './api';
import { EXIT } from './job';

// Caller IP pin (.specs/runner-secrets-gate.md, "Caller IP pin"): the server
// runs a member's job calls only from the one address pinned to their account.
// From a new address it refuses with RUNNER_IP_CHALLENGE_REQUIRED, and the
// member moves the pin by typing the code from their authenticator app. The
// code must come from a person at this terminal: with no TTY the CLI stops
// and names the command for them to run.

export type IpPinIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** One visible line; '' when nobody is at a terminal. */
  promptLine: (label: string) => Promise<string>;
};

/** Wrong codes the CLI accepts before it gives up; the server burns the
 *  challenge on its own count too. */
const MAX_TRIES = 3;

export const NO_TTY_HINT =
  'This terminal is at a new address and no one is here to type the code.\n' +
  'Run "factiii-runner verify-ip" yourself, then call the job again.\n';

/** Open a challenge for this address and answer it with the code the person
 *  types. True when the pin moved. */
export async function confirmAddress(api: Api, io: IpPinIo): Promise<boolean> {
  const { challengeId, ip } = await api.mutation<{ challengeId: string; ip: string }>(
    PROCEDURES.ipChallenge,
    {}
  );
  io.err(`\nRunner jobs from this terminal come from a new address (${ip}).\n`);
  for (let tries = 0; tries < MAX_TRIES; tries += 1) {
    const code = (await io.promptLine('Enter the 6-digit code from your Factiii app: ')).trim();
    if (!code) {
      io.err(NO_TTY_HINT);
      return false;
    }
    try {
      await api.mutation(PROCEDURES.verifyIp, { challengeId, code });
      io.err(`Address confirmed: runner jobs now run from ${ip}.\n`);
      return true;
    } catch (err) {
      // 400 = a wrong code (one attempt burnt) or the challenge spent. Anything
      // else - expired, another address, a dead login - is not a retry.
      if (!(err instanceof ApiError) || err.httpStatus !== 400) throw err;
      io.err(`${err.message}\n`);
      if (/start again/i.test(err.message)) return false;
    }
  }
  return false;
}

/** Run `body`; when the server wants this address confirmed, confirm it and
 *  run `body` once more. `body` must be safe to call twice. */
export async function withAddressCheck(
  api: Api,
  io: IpPinIo,
  body: () => Promise<number>
): Promise<number> {
  try {
    return await body();
  } catch (err) {
    if (!isNewAddress(err)) throw err;
    if (!(await confirmAddress(api, io))) return EXIT.failedToStart;
    return body();
  }
}

/** `factiii-runner verify-ip`: confirm this address on its own. */
export async function verifyIpCommand(api: Api, io: IpPinIo): Promise<number> {
  return (await confirmAddress(api, io)) ? 0 : EXIT.failedToStart;
}
