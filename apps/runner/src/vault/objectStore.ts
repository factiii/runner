import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  VaultObjectHead,
  VaultObjectListing,
  VaultObjectStore,
  VaultPresignedUpload
} from '@shared/all/domains/vaultStore';

// The Vault's file store: the R2 verbs (shared/all/domains/vaultStore.ts) on
// the runner's own disk, `<runner dir>/vault/objects`.
//
// An object is a file named by the SHA-256 of its key, with a JSON sidecar
// holding the key, type, size and hash. So a key is only ever data: no key
// names a path, whatever the client put in a file name.
//
// A "signed URL" is a ticket: `runner-vault:put?…` or `runner-vault:get?…`
// (Runner Storage's start `runner-storage:` instead),
// with the key, size and expiry signed with HMAC-SHA256 under a key made when
// the process starts and never written down. A device redeems it over its
// direct link (`vaultWrite`, `vaultRead`); nothing listens on a port. A
// restart voids every ticket, as a presign's expiry would.

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_EXPIRES_S = 900;
const TICKET_SCHEME = 'runner-vault:';
/** Runner Storage's tickets (.specs/runner-vault.md "Two stores"): another
 *  scheme, so the daemon hands a ticket to the store that signed it, and a
 *  ticket of one store never redeems in the other. */
export const RUNNER_STORAGE_TICKET_SCHEME = 'runner-storage:';

/** The store that signed a ticket, by its scheme. */
export const ticketStore = (ticket: string): 'vault' | 'runner' =>
  ticket.startsWith(RUNNER_STORAGE_TICKET_SCHEME) ? 'runner' : 'vault';

type Meta = {
  key: string;
  size: number;
  contentType: string;
  sha256: string;
  lastModified: string;
};

type Ticket =
  | { op: 'put'; key: string; contentType: string; size: number; expires: number }
  | { op: 'get'; key: string; expires: number; attachmentName: string };

const b64url = (text: string) => Buffer.from(text).toString('base64url');
const unb64url = (text: string) => Buffer.from(text, 'base64url').toString();

