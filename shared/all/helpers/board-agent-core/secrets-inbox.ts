import fs from 'fs/promises';
import path from 'path';

import type { SecretsInboxItem } from '../../domains/electron';
import type { AuditLog } from './audit';
import {
  decryptToRunner,
  ensureSecretsDir,
  setSecretFileWithIdentity,
  setSecretWithIdentity,
  storedSecretFiles,
  storedSecretKeys,
  unwrapIdentity
} from './host-secrets';
import { isFailedPasswordAttempt } from './password-throttle';
import type { SecretsGate } from './secrets-gate';
import type { AuditVia } from './secrets-run';
import type { WindowActor } from './secrets-window';

// Secret updates from a laptop (.specs/runner-secrets-store.md "Updating
// secrets"). The CLI encrypts the value to this runner's age recipient before
// it sends, so the server relays ciphertext only. The runner parks it in
// `<space>/secrets/inbox/` (0600) and opens the gate: a replaced value can
// redirect a deploy, so it lands only when a password holder approves. A deny,
// or 24 hours with no answer, deletes it.
//
// Values exist in plaintext only inside apply(), between age and sops. They
// are never logged, never returned, never listed.
//
// An approval never opens the unlock window, even when the answer carries
// `unlockFor`: the window covers jobs, and a password typed to accept a new
// value must not also start one.

const INBOX_DIR = 'inbox';
const EXPIRY_MS = 24 * 60 * 60_000;
/** Big enough for a whole server .env or a signing certificate. */
const MAX_CIPHERTEXT = 8 * 1024 * 1024;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const ARMOR_HEAD = '-----BEGIN AGE ENCRYPTED FILE-----';

type Meta = {
  id: string;
  key: string;
  kind: 'env' | 'file';
  byUserId: string;
  byName: string;
  at: string;
};

export type InboxSubmit = {
  submitId: string;
  key: string;
  kind: 'env' | 'file';
  ciphertext: string;
  actor: WindowActor;
};

export class SecretsInbox {
  /** Items settled in this process, so a withdrawn gate prompt that resolves
   *  as "denied" does not delete an item that was just approved. */
  private settled = new Set<string>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private opts: {
      configDir: string;
      spaceDir: string;
      gate: SecretsGate;
      audit?: AuditLog;
      now?: () => number;
      /** An update settled (approved = 'done', denied or expired = 'denied',
       *  could not be stored = 'failed'), keyed by its submit id, so the
       *  server can close the row it opened for it. */
      onEnd?: (submitId: string, state: 'done' | 'denied' | 'failed') => void;
    }
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private dir(): string {
    return path.join(this.opts.spaceDir, 'secrets', INBOX_DIR);
  }

  private files(id: string): { blob: string; meta: string } {
    if (!ID.test(id)) throw new Error('Not an inbox item id.');
    return {
      blob: path.join(this.dir(), `${id}.age`),
      meta: path.join(this.dir(), `${id}.json`)
    };
  }

  /** Park one encrypted update and open the gate for it. Resolves once it is
   *  parked, not when someone answers. */
  async submit(item: InboxSubmit): Promise<{ accepted: true }> {
    if (!ID.test(item.submitId)) throw new Error('Not a usable submit id.');
    if (!NAME.test(item.key)) {
      throw new Error('A secret needs an env-style name (letters, digits, _).');
    }
    if (item.kind !== 'env' && item.kind !== 'file') {
      throw new Error('A secret is either "env" or "file".');
    }
    const armor = item.ciphertext.trim();
    if (!armor.startsWith(ARMOR_HEAD) || armor.length > MAX_CIPHERTEXT) {
      throw new Error(
        'The update must be age armor encrypted to this runner, under 8 MB.'
      );
    }
    const { blob, meta } = this.files(item.submitId);
    try {
      await fs.access(meta);
      throw new Error('That update was already submitted.');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('That update')) {
        throw err;
      }
    }
    await ensureSecretsDir(this.opts.spaceDir);
    await fs.mkdir(this.dir(), { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir(), 0o700);
    await fs.writeFile(blob, `${armor}\n`, { mode: 0o600 });
    const record: Meta = {
      id: item.submitId,
      key: item.key,
      kind: item.kind,
      byUserId: item.actor.userId,
      byName: item.actor.name,
      at: new Date(this.now()).toISOString()
    };
    await fs.writeFile(meta, JSON.stringify(record), { mode: 0o600 });
    void this.ask(record);
    return { accepted: true };
  }

