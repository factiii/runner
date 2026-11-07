import { randomUUID } from 'node:crypto';

import type {
  BoardAgentAction,
  BoardAgentActionMap,
  RunnerAskChat,
  RunnerAskChatMessage,
  RunnerAskEngine,
  RunnerVaultFile
} from '@shared/all/domains/electron';
import { LOCAL_AI_MODELS } from '@shared/all/helpers/localAiModels';
import { vaultChatSchema } from '@shared/all/validators';

import type { VaultDb } from './db';

// Oakbox Ask chats made with a runner's model (.specs/runner-vault-ask.md "Runner
// chats"), kept in the Vault's own database and nowhere else: Factiii's server
// never sees them. Each belongs to the account that asked, and only that
// account lists, opens, continues or deletes it, owner and peer alike.
//
// These tables are the runner's own, not the server's (the cloud keeps its
// chats as model transcripts, AskChat), so they are not in vault.prisma. Their
// migrations run after the generated ones (db.ts `migrate`).

export const ASK_CHAT_MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: 'runner_0001_ask_chats',
    sql: `CREATE TABLE "RunnerAskChat" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "engine" TEXT NOT NULL,
  "model" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "RunnerAskChat_userId_updatedAt_idx" ON "RunnerAskChat"("userId", "updatedAt");
CREATE TABLE "RunnerAskMessage" (
  "id" SERIAL PRIMARY KEY,
  "chatId" TEXT NOT NULL REFERENCES "RunnerAskChat"("id") ON DELETE CASCADE,
  "position" INTEGER NOT NULL,
  "role" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "steps" JSONB NOT NULL DEFAULT '[]',
  "sources" JSONB NOT NULL DEFAULT '[]',
  "ms" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("chatId", "position")
);`
  },
  {
    // A chat whose last turn was stopped says so when it is opened again.
    id: 'runner_0002_ask_chat_stopped',
    sql: `ALTER TABLE "RunnerAskChat" ADD COLUMN "stopped" BOOLEAN NOT NULL DEFAULT false;`
  }
];

/** The chats the list shows, as the cloud's (askChatStore.ts). */
const LISTED = 100;
/** What a follow-up carries of the chat: vaultAskSchema's caps. */
const HISTORY = 20;
const HISTORY_CHARS = 16_000;
const TITLE_CHARS = 200;

const NOT_FOUND = 'That chat is not on this runner.';

type ChatRow = {
  id: string;
  title: string;
  engine: RunnerAskEngine;
  model: string | null;
  error: string | null;
  stopped: boolean;
  updatedAt: Date;
};

type MessageRow = {
  role: 'you' | 'answer';
  text: string;
  steps: string[];
  sources: RunnerVaultFile[];
  ms: number | null;
};

const CHAT_COLUMNS = '"id", "title", "engine", "model", "error", "stopped", "updatedAt"';

/** The Local AI table's name for an Ollama tag, else the tag. */
export const modelTitle = (engine: RunnerAskEngine, model: string | null): string => {
  if (engine === 'claude') return 'Claude';
  if (engine === 'codex') return 'Codex';
  return LOCAL_AI_MODELS.find((m) => m.id === model)?.title ?? model ?? 'Local AI';
};

const toChat = (row: ChatRow): RunnerAskChat => ({
  id: row.id,
  title: row.title,
  engine: row.engine,
  model: row.model,
  modelTitle: modelTitle(row.engine, row.model),
  updatedAt: new Date(row.updatedAt).toISOString(),
  error: row.error,
  stopped: row.stopped
});

/** What a turn in a chat runs on, and the thread before it. */
export type ChatThread = {
  engine: RunnerAskEngine;
  model: string | null;
  history: { role: 'you' | 'answer'; text: string }[];
};

export class VaultChats {
  constructor(private readonly db: VaultDb) {}

  /** The chat actions, for the account `caller`. */
  async handle(action: BoardAgentAction, payload: unknown, caller: string): Promise<unknown> {
    switch (action) {
      case 'vaultChats':
        return { chats: await this.list(caller) } satisfies BoardAgentActionMap['vaultChats']['result'];
      case 'vaultChat':
        return this.get(vaultChatSchema.parse(payload).chatId, caller);
      case 'vaultChatDelete': {
        const rows = await this.db.query<{ id: string }>(
          'DELETE FROM "RunnerAskChat" WHERE "id" = $1 AND "userId" = $2 RETURNING "id"',
          [vaultChatSchema.parse(payload).chatId, Number(caller)]
        );
        return { deleted: rows.length > 0 } satisfies BoardAgentActionMap['vaultChatDelete']['result'];
      }
      default:
        throw new Error(`Unknown vault action: ${String(action)}`);
    }
  }

