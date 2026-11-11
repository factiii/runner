import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import type { RunnerVaultKeyStatus, RunnerVaultKeyState, RunnerVaultNewKey } from '@shared/all/domains/electron';
import {
  normalizeVaultKey,
  VAULT_KEY_PENDING_MS,
  VAULT_LOCK_IDLE_MINUTES,
  VAULT_LOCKED,
  type VaultKeyConfirmInput,
  type VaultUnlockInput
} from '@shared/all/validators';

import { type KdfCost, newMasterKey, newVaultPassphrase, VAULT_KDF, wipe } from './crypto';
import { createKeyring, type Keyring, readKeyring, rekeyed, SLOT_KEYRING, unwrapWithVaultKey, writeKeyring } from './keyring';
import { recoverSeal, type SealOptions, sealPaths, sealVault } from './sealMigration';

// The Vault's key as the runner holds it (.specs/vault.md "Encryption and
// the Vault key"): plain (not set up), locked, or unlocked with the master
// key in this process's memory only. Unlocking takes the owner's Vault key
// over the direct link (the daemon refuses every vault action on the relay
// before this sees it); the Vault locks after its idle minutes with no vault
// activity, flushing its database first.
//
// A new Vault key (at setup, or a change) is made here and held in memory
// until the owner sends it back: what they saved in their password manager,
// filled or typed. Only then is the Vault sealed under it, or the master key
// re-wrapped, so no Vault is ever locked under a key nobody kept.

export const VAULT_SEALING = 'Your Vault is being encrypted. Try again in a moment.';
export const NOT_SEALED = 'Your Vault is not encrypted yet. Turn encryption on first.';
export const ALREADY_SEALED = 'Your Vault is already encrypted.';
export const NO_PENDING_KEY = 'That new Vault key is no longer waiting here. Start again for a new one.';
export const KEY_NOT_SAVED =
  'That is not the new Vault key shown. Fill it from your password manager, or copy it again.';

type Pending = { id: string; kind: 'setup' | 'change'; canonical: string; expiresAt: number };

/** Where the Vault's key is, one state at a time. `broken`: a key file this
 *  runner does not read; it stays sealed, nothing falls back to plaintext. */
type Held =
  | { kind: 'plain' }
  | { kind: 'sealing' }
  | { kind: 'locked'; keyring: Keyring }
  | { kind: 'unlocked'; keyring: Keyring; vk: Buffer }
  | { kind: 'broken'; problem: string };

/** The moves `move` allows. A broken Vault goes nowhere. */
const MOVES: Record<Held['kind'], readonly Held['kind'][]> = {
  plain: ['sealing'],
  sealing: ['plain', 'unlocked'],
  locked: ['locked', 'unlocked'],
  unlocked: ['unlocked', 'locked'],
  broken: []
};

export type VaultKeysOptions = {
  /** `parts/vault`. */
  root: string;
  /** Flush and close the Vault's database and drop what holds the key,
   *  before the key is dropped. A throw keeps the Vault unlocked. */
  onLock: () => Promise<void>;
  /** The key is in memory now (read who is let in, kick the ingest). */
  onUnlock?: () => void;
  /** Encrypting a plaintext Vault: its database's dump and the check. */
  seal: Pick<SealOptions, 'dumpPlain' | 'verifyDump'> & {
    /** Stop serving and close the plaintext database first. */
    before: () => Promise<void>;
  };
  now?: () => number;
  /** For the tests: the idle lock in ms instead of the setting's minutes. */
  idleMs?: number;
  /** For the tests: a light scrypt instead of VAULT_KDF. */
  kdf?: KdfCost;
  log?: (line: string) => void;
};