export class FsObjectStore implements VaultObjectStore {
  private readonly secret = randomBytes(32);

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
    /** The tickets' scheme: the Vault's, or Runner Storage's. */
    private readonly scheme: string = TICKET_SCHEME
  ) {}

  private file(key: string): string {
    return path.join(this.root, createHash('sha256').update(key).digest('hex'));
  }

  private ensureRoot(): void {
    fs.mkdirSync(this.root, { recursive: true, mode: DIR_MODE });
  }

  private readMeta(key: string): Meta | null {
    try {
      const meta = JSON.parse(fs.readFileSync(`${this.file(key)}.json`, 'utf-8')) as Meta;
      return meta.key === key && fs.existsSync(this.file(key)) ? meta : null;
    } catch {
      return null;
    }
  }

  private toHead(meta: Meta): VaultObjectHead {
    return { ...meta, lastModified: new Date(meta.lastModified) };
  }

  /** Move a finished part into place and write its sidecar. */
  private commit(key: string, part: string, contentType: string): VaultObjectHead {
    const hash = createHash('sha256');
    const fd = fs.openSync(part, 'r');
    const buffer = Buffer.alloc(1 << 20);
    let size = 0;
    try {
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (read === 0) break;
        hash.update(buffer.subarray(0, read));
        size += read;
      }
    } finally {
      fs.closeSync(fd);
    }
    const meta: Meta = {
      key,
      size,
      contentType,
      sha256: hash.digest('hex'),
      lastModified: new Date(this.now()).toISOString()
    };
    fs.renameSync(part, this.file(key));
    fs.writeFileSync(`${this.file(key)}.json`, JSON.stringify(meta), { mode: FILE_MODE });
    return this.toHead(meta);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<VaultObjectHead> {
    this.ensureRoot();
    const part = `${this.file(key)}.part`;
    fs.writeFileSync(part, bytes, { mode: FILE_MODE });
    return this.commit(key, part, contentType);
  }

  async get(key: string): Promise<Uint8Array> {
    if (!this.readMeta(key)) throw new Error(`Object ${key} not found`);
    return fs.readFileSync(this.file(key));
  }

  async getRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    const meta = this.readMeta(key);
    if (!meta) throw new Error(`Object ${key} not found`);
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
      throw new Error('Bad range.');
    }
    const end = Math.min(meta.size, offset + length);
    const buffer = Buffer.alloc(Math.max(0, end - offset));
    if (buffer.length === 0) return buffer;
    const fd = fs.openSync(this.file(key), 'r');
    try {
      fs.readSync(fd, buffer, 0, buffer.length, offset);
    } finally {
      fs.closeSync(fd);
    }
    return buffer;
  }

  async head(key: string): Promise<VaultObjectHead | null> {
    const meta = this.readMeta(key);
    return meta ? this.toHead(meta) : null;
  }

  async list(prefix: string): Promise<VaultObjectListing[]> {
    if (!fs.existsSync(this.root)) return [];
    const out: VaultObjectListing[] = [];
    for (const name of fs.readdirSync(this.root)) {
      if (!name.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.root, name), 'utf-8')) as Meta;
        if (!meta.key.startsWith(prefix)) continue;
        out.push({ key: meta.key, size: meta.size, lastModified: new Date(meta.lastModified) });
      } catch {
        // A sidecar cut short by a crash names nothing.
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async delete(key: string): Promise<boolean> {
    try {
      for (const file of [this.file(key), `${this.file(key)}.json`, `${this.file(key)}.part`]) {
        fs.rmSync(file, { force: true });
      }
      return true;
    } catch {
      return false;
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) await this.delete(key);
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  private ticket(op: 'put' | 'get', fields: Record<string, string>): string {
    const body = `${op}?${new URLSearchParams(fields).toString()}`;
    return `${this.scheme}${body}&s=${this.sign(body)}`;
  }

  /** The ticket's fields, or a refusal. Expiry is the caller's to check: a
   *  write is held to it only when it starts, as a PUT that began in time. */
  private redeem(url: string): Ticket {
    const refused = new Error('This file link is not valid on this runner.');
    if (!url.startsWith(this.scheme)) throw refused;
    const body = url.slice(this.scheme.length);
    const at = body.lastIndexOf('&s=');
    if (at < 0) throw refused;
    const signed = body.slice(0, at);
    const given = Buffer.from(body.slice(at + 3));
    const expected = Buffer.from(this.sign(signed));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw refused;
    const [op, query] = [signed.slice(0, signed.indexOf('?')), signed.slice(signed.indexOf('?') + 1)];
    const params = new URLSearchParams(query);
    const key = unb64url(params.get('k') ?? '');
    const expires = Number(params.get('e'));
    if (op === 'put') {
      return {
        op,
        key,
        contentType: unb64url(params.get('t') ?? ''),
        size: Number(params.get('n')),
        expires
      };
    }
    if (op === 'get') {
      return { op, key, expires, attachmentName: unb64url(params.get('a') ?? '') };
    }
    throw refused;
  }

  async presignPut(
    key: string,
    contentType: string,
    sizeBytes: number,
    maxSizeBytes: number,
    expiresInS = DEFAULT_EXPIRES_S
  ): Promise<VaultPresignedUpload> {
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0) throw new Error('Bad size.');
    if (sizeBytes > maxSizeBytes) {
      throw new Error(`Upload of ${sizeBytes} bytes exceeds the ${maxSizeBytes} byte limit`);
    }
    const url = this.ticket('put', {
      k: b64url(key),
      t: b64url(contentType),
      n: String(sizeBytes),
      e: String(this.now() + expiresInS * 1000)
    });
    return {
      method: 'PUT',
      url,
      headers: { 'Content-Type': contentType, 'Content-Length': String(sizeBytes) }
    };
  }

  async presignGet(
    key: string,
    expiresInS = DEFAULT_EXPIRES_S,
    attachmentName?: string
  ): Promise<string> {
    return this.ticket('get', {
      k: b64url(key),
      e: String(this.now() + expiresInS * 1000),
      a: b64url(attachmentName ?? '')
    });
  }

  /**
   * Append one range of a signed write. `offset` must be what has arrived so
   * far (0 starts over); the bytes may never pass the signed size, and the
   * last range must end on it. Then the object is stored whole, and only
   * then: a write that fails at any point leaves nothing behind.
   */
  writeSigned(
    url: string,
    offset: number,
    bytes: Uint8Array,
    last: boolean,
    /** Checked before a byte is written: whose key the caller may fill. */
    mayWrite: (key: string) => boolean = () => true
  ): { key: string; received: number; head: VaultObjectHead | null } {
    const ticket = this.redeem(url);
    if (ticket.op !== 'put') throw new Error('This file link is not for writing.');
    if (!mayWrite(ticket.key)) throw new Error('This file link is not yours.');
    const part = `${this.file(ticket.key)}.part`;
    const drop = (message: string): never => {
      fs.rmSync(part, { force: true });
      throw new Error(message);
    };
    if (offset === 0) {
      if (this.now() > ticket.expires) throw new Error('This file link has expired.');
      this.ensureRoot();
      fs.writeFileSync(part, new Uint8Array(0), { mode: FILE_MODE });
    }
    const have = fs.existsSync(part) ? fs.statSync(part).size : -1;
    if (have !== offset) drop('The upload lost its place. Start it again.');
    if (offset + bytes.length > ticket.size) drop('The upload is bigger than it said.');
    fs.appendFileSync(part, bytes);
    const received = offset + bytes.length;
    if (!last) return { key: ticket.key, received, head: null };
    if (received !== ticket.size) drop('The upload is smaller than it said.');
    return {
      key: ticket.key,
      received,
      head: this.commit(ticket.key, part, ticket.contentType)
    };
  }

  /** One range of the object a signed read names. */
  async readSigned(
    url: string,
    offset: number,
    length: number
  ): Promise<{ key: string; bytes: Uint8Array; attachmentName: string }> {
    const ticket = this.redeem(url);
    if (ticket.op !== 'get') throw new Error('This file link is not for reading.');
    if (this.now() > ticket.expires) throw new Error('This file link has expired.');
    return {
      key: ticket.key,
      bytes: await this.getRange(ticket.key, offset, length),
      attachmentName: ticket.attachmentName
    };
  }
}
