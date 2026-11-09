import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import type {
  SkillLinkState,
  SkillScope,
  SkillStatus,
  SkillSummary
} from '../../domains/electron';
import type { SkillFrontmatter } from '../../validators';
import { SKILL_DIR_NAME_REGEX, SKILL_NAME_REGEX } from '../../validators';
import { type AgentHomes, cliHomes, defaultAgentHomes } from './agent-homes';
import { buildCloneUrl } from './git';
import { gitCatFileBatch, hostGit, hostGitRemote } from './host-deploy';
import { libraryOriginOf } from '../librarySkill';
import { skillMentions } from '../skillConnections';
import { parseSkill, resolveSkillDir } from './skill-format';
import { hostSpacePaths } from './spacePaths';

// Host-side plumbing behind the board's Skills modal. Global skills are written
// straight to the host and apply at once; repo skills are read at a ref and can
// only change through a merge, the gate approveDeploySkill already uses.
// Repo reads never use a checkout: the primary clone (paths.repo) is frozen at
// clone time and drifts from origin, so everything goes through <spaceDir>/workspace.

/** The one place skills live. Every agent CLI is pointed here; Claude Code is
 *  the exception: one symlink at `.claude/skills` points at it. */
const AGENTS_ROOT = '.agents/skills';
const CLAUDE_ROOT = '.claude/skills';
/** The per-CLI roots in a REPO. Each one becomes a symlink to
 *  `.agents/skills`, and any skill still sitting in one is moved out first. */
const CLI_ROOTS = [CLAUDE_ROOT, '.codex/skills'];

/** Personal skills live in the host user's real home, `~/.agents/skills`: the
 *  one canonical root, which the person's own sessions may read too. */
export function globalAgentsRoot(home: string = os.homedir()): string {
  return path.join(home, '.agents', 'skills');
}

/** The host's per-CLI skill roots: `skills/` in the homes the CLIs use here.
 *  On a runner those are its own (agent-homes.ts), not `~/.claude` and
 *  `~/.codex`: a link in the default homes would reach the person's own
 *  sessions and never the runner's. Each becomes a symlink to the canonical
 *  root, like the repo ones. */
function hostCliSkillDirs(homes: AgentHomes = cliHomes()): string[] {
  return [path.join(homes.claude, 'skills'), path.join(homes.codex, 'skills')];
}

/** Does this link resolve to the canonical root? A link made before the
 *  runner had its own homes is relative (`../.agents/skills`); one made since
 *  is absolute, since the runner's homes are not one level under `~`. */
function linksToAgentsRoot(
  linkPath: string,
  target: string,
  agentsRoot: string
): boolean {
  const resolved = path.resolve(
    path.dirname(linkPath),
    target.replace(/\/+$/, '')
  );
  return resolved === agentsRoot;
}

/** In a repo, `.claude/skills` and `.codex/skills` are both one level deep, so
 *  the link back to `.agents/skills` is a single `../`. One link per root
 *  covers every skill under it. (On the host the link is absolute; see
 *  linksToAgentsRoot.) */
const AGENTS_LINK_TARGET = '../.agents/skills';

const BRANCH_PREFIX = 'skill/';

/** The one branch `migrateSkillsImpl` writes. Named here because the list path
 *  reports it too: an open migration is what the modal's gate has to show
 *  instead of offering to propose the same thing again. */
export const MIGRATE_BRANCH = `${BRANCH_PREFIX}migrate`;

/** Git's mode for a symlink blob, as reported by `ls-tree`. */
const SYMLINK_MODE = '120000';

export type SkillsOverview = {
  global: SkillSummary[];
  repo: SkillSummary[];
  /** Whether `.claude/skills` links to `.agents/skills`. Anything but
   *  `linked` blocks the modal until the user migrates. */
  globalLink: SkillLinkState;
  repoLink: SkillLinkState;
  /** Default branch the repo skills were read from. */
  repoBranch: string;
  /** False when the space has no repo configured, so the UI can explain the
   *  gap rather than show an empty list that reads as "no skills". */
  repoAvailable: boolean;
  /** `skill/migrate` when a migration is pushed and still unmerged, else ''.
   *  The gate stays up until the merge lands, so without this the only thing
   *  it could offer is a second propose - which is what the user reads as the
   *  first one having failed. */
  repoMigrationBranch: string;
  /** Skills that landed on the default branch after that migration was pushed,
   *  so its branch no longer moves all of them. Empty is the normal case. */
  repoMigrationMissing: string[];
};

/** The `origin` field, present only for a copy of a library skill. */
const originOf = (raw: string): Pick<SkillSummary, 'origin'> => {
  const origin = libraryOriginOf(raw);
  return origin ? { origin } : {};
};

function summarize(
  raw: string,
  base: Omit<SkillSummary, 'description' | 'errors'>
): SkillSummary {
  const { frontmatter, errors } = parseSkill(raw);
  return {
    ...base,
    description: frontmatter.description,
    errors,
    // Read here, while the file is open, so the Skills tab draws how skills
    // connect without reading each one again.
    uses: skillMentions(raw),
    // Whether the library has moved on is the server's to say; the runner
    // only reports what the copy records.
    ...originOf(raw)
  };
}

