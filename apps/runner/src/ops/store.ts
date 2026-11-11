import fs from 'node:fs/promises';
import path from 'node:path';

import type { AuditLog } from '@shared/all/helpers/board-agent-core/audit';
import { decodeFileSecret } from '@shared/all/helpers/board-agent-core/engine';
import {
  adoptRunnerKey,
  changeSpacePassword,
  initSecrets,
  listSecretKeys,
  readSecretMeta,
  secretFileEnvKeys,
  secretsInitialized,
  setSecret,
  setSecretFile,
  setSecretFileEnvKey,
  setSecretMeta,
  spaceKeyDir,
  storedSecretFiles,
  unsetSecret,
  unsetSecretFile,
  unsetSecretFileEnvKey
} from '@shared/all/helpers/board-agent-core/host-secrets';
import { isFailedPasswordAttempt } from '@shared/all/helpers/board-agent-core/password-throttle';
import {
  applySecretsBackupImport,
  exportSecretsBackup,
  planSecretsBackupImport,
  storeKeyFor
} from '@shared/all/helpers/board-agent-core/secrets-backup';
import type { AuditVia } from '@shared/all/helpers/board-agent-core/secrets-run';
import type { WindowActor } from '@shared/all/helpers/board-agent-core/secrets-window';
import type { SecretMeta } from '@shared/all/helpers/board-agent-core/secret-descriptions';

// The board's Secrets tab with the ops user on, as ops socket ops
// (.specs/ops-user.md, "Store ops"). Two clients: Factiii Desktop's ops
// panel, and the session half's engine, which sends the Secrets tab's actions
// here (shared ops-store-actions.ts) so a headless runner's tab works from
// the web and the phone.
//
// Each one that reads or writes the store is checked by the store with the
// board password, and each answer is names only: no value, no masked tail,
// no bundle. Nor does any answer say whether two values are equal (an import
// plan's `same`), which would let a caller with the password test guesses
// against a stored value. A backup
// is written inside the ops home, never sent: with the board password and a
// passphrase it chose, a caller could otherwise read every value out of it,
// and the normal user (the AI's uid) is who calls. Copying it out takes the
// person's admin prompt (Desktop "Save a copy").

export type StoreActor = { by: WindowActor; via: AuditVia };

export type OpsStore = {
  set(b: StoreActor & { password: string; key: string; value: string }): Promise<{ success: boolean }>;
  unset(b: StoreActor & { password: string; key: string }): Promise<{ success: boolean }>;
  setFile(b: StoreActor & { password: string; name: string; contentBase64: string }): Promise<{ success: boolean }>;
  unsetFile(b: StoreActor & { password: string; name: string }): Promise<{ success: boolean }>;
  changePassword(b: StoreActor & { oldPassword: string; newPassword: string }): Promise<{ success: boolean }>;
  backupExport(b: StoreActor & { password: string; passphrase: string }): Promise<{ file: string }>;
  /** Every secret in the backup (the panel), or the picks (the Secrets
   *  tab). A pick the board already has needs `conflict`: without it the
   *  pick is kept, never compared, so no answer says whether two values are
   *  equal. */
  backupImport(
    b: StoreActor & {
      bundle: string;
      passphrase: string;
      targetPassword: string;
      picks?: { secrets: BackupPick[]; files: BackupPick[] };
    }
  ): Promise<{
    secrets: string[];
    files: string[];
  }>;
} & OpsStoreReads;

/** A key inside an env file secret, by name only. */
export type FileEnvKeyName = { name: string; editable: boolean };

/** What importing a backup would touch: the backup's names, and whether
 *  this board already has one of that name. Never a tail, a size of the
 *  board's own file, or whether the two are equal. */
export type BackupPlanNames = {
  board: string;
  createdAt: string;
  secrets: { name: string; exists: boolean }[];
  files: { name: string; size: number; exists: boolean }[];
};

export type BackupPick = { name: string; conflict?: 'keep' | 'take' };

export type OpsStoreReads = {
  status(): Promise<{ initialized: boolean }>;
  init(b: StoreActor & { password: string }): Promise<{ success: boolean }>;
  list(b: StoreActor & { password: string }): Promise<{
    keys: string[];
    meta: Record<string, SecretMeta>;
    files: string[];
  }>;
  /** A key's description. No password: it writes no secret material. */
  setMeta(b: { key: string; patch: Partial<SecretMeta> }): Promise<{ success: boolean }>;
  backupPlan(b: StoreActor & { bundle: string; passphrase: string; targetPassword: string }): Promise<BackupPlanNames>;
  fileEnvKeys(b: StoreActor & { password: string; name: string }): Promise<FileEnvKeyName[] | null>;
  fileEnvSet(b: StoreActor & { password: string; name: string; key: string; value: string }): Promise<{
    occurrences: number;
    keys: FileEnvKeyName[];
  }>;
  fileEnvUnset(b: StoreActor & { password: string; name: string; key: string }): Promise<{
    removed: number;
    keys: FileEnvKeyName[];
  }>;
};