  /** Every waiting update, oldest first. Expired ones are deleted on the way. */
  async list(): Promise<SecretsInboxItem[]> {
    const names = await fs.readdir(this.dir()).catch(() => [] as string[]);
    const items: SecretsInboxItem[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const meta = await this.readMeta(name.slice(0, -'.json'.length));
      if (!meta) continue;
      if (this.now() - Date.parse(meta.at) > EXPIRY_MS) {
        this.settled.add(meta.id);
        await this.drop(meta.id);
        this.opts.gate.withdraw((r) => r.inbox?.id === meta.id);
        this.opts.onEnd?.(meta.id, 'denied');
        continue;
      }
      items.push({
        id: meta.id,
        key: meta.key,
        kind: meta.kind,
        replaces: await this.replaces(meta),
        byUserId: meta.byUserId,
        byName: meta.byName,
        at: meta.at
      });
    }
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Re-open the gate for updates parked before a restart, and start the
   *  24-hour sweep. Called once when the space comes up. */
  async resume(): Promise<void> {
    for (const item of await this.list()) {
      const meta = await this.readMeta(item.id);
      if (meta) void this.ask(meta);
    }
    this.sweeper ??= setInterval(() => void this.list(), 60 * 60_000);
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  /**
   * Answer one update from the inbox list rather than the gate prompt.
   * Approving needs the password: the unlock window covers jobs, never
   * writes. Either way the gate stops asking about it.
   */
  async answer(
    payload: {
      id: string;
      password?: string;
      approve: boolean;
      unlockFor?: number;
    },
    by: WindowActor,
    via: AuditVia
  ): Promise<{ success: boolean }> {
    const meta = await this.readMeta(payload.id);
    if (!meta) throw new Error('That update is no longer waiting.');
    if (!payload.approve) {
      await this.deny(meta, by, via);
      return { success: true };
    }
    if (!payload.password)
      throw new Error('Approving an update needs the password.');
    // Throws 'Wrong password.' before anything is touched. The guess limit is
    // in unwrapIdentity; each failure goes on the record here.
    let identity: string;
    try {
      identity = await unwrapIdentity(this.opts.configDir, payload.password);
    } catch (err) {
      await this.auditFailedPassword(err, meta, by, via);
      throw err;
    }
    // `payload.unlockFor` is ignored: approving a write never opens a job
    // window (see the class note).
    await this.apply(meta, identity, by, via);
    return { success: true };
  }

  /** One audit line per failed password attempt (wrong, or refused by the
   *  guess limit). `by` is who typed it. */
  private async auditFailedPassword(
    err: unknown,
    meta: Meta,
    by: WindowActor,
    via: AuditVia
  ): Promise<void> {
    if (!isFailedPasswordAttempt(err) || !this.opts.audit) return;
    await this.opts.audit.append({
      actor: by,
      via,
      action: 'auth-failed',
      job: null,
      keys: [meta.key],
      command: null,
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail: `${err instanceof Error ? err.message : String(err)} (secret update from ${meta.byName})`
    });
  }

  /** The gate prompt for one update, re-asked on a wrong password. */
  private async ask(meta: Meta): Promise<void> {
    const replaces = await this.replaces(meta);
    let error = '';
    for (;;) {
      const auth = await this.opts.gate.request({
        command: `${replaces ? 'Replace' : 'Add'} ${meta.kind === 'file' ? 'file secret' : 'secret'} ${meta.key}`,
        keys: [meta.key],
        origin: `Secret update from ${meta.byName}`,
        error,
        caller: { userId: meta.byUserId, name: meta.byName },
        inbox: { id: meta.id, key: meta.key, kind: meta.kind, replaces },
        queued: true
      });
      if (this.settled.has(meta.id)) return;
      if ('denied' in auth) {
        await this.deny(meta, auth.by ?? null, auth.via ?? 'data-channel');
        return;
      }
      // A window never answers a write; only jobs ride it.
      if ('windowed' in auth) continue;
      let identity: string;
      try {
        identity = await unwrapIdentity(this.opts.configDir, auth.password);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        await this.auditFailedPassword(
          err,
          meta,
          auth.by ?? { userId: '', name: 'Unknown' },
          auth.via ?? 'data-channel'
        );
        continue;
      }
      const by = auth.by ?? { userId: '', name: 'Owner' };
      const via = auth.via ?? 'data-channel';
      try {
        await this.apply(meta, identity, by, via);
      } catch (err) {
        // A value that cannot be stored (bad armor, a multi-line env value) is
        // already dropped by apply(); re-asking could never succeed. The
        // message names the key and the problem, never the value.
        console.error(
          '[inbox] could not apply an update:',
          err instanceof Error ? err.message : err
        );
        return;
      }
      // `auth.unlockFor` is ignored on purpose: approving a secret update
      // never opens a job window, whatever duration the answer carries.
      return;
    }
  }

  /** Decrypt, merge into the store (env) or blobs (file), delete the parked
   *  copy. The plaintext lives only in this function's buffers. */
  private async apply(
    meta: Meta,
    identity: string,
    by: WindowActor,
    via: AuditVia
  ): Promise<void> {
    this.settled.add(meta.id);
    const { blob } = this.files(meta.id);
    const replaces = await this.replaces(meta);
    let plain: Buffer;
    try {
      plain = await decryptToRunner(identity, blob);
    } catch (err) {
      await this.drop(meta.id);
      this.opts.gate.withdraw((r) => r.inbox?.id === meta.id);
      this.opts.onEnd?.(meta.id, 'failed');
      throw err;
    }
    let stored = false;
    try {
      if (meta.kind === 'env') {
        // A value piped from a file ends in one newline nobody meant.
        const value = plain.toString('utf-8').replace(/\r?\n$/, '');
        if (value.includes('\n')) {
          throw new Error(
            `${meta.key} has more than one line; send it as a file secret.`
          );
        }
        await setSecretWithIdentity(
          this.opts.configDir,
          this.opts.spaceDir,
          identity,
          meta.key,
          value
        );
      } else {
        await setSecretFileWithIdentity(
          this.opts.configDir,
          this.opts.spaceDir,
          identity,
          meta.key,
          plain
        );
      }
      stored = true;
    } finally {
      plain.fill(0);
      await this.drop(meta.id);
      this.opts.gate.withdraw((r) => r.inbox?.id === meta.id);
      this.opts.onEnd?.(meta.id, stored ? 'done' : 'failed');
    }
    await this.opts.audit?.append({
      actor: { userId: meta.byUserId, name: meta.byName },
      via,
      action: 'secret-set',
      job: null,
      keys: [meta.key],
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail: `inbox ${meta.kind}${replaces ? ' (replaced)' : ''}; approved by ${by.name}`
    });
  }

  private async deny(
    meta: Meta,
    by: WindowActor | null,
    via: AuditVia
  ): Promise<void> {
    this.settled.add(meta.id);
    await this.drop(meta.id);
    this.opts.gate.withdraw((r) => r.inbox?.id === meta.id);
    this.opts.onEnd?.(meta.id, 'denied');
    await this.opts.audit?.append({
      actor: by ?? { userId: meta.byUserId, name: meta.byName },
      via,
      action: 'denied',
      job: null,
      keys: [meta.key],
      exitCode: null,
      durationMs: null,
      unlockedBy: null,
      detail: `inbox ${meta.kind} from ${meta.byName}`
    });
  }

  private async replaces(meta: Meta): Promise<boolean> {
    const names =
      meta.kind === 'env'
        ? await storedSecretKeys(this.opts.spaceDir)
        : await storedSecretFiles(this.opts.spaceDir);
    return names.includes(meta.key);
  }

  private async readMeta(id: string): Promise<Meta | null> {
    if (!ID.test(id)) return null;
    const raw = await fs.readFile(this.files(id).meta, 'utf-8').catch(() => '');
    if (!raw) return null;
    try {
      const meta = JSON.parse(raw) as Meta;
      return meta.id === id && NAME.test(meta.key) ? meta : null;
    } catch {
      return null;
    }
  }

  /** Delete the parked copy: overwrite the ciphertext, then remove both. */
  private async drop(id: string): Promise<void> {
    const { blob, meta } = this.files(id);
    const size = (await fs.stat(blob).catch(() => null))?.size ?? 0;
    if (size)
      await fs.writeFile(blob, Buffer.alloc(size)).catch(() => undefined);
    await fs.rm(blob, { force: true });
    await fs.rm(meta, { force: true });
  }

  destroy(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}