/** Does one CLI skill dir point at `~/.agents/skills`? */
async function rootLinkState(linkPath: string): Promise<SkillLinkState> {
  const stat = await fs.lstat(linkPath).catch(() => null);
  if (!stat) return 'missing';
  if (!stat.isSymbolicLink()) return 'blocked';
  const target = await fs.readlink(linkPath).catch(() => '');
  return target && linksToAgentsRoot(linkPath, target, globalAgentsRoot())
    ? 'linked'
    : 'missing';
}

/** Both CLIs need a link in their home. Codex reads `.agents/skills`
 *  natively inside a repo, but that scan runs from the cwd up to the repo root
 *  and never reaches `~/.agents/skills`. So codex's `skills` needs the link
 *  exactly as claude's does. */
async function globalLinkState(): Promise<SkillLinkState> {
  const states = await Promise.all(hostCliSkillDirs().map(rootLinkState));
  if (states.includes('blocked')) return 'blocked';
  return states.includes('missing') ? 'missing' : 'linked';
}

/** Every skill under the host's `~/.agents/skills`. A missing root is normal:
 *  it just means no personal skills have been written yet. */
async function listGlobal(): Promise<SkillSummary[]> {
  const root = globalAgentsRoot();
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch(() => []);
  const out: SkillSummary[] = [];
  for (const entry of entries) {
    if (entry.isFile()) continue;
    const dir = path.join(root, entry.name);
    const raw = await fs
      .readFile(path.join(dir, 'SKILL.md'), 'utf-8')
      .catch(() => '');
    if (!raw) continue;
    out.push(
      summarize(raw, {
        name: entry.name,
        scope: 'global',
        dir,
        status: 'live',
        pendingBranch: ''
      })
    );
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Same, from the repo tree: a committed SKILL.md outside `.agents/skills`. */
export function strayRepoSkills(liveBlobs: Map<string, string>): string[] {
  return [...liveBlobs.keys()]
    .filter((key) => CLI_ROOTS.some((root) => key.startsWith(`${root}/`)))
    .sort();
}

export type TreeEntry = { mode: string; sha: string; filePath: string };

/** `ls-tree -r` over the skill roots at one ref. Roots absent from that ref are
 *  simply missing from the output, so one call covers all three. */
async function treeAt(repo: string, ref: string): Promise<TreeEntry[]> {
  const raw = await hostGit(
    repo,
    'ls-tree',
    '-r',
    ref,
    '--',
    AGENTS_ROOT,
    ...CLI_ROOTS
  ).catch(() => '');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // `<mode> <type> <sha>\t<path>`
      const [meta, filePath] = line.split('\t');
      const [mode, , sha] = meta.split(/\s+/);
      return { mode, sha, filePath };
    })
    .filter((entry) => Boolean(entry.filePath));
}

/** `<root>/<name>` -> the SKILL.md blob sha under it. */
export function skillBlobs(entries: TreeEntry[]): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const entry of entries) {
    const match = /^(.+\/skills)\/([^/]+)\/SKILL\.md$/.exec(entry.filePath);
    if (match) blobs.set(`${match[1]}/${match[2]}`, entry.sha);
  }
  return blobs;
}

/** Symlinked skill dirs, as `<root>/<name>` -> link target text. */
async function skillLinks(
  repo: string,
  entries: TreeEntry[]
): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  // Both shapes matter: `<root>/skills` is the directory link this model uses,
  // and `<root>/skills/<name>` is a per-skill link left by the old one.
  const linkEntries = entries.filter(
    (entry) =>
      entry.mode === SYMLINK_MODE &&
      /^.+\/skills(\/[^/]+)?$/.test(entry.filePath)
  );
  const targets = await gitCatFileBatch(
    repo,
    linkEntries.map((entry) => entry.sha)
  );
  for (const entry of linkEntries) {
    const target = targets.get(entry.sha)?.trim();
    if (target) links.set(entry.filePath, target);
  }
  return links;
}

export type PendingBranch = { branch: string; blobs: Map<string, string> };

/** One repo skill, resolved but not yet read. Pure: comparing blob shas is the
 *  whole of the merge-state logic, so it is separated from the git IO and
 *  tested directly. */
export type ResolvedRepoSkill = {
  name: string;
  /** `.agents/skills/<name>`, the skill's canonical repo-relative dir. */
  dir: string;
  status: SkillStatus;
  pendingBranch: string;
  /** Blob to read the SKILL.md from: the merged one when there is one, else
   *  the branch copy so a pending-new skill still renders. */
  sha: string;
};

/** Classify every skill in `.agents/skills`, across the default branch and any
 *  unmerged `skill/*` branches. `links` maps a symlinked dir to its target, and
 *  is what decides whether Claude Code can actually load each skill. */
