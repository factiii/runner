import type { RunnerTagEntry, RunnerVaultFilePost } from '../domains/electron';
import {
  RUNNER_FILE_TEXT_CHARS,
  RUNNER_NOTE_BODY_CHARS,
  RUNNER_NOTE_TITLE_CHARS
} from '../validators/runnerVault';
import { readableIngestError } from './ingestError';

// A runner file's page and the notes kept from runner Ask answers, as Oakbox
// shows them (.specs/oakbox.md "Backend", .specs/runner-vault-ask.md "A runner
// file's page", "Kept research on the runner"), for Oakbox web and the phone
// app. The runner sends ids and values; the names come from Factiii's tree
// (`oakboxBackend.categories`), which the runner never keeps.

/** The tree as either read gives it: names, edges and AI Research. */
type Tree = {
  roots: { id: number; name: string }[];
  branches: { id: number; name: string }[];
  edges: { parentId: number; childId: number }[];
  aiResearch: { id: number } | null;
};

/** One tag as the document screen draws it (`nestTags`, `tagDetails`). */
type RunnerDocTag = {
  id: number;
  name: string;
  parentIds: number[];
  entries: RunnerTagEntry[];
};

/** AI Research's name in Organize's list (useVaultTree) and on a page. */
export const AI_RESEARCH_NAME = 'AI research';

/** Each category's name, by id, AI Research among them. */
export function categoryNames(tree: Tree): Map<number, string> {
  const names = new Map(
    [...tree.roots, ...tree.branches].map((node) => [node.id, node.name])
  );
  if (tree.aiResearch) names.set(tree.aiResearch.id, AI_RESEARCH_NAME);
  return names;
}

/** The file's categories with their names and parents. One the tree no
 *  longer holds (removed since the run) is left out: it has no name. */
export function runnerDocTags(
  tags: RunnerVaultFilePost['tags'],
  tree: Tree
): RunnerDocTag[] {
  const names = categoryNames(tree);
  return tags.flatMap(({ factiiiId, entries }) => {
    const name = names.get(factiiiId);
    if (name === undefined) return [];
    const parentIds = tree.edges
      .filter((edge) => edge.childId === factiiiId)
      .map((edge) => edge.parentId);
    return [{ id: factiiiId, name, parentIds, entries }];
  });
}

/** Where a runner file stands, for the page's note. Null once its text is
 *  there to show. */
export function runnerDocNote(post: RunnerVaultFilePost): string | null {
  if (post.file.ingestStatus === 'PENDING') return RUNNER_FILE_UNREAD;
  if (post.file.ingestStatus === 'FAILED') {
    return `Reading this file failed: ${readableIngestError(post.ingestError)}. It is kept on your runner, and you can still find it by name.`;
  }
  if (!post.text) {
    return 'Your runner could not read any text out of this one. It is kept there, and you can still find it by name.';
  }
  return null;
}

export const RUNNER_FILE_UNREAD =
  'Not read yet. Your runner reads a file before it can show its text, search it or categorize it. Reading needs Vault search, which runs on a Mac with Apple silicon or on Linux.';

/** The meta line under the title: where it is, how it was read, how much. */
export function runnerDocMeta(
  post: RunnerVaultFilePost,
  runnerName: string
): string {
  return [
    `On ${runnerName}`,
    post.transcriptSource === 'OCR' ? 'read with OCR' : null,
    post.pieces > 0
      ? `${post.pieces.toLocaleString()} searchable pieces`
      : null,
    post.categorizedAt ? null : 'not categorized yet'
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/** Said under a cut text: how much of it shows. */
export const runnerDocCut = (post: RunnerVaultFilePost): string | null =>
  post.textChars > post.text.length
    ? `This shows the first ${RUNNER_FILE_TEXT_CHARS.toLocaleString()} of ${post.textChars.toLocaleString()} characters. Download the file for the rest.`
    : null;

/** A note Ask's model keeps on the runner with its save tool, as the
 *  server's saveVaultResearch cuts one: the title and the HTML body trimmed
 *  to the runner's caps. Null when either has nothing in it once the markup
 *  is gone ("Nothing to save"). */
export function runnerNoteFrom(
  title: string,
  body: string
): { title: string; body: string } | null {
  const name = title.trim().slice(0, RUNNER_NOTE_TITLE_CHARS);
  const html = body.trim().slice(0, RUNNER_NOTE_BODY_CHARS);
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name && text ? { title: name, body: html } : null;
}
