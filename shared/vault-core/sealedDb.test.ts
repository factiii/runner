import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { newMasterKey, VaultCryptoError } from './crypto';
import {
  type DbStatement,
  openSealedVaultDb,
  type SealableDb
} from './sealedDb';

// The sealed database's own rules (.specs/vault.md "Encryption and the Vault
// key"), on a fake database: on disk only an encrypted dump, flushed after
// writes on a debounce, skipped when nothing changed, held while a
// transaction is open, and written on close. The runner runs the same on its
// real PGlite child (apps/runner/src/vault/sealedDb.test.ts).

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-core-sealed-db-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

type FakeOp = { op: 'begin' } | { op: 'commit'; tx: number } | { op: 'rss' };

/** A database of text rows: a write moves its WAL position, a read does not,
 *  and its dump is the rows as JSON. */
function fakeDb(load: Uint8Array | null): SealableDb<FakeOp> {
  const rows: string[] = load
    ? (JSON.parse(Buffer.from(load).toString('utf-8')) as string[])
    : [];
  let lsn = 0;
  let open = true;
  const run = (sql: string, params?: unknown[]) => {
    if (sql.startsWith('SELECT pg_current_wal_insert_lsn'))
      return [{ lsn: String(lsn) }];
    if (sql.startsWith('SELECT')) return rows.map((text) => ({ text }));
    if (sql.startsWith('INSERT')) rows.push(String(params?.[0]));
    lsn += 1;
    return [];
  };
  return {
    query: async <T>(sql: string, params?: unknown[]) =>
      run(sql, params) as T[],
    batch: async (statements: DbStatement[]) =>
      statements.map((s) => run(s.sql, s.params)),
    driver: async (op) => (op.op === 'rss' ? 0 : null),
    close: async () => {
      open = false;
    },
    alive: () => open,
    dump: async () => new Uint8Array(Buffer.from(JSON.stringify(rows)))
  };
}

const waitFor = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
};

describe('the sealed database (vault-core)', () => {
  const vk = newMasterKey();
  const open = (dumpPath: string, key: () => Buffer = () => vk) =>
    openSealedVaultDb<FakeOp>({
      open: async (load) => fakeDb(load),
      dumpPath,
      key,
      log: () => undefined,
      quietMs: 30,
      maxMs: 300
    });

  it('writes an encrypted dump after writes, none after reads, and reopens from it', async () => {
    const dumpPath = path.join(tmp, 'a.sealed');
    const db = await open(dumpPath);
    await db.query('INSERT', ['SEALED-DB-MARKER']);
    await waitFor(() => db.flushes() > 0);
    assert.equal(db.flushes(), 1);
    assert.equal(
      fs.readFileSync(dumpPath).includes(Buffer.from('SEALED-DB-MARKER')),
      false
    );

    await db.query('SELECT');
    await db.flush();
    assert.equal(db.flushes(), 1);

    await db.batch([{ sql: 'INSERT', params: ['second'] }]);
    await db.close();
    assert.equal(db.flushes(), 2);

    const again = await open(dumpPath);
    const rows = await again.query<{ text: string }>('SELECT');
    assert.deepEqual(
      rows.map((row) => row.text),
      ['SEALED-DB-MARKER', 'second']
    );
    await again.close();
  });

  it('writes no dump while a transaction is open', async () => {
    const db = await open(path.join(tmp, 'b.sealed'));
    await db.driver({ op: 'begin' });
    await db.query('INSERT', ['inside']);
    await db.flush();
    assert.equal(db.flushes(), 0);
    await db.driver({ op: 'commit', tx: 1 });
    await db.flush();
    assert.equal(db.flushes(), 1);
    await db.close();
  });

  it('does not open with another key, nor while locked', async () => {
    const dumpPath = path.join(tmp, 'a.sealed');
    await assert.rejects(
      () => open(dumpPath, () => newMasterKey()),
      VaultCryptoError
    );
    await assert.rejects(
      () =>
        open(dumpPath, () => {
          throw new Error('locked');
        }),
      /locked/
    );
  });
});
