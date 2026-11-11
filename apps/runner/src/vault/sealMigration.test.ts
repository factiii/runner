import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { BLOB_KIND, newMasterKey, newVaultPassphrase, openBlob, openSealedFile } from './crypto';
import { createKeyring, type Keyring, readKeyring, unwrapWithVaultKey } from './keyring';
import { recoverSeal, SealCrash, sealPaths, type SealStep, sealVault } from './sealMigration';

// Encrypting a plaintext Vault in place (.specs/vault.md "Encryption and
// the Vault key" → Migration), crash-safe: a crash at any step either leaves
// the plaintext Vault as it was (before the commit) or finishes at the next
// start (after it), never half of each.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-seal-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const STEPS: SealStep[] = [
  'journal',
  'keys',
  'dump',
  'objects',
  'verify',
  'commit',
  'dump-in-place',
  'objects-aside',
  'objects-in-place',
  'keys-in-place',
  'shred',
  'done'
];
const DUMP = Buffer.from('PLAIN-DUMP-MARKER and the rest of a database');
const BODY = Buffer.from('PLAIN-FILE-MARKER, a file the owner added');

/** A plaintext Vault as runners before step 4 left it. */
function plainVault(name: string) {
  const root = path.join(tmp, name);
  const paths = sealPaths(root);
  fs.mkdirSync(path.join(paths.plainDb, 'base'), { recursive: true });
  fs.writeFileSync(path.join(paths.plainDb, 'base', 'page'), DUMP);
  fs.mkdirSync(paths.objects, { recursive: true });
  const object = createHash('sha256').update('vault/1/u/a.txt').digest('hex');
  fs.writeFileSync(path.join(paths.objects, object), BODY);
  fs.writeFileSync(
    path.join(paths.objects, `${object}.json`),
    JSON.stringify({
      key: 'vault/1/u/a.txt',
      size: BODY.length,
      contentType: 'text/plain',
      sha256: createHash('sha256').update(BODY).digest('hex'),
      lastModified: new Date().toISOString()
    })
  );
  // An upload a crash left half done: not a file, not sealed.
  fs.writeFileSync(path.join(paths.objects, `${object}x.part`), 'half');
  return { paths, object };
}

/** Every byte under a folder, for "no plaintext left". */
function allBytes(dir: string): Buffer {
  if (!fs.existsSync(dir)) return Buffer.alloc(0);
  return Buffer.concat(
    fs.readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name)))
  );
}

/** A light scrypt: these tests seal many Vaults. */
const LIGHT = { N: 2 ** 10, r: 8, p: 1 };

async function options(paths: ReturnType<typeof sealPaths>, crashAt?: SealStep) {
  const vk = newMasterKey();
  const vaultKey = newVaultPassphrase();
  const keyring = await createKeyring(vk, vaultKey, LIGHT);
  return {
    vk,
    vaultKey,
    keyring,
    run: () =>
      sealVault({
        paths,
        vk,
        keyring,
        dumpPlain: async () => DUMP,
        verifyDump: async (plain) => assert.deepEqual(plain, DUMP),
        at: (step) => {
          if (step === crashAt) throw new SealCrash(`crash at ${step}`);
        }
      })
  };
}

/** The sealed Vault is whole and the plaintext gone. */
function assertSealed(paths: ReturnType<typeof sealPaths>, vk: Buffer, object: string) {
  assert.equal(fs.existsSync(paths.journal), false);
  assert.equal(fs.existsSync(paths.plainDb), false);
  assert.equal(fs.existsSync(paths.objectsOld), false);
  assert.ok(readKeyring(paths.keys));
  assert.deepEqual(openBlob(vk, BLOB_KIND.dump, fs.readFileSync(paths.dump)), DUMP);
  assert.deepEqual(openSealedFile(vk, path.join(paths.objects, object)), BODY);
  const disk = allBytes(paths.root);
  assert.equal(disk.includes(Buffer.from('PLAIN-DUMP-MARKER')), false);
  assert.equal(disk.includes(Buffer.from('PLAIN-FILE-MARKER')), false);
}

