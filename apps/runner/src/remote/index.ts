import type { Command } from 'commander';

import { promptLine, promptPassword } from '../promptPassword';

import {
  ApiError,
  createApi,
  describeSpace,
  fetchRunners,
  localBoard,
  PROCEDURES,
  resolveRunner,
  resolveServer,
  resolveSpace,
  serverAccount,
  type Api
} from './api';
import { printAudit } from './audit';
import { verifyIpCommand, withAddressCheck, type IpPinIo } from './ipPin';
import { cancelJob, listJobs, parseParams, printRunners, runJob, EXIT, type JobIo } from './job';
import { localBridge, localCancelJob, localListJobs, localRunJob } from './local';
import { login, logout } from './login';
import { setSecret } from './secret';
import { readToken } from './tokenStore';

// The laptop side of the shared runner (.specs/runner-secrets-gate.md): a
// member calls jobs, submits encrypted secret updates, and (owner) reads the
// audit log, all through the Factiii server with their own login. None of
// these commands need a paired runner on this machine.

const out = (text: string): void => {
  process.stdout.write(text);
};
const err = (text: string): void => {
  process.stderr.write(text);
};
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const SERVER_HELP = 'API server URL (default: $FACTIII_API_URL or https://api.factiii.com)';

/** The address check's prompt: a visible line, '' when nobody is here. */
const pinIo: IpPinIo = { out, err, promptLine };
const SPACE_HELP = 'board slug (default: $FACTIII_SPACE)';
const RUNNER_HELP =
  'the runner to use, by name or id (default: $FACTIII_RUNNER); see "factiii-runner runners"';

function authedApi(serverFlag?: string): { api: Api; serverUrl: string } {
  const serverUrl = resolveServer(serverFlag);
  const token = readToken(serverAccount(serverUrl));
  if (!token) {
    throw new Error(
      `Not logged in to ${serverAccount(serverUrl)}. Run "factiii-runner login${
        serverFlag ? ` --server ${serverUrl}` : ''
      }" first.`
    );
  }
  return { api: createApi({ serverUrl, token }), serverUrl };
}

