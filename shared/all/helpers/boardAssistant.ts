import { z } from 'zod';

// The Board Assistant's client-side contract, shared by web and mobile: the
// board snapshot the model is given, and the actions it may propose back.
// The prompt that teaches the model this format is `boardAI` in
// board-agent-core/prompts.json; the two must change together.

const reason = z.string().catch('');

const boardActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add'),
    listId: z.coerce.number().int(),
    listName: z.string(),
    content: z.string().min(1),
    reason
  }),
  z.object({
    type: z.literal('edit'),
    postId: z.string().min(1),
    title: z.string(),
    content: z.string().min(1),
    reason
  }),
  z.object({
    type: z.literal('delete'),
    postId: z.string().min(1),
    title: z.string(),
    reason
  }),
  z.object({
    type: z.literal('move'),
    postId: z.string().min(1),
    title: z.string(),
    fromListName: z.string().catch(''),
    toListId: z.coerce.number().int(),
    toListName: z.string(),
    reason
  }),
  z.object({
    type: z.literal('assign'),
    postId: z.string().min(1),
    title: z.string(),
    userId: z.coerce.number().int(),
    // What the model called the member. Display resolves the name from the
    // member list by `userId`, so a wrong name here cannot mislabel a row.
    username: z.string().catch(''),
    reason
  })
]);

export type BoardAction = z.infer<typeof boardActionSchema>;
export type PendingAction = BoardAction & { id: string; approved: boolean };

/** Someone a card can be assigned to. */
export type BoardMember = { userId: number; username: string; name: string };

export type BoardSnapshot = {
  columns: {
    id: number;
    name: string;
    cards: {
      postId: string;
      title: string;
      /** Extra text for the model when the snapshot came from the client's
       *  cache, which holds more than the title. */
      detail?: string;
    }[];
  }[];
};

const BOARD_ACTIONS_MARKER = 'BOARD_ACTIONS';

/** The reply without its trailing actions block: what the chat renders. */
export function stripBoardActions(text: string): string {
  const idx = text.indexOf(BOARD_ACTIONS_MARKER);
  if (idx === -1) return text;
  return text.slice(0, idx).trim();
}

/** Every complete, well-formed action in the reply so far. Safe to call on a
 *  partial stream: a line that is still arriving does not parse and is
 *  skipped until it does. */
export function parseBoardActions(text: string): BoardAction[] {
  const idx = text.indexOf(BOARD_ACTIONS_MARKER);
  if (idx === -1) return [];

  const block = text.slice(idx + BOARD_ACTIONS_MARKER.length).trim();
  const actions: BoardAction[] = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      // Line not yet complete
      continue;
    }
    const parsed = boardActionSchema.safeParse(raw);
    if (parsed.success) actions.push(parsed.data);
  }
  return actions;
}

/** The board as the model reads it. The `[id: ...]`, `[listId: ...]` and
 *  `[userId: ...]` markers are the ids its actions must quote back. */
export function formatBoardContext(
  snapshot: BoardSnapshot,
  members: BoardMember[]
): string {
  let context = '';
  for (const column of snapshot.columns) {
    context += `## List: ${column.name} [listId: ${column.id}]\n`;
    if (column.cards.length === 0) {
      context += '(empty)\n\n';
      continue;
    }
    for (const card of column.cards) {
      context += `- [id: ${card.postId}] ${card.title || '(untitled)'}${card.detail ?? ''}\n`;
    }
    context += '\n';
  }
  if (members.length > 0) {
    context += '## Members (who a card can be assigned to)\n';
    for (const member of members) {
      const name = member.name ? ` (${member.name})` : '';
      context += `- [userId: ${member.userId}] @${member.username}${name}\n`;
    }
    context += '\n';
  }
  return context;
}

const PREVIEW_CHARS = 60;

const clip = (text: string, max = PREVIEW_CHARS): string =>
  text.length > max ? `${text.slice(0, max)}...` : text;

/** The member an assign action points at, or undefined when the id is not on
 *  the board: the model invented it, or the member has since left. */
