import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { secretsBinariesPresent } from '@shared/all/helpers/board-agent-core/secrets-binaries.testutil';

import { PROCEDURES, type Api } from './api';
import {
  ageEncrypt,
  checkRecipientPin,
  readSecretValue,
  recipientPinKeys,
  setSecret,
  type SpawnLike
} from './secret';

const RECIPIENT = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';
const OTHER_RECIPIENT = 'age1lggyhqrw2nlhcxprm67z43rta597azn8gknawjehu9d9dl0jq3yqqvfafg';
const VALUE = 'sk_live_TOPSECRET_123';

/** A fake `age` that records its argv and stdin, then prints armor. */
function fakeSpawn(): { spawnImpl: SpawnLike; seen: { bin: string; args: string[]; stdin: string }[] } {
  const seen: { bin: string; args: string[]; stdin: string }[] = [];
  const spawnImpl = ((bin: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const record = { bin, args, stdin: '' };
    seen.push(record);
    const chunks: Buffer[] = [];
    child.stdin.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    child.stdin.on('end', () => {
      record.stdin = Buffer.concat(chunks).toString();
      child.stdout.end('-----BEGIN AGE ENCRYPTED FILE-----\nZmFrZQ==\n-----END AGE ENCRYPTED FILE-----\n');
      child.stdout.on('end', () => child.emit('close', 0));
      child.stdout.resume();
      // Re-emit data for the consumer: PassThrough already buffered it.
    });
    return child;
  }) as unknown as SpawnLike;
  return { spawnImpl, seen };
}

function pipedStdin(text: string | Buffer): NodeJS.ReadableStream & { isTTY?: boolean } {
  return Readable.from([Buffer.from(text)]);
}

function ttyStdin(): NodeJS.ReadableStream & { isTTY?: boolean } {
  const s = Readable.from([]) as Readable & { isTTY?: boolean };
  s.isTTY = true;
  return s;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'factiii-cli-test-'));
}

describe('readSecretValue', () => {
  const noPrompt = async (): Promise<string> => {
    throw new Error('must not prompt');
  };

  it('refuses a terminal on stdin without --from-tty', async () => {
    await assert.rejects(
      readSecretValue('env', false, { stdin: ttyStdin(), promptSilent: noPrompt }),
      /Refusing to read a secret from the terminal/
    );
  });

  it('prompts silently with --from-tty', async () => {
    let label = '';
    const value = await readSecretValue('env', true, {
      stdin: ttyStdin(),
      promptSilent: async (l) => {
        label = l;
        return VALUE;
      }
    });
    assert.equal(value.toString(), VALUE);
    assert.match(label, /no echo/);
  });

  it('refuses --from-tty for a file blob', async () => {
    await assert.rejects(readSecretValue('file', true, { stdin: ttyStdin(), promptSilent: noPrompt }));
  });

  it('reads stdin, drops one trailing newline for env, keeps bytes for a file', async () => {
    assert.equal((await readSecretValue('env', false, { stdin: pipedStdin(`${VALUE}\n`), promptSilent: noPrompt })).toString(), VALUE);
    assert.equal((await readSecretValue('env', false, { stdin: pipedStdin(`${VALUE}\r\n`), promptSilent: noPrompt })).toString(), VALUE);
    assert.equal((await readSecretValue('file', false, { stdin: pipedStdin('blob\n'), promptSilent: noPrompt })).toString(), 'blob\n');
  });

  it('refuses an empty value', async () => {
    await assert.rejects(readSecretValue('env', false, { stdin: pipedStdin('\n'), promptSilent: noPrompt }), /empty/);
  });
});