export function resolveRepoSkills(
  liveBlobs: Map<string, string>,
  pending: PendingBranch[]
): ResolvedRepoSkill[] {
  const keys = new Set<string>();
  for (const key of liveBlobs.keys()) {
    if (key.startsWith(`${AGENTS_ROOT}/`)) keys.add(key);
  }
  for (const entry of pending) {
    for (const key of entry.blobs.keys()) {
      if (key.startsWith(`${AGENTS_ROOT}/`)) keys.add(key);
    }
  }

  const out: ResolvedRepoSkill[] = [];
  for (const key of [...keys].sort()) {
    const name = key.slice(AGENTS_ROOT.length + 1);
    const live = liveBlobs.get(key) || '';
    const onBranch = pending.find((entry) => {
      const sha = entry.blobs.get(key);
      return Boolean(sha) && sha !== live;
    });
    const status: SkillStatus = live
      ? onBranch
        ? 'pending-edit'
        : 'live'
      : 'pending-new';

    out.push({
      name,
      dir: key,
      status,
      pendingBranch: status === 'live' ? '' : onBranch?.branch || '',
      sha: live || onBranch?.blobs.get(key) || ''
    });
  }
  return out;
}

async function repoSkills(ctx: RepoContext): Promise<SkillSummary[]> {
  const skills = resolveRepoSkills(ctx.liveBlobs, ctx.pending);
  // Blob -> text for this call only. It dedupes shas repeated across pending
  // branches; nothing outside needs it.
  const cache = new Map<string, string>();
  const missing = skills
    .map((skill) => skill.sha)
    .filter((sha) => sha && !cache.has(sha));
  for (const [sha, text] of await gitCatFileBatch(ctx.repo, missing)) {
    cache.set(sha, text);
  }
  return skills.map((skill) =>
    summarize(cache.get(skill.sha) ?? '', {
      name: skill.name,
      scope: 'repo',
      dir: skill.dir,
      status: skill.status,
      pendingBranch: skill.pendingBranch
    })
  );
}

/** Unmerged `skill/*` branches, newest first, with their skill blobs. Mirrors
 *  the deploy harness's draft discovery (checkDeployStatus). */
async function pendingBranches(
  repo: string,
  mainBranch: string
): Promise<PendingBranch[]> {
  const refs = await hostGit(
    repo,
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)',
    `refs/remotes/origin/${BRANCH_PREFIX}*`
  ).catch(() => '');

  const branches = await Promise.all(
    refs
      .split('\n')
      .filter(Boolean)
      .map(async (ref) => {
        // A merged branch that was never deleted still differs from main once
        // main moves on, so comparing blobs alone reports it as pending for
        // ever. Contained in main means merged (or behind): not a proposal.
        const merged = await hostGit(
          repo,
          'merge-base',
          '--is-ancestor',
          ref,
          `origin/${mainBranch}`
        ).then(
          () => true,
          () => false
        );
        if (merged) return null;
        return {
          branch: ref.replace(/^origin\//, ''),
          blobs: skillBlobs(await treeAt(repo, ref))
        };
      })
  );
  return branches.filter((entry): entry is PendingBranch => entry !== null);
}

export type SkillsRepoOpts = {
  spaceDir: string;
  repoUrl?: string;
  mainBranch?: string;
  githubToken?: string;
};

function requireRepo(opts: SkillsRepoOpts): {
  spaceDir: string;
  repoUrl: string;
  mainBranch?: string;
  githubToken: string;
} {
  if (!opts.repoUrl || !opts.githubToken) {
    throw new Error('Set the repository URL and GitHub token first.');
  }
  return {
    spaceDir: opts.spaceDir,
    repoUrl: opts.repoUrl,
    mainBranch: opts.mainBranch,
    githubToken: opts.githubToken
  };
}

type RepoContext = {
  /** The space's primary clone. Reads only: no checkout happens here. */
  repo: string;
  branch: string;
  liveTree: TreeEntry[];
  liveBlobs: Map<string, string>;
  links: Map<string, string>;
  pending: PendingBranch[];
};

/** One workspace fetch and one tree read, shared by every repo path. Reading a
 *  single skill resolves it from here rather than listing everything again. */
/** The space's primary clone, cloned on first use and always fetched. Skills
 *  read straight out of it: `ls-tree` and `cat-file` need no checkout, so no
 *  working tree is touched and nothing can collide with a card or terminal. */
async function ensureSkillsRepo(opts: SkillsRepoOpts): Promise<{
  repo: string;
  branch: string;
}> {
  const { spaceDir, repoUrl, mainBranch, githubToken } = requireRepo(opts);
  const paths = hostSpacePaths(spaceDir);
  const branch = (mainBranch || 'main').replace(/[^\w./-]/g, '');
  const url = buildCloneUrl(repoUrl);

  try {
    await hostGit(paths.repo, 'rev-parse', '--git-dir');
    // The plain URL: this also takes out a token an older runner put there.
    await hostGit(paths.repo, 'remote', 'set-url', 'origin', url);
  } catch {
    await hostGitRemote(
      paths.root,
      githubToken,
      'clone',
      '--branch',
      branch,
      url,
      paths.repo
    );
  }
  // One fetch covers the default branch and every draft, so nothing below can
  // read a stale ref.
  await hostGitRemote(
    paths.repo,
    githubToken,
    'fetch',
    'origin',
    branch,
    `+refs/heads/${BRANCH_PREFIX}*:refs/remotes/origin/${BRANCH_PREFIX}*`
  );
  return { repo: paths.repo, branch };
}

