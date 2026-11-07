import type { RunnerVaultFile, RunnerVaultNote } from '@shared/all/domains/electron';
import {
  describeToolCall,
  describeToolResult,
  isResearchTool,
  ontologyPage,
  parseToolInput,
  researchToolDefs,
  type ResearchToolName,
  researchToolNames
} from '@shared/all/helpers/researchTools';
import type { RunnerCategoryTree } from '@shared/all/validators';

import type { AskTools } from './ask';
import type { VaultDb } from './db';
import { utc } from './posts';
import { askTerms, type VaultCaller } from './service';

// Ask's research tools on a runner (.specs/runner-vault-ask.md "Ask with a
// runner's model"): the cloud Ask's file tools (shared/all/helpers/
// researchTools.ts), the same names, inputs and result shapes, over the
// runner's own database. Claude and Codex reach them through the turn's MCP
// server (askMcp.ts), Ollama as function tools (askEngines.ts); every call is
// labelled in Ask's work line as the cloud labels it.
//
// Whose rows a tool reads is the caller's Vault access (access.ts): the
// files of everyone it reads (`readers`), and its own notes. The tag and
// category tools name categories from Factiii's tree, which the app sends
// with the turn (the runner keeps only ids); without it they are not
// offered. save_research is the owner's alone, as every note is.
//
// The web and skill tools need Factiii, so a runner has none of them.

/** search_my_files's hits (the cloud's SEARCH_LIMIT), and how much of each
 *  row's text a hit carries. */
const SEARCH_HITS = 8;
const HIT_CHARS = 1_200;
/** list_my_files's page, the cloud's. */
const LIST_FILES = 200;
/** search_my_tags's hits and each one's snippet, the cloud's. */
const TAG_HITS = 20;
const SNIPPET_CHARS = 1_200;
/** read_my_file's cut, the cloud's READ_CHAR_LIMIT. */
const READ_CHARS = 24_000;

/** The caller's rows: a file of anyone it reads, or a note of its own (a
 *  post with no upload). `u` is the post's upload, LEFT JOINed. */
const MINE = `p."status" = 'PRIVATE' AND p."parentPostId" IS NULL
  AND ((u."id" IS NOT NULL AND u."userId" = ANY($1::int[])) OR (u."id" IS NULL AND p."userId" = $2))`;
const POST_UPLOAD = `LEFT JOIN "_postUploads" pu ON pu."A" = p."id"
  LEFT JOIN "Upload" u ON u."id" = pu."B"`;

/** search_my_files's hit, as the cloud's (a note's `uploadId` is null). */
type Hit = {
  uploadId: string | null;
  postUuid: string;
  name: string | null;
  page: number | null;
  text: string;
  syncedAt: string;
  distance: number | null;
};

const HIT_COLUMNS = `u."id" AS "uploadId", p."uuid"::text AS "postUuid",
  COALESCE(u."name", p."title") AS "name", pc."page", left(pc."text", ${HIT_CHARS}) AS "text",
  ${utc('COALESCE(u."createdAt", p."createdAt")')} AS "syncedAt"`;

const pattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The rows the tools read: the runner's database, and the embedder a
 *  search's query is embedded with (null when it is not there). */
export class VaultAskTools {
  constructor(
    private readonly db: VaultDb,
    private readonly embed: (text: string) => Promise<number[] | null>
  ) {}

  /**
   * search_my_files: by meaning, the rows nearest the query, as the cloud
   * searches; `exact`, the rows whose file name or text holds it. With no
   * embedder the words are the whole search: the query, then its longer
   * words one by one (askTerms), as Oakbox's search on a runner falls back.
   */
  async searchFiles({ readers, caller }: VaultCaller, query: string, exact: boolean): Promise<Hit[]> {
    const vector = exact ? null : await this.embed(query);
    if (vector) {
      const rows = await this.db.query<Hit>(
        `SELECT ${HIT_COLUMNS}, (sv."vector" <=> $3::halfvec)::float8 AS "distance"
           FROM "SearchVector" sv
           JOIN "PostContent" pc ON pc."id" = sv."postContentId"
           JOIN "Post" p ON p."id" = pc."postId"
           ${POST_UPLOAD}
          WHERE ${MINE}
          ORDER BY "distance" ASC, pc."id" ASC
          LIMIT $4`,
        [readers, Number(caller), `[${vector.join(',')}]`, SEARCH_HITS]
      );
      return rows.map((row) => ({ ...row, distance: Number(row.distance) }));
    }
    const words = async (text: string) =>
      this.db.query<Hit>(
        `SELECT ${HIT_COLUMNS}, NULL::float8 AS "distance"
           FROM "PostContent" pc
           JOIN "Post" p ON p."id" = pc."postId"
           ${POST_UPLOAD}
          WHERE ${MINE}
            AND (COALESCE(u."name", p."title") ILIKE $3 OR pc."text" ILIKE $3)
          ORDER BY COALESCE(u."createdAt", p."createdAt") DESC, pc."seq" ASC
          LIMIT $4`,
        [readers, Number(caller), pattern(text), SEARCH_HITS]
      );
    const found = await words(query.trim());
    if (exact || found.length > 0) return found;
    for (const term of askTerms(query)) {
      const hits = await words(term);
      if (hits.length > 0) return hits;
    }
    return [];
  }