describe('ageEncrypt', () => {
  it('passes the value on stdin, never in argv', async () => {
    const { spawnImpl, seen } = fakeSpawn();
    const armor = await ageEncrypt(RECIPIENT, Buffer.from(VALUE), spawnImpl);
    assert.match(armor, /BEGIN AGE ENCRYPTED FILE/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].bin, 'age');
    assert.deepEqual(seen[0].args, ['-r', RECIPIENT, '-a']);
    assert.ok(!seen[0].args.some((a) => a.includes(VALUE)));
    assert.equal(seen[0].stdin, VALUE);
  });

  it('refuses a recipient that is not an age X25519 key', async () => {
    const { spawnImpl, seen } = fakeSpawn();
    await assert.rejects(ageEncrypt('--identity=/etc/passwd', Buffer.from(VALUE), spawnImpl), /invalid age recipient/);
    await assert.rejects(ageEncrypt(`${RECIPIENT}x`, Buffer.from(VALUE), spawnImpl));
    assert.equal(seen.length, 0);
  });

  // Skips with a printed reason, or fails under
  // FACTIII_REQUIRE_SECRETS_BINARIES=1 (see shared secrets-binaries.testutil).
  const hasAge = secretsBinariesPresent('remote/secret.test.ts', ['age', 'age-keygen']);
  it('round-trips through the real age binary', { skip: !hasAge && 'age or age-keygen not installed' }, async () => {
    const dir = tmpDir();
    try {
      const keyFile = path.join(dir, 'key.txt');
      spawnSync('age-keygen', ['-o', keyFile]);
      const recipient = spawnSync('age-keygen', ['-y', keyFile], { encoding: 'utf-8' }).stdout.trim();
      const armor = await ageEncrypt(recipient, Buffer.from(VALUE));
      assert.ok(!armor.includes(VALUE));
      const plain = spawnSync('age', ['-d', '-i', keyFile], { input: armor, encoding: 'utf-8' });
      assert.equal(plain.stdout, VALUE);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkRecipientPin', () => {
  it('pins the first recipient and refuses a change without consent', () => {
    const dir = tmpDir();
    try {
      assert.equal(checkRecipientPin('h/s', RECIPIENT, false, dir), 'pinned-now');
      assert.equal(checkRecipientPin('h/s', RECIPIENT, false, dir), 'match');
      assert.throws(() => checkRecipientPin('h/s', OTHER_RECIPIENT, false, dir), /changed/);
      assert.equal(checkRecipientPin('h/s', OTHER_RECIPIENT, true, dir), 'replaced');
      assert.equal(checkRecipientPin('h/s', OTHER_RECIPIENT, false, dir), 'match');
      assert.equal(fs.statSync(path.join(dir, 'cli-recipients.json')).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A pin from before calls named their runner sits under `<server>/<space>`.
  it('checks a named runner against the pin stored before runners were named', () => {
    const dir = tmpDir();
    try {
      assert.equal(checkRecipientPin('h/s', RECIPIENT, false, dir), 'pinned-now');
      assert.throws(() => checkRecipientPin('h/s/7', OTHER_RECIPIENT, false, dir, 'h/s'), /changed/);
      assert.equal(checkRecipientPin('h/s/7', RECIPIENT, false, dir, 'h/s'), 'match');
      // Once the runner has its own pin, the old one is not read again.
      assert.equal(checkRecipientPin('h/s/7', OTHER_RECIPIENT, true, dir, 'h/s'), 'replaced');
      assert.equal(checkRecipientPin('h/s/7', OTHER_RECIPIENT, false, dir, 'h/s'), 'match');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The slug follows the space's name. A pin by slug was lost on a rename, and
  // the next call trusted whatever recipient the server handed back.
  it('pins by space id, so a renamed board keeps its pin', () => {
    const dir = tmpDir();
    try {
      // Pinned by slug, by a CLI from before pins were by id.
      assert.equal(checkRecipientPin('h/acme/7', RECIPIENT, false, dir), 'pinned-now');
      // The space is renamed; the runner's spaces.json knows the old slug.
      const keys = recipientPinKeys({ serverHost: 'h', spaceSlug: 'acme-labs', runnerId: 7, spaceId: 12, formerSlugs: ['acme'] });
      assert.equal(keys.pinKey, 'h/space-12/7');
      assert.throws(
        () => checkRecipientPin(keys.pinKey, OTHER_RECIPIENT, false, dir, keys.legacyKeys, 'runner 7 on Acme Labs'),
        /recipient for runner 7 on Acme Labs changed/
      );
      assert.equal(checkRecipientPin(keys.pinKey, RECIPIENT, false, dir, keys.legacyKeys), 'match');
      // Carried to the id: any later slug finds it with no old key at all.
      const later = recipientPinKeys({ serverHost: 'h', spaceSlug: 'acme-two', runnerId: 7, spaceId: 12 });
      assert.throws(() => checkRecipientPin(later.pinKey, OTHER_RECIPIENT, false, dir, later.legacyKeys), /changed/);
      // A server that does not say the id keeps the slug key.
      assert.equal(recipientPinKeys({ serverHost: 'h', spaceSlug: 's', runnerId: 7 }).pinKey, 'h/s/7');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('setSecret', () => {
  it('sends only ciphertext to the server, and the value never reaches argv', async () => {
    const dir = tmpDir();
    const sent: { path: string; input: unknown }[] = [];
    const api: Api = {
      async query<T>(p: string, input: unknown): Promise<T> {
        sent.push({ path: p, input });
        assert.equal(p, PROCEDURES.recipient);
        return { recipient: RECIPIENT } as T;
      },
      async mutation<T>(p: string, input: unknown): Promise<T> {
        sent.push({ path: p, input });
        return { ok: true } as T;
      }
    };
    const { spawnImpl, seen } = fakeSpawn();
    let stdout = '';
    try {
      const code = await setSecret(
        api,
        { serverHost: 'api.factiii.com', spaceSlug: 'factiii-board', runnerId: 7, key: 'EXPO_TOKEN', kind: 'env', fromTty: false, acceptNewRecipient: false },
        {
          out: (t) => {
            stdout += t;
          },
          err: () => {},
          stdin: pipedStdin(`${VALUE}\n`),
          promptSilent: async () => '',
          spawnImpl,
          pinDir: dir
        }
      );
      assert.equal(code, 0);
      assert.equal(stdout, 'submitted; waiting for an approver\n');
      const submit = sent.find((s) => s.path === PROCEDURES.submitSecret);
      assert.ok(submit);
      assert.deepEqual(Object.keys(submit.input as object).sort(), ['ciphertext', 'key', 'kind', 'runnerId', 'spaceSlug']);
      assert.match((submit.input as { ciphertext: string }).ciphertext, /BEGIN AGE ENCRYPTED FILE/);
      assert.ok(!JSON.stringify(sent).includes(VALUE), 'the value reached the server');
      assert.ok(!seen.some((s) => s.args.join(' ').includes(VALUE)), 'the value reached argv');
      assert.ok(!stdout.includes(VALUE));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a bad key before it reads stdin', async () => {
    const api = {} as Api;
    for (const key of ['desktop-cert.p12', 'lower_case', '_LEADING']) {
      await assert.rejects(
        setSecret(
          api,
          { serverHost: 'h', spaceSlug: 's', runnerId: 7, key, kind: 'file', fromTty: false, acceptNewRecipient: false },
          { out: () => {}, err: () => {}, stdin: ttyStdin(), promptSilent: async () => '' }
        ),
        /not a valid name/
      );
    }
    await assert.rejects(
      setSecret(
        api,
        { serverHost: 'h', spaceSlug: 's', runnerId: 7, key: 'bad key', kind: 'env', fromTty: false, acceptNewRecipient: false },
        { out: () => {}, err: () => {}, stdin: ttyStdin(), promptSilent: async () => '' }
      ),
      /not a valid name/
    );
  });
});
