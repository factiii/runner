import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import type { AuditEntry } from '../../domains/electron';

// The runner's own record of what it did with the secrets store
// (.specs/runner-secrets-gate.md "Audit log"). One JSON line per action in
// `<spaceDir>/audit.jsonl` - `~/.factiii-runner/<space>/audit.jsonl` on a
// runner - append-only and 0600. The runner is the source of truth because it
// is where each action executes; the server keeps its own row per forwarded
// call, and a call in one log with no line in the other is a finding.
//
// `prev` is the sha256 of the previous line exactly as written, so an edited,
// reordered or deleted line breaks the chain from that point on. It does not
// stop the runner user rewriting the whole file - nothing local can - but it
// does stop a quiet one-line edit.
//
// Never a value, the password, or a decrypted file path. Callers pass names;
// this module has no way to receive anything else.

export type { AuditEntry };

/** What a caller supplies; `ts` and `prev` are the log's to set. */
export type AuditRecord = Omit<AuditEntry, 'ts' | 'prev' | 'command'> & {
  command?: string | null;
};

const FILE = 'audit.jsonl';
/** `prev` of the first line: there is nothing before it to hash. */
const GENESIS = '0'.repeat(64);

const sha256 = (line: string) =>
  crypto.createHash('sha256').update(line).digest('hex');

export function auditPath(spaceDir: string): string {
  return path.join(spaceDir, FILE);
}

export type AuditQuery = {
  limit?: number;
  beforeTs?: string;
  actorUserId?: string;
  job?: string;
  key?: string;
};

export class AuditLog {
  /** Appends are serialised: each line hashes the one before it, so two
   *  concurrent writers reading the same tail would fork the chain. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Hash of the last line written, once read. Saves a file read per line. */
  private lastHash: string | null = null;

  constructor(
    private spaceDir: string,
    private now: () => Date = () => new Date()
  ) {}

  private file(): string {
    return auditPath(this.spaceDir);
  }

  /** Append one line. Never throws at the caller: a failed audit write must
   *  not turn a finished deploy into a failed one. It is reported instead. */
  append(record: AuditRecord): Promise<void> {
    const write = this.tail.then(() => this.write(record));
    this.tail = write.catch((err: unknown) => {
      console.error(
        '[audit] could not write the audit log:',
        err instanceof Error ? err.message : err
      );
    });
    return this.tail as Promise<void>;
  }

  private async write(record: AuditRecord): Promise<void> {
    const prev = this.lastHash ?? (await this.readLastHash());
    const entry: AuditEntry = {
      ts: this.now().toISOString(),
      actor: { userId: record.actor.userId, name: record.actor.name },
      via: record.via,
      action: record.action,
      job: record.job ?? null,
      keys: [...record.keys],
      command: record.command ?? null,
      exitCode: record.exitCode ?? null,
      durationMs: record.durationMs ?? null,
      unlockedBy: record.unlockedBy ?? null,
      ...(record.detail ? { detail: record.detail } : {}),
      prev
    };
    const line = JSON.stringify(entry);
    await fs.mkdir(this.spaceDir, { recursive: true });
    // 'a' opens O_APPEND: the kernel places every write at the end, so even a
    // second process cannot overwrite an existing line.
    await fs.appendFile(this.file(), `${line}\n`, { mode: 0o600 });
    // appendFile applies the mode only on create; tighten a pre-existing file.
    await fs.chmod(this.file(), 0o600).catch(() => undefined);
    this.lastHash = sha256(line);
  }

  private async readLastHash(): Promise<string> {
    const lines = await this.lines();
    return lines.length ? sha256(lines[lines.length - 1]) : GENESIS;
  }

  private async lines(): Promise<string[]> {
    const raw = await fs.readFile(this.file(), 'utf-8').catch(() => '');
    return raw.split('\n').filter((l) => l.length > 0);
  }

  /** Start over: the current file is renamed to `audit.cleared-<ts>.jsonl`
   *  beside it (0600, kept, never deleted) and the new log opens with an
   *  `audit-clear` line naming who cleared it. A clear is itself on the
   *  record, and the old chain can still be read and verified on the runner.
   *  Queued behind any pending append, so no line lands in the moved file
   *  after the count. */
  clear(
    actor: AuditEntry['actor'],
    via: AuditEntry['via']
  ): Promise<{ cleared: number }> {
    const run = this.tail.then(async () => {
      const lines = await this.lines();
      const stamp = this.now().toISOString().replace(/[:.]/g, '-');
      const kept = `audit.cleared-${stamp}.jsonl`;
      if (lines.length > 0) {
        await fs.rename(this.file(), path.join(this.spaceDir, kept));
      }
      this.lastHash = null;
      await this.write({
        actor,
        via,
        action: 'audit-clear',
        job: null,
        keys: [],
        exitCode: null,
        durationMs: null,
        unlockedBy: null,
        detail:
          lines.length > 0
            ? `Cleared ${lines.length} entries; kept on the runner as ${kept}`
            : 'Cleared an empty log'
      });
      return { cleared: lines.length };
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Newest first, filtered. `chainIntact` covers the WHOLE file, not only the
   *  page returned: a break outside the page is still a break. */
  async read(query: AuditQuery = {}): Promise<{
    entries: AuditEntry[];
    chainIntact: boolean;
    firstBrokenTs: string | null;
  }> {
    // Wait for queued writes, so a read right after an action sees it.
    await this.tail;
    const lines = await this.lines();
    let { intact, firstBrokenTs } = verifyChain(lines);
    // No later line hashes the newest one, so the chain alone cannot see it
    // edited. This process knows what it last wrote; a mismatch is a break.
    const last = lines[lines.length - 1];
    if (intact && last && this.lastHash && sha256(last) !== this.lastHash) {
      intact = false;
      firstBrokenTs = parseLine(last)?.ts ?? null;
    }

    const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
    const entries: AuditEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i -= 1) {
      const entry = parseLine(lines[i]);
      if (!entry) continue;
      if (query.beforeTs && !(entry.ts < query.beforeTs)) continue;
      if (query.actorUserId && entry.actor.userId !== query.actorUserId) {
        continue;
      }
      if (query.job && entry.job !== query.job) continue;
      if (query.key && !entry.keys.includes(query.key)) continue;
      entries.push(entry);
    }
    return { entries, chainIntact: intact, firstBrokenTs };
  }
}

function parseLine(line: string): AuditEntry | null {
  try {
    const parsed = JSON.parse(line) as AuditEntry;
    return parsed && typeof parsed.ts === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Walk the chain. The first line must point at the genesis hash and every
 * later one at the hash of the line before it.
 *
 * A mismatch at line N+1 means line N no longer hashes to what N+1 recorded,
 * so line N is the one that changed (or a line after it was deleted): that is
 * the line reported, by its `ts`, as Runner Settings' "first broken line". A
 * first line that does not point at genesis, or a line that is not JSON, is
 * reported itself (the previous line's ts, for unparseable text).
 */
function verifyChain(lines: string[]): {
  intact: boolean;
  firstBrokenTs: string | null;
} {
  let expected = GENESIS;
  let lastTs: string | null = null;
  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry) return { intact: false, firstBrokenTs: lastTs };
    if (entry.prev !== expected) {
      return { intact: false, firstBrokenTs: lastTs ?? entry.ts };
    }
    expected = sha256(line);
    lastTs = entry.ts;
  }
  return { intact: true, firstBrokenTs: null };
}
