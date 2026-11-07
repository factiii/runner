import { z } from 'zod';

// What the IDE's git panel asks a runner to do (`bareGitAct`). One schema for
// the client (the commit box's checks) and the runner (which parses every op
// before it reaches git). See .specs/ide-git-panel.md.
//
// These are shape checks only. What a name or a path may be is the runner's
// to decide against the repository (git-panel-write.ts): a branch is checked
// with `git check-ref-format`, a path with toRepoRelative, a commit with
// `merge-base --is-ancestor`.

const pathSchema = z.string().min(1).max(4096);
const pathsSchema = z.array(pathSchema).max(5000);
const branchSchema = z.string().trim().min(1).max(255);
const shaSchema = z.string().regex(/^[0-9a-f]{4,40}$/i, 'Not a commit id');

/** GitHub Desktop's limits are softer (it only warns past 50); past this a
 *  summary is a paragraph in the wrong box. */
export const COMMIT_SUMMARY_MAX = 500;
export const COMMIT_DESCRIPTION_MAX = 20_000;
/** A partial patch is one file's selected lines; nothing near this. */
export const GIT_PATCH_MAX = 2 * 1024 * 1024;

export const commitMessageSchema = z.object({
  summary: z
    .string()
    .trim()
    .min(1, 'A commit needs a summary.')
    .max(COMMIT_SUMMARY_MAX),
  description: z.string().max(COMMIT_DESCRIPTION_MAX),
  amend: z.boolean()
});

/** The branch the client's button named ("Commit to <branch>", Push
 *  origin). The agent in the session's terminal can switch branch under the
 *  panel, so the runner refuses a commit or push when HEAD is no longer on
 *  it. Absent from an older client, which is not checked. */
const expectBranchSchema = z.string().max(255).optional();

export const bareGitOpSchema = z.discriminatedUnion('kind', [
  // Include / exclude whole files (the checkboxes). [] is every file.
  z.object({ kind: z.literal('stage'), paths: pathsSchema }),
  z.object({ kind: z.literal('unstage'), paths: pathsSchema }),
  // Include / exclude some lines: a patch against the index, never the tree.
  z.object({
    kind: z.literal('applyPatch'),
    patch: z.string().min(1).max(GIT_PATCH_MAX),
    reverse: z.boolean()
  }),
  // Back to HEAD, staged and unstaged alike. [] is every changed file.
  z.object({ kind: z.literal('discard'), paths: pathsSchema }),
  z.object({ kind: z.literal('ignore'), path: pathSchema }),
  commitMessageSchema.extend({
    kind: z.literal('commit'),
    expectBranch: expectBranchSchema
  }),
  z.object({ kind: z.literal('undo'), sha: shaSchema }),
  z.object({ kind: z.literal('revert'), sha: shaSchema }),
  z.object({
    kind: z.literal('createBranch'),
    name: branchSchema,
    /** A commit to start it at; absent is HEAD. */
    from: shaSchema.optional()
  }),
  z.object({
    kind: z.literal('switchBranch'),
    branch: branchSchema,
    /** Stash the uncommitted changes on the branch being left ("leave them
     *  on <branch>") instead of carrying them over ("bring my changes"). */
    leaveChanges: z.boolean()
  }),
  z.object({
    kind: z.literal('renameBranch'),
    branch: branchSchema,
    name: branchSchema
  }),
  z.object({ kind: z.literal('deleteBranch'), branch: branchSchema }),
  /** Merge `branch` into the checked-out one. */
  z.object({ kind: z.literal('merge'), branch: branchSchema }),
  /** Abort the merge or revert in progress. */
  z.object({ kind: z.literal('abort') }),
  z.object({ kind: z.literal('fetch') }),
  z.object({ kind: z.literal('pull') }),
  z.object({ kind: z.literal('push'), expectBranch: expectBranchSchema }),
  z.object({ kind: z.literal('stashRestore'), sha: shaSchema }),
  z.object({ kind: z.literal('stashDrop'), sha: shaSchema })
]);

export type BareGitOp = z.infer<typeof bareGitOpSchema>;
export type BareGitOpKind = BareGitOp['kind'];