export function assigneeOf(
  action: Extract<BoardAction, { type: 'assign' }>,
  members: BoardMember[]
): BoardMember | undefined {
  return members.find((m) => m.userId === action.userId);
}

/** The two strings a review row shows. Shared so web and mobile agree. */
export function actionRowText(
  action: BoardAction,
  members: BoardMember[]
): { title: string; subtitle: string } {
  switch (action.type) {
    case 'add':
      return {
        title: clip(action.content),
        subtitle: `→ ${action.listName}`
      };
    case 'edit':
      return { title: action.title, subtitle: `→ ${clip(action.content)}` };
    case 'move':
      return {
        title: action.title,
        subtitle: `${action.fromListName} → ${action.toListName}`
      };
    case 'assign': {
      const member = assigneeOf(action, members);
      return {
        title: action.title,
        subtitle: member ? `→ @${member.username}` : '→ not a board member'
      };
    }
    case 'delete':
      return { title: action.title, subtitle: '' };
  }
}

/** One line of the result that goes back to the model after a review. */
export function describeBoardAction(
  action: BoardAction,
  members: BoardMember[]
): string {
  switch (action.type) {
    case 'delete':
      return `Deleted card "${action.title}"`;
    case 'edit':
      return `Edited card "${action.title}"`;
    case 'add':
      return `Added card "${action.content.slice(0, 80)}" to ${action.listName}`;
    case 'move':
      return `Moved card "${action.title}" from ${action.fromListName} to ${action.toListName}`;
    case 'assign': {
      const member = assigneeOf(action, members);
      return `Assigned card "${action.title}" to @${member?.username ?? action.username}`;
    }
  }
}

// ── After a review ──

const ACTION_RESULT_PREFIX = '[Action result: ';

/** Carry the outcome of the last review to the model, ahead of the user's
 *  next question. `boardAI` in prompts.json tells it how to read the block. */
export function withActionResult(question: string, result: string): string {
  return result ? `${ACTION_RESULT_PREFIX}${result}]\n\n${question}` : question;
}

/** The question as the user typed it, without the result block: what a
 *  transcript, a title or a preview shows. */
export function withoutActionResult(question: string): string {
  if (!question.startsWith(ACTION_RESULT_PREFIX)) return question;
  const end = question.indexOf(']\n\n');
  return end === -1 ? question : question.slice(end + 3);
}

/** What the user sends when they take up the offer of a report. */
export const REPORT_REQUEST = 'Yes, report what was done.';

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The line the chat shows the moment a review finishes: counts only. The
 *  full account is the model's report, which the user asks for. */
export function reviewNotice(counts: {
  applied: number;
  failed: number;
  rejected: number;
}): string {
  const { applied, failed, rejected } = counts;
  if (applied === 0 && failed === 0) {
    return `Dismissed ${plural(rejected, 'proposed change')}. Nothing on the board changed.`;
  }
  const parts = [`Applied ${plural(applied, 'change')} to the board.`];
  if (failed > 0) parts.push(`${failed} failed.`);
  if (rejected > 0) parts.push(`${rejected} left out.`);
  return parts.join(' ');
}

// ── What a conversation is about ──

// A shorter title matches too much prose to mean the card was named.
const MIN_TITLE_CHARS = 4;

/**
 * "List > Card title" when a turn is about exactly one card, else ''. The
 * question is read first: it is the user's own words. A reply only counts
 * when it names a single card, by id (its actions quote ids) or by title; a
 * board-wide answer names many and labels nothing.
 */
export function discussedCardTopic(
  question: string,
  reply: string,
  snapshot: BoardSnapshot
): string {
  const cards = snapshot.columns.flatMap((column) =>
    column.cards.map((card) => ({ ...card, list: column.name }))
  );
  const onlyCardIn = (text: string) => {
    const lower = text.toLowerCase();
    const hits = cards.filter(
      (card) =>
        text.includes(card.postId) ||
        (card.title.length >= MIN_TITLE_CHARS &&
          lower.includes(card.title.toLowerCase()))
    );
    return hits.length === 1 ? hits[0] : undefined;
  };
  const card = onlyCardIn(question) ?? onlyCardIn(reply);
  return card ? `${card.list} > ${card.title}` : '';
}