  /** list_my_files: every file the caller reads, newest first. */
  async listFiles({ readers }: VaultCaller) {
    return this.db.query<{
      uploadId: string;
      postUuid: string;
      name: string | null;
      type: string;
      transcriptSource: string | null;
      syncedAt: string;
      chunks: number;
    }>(
      `SELECT u."id" AS "uploadId", p."uuid"::text AS "postUuid", u."name",
              u."type"::text AS "type", u."transcriptSource"::text AS "transcriptSource",
              ${utc('u."createdAt"')} AS "syncedAt",
              (SELECT count(*)::int FROM "SearchVector" s
                 JOIN "PostContent" c ON c."id" = s."postContentId"
                WHERE c."postId" = p."id") AS "chunks"
         FROM "Upload" u
         JOIN "_postUploads" pu ON pu."B" = u."id"
         JOIN "Post" p ON p."id" = pu."A"
        WHERE u."userId" = ANY($1::int[]) AND p."parentPostId" IS NULL AND p."status" = 'PRIVATE'
        ORDER BY u."createdAt" DESC, u."id" DESC
        LIMIT $2`,
      [readers, LIST_FILES]
    );
  }

  /** How many of the caller's posts carry each category, by id. */
  private async tagCounts(
    { readers, caller }: VaultCaller,
    factiiiIds: number[] | null
  ): Promise<Map<number, number>> {
    const rows = await this.db.query<{ factiiiId: number; posts: number }>(
      `SELECT c."factiiiId", count(DISTINCT p."id")::int AS "posts"
         FROM "PostFactiiiCount" c
         JOIN "Post" p ON p."id" = c."postId"
         ${POST_UPLOAD}
        WHERE ${MINE} AND ($3::int[] IS NULL OR c."factiiiId" = ANY($3::int[]))
        GROUP BY c."factiiiId"`,
      [readers, Number(caller), factiiiIds]
    );
    return new Map(rows.map((row) => [Number(row.factiiiId), row.posts]));
  }

  /** list_my_tags: every category on the caller's posts that the tree
   *  names, with how many carry it. */
  async listTags(entered: VaultCaller, tree: RunnerCategoryTree) {
    const names = new Map(tree.nodes.map((node) => [node.id, node.name]));
    const counts = await this.tagCounts(entered, null);
    return [...counts]
      .flatMap(([id, posts]) => {
        const name = names.get(id);
        return name ? [{ name, posts }] : [];
      })
      .sort((a, b) => b.posts - a.posts || a.name.localeCompare(b.name));
  }

  /** search_my_tags: the caller's posts tagged with the category named
   *  `factiii`, newest first, each with every category it carries. */
  async searchTags({ readers, caller }: VaultCaller, tree: RunnerCategoryTree, factiii: string) {
    const wanted = factiii.trim().toLowerCase();
    const ids = tree.nodes.filter((node) => node.name.toLowerCase() === wanted).map((n) => n.id);
    if (ids.length === 0) return [];
    const rows = await this.db.query<{
      uploadId: string | null;
      postUuid: string;
      title: string | null;
      factiiiIds: number[];
      createdAt: string;
      snippet: string;
    }>(
      `SELECT u."id" AS "uploadId", p."uuid"::text AS "postUuid", p."title",
              (SELECT array_agg(DISTINCT c2."factiiiId") FROM "PostFactiiiCount" c2
                WHERE c2."postId" = p."id") AS "factiiiIds",
              ${utc('p."createdAt"')} AS "createdAt",
              left(p."content", ${SNIPPET_CHARS}) AS "snippet"
         FROM "Post" p
         ${POST_UPLOAD}
        WHERE ${MINE}
          AND EXISTS (SELECT 1 FROM "PostFactiiiCount" c
                       WHERE c."postId" = p."id" AND c."factiiiId" = ANY($3::int[]))
        ORDER BY p."createdAt" DESC, p."id" DESC
        LIMIT $4`,
      [readers, Number(caller), ids, TAG_HITS]
    );
    const names = new Map(tree.nodes.map((node) => [node.id, node.name]));
    return rows.map(({ factiiiIds, ...row }) => ({
      ...row,
      factiiis: (factiiiIds ?? [])
        .flatMap((id) => names.get(Number(id)) ?? [])
        .sort()
        .join(', ')
    }));
  }

