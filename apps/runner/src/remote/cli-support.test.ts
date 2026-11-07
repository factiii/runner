import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { AuditEntry } from '@shared/all/domains/electron';

import {
  ApiError,
  createApi,
  describeSpace,
  pickRunner,
  PROCEDURES,
  resolveRunner,
  resolveRunnerRef,
  resolveServer,
  RUNNER_CLI_TOKEN_HEADER,
  resolveSpace,
  sessionBoard,
  serverAccount,
  type Api,
  type FetchLike,
  type OpenRunner
} from './api';
import { formatAudit, printAudit } from './audit';
import { login, logout } from './login';
import { deleteToken, readToken, TOKEN_SERVICE, writeToken, type Exec } from './tokenStore';

const TOKEN = 'frc_abcDEF-123_xyz';

/** A fake `security` backed by an in-memory keychain, recording every call. */
function fakeSecurity(): { exec: Exec; calls: { args: string[]; input?: string }[]; items: Map<string, string> } {
  const items = new Map<string, string>();
  const calls: { args: string[]; input?: string }[] = [];
  const exec: Exec = (bin, args, input) => {
    assert.equal(bin, 'security');
    calls.push({ args, input });
    const flag = (name: string, from: string[]): string => from[from.indexOf(name) + 1];
    if (args[0] === '-i') {
      // Parse the one command `security -i` gets on stdin.
      const words = [...(input ?? '').matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
      assert.equal(words[0], 'add-generic-password');
      items.set(`${flag('-s', words)}|${flag('-a', words)}`, flag('-w', words));
      return { status: 0, stdout: '' };
    }
    const id = `${flag('-s', args)}|${flag('-a', args)}`;
    if (args[0] === 'find-generic-password') {
      return items.has(id) ? { status: 0, stdout: `${items.get(id)}\n` } : { status: 44, stdout: '' };
    }
    if (args[0] === 'delete-generic-password') {
      return items.delete(id) ? { status: 0, stdout: '' } : { status: 44, stdout: '' };
    }
    throw new Error(`unexpected security call ${args.join(' ')}`);
  };
  return { exec, calls, items };
}

// The token store is macOS-only; pretend to be macOS on a Linux CI host.
const realPlatform = process.platform;
before(() => Object.defineProperty(process, 'platform', { value: 'darwin' }));
after(() => Object.defineProperty(process, 'platform', { value: realPlatform }));

describe('tokenStore', () => {
  it('writes the token over stdin, never in argv, and reads it back', () => {
    const sec = fakeSecurity();
    writeToken('api.factiii.com', TOKEN, sec.exec);
    assert.ok(!sec.calls.some((c) => c.args.some((a) => a.includes(TOKEN))), 'token appeared in argv');
    const write = sec.calls.find((c) => c.args[0] === '-i');
    assert.ok(write?.input?.includes(TOKEN));
    assert.equal(sec.items.get(`${TOKEN_SERVICE}|api.factiii.com`), TOKEN);
    assert.equal(readToken('api.factiii.com', sec.exec), TOKEN);
    assert.equal(readToken('localhost:5001', sec.exec), null);
  });

  it('fails when the keychain did not keep the token', () => {
    const exec: Exec = (_b, args) => (args[0] === '-i' ? { status: 0, stdout: '' } : { status: 44, stdout: '' });
    assert.throws(() => writeToken('api.factiii.com', TOKEN, exec), /did not keep/);
  });

  it('refuses a token that could break out of the quoted command', () => {
    const sec = fakeSecurity();
    assert.throws(() => writeToken('api.factiii.com', 'a" -w "b', sec.exec));
    assert.throws(() => writeToken('api.factiii.com', 'a\ndelete-keychain', sec.exec));
    assert.equal(sec.calls.length, 0);
  });

  it('deletes, and reports a missing item', () => {
    const sec = fakeSecurity();
    writeToken('api.factiii.com', TOKEN, sec.exec);
    assert.equal(deleteToken('api.factiii.com', sec.exec), true);
    assert.equal(deleteToken('api.factiii.com', sec.exec), false);
  });
});

describe('api', () => {
  it('sends SuperJSON envelopes with a bearer token and unwraps results', async () => {
    const seen: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: { data: { json: { callId: 'x' } } } }) };
    };
    const api = createApi({ serverUrl: 'http://localhost:5001/', token: TOKEN, fetchImpl });
    assert.deepEqual(await api.mutation(PROCEDURES.call, { job: 'j' }), { callId: 'x' });
    await api.query(PROCEDURES.status, { callId: 'x', afterSeq: 0 });
    assert.equal(seen[0].url, 'http://localhost:5001/trpc/runnerJobs.run');
    assert.equal(seen[0].init.body, JSON.stringify({ json: { job: 'j' } }));
    assert.equal(seen[0].init.headers[RUNNER_CLI_TOKEN_HEADER], TOKEN);
    assert.equal(seen[0].init.headers.authorization, undefined);
    assert.equal(seen[1].init.method, 'GET');
    const input = new URL(seen[1].url).searchParams.get('input');
    assert.deepEqual(JSON.parse(input ?? ''), { json: { callId: 'x', afterSeq: 0 } });
  });

  it('maps a tRPC error to ApiError with its code', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { json: { message: 'Not a member', data: { code: 'FORBIDDEN', httpStatus: 403 } } } })
    });
    const api = createApi({ serverUrl: 'https://api.factiii.com', fetchImpl });
    await assert.rejects(api.query('x', {}), (e: unknown) => e instanceof ApiError && e.code === 'FORBIDDEN' && e.message === 'Not a member');
  });

  it('resolves a terminal started before a rename to the slug and name the board has now', () => {
    const runner = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-space-'));
    try {
      fs.mkdirSync(path.join(runner, 'acme-labs', 'state'), { recursive: true });
      fs.writeFileSync(
        path.join(runner, 'spaces.json'),
        JSON.stringify({ '12': { slug: 'acme-labs', name: 'Acme Labs', was: ['acme'] } })
      );
      // What the terminal was started with, under the old slug (a link to the
      // moved folder).
      const sock = path.join(runner, 'acme', 'state', 'secrets.sock');
      const env: NodeJS.ProcessEnv = { FACTIII_SPACE: 'acme', FACTIII_SPACE_ID: '12', FACTIII_SECRETS_SOCK: sock };
      assert.equal(resolveSpace(undefined, env), 'acme-labs');
      assert.equal(sessionBoard(env)?.name, 'Acme Labs');
      // From a runner that did not set the id yet: by the old slug.
      assert.equal(resolveSpace(undefined, { FACTIII_SPACE: 'acme', FACTIII_SECRETS_SOCK: sock }), 'acme-labs');
      // A flag is taken as typed; a board the runner does not know is passed on.
      assert.equal(resolveSpace('other', env), 'other');
      assert.equal(resolveSpace(undefined, { FACTIII_SPACE: 'elsewhere', FACTIII_SECRETS_SOCK: sock }), 'elsewhere');
      assert.equal(describeSpace('acme', env), 'Acme Labs (acme-labs)');
      assert.equal(describeSpace('elsewhere', env), 'elsewhere');
    } finally {
      fs.rmSync(runner, { recursive: true, force: true });
    }
  });

  it('resolves server and space from flags, then env', () => {
    const saved = { api: process.env.FACTIII_API_URL, space: process.env.FACTIII_SPACE, id: process.env.FACTIII_SPACE_ID };
    try {
      delete process.env.FACTIII_API_URL;
      delete process.env.FACTIII_SPACE;
      // A runner session sets it; it would name that session's board.
      delete process.env.FACTIII_SPACE_ID;
      assert.equal(resolveServer(), 'https://api.factiii.com');
      assert.throws(() => resolveSpace(), /--space/);
      process.env.FACTIII_API_URL = 'http://localhost:5001';
      process.env.FACTIII_SPACE = 'env-space';
      assert.equal(resolveServer(), 'http://localhost:5001');
      assert.equal(resolveServer('https://x.test/'), 'https://x.test');
      assert.equal(resolveSpace(), 'env-space');
      assert.equal(resolveSpace('flag'), 'flag');
      assert.equal(serverAccount('http://localhost:5001'), 'localhost:5001');
    } finally {
      for (const [k, v] of [['FACTIII_API_URL', saved.api], ['FACTIII_SPACE', saved.space], ['FACTIII_SPACE_ID', saved.id]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  // The server never picks a runner: a call with none named stops here.
  it('needs a runner from the flag or FACTIII_RUNNER', () => {
    const saved = process.env.FACTIII_RUNNER;
    try {
      delete process.env.FACTIII_RUNNER;
      assert.throws(() => resolveRunnerRef(), /--runner/);
      process.env.FACTIII_RUNNER = 'mac-mini-office';
      assert.equal(resolveRunnerRef(), 'mac-mini-office');
      assert.equal(resolveRunnerRef('12'), '12');
    } finally {
      if (saved === undefined) delete process.env.FACTIII_RUNNER;
      else process.env.FACTIII_RUNNER = saved;
    }
  });

  it('resolves a runner by id or by name, among the runners open to the caller only', async () => {
    const open: OpenRunner[] = [
      { runnerId: 4, name: 'mac-mini-office', owned: false, online: true },
      { runnerId: 9, name: 'laptop', owned: true, online: false },
      { runnerId: 11, name: 'laptop', owned: true, online: true }
    ];
    assert.equal(pickRunner('4', open), 4);
    assert.equal(pickRunner('Mac-Mini-Office', open), 4);
    assert.throws(() => pickRunner('5', open), /not open to you/);
    assert.throws(() => pickRunner('nope', open), /No runner named "nope"/);
    assert.throws(() => pickRunner('laptop', open), /Pass its id: 9, 11/);
    assert.throws(() => pickRunner('4', []), /Open to you: none/);

    let asked: unknown;
    const api = {
      async query<T>(p: string, input: unknown): Promise<T> {
        assert.equal(p, PROCEDURES.runners);
        asked = input;
        return { runners: open } as T;
      }
    };
    assert.equal(await resolveRunner(api, 'factiii-board', 'mac-mini-office'), 4);
    assert.deepEqual(asked, { spaceSlug: 'factiii-board' });
  });
});

describe('login / logout', () => {
  it('prints the URL and code, polls, and stores the token in the keychain', async () => {
    const sec = fakeSecurity();
    let polls = 0;
    const api: Api = {
      query: async () => {
        throw new Error('no queries');
      },
      async mutation<T>(p: string): Promise<T> {
        if (p === PROCEDURES.startLogin) {
          return { deviceCode: 'dev', userCode: 'ABCD-EFGH', approveUrl: 'https://factiii.com/runners/cli?code=ABCD-EFGH', expiresIn: 600, interval: 3 } as T;
        }
        polls += 1;
        return (polls < 3
          ? { status: 'pending' }
          : { status: 'approved', token: TOKEN, user: { id: 7, username: 'hammad', name: 'Hammad' } }) as T;
      }
    };
    let stdout = '';
    const code = await login(api, 'https://api.factiii.com', {
      out: (t) => {
        stdout += t;
      },
      err: () => {},
      sleep: async () => {},
      exec: sec.exec
    });
    assert.equal(code, 0);
    assert.equal(polls, 3);
    assert.match(stdout, /ABCD-EFGH/);
    assert.match(stdout, /https:\/\/factiii\.com\/runners\/cli\?code=ABCD-EFGH/);
    assert.match(stdout, /as hammad/);
    assert.ok(!stdout.includes(TOKEN), 'the token was printed');
    assert.equal(readToken('api.factiii.com', sec.exec), TOKEN);
  });

  it('stops polling when the login is denied', async () => {
    const sec = fakeSecurity();
    const api: Api = {
      query: async () => {
        throw new Error('no queries');
      },
      async mutation<T>(p: string): Promise<T> {
        return (p === PROCEDURES.startLogin
          ? { deviceCode: 'dev', userCode: 'ABCD-EFGH', approveUrl: 'u', expiresIn: 600, interval: 3 }
          : { status: 'denied' }) as T;
      }
    };
    const code = await login(api, 'https://api.factiii.com', { out: () => {}, err: () => {}, sleep: async () => {}, exec: sec.exec });
    assert.equal(code, 1);
    assert.equal(sec.items.size, 0);
  });

  const revokeApi = (log: string[], fail?: Error) => (token: string): Api => ({
    query: async () => {
      throw new Error('no queries');
    },
    async mutation<T>(p: string, input: unknown): Promise<T> {
      log.push(`${p}:${token}:${JSON.stringify(input)}`);
      if (fail) throw fail;
      return { success: true } as T;
    }
  });

  it('logout revokes on the server, then deletes the keychain item for that server only', async () => {
    const sec = fakeSecurity();
    writeToken('api.factiii.com', TOKEN, sec.exec);
    writeToken('localhost:5001', TOKEN, sec.exec);
    const calls: string[] = [];
    let stdout = '';
    const code = await logout(revokeApi(calls), 'https://api.factiii.com', {
      out: (t) => {
        stdout += t;
      },
      err: () => {},
      exec: sec.exec
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, [`runnerJobs.revokeSelf:${TOKEN}:{}`]);
    assert.match(stdout, /revoked on the server/);
    assert.equal(readToken('api.factiii.com', sec.exec), null);
    assert.equal(readToken('localhost:5001', sec.exec), TOKEN);
  });

  it('logout still deletes the local item when the server revoke fails', async () => {
    for (const fail of [new TypeError('fetch failed'), new ApiError('Runner CLI token revoked or expired', 'UNAUTHORIZED', 401)]) {
      const sec = fakeSecurity();
      writeToken('api.factiii.com', TOKEN, sec.exec);
      let stderr = '';
      let stdout = '';
      const code = await logout(revokeApi([], fail), 'https://api.factiii.com', {
        out: (t) => {
          stdout += t;
        },
        err: (t) => {
          stderr += t;
        },
        exec: sec.exec
      });
      assert.equal(code, 0);
      assert.match(stderr, /server revoke did not happen/);
      assert.doesNotMatch(stdout, /revoked on the server/);
      assert.equal(readToken('api.factiii.com', sec.exec), null);
    }
  });

  it('logout makes no server call when not logged in', async () => {
    const sec = fakeSecurity();
    const calls: string[] = [];
    assert.equal(await logout(revokeApi(calls), 'https://api.factiii.com', { out: () => {}, err: () => {}, exec: sec.exec }), 0);
    assert.deepEqual(calls, []);
  });
});

describe('audit', () => {
  const entry: AuditEntry = {
    ts: '2026-09-27T14:40:00.000Z',
    actor: { userId: '7', name: 'Hammad' },
    via: 'api',
    action: 'job',
    job: 'deploy-prod',
    keys: ['EXPO_TOKEN'],
    command: 'bash deploy.sh',
    exitCode: 0,
    durationMs: 81234,
    unlockedBy: 'Jon',
    prev: 'abc'
  };

  it('prints a row per entry and the chain verdict', () => {
    const text = formatAudit({ entries: [entry], chainIntact: true, firstBrokenTs: null });
    assert.match(text, /Hammad\s+api\s+job\s+deploy-prod\s+EXPO_TOKEN\s+0\s+81\.2s/);
    assert.match(text, /Chain: intact/);
    assert.match(
      formatAudit({ entries: [], chainIntact: false, firstBrokenTs: '2026-09-27T14:40:00.000Z' }),
      /Chain: BROKEN at the line dated 2026-09-27T14:40/
    );
  });

  it('exits 2 when the chain is broken, and passes the filters through', async () => {
    let sent: unknown;
    const api: Api = {
      async query<T>(p: string, input: unknown): Promise<T> {
        assert.equal(p, PROCEDURES.audit);
        sent = input;
        return { entries: [], chainIntact: false, firstBrokenTs: null } as T;
      },
      mutation: async () => {
        throw new Error('no');
      }
    };
    const q = { limit: 5, actorUserId: '7', job: 'deploy-prod', key: 'EXPO_TOKEN' };
    assert.equal(await printAudit(api, { spaceSlug: 's', runnerId: 7, query: q }, { out: () => {} }), 2);
    assert.deepEqual(sent, { spaceSlug: 's', runnerId: 7, query: q });
  });
});
