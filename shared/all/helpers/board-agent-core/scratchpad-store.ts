// The host side of a space's scratchpad: a flat directory an agent writes into
// and the terminal window's right-hand panel draws. See .specs/scratchpad.md.
//
// Shell commands rather than `fs`, like every other file op in this tree: this
// module compiles under the web and mobile tsconfigs too, which have no
// business resolving node builtins.

import type { ScratchpadItem } from '../../domains/electron';
import {
  isSafeScratchpadName,
  SCRATCHPAD_CHUNK_BYTES,
  SCRATCHPAD_MAX_BYTES,
  SCRATCHPAD_MAX_ITEMS,
  scratchpadKind
} from '../scratchpad';
import { WorkspaceWatcher } from '../terminal-ai/watcher';
import type { ExecTarget } from './exec';

function shEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `stat` has no portable format string: GNU spells it `-c`, BSD `-f`, and the
 *  runner has to serve both. Try BSD first (macOS is the common host), fall
 *  through to GNU. */
const STAT_META = `stat -f '%m %z' "$f" 2>/dev/null || stat -c '%Y %s' "$f" 2>/dev/null`;

/** Written by the read script and matched on the way back out, so the panel
 *  shows the reason rather than a shell's exit code. */
const TOO_LARGE = 'Scratchpad item is too large to open here.';

export class ScratchpadStore {
  private watcher: WorkspaceWatcher | null = null;

  /**
   * @param target Resolved per call, never held: the space's exec target is
   *               rebuilt as the space provisions, and a captured one would go
   *               on pointing at the tree it was built for.
   * @param emit   Tells connected clients the directory moved. Carries a
   *               timestamp only: the panel refetches the whole listing.
   */
  constructor(
    private target: () => ExecTarget,
    private emit: (payload: { at: number }) => void
  ) {}

  private dir(): string {
    return this.target().paths.scratchpad;
  }

  /**
   * Everything on the scratchpad, newest first.
   *
   * Dotfiles are skipped: the panel is a display surface, and `.DS_Store` is
   * not something anyone drew. So are subdirectories: the scratchpad is flat,
   * which is what lets a name be an id everywhere else in this file.
   */
  async list(): Promise<ScratchpadItem[]> {
    const dir = this.dir();
    // Not caught: a scratchpad that cannot be read is an error the panel has a
    // slot for, and reporting it as "nothing drawn yet" would be a lie.
    const out = await this.target().run([
      'sh',
      '-c',
      `mkdir -p ${shEscape(dir)} && cd ${shEscape(dir)} && for f in *; do
          [ -f "$f" ] || continue
          meta=$(${STAT_META}) || continue
          echo "$meta $f"
        done | LC_ALL=C sort -rn | head -n ${SCRATCHPAD_MAX_ITEMS}`
    ]);
    // After the run, not before: that shell is what creates the directory, and
    // subscribing to one that does not exist yet throws — which used to kill
    // the watcher permanently, so a board's first list left it on manual
    // refresh for the life of the runner. Started on first list rather than at
    // construction so a space nobody has opened a panel on holds no handles.
    this.startWatching();

    const items: ScratchpadItem[] = [];
    for (const line of out.split('\n')) {
      // `<mtime> <size> <name>`, name last because it is the only field that
      // can hold a space. A name holding a newline cannot be parsed back out
      // of this and is dropped: `isSafeScratchpadName` rejects it anyway.
      const match = /^(\d+) (\d+) (.+)$/.exec(line);
      if (!match) continue;
      const [, mtime, size, name] = match;
      if (!isSafeScratchpadName(name)) continue;
      const bytes = Number(size);
      items.push({
        name,
        kind: scratchpadKind(name),
        size: bytes,
        // stat reports seconds; every other timestamp on the wire is ms.
        modifiedAt: Number(mtime) * 1000,
        tooLarge: bytes > SCRATCHPAD_MAX_BYTES
      });
    }
    return items;
  }

