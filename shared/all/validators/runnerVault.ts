import { z } from 'zod';

import { MAX_VAULT_FILE_BYTES, VAULT_SEARCH_MIN_CHARS } from '../domains/oakbox';
import {
  claudeAskSettingsSchema,
  codexAskSettingsSchema
} from './oakboxBackend';

// A runner Vault's actions (.specs/runner-vault.md "Actions"): checked on the
// runner before anything touches its database or disk, and used by the
// client to build the same payloads.

/** Raw bytes per write and per read: the vault backup's sizes, for its
 *  reasons (one ~512K-character frame; the relay drops a packet over 1 MB). */
export const RUNNER_VAULT_WRITE_CHUNK_BYTES = 384 * 1024;
export const RUNNER_VAULT_READ_CHUNK_BYTES = 512 * 1024;
/** The most base64 one write may carry: twice the chunk, as the backup. */
const WRITE_MAX_CHARS = Math.ceil((RUNNER_VAULT_WRITE_CHUNK_BYTES * 2 * 4) / 3) + 4;
const MAX_PAGE = 200;
/** A path a person typed or a folder gave: folders and all. */
const MAX_NAME_CHARS = 1024;

const uploadId = z.string().uuid();
const ticket = z.string().min(1).max(4096);

/** A factiii's id: a category Categorize tags a file with. */
const factiiiId = z.number().int().positive();

/** @deprecated The `vaultFiles` action, kept for one runner release: new
 *  clients call the shared router's `files` through `vaultRpc`
 *  (.specs/vault-router.md → Compatibility). */
export const vaultFilesSchema = z.object({
  query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE).optional(),
  before: uploadId.optional(),
  // Only the files Categorize tagged with this category.
  factiiiId: factiiiId.optional()
});

/** Oakbox's search on a runner: the cloud's file query cap and page size.
 *  @deprecated `vaultSearch`, kept for one runner release: new clients call
 *  the shared router's `search` (or `files` with `meaning`) through
 *  `vaultRpc`. */
export const vaultSearchSchema = z.object({
  query: z.string().trim().min(VAULT_SEARCH_MIN_CHARS).max(200),
  limit: z.number().int().min(1).max(MAX_PAGE).optional()
});

export const vaultUploadStartSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_NAME_CHARS)
    // No control characters and no `..` segment: the name is a path in the
    // vault's folder view, never on the runner's disk, but it is shown.
    .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), 'Bad file name.')
    .refine((name) => !name.split('/').includes('..'), 'Bad file name.'),
  size: z.number().int().min(0).max(MAX_VAULT_FILE_BYTES),
  contentType: z.string().min(1).max(255)
});

export const vaultWriteSchema = z.object({
  ticket,
  offset: z.number().int().min(0),
  content: z.string().max(WRITE_MAX_CHARS),
  last: z.boolean().optional()
});

/** @deprecated `vaultDownload`, kept for one runner release: new clients call
 *  the shared router's `downloadUrl` through `vaultRpc`, and redeem its
 *  ticket with `vaultRead` as before. */
export const vaultDownloadSchema = z.object({ uploadId });

export const vaultReadSchema = z.object({
  ticket,
  offset: z.number().int().min(0),
  length: z.number().int().min(1).max(RUNNER_VAULT_READ_CHUNK_BYTES)
});

/** @deprecated `vaultDelete`, kept for one runner release: new clients call
 *  the shared router's `deleteFiles` through `vaultRpc`. */
export const vaultDeleteSchema = z.object({
  uploadIds: z.array(uploadId).min(1).max(1000)
});

/** The shared vault router's procedures a runner answers so far
 *  (.specs/vault-router.md → What is in the router). The rest of the Vault is
 *  still its own actions. */
const VAULT_RPC_PATHS = ['files', 'search', 'downloadUrl', 'deleteFiles'] as const;
export type VaultRpcPath = (typeof VAULT_RPC_PATHS)[number];

/** One call of the shared vault router on a runner. `input` is the
 *  procedure's own, checked by the procedure (@shared/vault-router/inputs). */
export const vaultRpcSchema = z.object({
  path: z.enum(VAULT_RPC_PATHS),
  input: z.unknown().optional()
});

export const vaultShareSetSchema = z.object({
  memberId: z.string().regex(/^\d{1,12}$/),
  shared: z.boolean()
});

/** A question to Ask: the cloud's research reply cap (research.ts). */
const MAX_ASK_CHARS = 1000;
/** One earlier answer the thread carries back. */
const MAX_ANSWER_CHARS = 16_000;
/** The thread a turn carries: enough for a follow-up, never the whole chat. */
const MAX_ASK_HISTORY = 20;
/** Files one question carries: the cloud Ask's cap (MAX_ASK_FILES). */
const MAX_ASK_FILE_IDS = 10;

/** An Ollama tag, as `ollama list` prints it. */
const ollamaModel = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._/-]*(:[a-z0-9._-]+)?$/i)
  .max(200);

