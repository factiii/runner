import fs from 'fs';
import path from 'path';

import type { CodexNoticeStore } from '@shared/all/helpers/board-agent-core/session';

// Who has continued past the one-time Codex notice on this runner
// (.specs/codex-permissions.md "The new-user notice"), runner wide in
// `codex-notice.json` as `{ seen: [<userId>, …] }`. Plain JSON, 0600, like
// access.json: user ids, not secrets. One file for every board, so a person
// is asked once per runner, not once per board.

const NOTICE_FILE = 'codex-notice.json';

/** Never throws: a missing, unreadable or malformed file is nobody, so the
 *  notice shows again rather than being skipped. */
export function readCodexNoticeSeen(configDir: string): Set<string> {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(configDir, NOTICE_FILE), 'utf-8')
    ) as { seen?: unknown } | null;
    const seen = Array.isArray(raw?.seen) ? raw.seen : [];
    return new Set(
      seen.filter((id): id is string => typeof id === 'string' && id !== '')
    );
  } catch {
    return new Set();
  }
}

export function markCodexNoticeSeen(configDir: string, userId: string): void {
  if (!userId) return;
  const seen = readCodexNoticeSeen(configDir);
  if (seen.has(userId)) return;
  seen.add(userId);
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, NOTICE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ seen: [...seen] })}\n`, {
    mode: 0o600
  });
  fs.renameSync(tmp, file);
}

/** The store the engines read (ConfigProvider.codexNotice). Read on every
 *  call, so a Continue on one board counts on every other at once. */
export function codexNoticeStore(configDir: string): CodexNoticeStore {
  return {
    seen: (userId) => readCodexNoticeSeen(configDir).has(userId),
    markSeen: (userId) => markCodexNoticeSeen(configDir, userId)
  };
}