  private async list(caller: string): Promise<RunnerAskChat[]> {
    const rows = await this.db.query<ChatRow>(
      `SELECT ${CHAT_COLUMNS} FROM "RunnerAskChat" WHERE "userId" = $1
        ORDER BY "updatedAt" DESC, "id" DESC LIMIT $2`,
      [Number(caller), LISTED]
    );
    return rows.map(toChat);
  }

  /** Someone else's chat reads as not there, not as theirs. */
  private async owned(chatId: string, caller: string): Promise<ChatRow> {
    const [row] = await this.db.query<ChatRow>(
      `SELECT ${CHAT_COLUMNS} FROM "RunnerAskChat" WHERE "id" = $1 AND "userId" = $2`,
      [chatId, Number(caller)]
    );
    if (!row) throw new Error(NOT_FOUND);
    return row;
  }

  private messages(chatId: string): Promise<MessageRow[]> {
    return this.db.query<MessageRow>(
      `SELECT "role", "text", "steps", "sources", "ms" FROM "RunnerAskMessage"
        WHERE "chatId" = $1 ORDER BY "position" ASC`,
      [chatId]
    );
  }

  private async get(
    chatId: string,
    caller: string
  ): Promise<BoardAgentActionMap['vaultChat']['result']> {
    const chat = toChat(await this.owned(chatId, caller));
    const messages = (await this.messages(chatId)).map(
      (m): RunnerAskChatMessage => ({ ...m, ms: m.ms === null ? null : Number(m.ms) })
    );
    return { chat, messages };
  }

  /** A chat a follow-up continues: on the model it started on, from its
   *  own messages. */
  async thread(chatId: string, caller: string): Promise<ChatThread> {
    const chat = await this.owned(chatId, caller);
    const history = (await this.messages(chatId))
      .slice(-HISTORY)
      .map((m) => ({ role: m.role, text: m.text.slice(0, HISTORY_CHARS) }));
    return { engine: chat.engine, model: chat.model, history };
  }

  /** Save a question before it is answered: the next message of `chatId`,
   *  or a new chat named by it. Resolves the chat's id. */
  async question(
    caller: string,
    text: string,
    pick: { engine: RunnerAskEngine; model: string | null },
    chatId?: string
  ): Promise<string> {
    if (chatId) {
      await this.append(chatId, { role: 'you', text, steps: [], sources: [], ms: null });
      return chatId;
    }
    const id = randomUUID();
    await this.db.batch([
      {
        sql: `INSERT INTO "RunnerAskChat" ("id", "userId", "title", "engine", "model")
              VALUES ($1, $2, $3, $4, $5)`,
        params: [id, Number(caller), text.slice(0, TITLE_CHARS), pick.engine, pick.model]
      },
      {
        sql: `INSERT INTO "RunnerAskMessage" ("chatId", "position", "role", "text")
              VALUES ($1, 0, 'you', $2)`,
        params: [id, text]
      }
    ]);
    return id;
  }

  /** Save a turn's answer, with its steps, sources and time. */
  answered(chatId: string, answer: Omit<MessageRow, 'role'>): Promise<void> {
    return this.append(chatId, { role: 'answer', ...answer });
  }

  /** Keep why a turn failed, for when the chat is opened again. */
  async failed(chatId: string, error: string): Promise<void> {
    await this.db.query(
      'UPDATE "RunnerAskChat" SET "error" = $2, "stopped" = false, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1',
      [chatId, error]
    );
  }

  /** Keep that the last turn was stopped: its question stays, no answer. */
  async stopped(chatId: string): Promise<void> {
    await this.db.query(
      'UPDATE "RunnerAskChat" SET "error" = NULL, "stopped" = true, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1',
      [chatId]
    );
  }

  private async append(chatId: string, m: MessageRow): Promise<void> {
    await this.db.batch([
      {
        sql: `INSERT INTO "RunnerAskMessage" ("chatId", "position", "role", "text", "steps", "sources", "ms")
              SELECT $1, COALESCE(MAX("position") + 1, 0), $2, $3, $4::jsonb, $5::jsonb, $6
                FROM "RunnerAskMessage" WHERE "chatId" = $1`,
        params: [chatId, m.role, m.text, JSON.stringify(m.steps), JSON.stringify(m.sources), m.ms]
      },
      {
        sql: `UPDATE "RunnerAskChat" SET "error" = NULL, "stopped" = false, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        params: [chatId]
      }
    ]);
  }
}