/** A file secret's largest size, as the engine's (MAX_FILE_SECRET_BYTES). */
const MAX_FILE_SECRET_BYTES = 5 * 1024 * 1024;

const namesOnly = (keys: { name: string; editable: boolean }[]): FileEnvKeyName[] =>
  keys.map((k) => ({ name: k.name, editable: k.editable }));

/** `<ops home>/backups`, 0700 ops. */
export function backupsDir(opsHome: string): string {
  return path.join(opsHome, 'backups');
}

export function createOpsStore(opts: {
  slug: string;
  opsHome: string;
  spaceDir: string;
  audit: AuditLog;
  /** A re-key retires the window's key: lock it (as the engine does). */
  lockWindow: () => void;
  now?: () => Date;
}): OpsStore {
  const { spaceDir, audit } = opts;
  const configDir = spaceKeyDir(spaceDir);
  const now = opts.now ?? (() => new Date());

  const log = (a: StoreActor, action: string, keys: string[], detail: string) =>
    audit.append({
      actor: a.by,
      via: a.via,
      // The engine's own action names, so the audit tab reads them the same.
      action: action as Parameters<AuditLog['append']>[0]['action'],
      job: null,
      keys,
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail
    });

  /** A wrong password is logged and counted (the store's throttle), as the
   *  engine's auditPasswordFailure does. */
  const guarded = async <T>(a: StoreActor, what: string, keys: string[], run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (isFailedPasswordAttempt(err)) {
        await log(a, 'auth-failed', keys, `${err instanceof Error ? err.message : String(err)} (${what}; ops user)`);
      }
      throw err;
    }
  };

  return {
    set: async (b) => {
      const res = await guarded(b, 'set secret', [b.key], () => setSecret(configDir, spaceDir, b.password, b.key, b.value));
      await log(b, 'secret-set', [b.key], 'ops user');
      return { success: res.success };
    },
    unset: async (b) => {
      const res = await guarded(b, 'remove secret', [b.key], () => unsetSecret(configDir, spaceDir, b.password, b.key));
      await log(b, 'secret-unset', [b.key], 'ops user');
      return { success: res.success };
    },
    setFile: async (b) => {
      const data = decodeFileSecret(b.contentBase64);
      try {
        await guarded(b, 'set file secret', [b.name], () => setSecretFile(configDir, spaceDir, b.password, b.name, data));
      } finally {
        data.fill(0);
      }
      await log(b, 'secret-set', [b.name], 'file; ops user');
      return { success: true };
    },
    unsetFile: async (b) => {
      await guarded(b, 'remove file secret', [b.name], () => unsetSecretFile(configDir, spaceDir, b.password, b.name));
      await log(b, 'secret-unset', [b.name], 'file; ops user');
      return { success: true };
    },
    changePassword: async (b) => {
      try {
        await guarded(b, 'password change', [], () => changeSpacePassword(spaceDir, b.oldPassword, b.newPassword));
      } catch (err) {
        // Past the password check the key may already be replaced.
        if (!isFailedPasswordAttempt(err)) opts.lockWindow();
        throw err;
      }
      opts.lockWindow();
      await log(b, 'password-rotate', [], 'ops user');
      return { success: true };
    },
    backupExport: async (b) => {
      const bundle = await guarded(b, 'secrets backup', [], () =>
        exportSecretsBackup({ spaceDir, board: opts.slug, password: b.password, passphrase: b.passphrase })
      );
      const dir = backupsDir(opts.opsHome);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      const file = `${opts.slug}-secrets-${stamp}.factiii-backup`;
      await fs.writeFile(path.join(dir, file), bundle, { mode: 0o600, flag: 'wx' });
      await log(b, 'backup-export', [], `ops user; kept in the ops home as ${file}`);
      return { file };
    },
    backupImport: async (b) => {
      const hasStore = await secretsInitialized(configDir);
      const targetKey = storeKeyFor(spaceDir, b.targetPassword, hasStore);
      const imported = await guarded(b, 'import backup', [], async () => {
        // Every name in the file: the plan's masked tails stay here.
        const plan = await planSecretsBackupImport({
          bundle: b.bundle,
          passphrase: b.passphrase,
          spaceDir,
          targetKey: hasStore ? targetKey : null
        });
        // With picks, each is checked against the plan; one the board
        // already holds keeps the board's value unless the pick says take,
        // whether or not the two are equal, so the import's outcome cannot
        // answer that.
        const pick = <R extends { name: string; current: unknown }>(rows: R[], picked: BackupPick[]) =>
          picked
            .map((p) => {
              const row = rows.find((r) => r.name === p.name);
              if (!row) return null;
              if (!row.current) return { name: p.name };
              return p.conflict === 'take' ? { name: p.name, conflict: 'take' as const } : null;
            })
            .filter((p): p is { name: string; conflict?: 'take' } => p !== null);
        // No picks (the panel's "Import every secret in it"): every name,
        // taking the backup's value. Each pick is an object: the store
        // refuses a bare name.
        const every = (rows: { name: string }[]) => rows.map((r) => ({ name: r.name, conflict: 'take' as const }));
        const secrets = b.picks ? pick(plan.secrets, b.picks.secrets) : every(plan.secrets);
        const files = b.picks ? pick(plan.files, b.picks.files) : every(plan.files);
        // Everything picked is kept: nothing to write (the store refuses an
        // empty import).
        if (secrets.length === 0 && files.length === 0) {
          return { board: plan.board, createdAt: plan.createdAt, secrets: [], files: [] };
        }
        await applySecretsBackupImport({
          bundle: b.bundle,
          passphrase: b.passphrase,
          spaceDir,
          targetKey,
          secrets,
          files
        });
        // The names asked for, not the names written: a take over an equal
        // value writes nothing, and saying so would answer whether the two
        // are equal.
        return {
          board: plan.board,
          createdAt: plan.createdAt,
          secrets: secrets.map((p) => p.name),
          files: files.map((p) => p.name)
        };
      });
      await log(
        b,
        'backup-import',
        [...imported.secrets, ...imported.files],
        `ops user; ${imported.board} backup of ${imported.createdAt.slice(0, 10)}`
      );
      return { secrets: imported.secrets, files: imported.files };
    },
    status: async () => {
      // As the engine's deploySecretsStatus: a store from before per-board
      // keys gets its key first, so it never reads as no store.
      await adoptRunnerKey(path.dirname(spaceDir), spaceDir).catch(() => false);
      return { initialized: await secretsInitialized(configDir) };
    },
    // Not logged, as the engine's deploySecretsInit is not.
    init: async (b) => ({ success: (await initSecrets(configDir, b.password)).success }),
    list: async (b) => ({
      keys: await guarded(b, 'list secrets', [], () => listSecretKeys(configDir, spaceDir, b.password)),
      meta: await readSecretMeta(spaceDir),
      files: await storedSecretFiles(spaceDir)
    }),
    setMeta: async (b) => setSecretMeta(spaceDir, b.key, b.patch),
    backupPlan: async (b) => {
      const hasStore = await secretsInitialized(configDir);
      const plan = await guarded(b, 'import backup', [], () =>
        planSecretsBackupImport({
          bundle: b.bundle,
          passphrase: b.passphrase,
          spaceDir,
          targetKey: hasStore ? storeKeyFor(spaceDir, b.targetPassword, true) : null
        })
      );
      return {
        board: plan.board,
        createdAt: plan.createdAt,
        secrets: plan.secrets.map((x) => ({ name: x.name, exists: x.current !== null })),
        // The backup's own size is the caller's file; the board's is not said.
        files: plan.files.map((x) => ({ name: x.name, size: x.size, exists: x.current !== null }))
      };
    },
    fileEnvKeys: async (b) => {
      const keys = await guarded(b, 'list file secret keys', [b.name], () =>
        secretFileEnvKeys(configDir, spaceDir, b.password, b.name)
      );
      return keys ? namesOnly(keys) : null;
    },
    fileEnvSet: async (b) => {
      const res = await guarded(b, 'set file secret key', [b.name], () =>
        setSecretFileEnvKey(configDir, spaceDir, b.password, {
          name: b.name,
          key: b.key,
          value: b.value,
          maxBytes: MAX_FILE_SECRET_BYTES
        })
      );
      await log(b, 'secret-set', [b.name], `key ${b.key} in the file; ops user`);
      return { occurrences: res.occurrences, keys: namesOnly(res.keys) };
    },
    fileEnvUnset: async (b) => {
      const res = await guarded(b, 'remove file secret key', [b.name], () =>
        unsetSecretFileEnvKey(configDir, spaceDir, b.password, {
          name: b.name,
          key: b.key,
          maxBytes: MAX_FILE_SECRET_BYTES
        })
      );
      await log(b, 'secret-unset', [b.name], `key ${b.key} in the file; ops user`);
      return { removed: res.removed, keys: namesOnly(res.keys) };
    }
  };
}