export class VaultKeys {
  private held: Held = { kind: 'plain' };
  private idleTimer: NodeJS.Timeout | null = null;
  private pending: Pending | null = null;
  /** One scrypt at a time: each takes 128 MiB. */
  private deriving: Promise<unknown> = Promise.resolve();
  private readonly paths;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: VaultKeysOptions) {
    this.paths = sealPaths(options.root);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(`[vault] ${line}`));
    // A migration a crash cut short is finished or undone before anything
    // reads the Vault.
    const recovered = recoverSeal(this.paths);
    if (recovered !== 'none') this.log(`An interrupted encryption was ${recovered === 'rolled-forward' ? 'finished' : 'undone'}.`);
    try {
      const read = readKeyring(this.paths.keys);
      if (read === 'slots') this.held = { kind: 'broken', problem: SLOT_KEYRING };
      else if (read) this.held = { kind: 'locked', keyring: read };
    } catch (err) {
      this.held = { kind: 'broken', problem: err instanceof Error ? err.message : String(err) };
    }
    if (this.held.kind === 'broken') this.log(this.held.problem);
  }

  /** The one place the held state changes; a move MOVES does not allow is
   *  a bug, and throws. */
  private move(next: Held): void {
    if (!MOVES[this.held.kind].includes(next.kind)) {
      throw new Error(`The Vault cannot go from ${this.held.kind} to ${next.kind}.`);
    }
    this.held = next;
  }

  private get keyring(): Keyring | null {
    return this.held.kind === 'locked' || this.held.kind === 'unlocked' ? this.held.keyring : null;
  }

  private get problem(): string | null {
    return this.held.kind === 'broken' ? this.held.problem : null;
  }

  state(): RunnerVaultKeyState {
    if (this.held.kind === 'unlocked') return 'unlocked';
    return this.sealed() ? 'locked' : 'plain';
  }

  /** Encrypted at rest (locked or not). */
  sealed(): boolean {
    return this.held.kind !== 'plain' && this.held.kind !== 'sealing';
  }

  /** Encrypting now: nothing is served from the Vault. */
  busy(): boolean {
    return this.held.kind === 'sealing';
  }

  /** The master key, or VAULT_LOCKED. */
  key(): Buffer {
    const held = this.held;
    if (held.kind === 'broken') throw new Error(held.problem);
    if (held.kind !== 'unlocked') throw new Error(held.kind === 'sealing' ? VAULT_SEALING : VAULT_LOCKED);
    return held.vk;
  }

  /** Vault activity: the idle lock starts again. */
  touch(): void {
    if (this.held.kind !== 'unlocked') return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ms = this.options.idleMs ?? this.held.keyring.lockIdleMinutes * 60_000;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.lock().catch((err: unknown) => {
        this.log(`The Vault did not lock: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, ms);
    this.idleTimer.unref();
  }

  status(): RunnerVaultKeyStatus {
    return {
      state: this.state(),
      vaultId: this.keyring?.vaultId ?? null,
      lockIdleMinutes: this.keyring?.lockIdleMinutes ?? VAULT_LOCK_IDLE_MINUTES,
      keySetAt: this.keyring?.keySetAt ?? null,
      problem: this.problem
    };
  }

  /** A new keyring on disk, the key (if any) kept as it is. */
  private save(keyring: Keyring): void {
    writeKeyring(this.paths.keys, keyring);
    this.move(this.held.kind === 'unlocked' ? { ...this.held, keyring } : { kind: 'locked', keyring });
  }

  private unlocked(keyring: Keyring, vk: Buffer): void {
    if (this.held.kind === 'unlocked' && this.held.vk !== vk) wipe(this.held.vk);
    this.move({ kind: 'unlocked', keyring, vk });
    this.touch();
    this.options.onUnlock?.();
  }

  /** Run a key derivation after the one before it. */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.deriving.then(run, run);
    this.deriving = next.catch(() => undefined);
    return next;
  }

  /** The master key from a Vault key (WRONG_VAULT_KEY if it is not it). */
  private open(vaultKey: string): Promise<Buffer> {
    const keyring = this.keyring;
    if (this.problem) throw new Error(this.problem);
    if (!keyring) throw new Error(NOT_SEALED);
    return this.serial(() => unwrapWithVaultKey(keyring, vaultKey));
  }

  /** A new Vault key, held until `confirmed` sees it back. */
  private newPending(kind: Pending['kind']): RunnerVaultNewKey {
    const vaultKey = newVaultPassphrase();
    const canonical = normalizeVaultKey(vaultKey);
    if (!canonical) throw new Error('The new Vault key did not form.');
    const expiresAt = this.now() + VAULT_KEY_PENDING_MS;
    this.pending = { id: randomUUID(), kind, canonical, expiresAt };
    return { pendingId: this.pending.id, vaultKey, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** The waiting key this confirms, or a throw. It stays waiting until the
   *  step it is for succeeds, so a failed setup can be tried again. */
  private confirmed(kind: Pending['kind'], input: VaultKeyConfirmInput): Pending {
    const pending = this.pending;
    if (!pending || pending.kind !== kind || pending.id !== input.pendingId || pending.expiresAt <= this.now()) {
      throw new Error(NO_PENDING_KEY);
    }
    if (normalizeVaultKey(input.vaultKey) !== pending.canonical) throw new Error(KEY_NOT_SAVED);
    return pending;
  }

  /** Turn encryption on, step one: a new Vault key to save. Nothing on
   *  disk changes. */
  setupStart(): RunnerVaultNewKey {
    if (this.sealed()) throw new Error(this.problem ?? ALREADY_SEALED);
    if (this.busy()) throw new Error(VAULT_SEALING);
    return this.newPending('setup');
  }

  /** Step two, with the key sent back: a new master key, wrapped under the
   *  Vault key, and a plaintext Vault encrypted in place. */
  async setup(input: VaultKeyConfirmInput): Promise<RunnerVaultKeyStatus> {
    if (this.sealed()) throw new Error(this.problem ?? ALREADY_SEALED);
    if (this.busy()) throw new Error(VAULT_SEALING);
    const pending = this.confirmed('setup', input);
    this.move({ kind: 'sealing' });
    const vk = newMasterKey();
    let keyring: Keyring;
    try {
      keyring = await this.serial(() => createKeyring(vk, pending.canonical, this.options.kdf ?? VAULT_KDF));
      await this.options.seal.before();
      await sealVault({
        paths: this.paths,
        vk,
        keyring,
        dumpPlain: this.options.seal.dumpPlain,
        verifyDump: this.options.seal.verifyDump
      });
    } catch (err) {
      wipe(vk);
      this.move({ kind: 'plain' });
      throw err;
    }
    this.pending = null;
    this.log('The Vault is encrypted.');
    this.unlocked(keyring, vk);
    return this.status();
  }

  async unlock(input: VaultUnlockInput): Promise<RunnerVaultKeyStatus> {
    const vk = await this.open(input.vaultKey);
    // Another unlock got there first: its key stays.
    if (this.held.kind === 'unlocked') wipe(vk);
    else if (this.held.kind === 'locked') this.unlocked(this.held.keyring, vk);
    else wipe(vk);
    this.touch();
    return this.status();
  }

  /** Flush and close the database, then drop the key. */
  async lock(): Promise<RunnerVaultKeyStatus> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.held.kind !== 'unlocked') return this.status();
    await this.options.onLock();
    // Read again after the await: a change may have saved a new keyring.
    const held = this.held;
    if (held.kind !== 'unlocked') return this.status();
    wipe(held.vk);
    this.move({ kind: 'locked', keyring: held.keyring });
    this.log('The Vault is locked.');
    return this.status();
  }

  settings(lockIdleMinutes: number): RunnerVaultKeyStatus {
    if (this.problem) throw new Error(this.problem);
    if (!this.keyring) throw new Error(NOT_SEALED);
    this.save({ ...this.keyring, lockIdleMinutes });
    this.touch();
    return this.status();
  }

  /** Change the Vault key, step one: a new key to save. Locked, the current
   *  key is needed (and unlocks); unlocked, the owner is already here. */
  async changeStart(input: { vaultKey?: string }): Promise<RunnerVaultNewKey> {
    if (this.held.kind !== 'unlocked') {
      if (!input.vaultKey) this.key();
      else await this.unlock({ vaultKey: input.vaultKey });
    }
    this.key();
    this.touch();
    return this.newPending('change');
  }

  /** Step two: the master key wrapped under the new key alone. Nothing is
   *  re-encrypted; the old key opens nothing from now on. */
  async change(input: VaultKeyConfirmInput): Promise<RunnerVaultKeyStatus> {
    const pending = this.confirmed('change', input);
    const vk = this.key();
    const keyring = this.keyring;
    if (!keyring) throw new Error(NOT_SEALED);
    this.save(await this.serial(() => rekeyed(keyring, vk, pending.canonical, this.options.kdf ?? VAULT_KDF)));
    this.pending = null;
    this.log('The Vault key was changed.');
    this.touch();
    return this.status();
  }

  /** The keyring file exists on disk (for the daemon's reads). */
  static sealedAt(root: string): boolean {
    return fs.existsSync(sealPaths(root).keys);
  }
}