/** The plaintext Vault exactly as it was, nothing staged left. */
function assertPlain(paths: ReturnType<typeof sealPaths>, object: string) {
  for (const gone of [paths.journal, paths.keys, paths.keysNext, paths.dump, paths.dumpNext, paths.objectsNext]) {
    assert.equal(fs.existsSync(gone), false, gone);
  }
  assert.deepEqual(fs.readFileSync(path.join(paths.plainDb, 'base', 'page')), DUMP);
  assert.deepEqual(fs.readFileSync(path.join(paths.objects, object)), BODY);
}

describe('encrypting a plaintext Vault', () => {
  it('seals the database and files, verifies, and removes the plaintext', async () => {
    const { paths, object } = plainVault('whole');
    const { vk, vaultKey, keyring, run } = await options(paths);
    await run();
    assertSealed(paths, vk, object);
    const onDisk = readKeyring(paths.keys) as Keyring;
    assert.deepEqual(await unwrapWithVaultKey(onDisk, vaultKey), vk);
    assert.equal(onDisk.vaultId, keyring.vaultId);
    // Nothing secret in the key file: not the Vault key, not the master key.
    const text = fs.readFileSync(paths.keys, 'utf-8');
    assert.equal(text.includes(vaultKey.replace(/-/g, '')), false);
    assert.equal(text.includes(vaultKey), false);
    assert.equal(text.includes(vk.toString('base64')), false);
    assert.equal(recoverSeal(paths), 'none');
  });

  it('rolls back at once when the check fails, leaving the plaintext', async () => {
    const { paths, object } = plainVault('bad-verify');
    const vk = newMasterKey();
    const keyring = await createKeyring(vk, newVaultPassphrase(), LIGHT);
    await assert.rejects(() =>
      sealVault({
        paths,
        vk,
        keyring,
        dumpPlain: async () => DUMP,
        verifyDump: async () => {
          throw new Error('counts differ');
        }
      })
    );
    assertPlain(paths, object);
  });

  for (const step of STEPS) {
    it(`survives a crash after "${step}"`, async () => {
      const { paths, object } = plainVault(`crash-${step}`);
      const first = await options(paths, step);
      await assert.rejects(first.run, SealCrash);
      const recovered = recoverSeal(paths);
      const committed = STEPS.indexOf(step) >= STEPS.indexOf('commit');
      if (step === 'done') {
        // The journal was already gone: nothing to do.
        assert.equal(recovered, 'none');
        assertSealed(paths, first.vk, object);
      } else if (committed) {
        assert.equal(recovered, 'rolled-forward');
        assertSealed(paths, first.vk, object);
      } else {
        assert.equal(recovered, 'rolled-back');
        assertPlain(paths, object);
        // And setup can run again from the start.
        const again = await options(paths);
        await again.run();
        assertSealed(paths, again.vk, object);
      }
      // A second recovery is a no-op.
      assert.equal(recoverSeal(paths), 'none');
    });
  }

  it('refuses to seal twice', async () => {
    const { paths } = plainVault('twice');
    await (await options(paths)).run();
    await assert.rejects((await options(paths)).run, /already encrypted/);
  });

  it('seals a Vault with no database or files yet', async () => {
    const root = path.join(tmp, 'empty');
    const paths = sealPaths(root);
    const vk = newMasterKey();
    await sealVault({
      paths,
      vk,
      keyring: await createKeyring(vk, newVaultPassphrase(), LIGHT),
      dumpPlain: async () => null,
      verifyDump: async () => undefined
    });
    assert.ok(readKeyring(paths.keys));
    assert.equal(fs.existsSync(paths.dump), false);
    assert.deepEqual(fs.readdirSync(paths.objects), []);
  });
});