/** Run a command body and exit with its code; errors print and exit 1. */
async function run(body: () => Promise<number>): Promise<never> {
  try {
    process.exit(await body());
  } catch (e) {
    if (e instanceof ApiError && e.code === 'UNAUTHORIZED') {
      err('\nThe server rejected your login. Run "factiii-runner login" again.\n');
    } else {
      err(`\n${e instanceof Error ? e.message : String(e)}\n`);
    }
    process.exit(EXIT.usage);
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerRemoteCommands(program: Command): void {
  program
    .command('login')
    .description('Log this terminal in to your Factiii account (for job, secret, audit)')
    .option('-s, --server <url>', SERVER_HELP)
    .action((opts: { server?: string }) =>
      run(() => {
        const serverUrl = resolveServer(opts.server);
        return login(createApi({ serverUrl }), serverUrl, { out, err, sleep });
      })
    );

  program
    .command('logout')
    .description('Revoke this terminal’s Factiii login and delete it from the Keychain')
    .option('-s, --server <url>', SERVER_HELP)
    .action((opts: { server?: string }) =>
      run(() => {
        const serverUrl = resolveServer(opts.server);
        return logout((token) => createApi({ serverUrl, token }), serverUrl, { out, err });
      })
    );

  program
    .command('runners')
    .description('List the runners open to you on a space: yours, and the ones whose owner gave you API access')
    .option('--space <slug>', SPACE_HELP)
    .option('-s, --server <url>', SERVER_HELP)
    .action((opts: { space?: string; server?: string }) =>
      run(async () => {
        const spaceSlug = resolveSpace(opts.space);
        const { api } = authedApi(opts.server);
        printRunners(await fetchRunners(api, spaceSlug), describeSpace(spaceSlug), { out });
        return 0;
      })
    );

  program
    .command('job')
    .description(
      'List or call a job on the runner you name; exits with the job’s code (77 = denied). ' +
        'Inside a runner session (FACTIII_SECRETS_SOCK + FACTIII_SECRETS_TOKEN set) it uses the local socket, not a login.'
    )
    .argument('[name]', 'job to call')
    .option('--list', 'list the jobs')
    .option('--space <slug>', SPACE_HELP)
    .option('--runner <name or id>', RUNNER_HELP)
    .option('--param <key=value>', 'job parameter (repeatable)', collect, [] as string[])
    .option('-s, --server <url>', SERVER_HELP)
    .action(
      (
        name: string | undefined,
        opts: { list?: boolean; space?: string; runner?: string; param: string[]; server?: string }
      ) =>
      run(async () => {
        const io: JobIo = {
          out,
          err,
          sleep,
          onInterrupt: (handler) => {
            process.once('SIGINT', handler);
            return () => process.removeListener('SIGINT', handler);
          }
        };
        // On the runner itself: the session's secrets socket stands in for the
        // login, and the space and the runner are the session's own (--space
        // and --runner are ignored).
        const bridge = localBridge();
        if (bridge) {
          if (opts.list) return localListJobs(bridge, io);
          if (!name) throw new Error('Name a job, or pass --list.');
          return localRunJob(bridge, { job: name, params: parseParams(opts.param) }, io);
        }
        const spaceSlug = resolveSpace(opts.space);
        const { api } = authedApi(opts.server);
        const runnerId = await resolveRunner(api, spaceSlug, opts.runner);
        if (opts.list) return listJobs(api, spaceSlug, runnerId, { out });
        if (!name) throw new Error('Name a job, or pass --list.');
        // A new address asks for the authenticator code first, then calls.
        return withAddressCheck(api, pinIo, () =>
          runJob(
            api,
            {
              spaceSlug,
              runnerId,
              job: name,
              params: parseParams(opts.param),
              cancelFlags: opts.server ? `--server ${resolveServer(opts.server)}` : ''
            },
            io
          )
        );
      })
    );

  program
    .command('verify-ip')
    .description(
      'Confirm this terminal’s address for runner jobs with your authenticator code (asked for on its own when an address is new)'
    )
    .option('-s, --server <url>', SERVER_HELP)
    .action((opts: { server?: string }) =>
      run(() => verifyIpCommand(authedApi(opts.server).api, pinIo))
    );

  program
    .command('cancel')
    .description('Cancel a job call; exits 0 when cancelled, 1 when it had already ended, 3 on an error')
    .argument('<callId>', 'the call id that `job` printed')
    .option('--space <slug>', 'accepted for symmetry with job; a call id names its space already')
    .option('-s, --server <url>', SERVER_HELP)
    .action((callId: string, opts: { space?: string; server?: string }) =>
      run(async () => {
        const bridge = localBridge();
        if (bridge) return localCancelJob(bridge, callId, { out, err });
        try {
          const { api } = authedApi(opts.server);
          return await withAddressCheck(api, pinIo, () => cancelJob(api, callId, { out, err }));
        } catch (e) {
          // Not logged in is an error like any other here: exit 3, not 1,
          // because 1 means "nothing to cancel".
          err(`\n${e instanceof Error ? e.message : String(e)}\n`);
          return EXIT.failedToStart;
        }
      })
    );

  const secret = program
    .command('secret')
    .description('Submit an encrypted secret update to the runner you name');

  secret
    .command('set')
    .description('Encrypt a value from stdin to the runner and submit it for approval')
    .argument('<KEY>', 'UPPER_SNAKE_CASE name: the env key, or the blob name with --file')
    .option('--space <slug>', SPACE_HELP)
    .option('--runner <name or id>', RUNNER_HELP)
    .option('--file', 'the value is a file blob (exact bytes)')
    .option('--from-tty', 'type the value at a silent prompt instead of piping it')
    .option('--accept-new-recipient', 'trust a changed runner recipient (check it in Runner Settings first)')
    .option('-s, --server <url>', SERVER_HELP)
    .action(
      (
        key: string,
        opts: {
          space?: string;
          runner?: string;
          file?: boolean;
          fromTty?: boolean;
          acceptNewRecipient?: boolean;
          server?: string;
        }
      ) =>
        run(async () => {
          const spaceSlug = resolveSpace(opts.space);
          const { api, serverUrl } = authedApi(opts.server);
          const runnerId = await resolveRunner(api, spaceSlug, opts.runner);
          // The value is read from stdin once, so the address is checked
          // before anything is read rather than by calling setSecret twice.
          const gate = await withAddressCheck(api, pinIo, async () => {
            await api.query(PROCEDURES.checkAddress, {});
            return 0;
          });
          if (gate !== 0) return gate;
          return setSecret(
            api,
            {
              serverHost: serverAccount(serverUrl),
              spaceSlug,
              runnerId,
              key,
              kind: opts.file ? 'file' : 'env',
              fromTty: Boolean(opts.fromTty),
              acceptNewRecipient: Boolean(opts.acceptNewRecipient),
              spaceLabel: describeSpace(spaceSlug),
              formerSlugs: localBoard(spaceSlug)?.was
            },
            { out, err, stdin: process.stdin, promptSilent: promptPassword }
          );
        })
    );

  program
    .command('audit')
    .description('Print the audit log of the runner you name (owner only); exits 2 when the chain is broken')
    .option('--space <slug>', SPACE_HELP)
    .option('--runner <name or id>', RUNNER_HELP)
    .option('--actor <userId>', 'only this user id')
    .option('--job <name>', 'only this job')
    .option('--key <name>', 'only lines that name this key')
    .option('--limit <n>', 'lines to show', '50')
    .option('-s, --server <url>', SERVER_HELP)
    .action(
      (opts: {
        space?: string;
        runner?: string;
        actor?: string;
        job?: string;
        key?: string;
        limit: string;
        server?: string;
      }) =>
        run(async () => {
          const spaceSlug = resolveSpace(opts.space);
          const limit = Number(opts.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('--limit needs a whole number from 1 to 500.');
          const { api } = authedApi(opts.server);
          const runnerId = await resolveRunner(api, spaceSlug, opts.runner);
          return withAddressCheck(api, pinIo, () =>
            printAudit(
              api,
              {
                spaceSlug,
                runnerId,
                query: { limit, actorUserId: opts.actor, job: opts.job, key: opts.key }
              },
              { out }
            )
          );
        })
    );
}