/** The categories one run may carry: far over any person's tree, under what
 *  one link message holds. */
const MAX_CATEGORIES = 1000;

/** One category as the run asks about it: a factiii from Factiii's tree
 *  (`oakboxBackend.categories`), its rule (`description`) and requirements. */
const categoryNodeSchema = z.object({
  id: factiiiId,
  slug: z.string().max(200),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(1000).nullable(),
  requirements: z.array(z.string().max(64)).max(32)
});

/** Factiii's category tree as a runner reads it (`oakboxBackend.categories`):
 *  the nodes, which of them are roots, and the edges between them. It comes
 *  with each run or Ask turn that needs it, and is never kept. */
export const runnerCategoryTreeSchema = z.object({
  nodes: z.array(categoryNodeSchema).max(MAX_CATEGORIES),
  roots: z.array(factiiiId).max(MAX_CATEGORIES),
  edges: z
    .array(z.object({ parentId: factiiiId, childId: factiiiId }))
    .max(MAX_CATEGORIES * 4)
});

export type RunnerCategoryTree = z.infer<typeof runnerCategoryTreeSchema>;

/** Oakbox Ask on a runner (.specs/runner-vault-ask.md "Ask with a runner's
 *  model"). `model` is an Ollama tag. */
export const vaultAskSchema = z
  .object({
    engine: z.enum(['ollama', 'claude', 'codex']),
    model: ollamaModel.optional(),
    question: z.string().trim().min(1).max(MAX_ASK_CHARS),
    history: z
      .array(
        z.object({
          role: z.enum(['you', 'answer']),
          text: z.string().max(MAX_ANSWER_CHARS)
        })
      )
      .max(MAX_ASK_HISTORY)
      .optional(),
    chatId: z.string().uuid().optional(),
    // Files added to the question in Ask, by their id in this Vault: read
    // first, whatever the search finds.
    fileIds: z.array(z.string().uuid()).max(MAX_ASK_FILE_IDS).optional(),
    // Claude's or Codex's model and effort, from Account > Backend: the
    // engine's own lists only (oakboxBackend.ts).
    cli: z.union([claudeAskSettingsSchema, codexAskSettingsSchema]).optional(),
    // AI Research's id from Factiii's tree: the tag a note the model keeps
    // this turn carries.
    aiResearchId: factiiiId.nullable().optional(),
    // Factiii's category tree, for the tag and category tools
    // (list_my_tags, search_my_tags, list_my_ontology): the runner keeps only
    // ids. Without it those tools are not offered.
    categories: runnerCategoryTreeSchema.optional()
  })
  .refine((ask) => ask.engine !== 'ollama' || ask.model, 'Pick a model.')
  .refine(
    (ask) =>
      !ask.cli ||
      (ask.engine === 'claude' &&
        claudeAskSettingsSchema.safeParse(ask.cli).success) ||
      (ask.engine === 'codex' &&
        codexAskSettingsSchema.safeParse(ask.cli).success),
    'Those settings are not for this model.'
  );

export const vaultAskPollSchema = z.object({ askId: z.string().uuid() });
/** Stop a running turn (vaultAskCancel). */
export const vaultAskCancelSchema = vaultAskPollSchema;

/** One runner Ask chat (vaultChat, vaultChatDelete). */
export const vaultChatSchema = z.object({ chatId: z.string().uuid() });

/** Start Categorize on a runner (.specs/runner-vault-ask.md "Categorize on the
 *  runner"). The tree comes with the run: the runner keeps the tags, never
 *  the tree. `aiResearchId` is the built-in AI Research factiii a Markdown
 *  file carries unless the model says it is not research. */
export const vaultCategorizeStartSchema = z
  .object({
    engine: z.enum(['ollama', 'claude', 'codex']),
    model: ollamaModel.optional(),
    tree: runnerCategoryTreeSchema,
    aiResearchId: factiiiId.nullable()
  })
  .refine((run) => run.engine !== 'ollama' || run.model, 'Pick a model.');

/** One runner file's page (vaultFilePost). */
export const vaultFilePostSchema = z.object({ uploadId });

/** The text a runner file's page carries: about 40 pages, one link message
 *  well under the relay's 1 MB, the rest a Download away. */
export const RUNNER_FILE_TEXT_CHARS = 100_000;

/** The server's caps on a kept note (vaultSaveResearch.ts): a title, and an
 *  answer long enough to be worth keeping and short enough that a stray
 *  keep is cheap. Past them the model's text is cut, as the server cuts. */
export const RUNNER_NOTE_TITLE_CHARS = 200;
export const RUNNER_NOTE_BODY_CHARS = 20_000;

/** The kept notes, or one of them (vaultNotes). */
export const vaultNotesSchema = z.object({
  noteId: z.string().uuid().optional()
});

export const vaultNoteDeleteSchema = z.object({ noteId: z.string().uuid() });

export type RunnerCategorizePayload = z.infer<
  typeof vaultCategorizeStartSchema
>;