/** A worktree of its own for the write paths. `--detach` keeps it off every
 *  branch until a propose checks one out, so it never blocks a card, a
 *  terminal or deploy from using the branch it wants. */
async function ensureSkillsWorktree(
  spaceDir: string,
  branch: string
): Promise<string> {
  const { repo, skills: worktree } = hostSpacePaths(spaceDir);
  try {
    await hostGit(worktree, 'rev-parse', '--git-dir');
  } catch {
    // Drop bookkeeping for a dir that no longer exists, else `add` refuses.
    await hostGit(repo, 'worktree', 'prune').catch(() => {});
    await fs.rm(worktree, { recursive: true, force: true });
    await hostGit(
      repo,
      'worktree',
      'add',
      '--detach',
      worktree,
      `origin/${branch}`
    );
  }
  return worktree;
}

async function repoContext(opts: SkillsRepoOpts): Promise<RepoContext> {
  const { repo, branch } = await ensureSkillsRepo(opts);
  const liveTree = await treeAt(repo, `origin/${branch}`);
  const [links, pending] = await Promise.all([
    skillLinks(repo, liveTree),
    pendingBranches(repo, branch)
  ]);
  return {
    repo,
    branch,
    liveTree,
    liveBlobs: skillBlobs(liveTree),
    links,
    pending
  };
}

function findRepoSkill(
  ctx: RepoContext,
  name: string
): ResolvedRepoSkill | null {
  return (
    resolveRepoSkills(ctx.liveBlobs, ctx.pending).find(
      (skill) => skill.name === name
    ) ?? null
  );
}

/** One skills operation per space at a time. Every entry point below runs git
 *  in the same clone, and two at once raced the first clone: both saw no git
 *  dir, both ran `git clone`, and the loser failed with "destination path
 *  already exists". `checkout -B` and `clean -fd` are as unsafe to interleave. */
const workspaceQueues = new Map<string, Promise<unknown>>();

function withWorkspace<T>(spaceDir: string, run: () => Promise<T>): Promise<T> {
  // Chain onto whatever is queued, and never let a rejection break the chain.
  const next = (workspaceQueues.get(spaceDir) ?? Promise.resolve()).then(
    run,
    run
  );
  workspaceQueues.set(
    spaceDir,
    next.catch(() => {})
  );
  return next;
}

/** Is `.claude/skills` a link to `.agents/skills` at this ref? A committed
 *  SKILL.md under it means a real directory, which a link cannot replace. */
function repoLinkState(ctx: RepoContext): SkillLinkState {
  const target = ctx.links.get(CLAUDE_ROOT);
  if (target) return target === AGENTS_LINK_TARGET ? 'linked' : 'missing';
  return [...ctx.liveBlobs.keys()].some((key) =>
    key.startsWith(`${CLAUDE_ROOT}/`)
  )
    ? 'blocked'
    : 'missing';
}

/** Everything the Skills modal lists: both global roots (from disk) and both
 *  repo roots (from `origin/<branch>` plus any unmerged skill/* branches). */
async function listSkillsImpl(opts: SkillsRepoOpts): Promise<SkillsOverview> {
  const [global, globalLink] = await Promise.all([
    listGlobal(),
    globalLinkState()
  ]);

  if (!opts.repoUrl || !opts.githubToken) {
    return {
      global,
      repo: [],
      globalLink,
      repoLink: 'linked',
      repoBranch: '',
      repoAvailable: false,
      repoMigrationBranch: '',
      repoMigrationMissing: []
    };
  }

  // Always fetch. Listing against a stale ref shows merged work as pending and
  // keeps the migration gate up after the merge has landed.
  const ctx = await repoContext(opts);
  const repo = await repoSkills(ctx);
  const migration = openMigration(ctx.liveBlobs, ctx.pending);
  return {
    global,
    repo,
    globalLink,
    repoLink: repoLinkState(ctx),
    repoBranch: ctx.branch,
    repoAvailable: true,
    repoMigrationBranch: migration.branch,
    repoMigrationMissing: migration.missing
  };
}

export type SkillDetail = {
  name: string;
  scope: SkillScope;
  content: string;
  frontmatter: SkillFrontmatter;
  errors: string[];
  /** Everything else in the skill dir, dir-relative. Listed for context; v1
   *  does not edit bundle files. */
  bundleFiles: string[];
  status: SkillStatus;
  pendingBranch: string;
};

/** Files under a global skill dir other than SKILL.md. Depth- and count-capped
 *  so a skill that vendored a dependency tree cannot hang the modal. */
async function bundleFilesOnDisk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, prefix: string, depth: number) => {
    if (depth > 3 || out.length >= 200) return;
    const entries = await fs
      .readdir(current, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), rel, depth + 1);
      } else if (rel !== 'SKILL.md') {
        out.push(rel);
      }
    }
  };
  await walk(dir, '', 0);
  return out.sort();
}