  /**
   * One item's bytes, base64. Capped: past SCRATCHPAD_MAX_BYTES the panel is
   * told to show the path instead, so a 4GB screen recording cannot pin the
   * data channel for minutes.
   *
   * One shell, not a size check and then a read: the panel opens every card at
   * once, so a second spawn per item is a doubled cost on the whole listing -
   * and a file that changed between the two calls would have been read past
   * the cap anyway.
   */
  async read(name: string): Promise<{ content: string; encoding: 'base64' }> {
    const file = shEscape(this.resolve(name));
    const content = await this.target()
      .sh(
        // Unquoted `$(wc -c)` on purpose: BSD wc pads its count with spaces,
        // which `[ -gt ]` will not parse. `base64 -w 0` is GNU-only (BSD
        // spells it -b), so unwrap with tr rather than asking it not to wrap.
        `[ -f ${file} ] || exit 1
         if [ $(wc -c < ${file}) -gt ${SCRATCHPAD_MAX_BYTES} ]; then
           echo '${TOO_LARGE}' >&2; exit 1
         fi
         base64 < ${file} | tr -d '\n'`
      )
      .catch((err: unknown) => {
        const text = err instanceof Error ? err.message : '';
        throw new Error(
          text.includes(TOO_LARGE) ? TOO_LARGE : 'Could not read that item.'
        );
      });
    return { content: content.trim(), encoding: 'base64' };
  }

  /**
   * One byte range of an item, base64. What a download is built out of.
   *
   * No size cap here, unlike `read`: the cap exists because a preview holds
   * the whole file in one message, and a range does not. `tail | head` rather
   * than `dd`, which needs a GNU-only flag to promise a full block over a pipe.
   */
  async readChunk(
    name: string,
    offset: number,
    length: number
  ): Promise<{ content: string; encoding: 'base64' }> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('Invalid scratchpad offset.');
    }
    if (
      !Number.isInteger(length) ||
      length <= 0 ||
      length > SCRATCHPAD_CHUNK_BYTES
    ) {
      throw new Error('Invalid scratchpad chunk length.');
    }
    const file = shEscape(this.resolve(name));
    const content = await this.target()
      .sh(
        // `tail -c +N` counts from 1, so the first byte is offset 0 plus one.
        `[ -f ${file} ] || exit 1
         tail -c +${offset + 1} ${file} | head -c ${length} | base64 | tr -d '\n'`
      )
      .catch(() => {
        throw new Error('Could not read that item.');
      });
    return { content: content.trim(), encoding: 'base64' };
  }

  async remove(name: string): Promise<void> {
    await this.target().run(['rm', '-f', '--', this.resolve(name)]);
  }

  /** Files only, and only at the top level: whatever put a directory in there
   *  is not something this panel drew, and `rm -rf` on an agent-writable path
   *  is a worse tool than this job needs. */
  async clear(): Promise<void> {
    const dir = shEscape(this.dir());
    // `mkdir -p` first: clearing a scratchpad nothing has written to yet is a
    // no-op, not the error a bare `cd` into a missing directory would raise.
    await this.target().run([
      'sh',
      '-c',
      `mkdir -p ${dir} && cd ${dir} && find . -maxdepth 1 -type f -delete`
    ]);
  }

  destroy(): void {
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) void watcher.close();
  }

  /** Idempotent: every panel that opens calls `list`, and they must not stack
   *  watchers on one directory. */
  private startWatching(): void {
    if (this.watcher) return;
    const watcher = new WorkspaceWatcher(this.dir(), () => {
      this.emit({ at: Date.now() });
    });
    this.watcher = watcher;
    watcher.start();
  }

  /** Absolute path for a name the agent chose. Flat by construction: the name
   *  is validated, never joined with anything a caller supplied. */
  private resolve(name: string): string {
    if (!isSafeScratchpadName(name)) {
      throw new Error('Invalid scratchpad item name.');
    }
    return `${this.dir()}/${name}`;
  }
}
