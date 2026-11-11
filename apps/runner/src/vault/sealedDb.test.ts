import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { newMasterKey, VaultCryptoError } from './crypto';
import { openSealedVaultDb } from './sealedDb';

// The encrypted Vault's database (.specs/vault.md "Encryption and the
// Vault key"): PGlite in memory, on disk only an encrypted dump, flushed after
// writes on a debounce, skipped when nothing changed, and on close.

const ENGINE = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sealed-db-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the sealed database', () => {
  const vk = newMasterKey();
  const dumpPath = path.join(tmp, 'db.sealed');
  const open = (key: () => Buffer = () => vk) =>
    openSealedVaultDb({ engineDir: ENGINE, dumpPath, key, log: () => undefined, quietMs: 50, maxMs: 400 });

  it('writes an encrypted dump after writes, none after reads, and reopens from it', async () => {
    const db = await open();
    await db.batch([
      { sql: 'CREATE TABLE "Note" ("id" INT PRIMARY KEY, "text" TEXT)', exec: true },
      { sql: 'INSERT INTO "Note" VALUES (1, $1)', params: ['SEALED-DB-MARKER'] }
    ]);
    // The debounce writes it on its own.
    for (let i = 0; i < 100 && db.flushes() === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(db.flushes(), 1);
    assert.ok(fs.existsSync(dumpPath));
    assert.equal(fs.readFileSync(dumpPath).includes(Buffer.from('SEALED-DB-MARKER')), false);

    // Reads change nothing: no dump.
    await db.query('SELECT * FROM "Note"');
    await db.flush();
    assert.equal(db.flushes(), 1);

    await db.query('INSERT INTO "Note" VALUES (2, $1)', ['second']);
    await db.close();

    const again = await open();
    const rows = await again.query<{ id: number; text: string }>('SELECT * FROM "Note" ORDER BY "id"');
    assert.deepEqual(rows.map((row) => row.text), ['SEALED-DB-MARKER', 'second']);
    // The runner's migrations ran on the first open and are in the dump.
    assert.ok((await again.query('SELECT "id" FROM "_vault_migrations"')).length > 0);
    await again.close();
  });

  it('does not open with another key, nor while locked', async () => {
    await assert.rejects(() => open(() => newMasterKey()), VaultCryptoError);
    await assert.rejects(
      () =>
        open(() => {
          throw new Error('locked');
        }),
      /locked/
    );
  });
});