async function readSkillImpl(
  opts: SkillsRepoOpts & { scope: SkillScope; name: string }
): Promise<SkillDetail> {
  if (opts.scope === 'global') {
    const dir = resolveSkillDir(globalAgentsRoot(), opts.name);
    const content = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf-8');
    const { frontmatter, errors } = parseSkill(content);
    return {
      name: opts.name,
      scope: 'global',
      content,
      frontmatter,
      errors,
      bundleFiles: await bundleFilesOnDisk(dir),
      status: 'live',
      pendingBranch: ''
    };
  }

  // Reading follows a list that already refreshed; going to the network again
  // would just make opening a skill feel slow.
  const ctx = await repoContext(opts);
  const skill = findRepoSkill(ctx, opts.name);
  if (!skill) throw new Error(`No repo skill named ${opts.name}.`);

  // Open the pending draft when there is one, not the merged copy. Proposing
  // again commits onto that same branch, so editing the merged text would
  // silently revert whatever is already waiting to be reviewed there.
  const draft = skill.pendingBranch
    ? ctx.pending
        .find((entry) => entry.branch === skill.pendingBranch)
        ?.blobs.get(skill.dir)
    : '';
  const content = await hostGit(ctx.repo, 'cat-file', '-p', draft || skill.sha);
  const { frontmatter, errors } = parseSkill(content);
  const tree = draft
    ? await treeAt(ctx.repo, `origin/${skill.pendingBranch}`)
    : ctx.liveTree;
  const bundleFiles = tree
    .filter(
      (entry) =>
        entry.filePath.startsWith(`${skill.dir}/`) &&
        entry.filePath !== `${skill.dir}/SKILL.md`
    )
    .map((entry) => entry.filePath.slice(skill.dir.length + 1))
    .sort();

  return {
    name: skill.name,
    scope: 'repo',
    content,
    frontmatter,
    errors,
    bundleFiles,
    status: skill.status,
    pendingBranch: skill.pendingBranch
  };
}

/** Move one skill dir into the canonical root. Refuses to overwrite: a name in
 *  both roots is two different skills, and the user must decide. */
async function moveIntoAgents(from: string, to: string): Promise<void> {
  if (
    await fs.access(to).then(
      () => true,
      () => false
    )
  ) {
    throw new Error(
      `${path.basename(to)} exists in both roots. Remove one copy, then migrate.`
    );
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch {
    // CODEX_HOME can sit on another filesystem, where rename is EXDEV.
    await fs.cp(from, to, { recursive: true });
    await fs.rm(from, { recursive: true, force: true });
  }
}

/** Move every stray skill on the host into `~/.agents/skills`, then replace
 *  each CLI's `skills` dir (in the homes the CLIs use here) with one symlink.
 *  After this every skill is visible to every CLI, and a new skill needs no
 *  link of its own. */
async function migrateGlobal(): Promise<string[]> {
  const moved: string[] = [];
  const dirs = hostCliSkillDirs();
  for (const dir of dirs) {
    const stat = await fs.lstat(dir).catch(() => null);
    // A symlink here is already our own bridge; there is nothing to move.
    if (!stat || stat.isSymbolicLink()) continue;
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() || entry.isSymbolicLink()) continue;
      const src = path.join(dir, entry.name);
      if (
        !(await fs.access(path.join(src, 'SKILL.md')).then(
          () => true,
          () => false
        ))
      ) {
        continue;
      }
      await moveIntoAgents(src, path.join(globalAgentsRoot(), entry.name));
      moved.push(entry.name);
    }
    // Only remove what is now empty: anything left is not ours to delete.
    await fs.rmdir(dir).catch(() => {});
  }

  for (const linkPath of dirs) {
    const after = await fs.lstat(linkPath).catch(() => null);
    if (after?.isSymbolicLink()) await fs.rm(linkPath, { force: true });
    else if (after) {
      throw new Error(
        `${linkPath} still has files that are not skills. Empty it, then migrate.`
      );
    }
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(globalAgentsRoot(), linkPath, 'dir');
  }
  return moved;
}

/** Subject of the commit `migrateSkillsImpl` writes, and the only thing that
 *  identifies the migration branch as machine-written. A branch carrying
 *  anything else is somebody's work: a review commit pushed to it, or a
 *  proposal for a skill that is itself named `migrate` (a legal skill name, so
 *  `proposeRepoSkillImpl` targets the same branch). */
const MIGRATE_SUBJECT = /^Migrate \d+ skill\(s\) to /;

/** Are all of these commit subjects ones this file wrote? The whole of the
 *  "may I replace that branch" decision, so it is pure and tested directly.
 *  Vacuously true for an empty log - a branch contained in the default branch
 *  is merged or behind, and holds nothing to lose. */
export function migrationCommitsOnly(log: string): boolean {
  return log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .every((subject) => MIGRATE_SUBJECT.test(subject));
}

/** The migration branch as the modal has to show it. `pending` is already
 *  filtered to unmerged, so a hit here is exactly "proposed and still waiting".
 *  `missing` names the skills that branch would leave behind - committed to a
 *  CLI root on the default branch, but absent from the branch's
 *  `.agents/skills`, so they landed after it was pushed. Both answers come
 *  from one lookup because `missing` is meaningless without `branch`.
 *
 *  Only a missing skill counts. An *edit* to a stray the branch already moves
 *  merges fine: git follows the rename. */
