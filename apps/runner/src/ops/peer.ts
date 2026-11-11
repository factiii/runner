import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { NONCE } from './protocol';

// Who is on the other end of the ops socket (.specs/ops-user.md, "The
// socket"). Node exposes no getpeereid / SO_PEERCRED, so the peer proves its
// uid with the one thing only root can forge: a file's owner. The server sends
// a random nonce; the client creates `<peer dir>/<nonce>` exclusively; the
// server lstat's it and checks the owner against the allowed uids. The peer
// dir is 1730 factiii-ops:factiii, so group members can create files in it
// but not list it, and only the ops user deletes them.
//
// A native addon (getpeereid, SO_PEERCRED, a named pipe's client SID) can
// stand in for this behind the same PeerCheck, without the drop dir.

export type PeerIdentity = { uid: number };

export type PeerCheck = {
  /** A fresh nonce for one connection. */
  challenge(): string;
  /** The peer's uid, proven by the challenge file; throws when it is not
   *  one of the allowed uids, or the file is missing or not a plain file. */
  verify(nonce: string): Promise<PeerIdentity>;
};

type StatLike = {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  nlink: number;
  uid: number;
};

export function challengePeerCheck(opts: {
  peerDir: string;
  /** The normal user's uid (and any other member of group factiii). */
  allowedUids: ReadonlySet<number>;
  lstat?: (file: string) => Promise<StatLike>;
  unlink?: (file: string) => Promise<void>;
}): PeerCheck {
  const lstat = opts.lstat ?? ((file: string) => fs.lstat(file));
  const unlink = opts.unlink ?? ((file: string) => fs.unlink(file));
  return {
    challenge: () => randomBytes(32).toString('hex'),
    verify: async (nonce) => {
      if (!NONCE.test(nonce)) throw new Error('bad nonce');
      const file = path.join(opts.peerDir, nonce);
      let st: StatLike;
      try {
        st = await lstat(file);
      } catch {
        throw new Error('no challenge file');
      }
      // Gone either way: a nonce is good for one connection.
      await unlink(file).catch(() => undefined);
      // A link would point the check at someone else's file.
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) {
        throw new Error('challenge file is not a plain file');
      }
      if (!opts.allowedUids.has(st.uid)) {
        throw new Error(`uid ${st.uid} is not allowed`);
      }
      return { uid: st.uid };
    }
  };
}

/** The client's half: make the file the server will check. */
export async function answerChallenge(peerDir: string, nonce: string): Promise<void> {
  if (!NONCE.test(nonce)) throw new Error('The ops service sent a bad challenge.');
  await fs.writeFile(path.join(peerDir, nonce), '', { flag: 'wx', mode: 0o600 });
}