  /** list_my_ontology: the tree's roots, their rules, what hangs under
   *  each, and how many of the caller's posts each caught. */
  async listOntology(
    entered: VaultCaller,
    tree: RunnerCategoryTree,
    opts: { query?: string; cursor?: number; limit?: number }
  ) {
    const byId = new Map(tree.nodes.map((node) => [node.id, node]));
    const roots = tree.roots.flatMap((id) => byId.get(id) ?? []);
    roots.sort((a, b) => a.name.localeCompare(b.name));
    const childrenOf = new Map<number, string[]>();
    for (const edge of tree.edges) {
      const child = byId.get(edge.childId);
      if (child) childrenOf.set(edge.parentId, [...(childrenOf.get(edge.parentId) ?? []), child.name]);
    }
    return ontologyPage(
      roots,
      (rootId) => childrenOf.get(rootId) ?? [],
      (rootIds) => this.tagCounts(entered, rootIds),
      opts
    );
  }
}

/** What one turn's tools run with. */
export type AskToolsContext = {
  tools: VaultAskTools;
  entered: VaultCaller;
  /** One file's text for the caller, cut at `chars` (RunnerVault.askText). */
  read(id: string, chars: number): Promise<{ file: RunnerVaultFile; text: string } | null>;
  /** The tree's categories, when the app sent it. */
  categories?: RunnerCategoryTree;
  /** Keep a note; null for a turn that may not (a member's). */
  save: ((title: string, body: string) => Promise<RunnerVaultNote>) | null;
  /** A step in Ask's work line. */
  step(label: string): void;
  /** A file a tool read: one of the turn's sources. */
  onRead(file: RunnerVaultFile): void;
};

const TAG_TOOLS: ResearchToolName[] = ['search_my_tags', 'list_my_tags', 'list_my_ontology'];

/**
 * One turn's tools: the cloud's file tools this turn may use, in the cloud's
 * order, as the models read them, and `call`, which runs one and answers it
 * as the cloud does: JSON, or "Tool failed: …". Each call is two steps in the
 * work line, as on the cloud: what it is doing (describeToolCall), then
 * what it found (describeToolResult).
 */
export function askResearchTools(ctx: AskToolsContext): AskTools {
  const offered = researchToolNames('files').filter(
    (name) =>
      (name !== 'save_research' || ctx.save !== null) &&
      (!TAG_TOOLS.includes(name) || ctx.categories !== undefined)
  );

  // `args` has passed the tool's own schema (parseToolInput).
  const run = async (name: ResearchToolName, args: Record<string, unknown>): Promise<unknown> => {
    const tree = ctx.categories as RunnerCategoryTree;
    switch (name) {
      case 'search_my_files':
        return ctx.tools.searchFiles(ctx.entered, String(args.query), args.exact === true);
      case 'list_my_files':
        return ctx.tools.listFiles(ctx.entered);
      case 'search_my_tags':
        return ctx.tools.searchTags(ctx.entered, tree, String(args.factiii));
      case 'list_my_tags':
        return ctx.tools.listTags(ctx.entered, tree);
      case 'list_my_ontology':
        return ctx.tools.listOntology(ctx.entered, tree, {
          ...(typeof args.query === 'string' ? { query: args.query } : {}),
          ...(typeof args.cursor === 'number' ? { cursor: args.cursor } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {})
        });
      case 'read_my_file': {
        // One past the cut, to tell a whole file from a cut one.
        const got = await ctx.read(String(args.uploadId), READ_CHARS + 1);
        if (!got) return { error: 'No such file for this user.' };
        ctx.onRead(got.file);
        return {
          name: got.file.name,
          text: got.text.slice(0, READ_CHARS),
          truncated: got.text.length > READ_CHARS
        };
      }
      case 'save_research': {
        if (!ctx.save) throw new Error('Only the owner of this runner keeps notes on it.');
        const note = await ctx.save(String(args.title), String(args.body));
        return { postUuid: note.id, title: note.title };
      }
      default:
        throw new Error(`No tool named ${name}.`);
    }
  };

  return {
    defs: researchToolDefs(offered),
    async call(name, input) {
      ctx.step(describeToolCall(name, input).label);
      let out: string;
      if (!isResearchTool(name) || !offered.includes(name)) {
        out = `Tool failed: no tool named ${name}.`;
      } else {
        const parsed = parseToolInput(name, input);
        out = parsed.ok
          ? await run(name, parsed.input as Record<string, unknown>).then(
              (result) => JSON.stringify(result),
              (err: unknown) => `Tool failed: ${err instanceof Error ? err.message : String(err)}`
            )
          : `Tool failed: ${parsed.error}`;
      }
      const outcome = describeToolResult(name, input, out);
      if (outcome) ctx.step(outcome);
      return out;
    }
  };
}