export function openMigration(
  liveBlobs: Map<string, string>,
  pending: PendingBranch[]
): { branch: string; missing: string[] } {
  const onBranch = pending.find(
    (entry) => entry.branch === MIGRATE_BRANCH
  )?.blobs;
  if (!onBranch) return { branch: '', missing: [] };

  const missing = new Set<string>();
  for (const stray of strayRepoSkills(liveBlobs)) {
    const name = stray.slice(stray.lastIndexOf('/') + 1);
    if (!onBranch.has(`${AGENTS_ROOT}/${name}`)) missing.add(name);
  }
  return { branch: MIGRATE_BRANCH, missing: [...missing].sort() };
}

/** Same migration inside the repo, as one reviewable commit: `git mv` each
 *  stray into `.agents/skills`, then commit the `.claude/skills` symlink. */
async function migrateSkillsImpl(
  opts: SkillsRepoOpts & {
    scope: SkillScope;
    gitName?: string;
    gitEmail?: string;
  }
): Promise<{ branch: string; moved: string[]; pushed: boolean }> {
  if (opts.scope === 'global') {
    return { branch: '', moved: await migrateGlobal(), pushed: false };
  }

  const ctx = await repoContext(opts);
  const strays = strayRepoSkills(ctx.liveBlobs);
  const linked = ctx.links.get(CLAUDE_ROOT);
  if (!strays.length && linked === AGENTS_LINK_TARGET) {
    return { branch: '', moved: [], pushed: false };
  }

  const { branch } = ctx;
  const workspace = await ensureSkillsWorktree(opts.spaceDir, branch);
  const target = MIGRATE_BRANCH;
  const { githubToken } = requireRepo(opts);
  // Always rebuilt from `origin/<branch>`, so a second click before the merge
  // builds a commit *behind* the tip the first one pushed - a plain push is
  // rejected non-fast-forward. Ask the remote rather than the tracking ref:
  // the fetch refspec never prunes, so a deleted branch leaves its ref behind.
  const existing = await hostGitRemote(
    workspace,
    githubToken,
    'ls-remote',
    '--heads',
    'origin',
    target
  ).catch(() => '');
  if (existing.trim()) {
    await hostGitRemote(
      workspace,
      githubToken,
      'fetch',
      'origin',
      `+refs/heads/${target}:refs/remotes/origin/${target}`
    );
  }
  await hostGit(workspace, 'checkout', '-B', target, `origin/${branch}`);
  await hostGit(workspace, 'clean', '-fd');
  if (opts.gitName) {
    await hostGit(workspace, 'config', 'user.name', opts.gitName);
  }
  if (opts.gitEmail) {
    await hostGit(workspace, 'config', 'user.email', opts.gitEmail);
  }

  const moved: string[] = [];
  for (const stray of strays) {
    const name = stray.slice(stray.lastIndexOf('/') + 1);
    const dest = `${AGENTS_ROOT}/${name}`;
    if (ctx.liveBlobs.has(dest)) {
      throw new Error(
        `${name} exists in both ${AGENTS_ROOT} and ${stray}. Remove one copy, then migrate.`
      );
    }
    await fs.mkdir(path.join(workspace, AGENTS_ROOT), { recursive: true });
    await hostGit(workspace, 'mv', stray, dest);
    moved.push(name);
  }

  // The directory link replaces the per-skill links entirely.
  const linkPath = path.join(workspace, CLAUDE_ROOT);
  await fs.rm(linkPath, { recursive: true, force: true });
  await fs.symlink(AGENTS_LINK_TARGET, linkPath, 'dir');

  await hostGit(workspace, 'add', '-A');
  const dirty = await hostGit(workspace, 'status', '--porcelain');
  if (!dirty.trim()) return { branch: '', moved: [], pushed: false };
  await hostGit(
    workspace,
    'commit',
    '-m',
    `Migrate ${moved.length} skill(s) to ${AGENTS_ROOT} and link ${CLAUDE_ROOT}`
  );

  if (!existing.trim()) {
    await hostGitRemote(workspace, githubToken, 'push', 'origin', target);
    return { branch: target, moved, pushed: true };
  }
  // Same tree as the branch already waiting to merge: the first click did this
  // work, so report that branch rather than churning it with a new commit.
  const [rebuilt, onBranch] = await Promise.all([
    hostGit(workspace, 'rev-parse', 'HEAD^{tree}'),
    hostGit(workspace, 'rev-parse', `origin/${target}^{tree}`)
  ]);
  if (rebuilt.trim() === onBranch.trim()) {
    return { branch: target, moved, pushed: false };
  }

  // The rebuild differs, so the branch has to be replaced rather than added
  // to - it is rooted on today's default branch, not on the old tip. Replacing
  // is only ever safe for a branch this function alone wrote. (--force-with-
  // lease cannot stand in for this check: the fetch above satisfies the lease.)
  // No `.catch` here: an empty log means the branch holds nothing of anyone's,
  // but a *failed* log means we do not know - and defaulting an unknown to
  // "ours" is how a force-push eats somebody's commits. Let it throw.
  const log = await hostGit(
    workspace,
    'log',
    '--format=%s',
    `origin/${branch}..origin/${target}`
  );
  if (!migrationCommitsOnly(log)) {
    throw new Error(
      `${target} carries commits that are not this migration. Merge or delete that branch, then migrate.`
    );
  }
  await hostGitRemote(
    workspace,
    githubToken,
    'push',
    '--force-with-lease',
    'origin',
    target
  );
  return { branch: target, moved, pushed: true };
}

