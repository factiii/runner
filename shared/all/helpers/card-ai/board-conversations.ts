import type {
  AgentProvider,
  BoardConversationSummary,
  BoardSessionMessage
} from '../../domains/electron';
import type { ExecTarget } from '../board-agent-core/exec';
import {
  type AskRecord,
  deleteAsk,
  listAsks,
  putAsk
} from '../board-agent-core/state';
import { withoutActionResult } from '../boardAssistant';

// The Board AI's conversations for one space. A space holds many: each has its
// own CLI thread (`sessionId`), so several can be asked at once, and each is
// kept in the space's redis so it can be resumed after the panel closes, the
// runner restarts, or it was set aside for a new one.

const TITLE_CHARS = 60;
const PREVIEW_CHARS = 120;
// Past this many the oldest set-aside conversation is dropped to make room.
const MAX_CONVERSATIONS = 100;

/** Ids are minted by the client and become a redis key. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

let localIdCounter = 0;

export class BoardConversations {
  private byId = new Map<string, AskRecord>();
  /** Set once the store has been read. A failed read is retried, because the
   *  space's redis is not up before its first setup. */
  private loaded = false;
  private loading: Promise<void> | null = null;
  /** Conversations with a turn in flight. Not persisted: a runner restart
   *  kills the CLI, so nothing is busy afterwards. */
  private busy = new Set<string>();

  constructor(private readonly target: () => ExecTarget) {}

  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loading ??= listAsks(this.target())
      .then((records) => {
        for (const record of records) {
          // A conversation created before the read finished wins.
          if (!this.byId.has(record.id)) this.byId.set(record.id, record);
        }
        this.loaded = true;
      })
      .catch(() => {
        // Not readable yet: answer from memory and try again next time.
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private save(record: AskRecord): void {
    // Fire-and-forget: the conversation in memory is what the next turn uses,
    // and a turn should not fail because redis blinked.
    void putAsk(this.target(), record).catch(() => {});
  }

  private touch(record: AskRecord): void {
    record.updatedAt = Date.now();
    this.save(record);
  }

  /** The conversation an id-less (older) client means: the one most recently
   *  used that has not been set aside. */
  private current(): AskRecord | undefined {
    return [...this.byId.values()]
      .filter((record) => !record.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  private create(id: string): AskRecord {
    if (!ID_PATTERN.test(id)) throw new Error('Invalid conversation id.');
    const now = Date.now();
    const record: AskRecord = {
      id,
      title: '',
      topic: '',
      sessionId: null,
      messages: [],
      archived: false,
      createdAt: now,
      updatedAt: now
    };
    this.byId.set(id, record);
    this.prune();
    return record;
  }

  private prune(): void {
    if (this.byId.size <= MAX_CONVERSATIONS) return;
    const oldest = [...this.byId.values()]
      .filter((record) => record.archived && !this.busy.has(record.id))
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!oldest) return;
    this.byId.delete(oldest.id);
    void deleteAsk(this.target(), oldest.id).catch(() => {});
  }

  /** The conversation a question goes to, created on its first question and
   *  marked busy before this returns, so a second question cannot resume the
   *  same CLI thread while the first is still writing to it. The caller ends
   *  the turn with `setBusy(id, false)`. Asking in a conversation that was
   *  set aside brings it back. */
  async beginTurn(id: string | undefined): Promise<AskRecord> {
    await this.load();
    const record =
      (id ? this.byId.get(id) : this.current()) ??
      this.create(id ?? `c-${Date.now()}-${++localIdCounter}`);
    if (this.busy.has(record.id)) {
      throw new Error('This conversation is still answering.');
    }
    this.busy.add(record.id);
    record.archived = false;
    return record;
  }

  /** Look one up without creating it. No id means the current one. */
  async find(id: string | undefined): Promise<AskRecord | undefined> {
    await this.load();
    return id ? this.byId.get(id) : this.current();
  }

  isBusy(id: string): boolean {
    return this.busy.has(id);
  }

  setBusy(id: string, busy: boolean): void {
    if (busy) this.busy.add(id);
    else this.busy.delete(id);
  }

  /** Record the user's turn. The first one names the conversation. */
  addUserMessage(record: AskRecord, message: BoardSessionMessage): void {
    record.messages.push(message);
    if (!record.title) {
      record.title =
        oneLine(withoutActionResult(message.content), TITLE_CHARS) ||
        'New conversation';
    }
    this.touch(record);
  }

  addAnswer(record: AskRecord, text: string, sessionId: string): void {
    // Deleted or handed to a terminal while it was answering: saving now
    // would bring it back.
    if (this.byId.get(record.id) !== record) return;
    if (sessionId) record.sessionId = sessionId;
    record.messages.push({ role: 'assistant', content: text });
    this.touch(record);
  }

  setProvider(record: AskRecord, provider: AgentProvider): void {
    record.provider = provider;
  }

  async list(): Promise<BoardConversationSummary[]> {
    await this.load();
    return [...this.byId.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((record) => {
        // The assistant answers in openui-lang, which is not a preview: the
        // last thing the user asked is.
        const lastAsked = [...record.messages]
          .reverse()
          .find((m) => m.role === 'user');
        return {
          id: record.id,
          title: record.title,
          topic: record.topic,
          preview: lastAsked
            ? oneLine(withoutActionResult(lastAsked.content), PREVIEW_CHARS)
            : '',
          provider: record.provider ?? null,
          archived: record.archived,
          busy: this.busy.has(record.id),
          messageCount: record.messages.length,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        };
      });
  }

  async update(
    id: string,
    patch: { title?: string; topic?: string; archived?: boolean }
  ): Promise<void> {
    const record = await this.find(id);
    if (!record) return;
    if (patch.title !== undefined) {
      record.title = oneLine(patch.title, TITLE_CHARS) || record.title;
    }
    if (patch.topic !== undefined) {
      record.topic = oneLine(patch.topic, PREVIEW_CHARS);
    }
    if (patch.archived !== undefined) record.archived = patch.archived;
    // A rename or a label is not activity: it must not reorder the list.
    this.save(record);
  }

  /** Forget a conversation. Its CLI thread stays on disk, unreferenced. */
  async remove(id: string): Promise<void> {
    // The store would squeeze a malformed id into some other key.
    if (!ID_PATTERN.test(id)) return;
    await this.load();
    this.byId.delete(id);
    this.busy.delete(id);
    await deleteAsk(this.target(), id).catch(() => {});
  }
}
