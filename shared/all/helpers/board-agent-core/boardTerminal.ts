import type { AgentProvider } from '../../domains/electron';

/**
 * Synthetic postId for a space's board-level "Ask Board" terminal. The terminal
 * bridge is postId-keyed; Ask has no card, so it borrows this per-space key.
 * Keyed by slug (not a constant) so it resolves to exactly one engine on a
 * shared runner. No node imports here - both the client and the runner use it.
 */
export function boardTerminalKey(spaceSlug: string): string {
  return `board-${spaceSlug}`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a real board card's postId (a UUID), false for a synthetic terminal
 *  id (`bare-…` / `board-…`). Gates card-only fetches like posts.replies. */
export function isCardPostId(id: string): boolean {
  return UUID_RE.test(id);
}

/** The CLI a session's agent runs. A synthetic terminal (`bare-…`) opens a
 *  plain shell and its only agent is the chat's, which is always Claude
 *  (chatRun.ts), so the provider recorded on it (the board default, which
 *  older runners stored) says nothing about it. */
export function sessionProvider(
  postId: string,
  provider: AgentProvider
): AgentProvider {
  return isCardPostId(postId) ? provider : 'claude';
}

/** The card a session is linked to (SessionSummary.cardId), or null: the
 *  link when one was set or cleared, else the session's own card when it was
 *  started on one. */
export function sessionCardId(session: {
  postId: string;
  cardId?: string;
}): string | null {
  if (session.cardId !== undefined) return session.cardId || null;
  return isCardPostId(session.postId) ? session.postId : null;
}