/** Reject a draft the CLIs would refuse to load, and keep the directory name
 *  and frontmatter name in agreement (both CLIs key the skill on the dir). */
function assertWritable(name: string, content: string): void {
  const parsed = parseSkill(content);
  if (parsed.errors.length) {
    throw new Error(`Fix the skill first: ${parsed.errors.join(' ')}`);
  }
  if (parsed.frontmatter.name !== name) {
    throw new Error(
      `Frontmatter name (${parsed.frontmatter.name}) must match the skill directory (${name}).`
    );
  }
}

/** Write one SKILL.md under `root`. `keepExisting` leaves an existing skill
 *  alone, which is what an owner's edit of a bundled skill deserves. */
async function writeSkillFile(opts: {
  root: string;
  name: string;
  content: string;
  keepExisting?: boolean;
}): Promise<void> {
  const dir = resolveSkillDir(opts.root, opts.name);
  const file = path.join(dir, 'SKILL.md');
  if (opts.keepExisting) {
    const exists = await fs.access(file).then(
      () => true,
      () => false
    );
    if (exists) return;
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, opts.content, 'utf-8');
}

/** Global skills are written straight to the host: no review, and every space
 *  this runner drives sees the change on its next agent run. */
export async function writeGlobalSkill(opts: {
  name: string;
  content: string;
}): Promise<void> {
  assertWritable(opts.name, opts.content);
  const root = globalAgentsRoot();
  const exists = await fs
    .access(path.join(resolveSkillDir(root, opts.name), 'SKILL.md'))
    .then(
      () => true,
      () => false
    );
  if (!exists) assertNewSkillName(opts.name);
  await writeSkillFile({ root, ...opts });
}

/** A skill being created must use the standard's name. One that already
 *  exists keeps its legacy name (SKILL_DIR_NAME_REGEX): renaming is a move of
 *  its directory, which is the owner's call, not a side effect of an edit. */
function assertNewSkillName(name: string): void {
  if (!SKILL_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid skill name: ${name}. Use lowercase letters, numbers and single dashes.`
    );
  }
}

/**
 * Install a skill this runner ships, where the CLIs will actually find it.
 *
 * The shared root is only reachable through a per-CLI symlink that
 * `migrateSkills` makes, and that runs only when the owner asks for it - so on
 * a host that never migrated, a skill written to the shared root sits where
 * nothing reads. An absent CLI root is free to claim; a real directory is the
 * owner's own skills and is left alone, with ours written in beside them.
 *
 * Never overwrites: a bundled skill is documentation the owner may edit, and
 * rewriting it every session would silently revert that. The cost is that
 * deleting it brings it back the next time the capability installs.
 */
export async function installBundledSkill(opts: {
  name: string;
  content: string;
  /** The home to install into. Injected rather than read from the environment
   *  so a test cannot write into the home of whoever runs it: under jest,
   *  `process.env.HOME` is a copy that never reaches the real environment
   *  `os.homedir()` reads. */
  home?: string;
  /** The CLI homes to link into. Default: with `home`, that home's
   *  `.claude`/`.codex`; without, the homes the CLIs use here (`cliHomes`,
   *  the runner's own once applied). */
  cliHomes?: AgentHomes;
}): Promise<void> {
  assertWritable(opts.name, opts.content);
  const home = opts.home ?? os.homedir();
  const homes =
    opts.cliHomes ?? (opts.home ? defaultAgentHomes(opts.home) : cliHomes());
  const agentsRoot = globalAgentsRoot(home);
  const write = (root: string): Promise<void> =>
    writeSkillFile({
      root,
      name: opts.name,
      content: opts.content,
      keepExisting: true
    });

  await write(agentsRoot);
  for (const linkPath of hostCliSkillDirs(homes)) {
    const stat = await fs.lstat(linkPath).catch(() => null);
    if (stat?.isSymbolicLink()) continue;
    if (!stat) {
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await fs.symlink(agentsRoot, linkPath, 'dir').catch(() => undefined);
      continue;
    }
    await write(linkPath);
  }
}

/**
 * Take back a skill an older runner installed with `installBundledSkill`, now
 * that the factiii plugin ships it. With both, every session listed the skill
 * twice (`share-a-port` and `factiii:share-a-port`), and the bundled copy,
 * never overwritten, kept whatever text it first shipped with.
 *
 * Only a copy still exactly as shipped goes: `content` is that text, and the
 * directory must hold nothing else. An edited copy, or one with files the
 * owner added, is theirs and stays. Symlinked CLI roots point at the shared
 * root, so only real ones are looked into.
 */
export async function retireBundledSkill(opts: {
  name: string;
  content: string;
  /** As in installBundledSkill: injected so a test never touches a real
   *  home. */
  home?: string;
  cliHomes?: AgentHomes;
}): Promise<void> {
  const home = opts.home ?? os.homedir();
  const homes =
    opts.cliHomes ?? (opts.home ? defaultAgentHomes(opts.home) : cliHomes());
  const roots = [globalAgentsRoot(home)];
  for (const linkPath of hostCliSkillDirs(homes)) {
    const stat = await fs.lstat(linkPath).catch(() => null);
    if (stat?.isDirectory()) roots.push(linkPath);
  }
  for (const root of roots) {
    const dir = resolveSkillDir(root, opts.name);
    const entries = await fs.readdir(dir).catch(() => null);
    if (entries?.length !== 1 || entries[0] !== 'SKILL.md') continue;
    const text = await fs
      .readFile(path.join(dir, 'SKILL.md'), 'utf-8')
      .catch(() => null);
    if (text === opts.content) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

/** Removes the whole skill directory, bundle files included. */
export async function deleteGlobalSkill(opts: { name: string }): Promise<void> {
  const dir = resolveSkillDir(globalAgentsRoot(), opts.name);
  await fs.rm(dir, { recursive: true, force: true });
}

/** Repo skills are never written in place. The edit rides a `skill/*` branch
 *  and stops there: merging it on GitHub is the approval gate, exactly as with
 *  the deploy contract (approveDeploySkill) and card pushes (cardFinalize).
 *  Re-proposing the same skill commits onto the existing branch rather than
 *  opening a competing one. */
async function proposeRepoSkillImpl(
  opts: SkillsRepoOpts & {
    name: string;
    content: string;
    gitName?: string;
    gitEmail?: string;
  }
): Promise<{ branch: string }> {
  assertWritable(opts.name, opts.content);
  if (!SKILL_DIR_NAME_REGEX.test(opts.name)) {
    throw new Error(`Invalid skill name: ${opts.name}`);
  }

  // Always fetch here: a push branched off a stale ref is the one case where
  // skipping the network is wrong.
  const ctx = await repoContext(opts);
  const known = findRepoSkill(ctx, opts.name);
  if (!known) assertNewSkillName(opts.name);
  const dir = known?.dir || `${AGENTS_ROOT}/${opts.name}`;

  const { branch } = ctx;
  const workspace = await ensureSkillsWorktree(opts.spaceDir, branch);
  const target = `${BRANCH_PREFIX}${opts.name}`;
  const { githubToken } = requireRepo(opts);
  const existing = await hostGitRemote(
    workspace,
    githubToken,
    'ls-remote',
    '--heads',
    'origin',
    target
  ).catch(() => '');

  if (existing.trim()) {
    await hostGitRemote(
      workspace,
      githubToken,
      'fetch',
      'origin',
      `+refs/heads/${target}:refs/remotes/origin/${target}`
    );
    await hostGit(workspace, 'checkout', '-B', target, `origin/${target}`);
  } else {
    await hostGit(workspace, 'checkout', '-B', target, `origin/${branch}`);
  }
  await hostGit(workspace, 'clean', '-fd');

  if (opts.gitName) {
    await hostGit(workspace, 'config', 'user.name', opts.gitName);
  }
  if (opts.gitEmail) {
    await hostGit(workspace, 'config', 'user.email', opts.gitEmail);
  }

  await fs.mkdir(path.join(workspace, dir), { recursive: true });
  await fs.writeFile(
    path.join(workspace, dir, 'SKILL.md'),
    opts.content,
    'utf-8'
  );

  const dirty = await hostGit(workspace, 'status', '--porcelain');
  if (!dirty.trim()) return { branch: target };

  await hostGit(workspace, 'add', '-A');
  await hostGit(
    workspace,
    'commit',
    '-m',
    `${known ? 'Update' : 'Add'} skill: ${opts.name}`
  );
  await hostGitRemote(workspace, githubToken, 'push', 'origin', target);
  return { branch: target };
}

// ── Public entry points ──
// Each one runs git in the space workspace, so they are serialised per space.

export function listSkills(opts: SkillsRepoOpts): Promise<SkillsOverview> {
  return withWorkspace(opts.spaceDir, () => listSkillsImpl(opts));
}

export function readSkill(
  opts: SkillsRepoOpts & { scope: SkillScope; name: string }
): Promise<SkillDetail> {
  return withWorkspace(opts.spaceDir, () => readSkillImpl(opts));
}

export function migrateSkills(
  opts: SkillsRepoOpts & {
    scope: SkillScope;
    gitName?: string;
    gitEmail?: string;
  }
): Promise<{ branch: string; moved: string[]; pushed: boolean }> {
  return withWorkspace(opts.spaceDir, () => migrateSkillsImpl(opts));
}

export function proposeRepoSkill(
  opts: SkillsRepoOpts & {
    name: string;
    content: string;
    gitName?: string;
    gitEmail?: string;
  }
): Promise<{ branch: string }> {
  return withWorkspace(opts.spaceDir, () => proposeRepoSkillImpl(opts));
}
