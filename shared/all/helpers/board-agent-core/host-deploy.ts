import { execFile, spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { z } from 'zod';

import { spawnAgent } from './agent';
import { hostTarget } from './exec';
import {
  buildCloneUrl,
  githubAuth,
  sessionCredentialConfig,
  stripCloneUrlCredentials
} from './git';
import { execLogin } from './host-env';
import { buildPrompt } from './prompt';
import prompts from './prompts.json';
import { SECRETS_BIN } from './plugin';
import type { AgentProvider } from './providers';
import { secretsSocketPath } from './secrets-bridge';
import { hostSpacePaths } from './spacePaths';

const execFileAsync = promisify(execFile);

// Host-side deploy harness plumbing. The deploy skill runs on the runner
// runner host, against the per-space environment schema in
// .specs/deploy.md: <spaceDir>/{workspace,backups,builds,secrets}. This
// module owns the workspace clone and the skill-contract check behind the
// Deploy button.

// The deploy contract lives in the cross-agent skills layout that Codex (and
// Cursor, Gemini CLI, Copilot) discover natively. Claude Code discovers via
// a committed `.claude/skills/deploy` symlink to this directory, so BOTH
// providers load the skill through their own native mechanism.
const SKILL_DIR = '.agents/skills/deploy';
const SKILL_PATH = `${SKILL_DIR}/SKILL.md`;
const VARIABLES_PATH = `${SKILL_DIR}/required-variables.json`;
const CHECKER_PATH = `${SKILL_DIR}/check-environment.sh`;
// Per-lane runbook pages SKILL.md points at (the Agent Skills layout). Not
// part of the contract check; shown in review and editable by a revision.
const REFERENCES_DIR = 'references';
const CLAUDE_SKILLS_DIR = '.claude/skills';
const CLAUDE_LINK = `${CLAUDE_SKILLS_DIR}/deploy`;

/** Claude Code only scans .claude/skills, so the workspace carries a relative
 *  symlink to the canonical skill dir. Committed by the creator; also ensured
 *  on every run checkout so older contracts keep working. */
export async function ensureClaudeSkillLink(workspace: string): Promise<void> {
  const linkPath = path.join(workspace, CLAUDE_LINK);
  try {
    await fs.lstat(linkPath);
    return; // already there (link or real dir)
  } catch {
    // missing - create it
  }
  await fs.mkdir(path.join(workspace, CLAUDE_SKILLS_DIR), { recursive: true });
  await fs.symlink('../../.agents/skills/deploy', linkPath, 'dir');
}

// Every host git call disables credential helpers: the system osxkeychain
// helper would only ever pop a blocking keychain dialog and copy a token into
// a keychain we never read. A call to origin gets the token per command
// (hostGitRemote), never through a URL or a file.
const GIT_NO_HELPER = ['-c', 'credential.helper='];
// Read per call, not at load: the runner puts the tool dirs on its PATH after
// this module has loaded (host-env.ts addToolDirs).
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export async function hostGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...GIT_NO_HELPER, ...args], {
    cwd,
    env: gitEnv(),
    maxBuffer: GIT_MAX_BUFFER
  });
  return stdout;
}

/** hostGit for a command that talks to origin (clone, fetch, push,
 *  ls-remote): the GitHub token goes with this one command (githubAuth). */
export async function hostGitRemote(
  cwd: string,
  githubToken: string,
  ...args: string[]
): Promise<string> {
  const auth = githubAuth(githubToken);
  const { stdout } = await execFileAsync('git', [...auth.args, ...args], {
    cwd,
    env: { ...gitEnv(), ...auth.env },
    maxBuffer: GIT_MAX_BUFFER
  });
  return stdout;
}

/** One `cat-file --batch` for many blobs instead of a subprocess each. Returns
 *  sha -> contents; unreadable shas are simply absent. */
export async function gitCatFileBatch(
  cwd: string,
  shas: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(shas.filter(Boolean))];
  if (!wanted.length) return out;

  const child = spawn('git', [...GIT_NO_HELPER, 'cat-file', '--batch'], {
    cwd,
    env: gitEnv()
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => {
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
  child.stdin.end(`${wanted.join('\n')}\n`);
  await done;

  // Each record is `<sha> <type> <size>\n<size bytes>\n`, so the byte count
  // drives the walk - contents can hold anything, newlines included.
  let buf = Buffer.concat(chunks);
  while (buf.length) {
    const nl = buf.indexOf(0x0a);
    if (nl === -1) break;
    const header = buf.subarray(0, nl).toString('utf-8');
    buf = buf.subarray(nl + 1);
    const [sha, type, sizeText] = header.split(' ');
    // "<sha> missing" has no body to skip.
    if (type === undefined || sizeText === undefined) continue;
    const size = Number(sizeText);
    if (!Number.isFinite(size)) break;
    out.set(sha, buf.subarray(0, size).toString('utf-8'));
    buf = buf.subarray(size + 1);
  }
  return out;
}

export type DeployStatus = {
  hasSkill: boolean;
  hasVariables: boolean;
  hasChecker: boolean;
  branch: string;
  // Newest unmerged deploy-skill* branch carrying the full contract - a
  // pushed draft the review flow can load instead of regenerating.
  pendingBranch: string;
  // Parsed required-variables.json from the default branch (empty when
  // absent/invalid): drives the Secrets settings grouping.
  variables: RequiredVariable[];
};

/** One branch the Deploy button can ship. See `listReleaseBranches`. */
export type ReleaseBranch = {
  name: string;
  /** Commits it carries that the default branch does not; 0 = already merged. */
  ahead: number;
  /** Its last commit, epoch SECONDS (git's `committerdate:unix`). */
  updated: number;
  /** Subject line of that commit, so the picker shows what the branch is. */
  subject: string;
};

// One git operation at a time per space. The workspace clone, its fetches and
// the jobs worktree (engine.ts) share one .git: a job list fetching while a
// job resets its worktree, or two first calls both cloning, raced into
// "holds a git repository that cannot be read". Keyed by the space dir.
const spaceGitLocks = new Map<string, Promise<unknown>>();

/** Run `fn` with this space's git lock held. Not re-entrant: `fn` must not
 *  call ensureWorkspaceClone (which takes the lock itself). */
export function withSpaceGit<T>(
  spaceDir: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = path.resolve(spaceDir);
  const before = spaceGitLocks.get(key) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  spaceGitLocks.set(key, tail);
  // Drop the entry once nothing queued behind it, so the map does not grow.
  void tail.then(() => {
    if (spaceGitLocks.get(key) === tail) spaceGitLocks.delete(key);
  });
  return run;
}

const UNREADABLE_REPO = 'holds a git repository that cannot be read';

/** Clone-or-fetch `<spaceDir>/workspace` and hand back its path plus the
 *  sanitized default branch. Shared with the skills modal (host-skills.ts) so
 *  both read repo files from the same up-to-date clone, at a ref.
 *
 *  Holds the space's git lock, and retries once when the clone reads as
 *  unreadable: that was a lock held by a concurrent git process outside this
 *  runner's queue (an agent in a session), which clears in a moment. */
export async function ensureWorkspaceClone(opts: {
  spaceDir: string;
  repoUrl: string;
  mainBranch?: string;
  githubToken: string;
}): Promise<{ workspace: string; branch: string }> {
  return withSpaceGit(opts.spaceDir, async () => {
    try {
      return await cloneOrFetch(opts);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes(UNREADABLE_REPO)) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1000));
      return cloneOrFetch(opts);
    }
  });
}

/** The default branch as the workspace clone tracks it. */
function workspaceBranch(mainBranch?: string): string {
  return (mainBranch || 'main').replace(/[^\w./-]/g, '');
}

/**
 * Files on the default branch as the workspace clone last fetched them, with
 * no fetch and no lock: for a cheap status read (the attention badge), which
 * must not wait on a clone or reach GitHub. Null when there is no clone yet;
 * a file the branch lacks is null in its slot. Reading while a fetch runs is
 * safe: git swaps the ref only once the objects are in.
 */
export async function cachedOriginFiles(
  spaceDir: string,
  mainBranch: string | undefined,
  files: string[]
): Promise<(string | null)[] | null> {
  const workspace = path.join(spaceDir, 'workspace');
  try {
    await hostGit(workspace, 'rev-parse', '--git-dir');
  } catch {
    return null;
  }
  const branch = workspaceBranch(mainBranch);
  return Promise.all(
    files.map((file) =>
      hostGit(workspace, 'cat-file', '-p', `origin/${branch}:${file}`).catch(
        () => null
      )
    )
  );
}

async function cloneOrFetch(opts: {
  spaceDir: string;
  repoUrl: string;
  mainBranch?: string;
  githubToken: string;
}): Promise<{ workspace: string; branch: string }> {
  const workspace = path.join(opts.spaceDir, 'workspace');
  const branch = workspaceBranch(opts.mainBranch);
  const url = buildCloneUrl(opts.repoUrl);

  let cloned = false;
  try {
    await hostGit(workspace, 'rev-parse', '--git-dir');
    // The plain URL: this also takes out a token an older runner put there.
    await hostGit(workspace, 'remote', 'set-url', 'origin', url);
  } catch {
    // No usable repo here. A killed clone leaves files behind, and `git clone`
    // refuses a non-empty directory - which would fail forever. The workspace
    // is derived, so clear it. A present `.git` is left alone: that is a repo
    // git could not read, not leftovers, and deleting it could lose a branch.
    const leftovers = await fs.readdir(workspace).catch(() => [] as string[]);
    if (leftovers.includes('.git')) {
      throw new Error(`${workspace} ${UNREADABLE_REPO}. Remove it and retry.`);
    }
    for (const name of leftovers) {
      await fs.rm(path.join(workspace, name), { recursive: true, force: true });
    }
    await hostGitRemote(
      opts.spaceDir,
      opts.githubToken,
      'clone',
      '--branch',
      branch,
      url,
      workspace
    );
    cloned = true;
  }
  if (!cloned) {
    await hostGitRemote(workspace, opts.githubToken, 'fetch', 'origin', branch);
  }
  return { workspace, branch };
}

/** Take the token out of the deploy checkout's `origin`, when there is a
 *  checkout: it is its own clone, so the primary clone's rewrite does not
 *  reach it. Only the remote URL changes. Never throws; false means the URL
 *  could not be rewritten and may still carry the token. */
export async function stripWorkspaceOriginToken(
  spaceDir: string
): Promise<boolean> {
  const workspace = path.join(spaceDir, 'workspace');
  try {
    await fs.access(path.join(workspace, '.git'));
  } catch {
    // no checkout, nothing carries the token
    return true;
  }
  try {
    // Under the lock, so a clone-or-fetch in flight (which set the URL with
    // the token it was given) cannot write after this.
    await withSpaceGit(spaceDir, async () => {
      const origin = (
        await hostGit(workspace, 'remote', 'get-url', 'origin')
      ).trim();
      const stripped = stripCloneUrlCredentials(origin);
      if (stripped !== origin) {
        await hostGit(workspace, 'remote', 'set-url', 'origin', stripped);
      }
    });
    return true;
  } catch {
    // The reason is dropped: a git error can quote the URL, token and all.
    return false;
  }
}

/** Clone-or-fetch the host workspace, then report whether the default branch
 *  carries the deploy contract (SKILL.md + required-variables.json + check-environment.sh). */
export async function checkDeployStatus(opts: {
  spaceDir: string;
  repoUrl: string;
  mainBranch?: string;
  githubToken: string;
}): Promise<DeployStatus> {
  const { workspace, branch } = await ensureWorkspaceClone(opts);

  const has = async (refPath: string) => {
    try {
      await hostGit(workspace, 'cat-file', '-e', refPath);
      return true;
    } catch {
      return false;
    }
  };
  const hasAll = async (ref: string) =>
    (await has(`${ref}:${SKILL_PATH}`)) &&
    (await has(`${ref}:${VARIABLES_PATH}`)) &&
    (await has(`${ref}:${CHECKER_PATH}`));

  // Any pushed-but-unmerged skill drafts? Newest complete one is resumable.
  let pendingBranch = '';
  if (!(await hasAll(`origin/${branch}`))) {
    try {
      // --prune, limited to this refspec: a draft branch merged and deleted on
      // origin leaves its tracking ref behind for ever otherwise, and the
      // listing below would keep offering a Resume that cannot fetch.
      await hostGitRemote(
        workspace,
        opts.githubToken,
        'fetch',
        'origin',
        '--prune',
        '+refs/heads/deploy-skill*:refs/remotes/origin/deploy-skill*'
      );
      const refs = await hostGit(
        workspace,
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)',
        'refs/remotes/origin/deploy-skill*'
      );
      for (const ref of refs.split('\n').filter(Boolean)) {
        if (await hasAll(ref)) {
          pendingBranch = ref.replace(/^origin\//, '');
          break;
        }
      }
    } catch {
      // no drafts to offer; the creator handles it
    }
  }

  const hasVariables = await has(`origin/${branch}:${VARIABLES_PATH}`);
  let variables: RequiredVariable[] = [];
  if (hasVariables) {
    try {
      const raw = await hostGit(
        workspace,
        'cat-file',
        '-p',
        `origin/${branch}:${VARIABLES_PATH}`
      );

      variables = z.array(requiredVariableSchema).parse(JSON.parse(raw));
    } catch {
      // invalid on the branch; the creator regenerates it
    }
  }
  return {
    hasSkill: await has(`origin/${branch}:${SKILL_PATH}`),
    hasVariables,
    hasChecker: await has(`origin/${branch}:${CHECKER_PATH}`),
    branch,
    pendingBranch,
    variables
  };
}

/** How many branches the picker offers; the newest ones are the releases. */
const RELEASE_BRANCH_LIMIT = 25;

// Subject last: a commit subject can hold a tab, and a trailing field would
// then be read out of the wrong column.
const BRANCH_FIELDS = '%(refname:short)%09%(committerdate:unix)';

/** Branches on origin a release could ship from, newest commit first. The
 *  default branch is left out on purpose: it IS production, so a release never
 *  starts there. `ahead` is what the branch would bring to it - 0 means the
 *  work is already merged and there is nothing to ship. */
export async function listReleaseBranches(opts: {
  spaceDir: string;
  repoUrl: string;
  mainBranch?: string;
  githubToken: string;
}): Promise<ReleaseBranch[]> {
  const { workspace, branch } = await ensureWorkspaceClone(opts);
  // Prune too: a branch deleted after its last release must not stay on offer.
  await hostGitRemote(workspace, opts.githubToken, 'fetch', 'origin', '--prune');

  // One subprocess for every count. %(ahead-behind:) landed in git 2.41 and
  // fails the whole listing on anything older, so an unknown-atom error falls
  // back to a rev-list per branch rather than losing the picker.
  let counted = true;
  let raw = '';
  try {
    raw = await hostGit(
      workspace,
      'for-each-ref',
      '--sort=-committerdate',
      `--format=${BRANCH_FIELDS}%09%(ahead-behind:refs/remotes/origin/${branch})%09%(contents:subject)`,
      'refs/remotes/origin'
    );
  } catch {
    counted = false;
    raw = await hostGit(
      workspace,
      'for-each-ref',
      '--sort=-committerdate',
      `--format=${BRANCH_FIELDS}%09%(contents:subject)`,
      'refs/remotes/origin'
    );
  }

  const branches: ReleaseBranch[] = [];
  for (const row of raw.split('\n')) {
    if (branches.length >= RELEASE_BRANCH_LIMIT) break;
    const [ref = '', unix = '', ...rest] = row.split('\t');
    // refs/remotes/origin/HEAD prints as a bare `origin` under
    // %(refname:short), so anything without the prefix is not a branch.
    if (!ref.startsWith('origin/')) continue;
    const name = ref.slice('origin/'.length);
    if (name === 'HEAD' || name === branch) continue;
    // "<ahead> <behind>" when the atom ran; the fallback counts it per branch.
    let ahead = counted ? Number(rest.shift()?.split(' ')[0]) || 0 : 0;
    if (!counted) {
      try {
        const count = await hostGit(
          workspace,
          'rev-list',
          '--count',
          `origin/${branch}..${ref}`
        );
        ahead = Number(count.trim()) || 0;
      } catch {
        // Unreadable ref (raced a prune): offer it uncounted rather than
        // dropping it - the owner may still know it is the release.
      }
    }
    branches.push({
      name,
      ahead,
      updated: Number(unix) || 0,
      subject: rest.join('\t').trim()
    });
  }
  return branches;
}

// The variables contract the creator must emit: every env key the skill's
// commands will need, described for the Secrets settings UI. category groups
// them by what they serve (the AI picks: server, client, deploy, database...).
const requiredVariableSchema = z.object({
  key: z.string().min(1),
  title: z.string().catch(''),
  description: z.string().catch(''),
  category: z.string().catch('general'),
  sensitive: z.boolean().catch(true),
  // 'file' is a sops blob under files/ (a .p12, a .p8, an SSH key), not a
  // line of secrets.enc.env. Absent = an env key.
  kind: z.enum(['env', 'file']).catch('env')
});
export type RequiredVariable = z.infer<typeof requiredVariableSchema>;

export const REQUIRED_VARIABLES_PATH = VARIABLES_PATH;

/** The keys a required-variables.json declares, with whether each is an env
 *  key or a file blob. An invalid file declares none, as in
 *  checkDeployStatus: the creator regenerates it. */
export function requiredVariableKeys(
  raw: string
): Pick<RequiredVariable, 'key' | 'kind'>[] {
  try {
    return z
      .array(requiredVariableSchema)
      .parse(JSON.parse(raw))
      .map((v) => ({ key: v.key, kind: v.kind }));
  } catch {
    return [];
  }
}

// The env-var contract every skill is written against (and can test during
// generation): machine-portable names, never absolute paths in SKILL.md.
export function spaceEnv(spaceDir: string): Record<string, string> {
  const paths = hostSpacePaths(spaceDir);
  return {
    WORKSPACE: paths.workspace,
    BACKUPS_DIR: paths.backups,
    BUILDS_DIR: paths.builds,
    // Where `factiii-secrets` finds the runner. It can also walk up for the
    // socket, but only from inside the space tree - a step that cd'd into a
    // build dir elsewhere would not find it.
    FACTIII_SECRETS_SOCK: secretsSocketPath(spaceDir),
    // No keychain credential helper and no interactive git prompts anywhere
    // in the deploy surface (agent sessions + authorized commands): auth
    // comes from the secrets store or the runner's GitHub connection, never
    // the keychain. The empty helper clears every other one; the second entry
    // is the same `factiii-secrets git-credential` the primary clone has, so
    // a push from the deploy checkout (which has no such config) works too.
    GIT_TERMINAL_PROMPT: '0',
    ...gitConfigEnv(
      sessionCredentialConfig(path.join(paths.bin, SECRETS_BIN))
    )
  };
}

/** `GIT_CONFIG_COUNT` / `_KEY_n` / `_VALUE_n` for these entries, in order. */
function gitConfigEnv(entries: [string, string][]): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(entries.length)
  };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

export type DeploySkillDraft = {
  // Full SKILL.md contents, for the review UI.
  skill: string;
  variables: RequiredVariable[];
  // Full check-environment.sh contents, for the review UI.
  checker: string;
  // references/<lane>.md pages, for the review UI. Empty when there are none.
  references: SkillReference[];
};

export type SkillReference = {
  // Relative to the skill dir, e.g. `references/web.md`.
  path: string;
  content: string;
};

/** The skill's `references/*.md` pages, sorted by path. Only regular `.md`
 *  files directly inside `<skill>/references/` count: a symlink, a subfolder
 *  or any other file type is skipped, so the review never shows (and a
 *  revision is never told about) anything outside the skill folder. */
export async function readSkillReferences(
  skillDir: string
): Promise<SkillReference[]> {
  const dir = path.join(skillDir, REFERENCES_DIR);
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  const refs: SkillReference[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    // isFile() is false for a symlink (Dirent does not follow it), so this
    // never reads through a link to a file elsewhere on the machine.
    const content = await fs
      .readFile(path.join(dir, entry.name), 'utf-8')
      .catch(() => null);
    if (content === null) continue;
    refs.push({ path: `${REFERENCES_DIR}/${entry.name}`, content });
  }
  return refs.sort((a, b) => a.path.localeCompare(b.path));
}

// The contract is the three files, on disk, valid. Read + validate them from
// the workspace after a generation/revision session. The references/ pages
// come along for review but are not validated.
async function readContract(workspace: string): Promise<DeploySkillDraft> {
  const skill = await fs
    .readFile(path.join(workspace, SKILL_PATH), 'utf-8')
    .catch(() => {
      throw new Error('The creator wrote no SKILL.md.');
    });
  const checker = await fs
    .readFile(path.join(workspace, CHECKER_PATH), 'utf-8')
    .catch(() => {
      throw new Error('The creator wrote no check-environment.sh.');
    });
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(workspace, VARIABLES_PATH), 'utf-8')
    ) as unknown;
    return {
      skill,
      checker,
      variables: z.array(requiredVariableSchema).parse(raw),
      references: await readSkillReferences(path.join(workspace, SKILL_DIR))
    };
  } catch {
    throw new Error('The creator wrote no valid required-variables.json.');
  }
}

type CreatorOpts = {
  spaceDir: string;
  repoUrl: string;
  mainBranch?: string;
  githubToken: string;
  provider: AgentProvider;
  sendLog: (entry: { type: string; content: string }) => void;
};

/** Generate the deploy skill + required-variables.json into the workspace
 *  (uncommitted) for review; the owner revises, then explicitly approves
 *  the push. */
export async function generateDeploySkill(
  opts: CreatorOpts & { instructions: string }
): Promise<DeploySkillDraft & { sessionId: string }> {
  const { instructions, sendLog } = opts;
  if (!instructions.trim()) {
    throw new Error('Describe your deployment process first.');
  }
  const status = await checkDeployStatus(opts);
  const workspace = path.join(opts.spaceDir, 'workspace');

  sendLog({
    type: 'system',
    content: `Resetting workspace to origin/${status.branch}...`
  });
  await hostGit(
    workspace,
    'checkout',
    '-B',
    status.branch,
    `origin/${status.branch}`
  );
  await hostGit(workspace, 'clean', '-fd');

  sendLog({
    type: 'system',
    content: 'Analyzing the repo and writing the deploy skill...'
  });
  const { result } = await spawnAgent(
    opts.provider,
    hostTarget(opts.spaceDir),
    {
      cwd: workspace,
      prompt: buildPrompt(prompts.deployCreate, {
        INSTRUCTIONS: instructions
      }),
      allowedTools: 'Read,Grep,Glob,Bash,Edit,Write,WebSearch,WebFetch,Skill',
      // auto: the per-action classifier blocks escalations/unrecognized-infra
      // actions - a host session with no human reviewing each command should
      // not run bypassPermissions. (Codex maps this to a workspace-write
      // sandbox; see agent.ts.)
      permissionMode: 'auto',
      includePartialMessages: true,
      env: spaceEnv(opts.spaceDir),
      callbacks: { onLog: (entry) => sendLog(entry) }
    }
  );
  const { sessionId } = await result;
  const draft = await readContract(workspace);
  return { ...draft, sessionId };
}

/** Apply the owner's corrections to the drafted skill by resuming the
 *  generation session; returns the updated draft for another review round. */
export async function reviseDeploySkill(
  opts: CreatorOpts & { feedback: string; resumeSessionId?: string }
): Promise<DeploySkillDraft & { sessionId: string }> {
  const { feedback, sendLog } = opts;
  if (!feedback.trim()) throw new Error('Corrections are empty.');
  const workspace = path.join(opts.spaceDir, 'workspace');

  sendLog({ type: 'system', content: 'Applying your corrections...' });
  const { result } = await spawnAgent(
    opts.provider,
    hostTarget(opts.spaceDir),
    {
      cwd: workspace,
      prompt: buildPrompt(prompts.deployCreateRevise, {
        FEEDBACK: feedback
      }),
      allowedTools: 'Read,Grep,Glob,Bash,Edit,Write,WebSearch,WebFetch,Skill',
      permissionMode: 'auto',
      includePartialMessages: true,
      resumeSessionId: opts.resumeSessionId || undefined,
      env: spaceEnv(opts.spaceDir),
      callbacks: { onLog: (entry) => sendLog(entry) }
    }
  );
  const { sessionId } = await result;
  const draft = await readContract(workspace);
  return { ...draft, sessionId: sessionId || opts.resumeSessionId || '' };
}

/** Resume a pushed deploy-skill branch: check it out in the workspace
 *  exactly as committed. Revisions edit the tree; approve then commits them
 *  as their OWN commit on this same branch (the existing history is
 *  respected, never recreated). */
export async function loadSkillDraft(
  opts: Omit<CreatorOpts, 'sendLog'> & { branch: string }
): Promise<DeploySkillDraft> {
  const branch = opts.branch.replace(/[^\w./-]/g, '');
  if (!branch.startsWith('deploy-skill')) {
    throw new Error('Not a deploy-skill branch.');
  }
  await checkDeployStatus(opts);
  const workspace = path.join(opts.spaceDir, 'workspace');
  // Ask the remote, not the tracking ref: the draft can be merged or deleted
  // between the status that offered it and this click. Raw git says "couldn't
  // find remote ref", which reads as a broken button rather than a gone branch.
  const onRemote = await hostGitRemote(
    workspace,
    opts.githubToken,
    'ls-remote',
    '--heads',
    'origin',
    branch
  ).catch(() => '');
  if (!onRemote.trim()) {
    throw new Error(
      `Branch ${branch} is no longer on origin - it was merged or deleted. Draft the deploy skill again.`
    );
  }
  await hostGitRemote(
    workspace,
    opts.githubToken,
    'fetch',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  );
  await hostGit(workspace, 'checkout', '-B', branch, `origin/${branch}`);
  await hostGit(workspace, 'clean', '-fd');
  return readContract(workspace);
}

/** The owner approved the previewed draft: commit the workspace and push it
 *  to a fresh branch (dated when the name is taken); merge is the final
 *  approval that arms the Deploy button. */
export async function approveDeploySkill(opts: {
  spaceDir: string;
  githubToken: string;
  gitName?: string;
  gitEmail?: string;
  // Set when the draft was loaded from an existing deploy-skill branch:
  // revisions become their own commit on THAT branch (no new branch, no
  // history rewrite). Nothing changed -> nothing to push, branch as-is.
  onBranch?: string;
}): Promise<{ branch: string }> {
  const workspace = path.join(opts.spaceDir, 'workspace');
  await readContract(workspace);
  // Commit Claude Code's discovery symlink alongside the skill files
  await ensureClaudeSkillLink(workspace);

  if (opts.gitName)
    await hostGit(workspace, 'config', 'user.name', opts.gitName);
  if (opts.gitEmail)
    await hostGit(workspace, 'config', 'user.email', opts.gitEmail);

  if (opts.onBranch) {
    const dirty = await hostGit(workspace, 'status', '--porcelain');
    if (dirty.trim()) {
      await hostGit(workspace, 'add', '-A');
      await hostGit(workspace, 'commit', '-m', 'Revise deploy skill');
      await hostGitRemote(
        workspace,
        opts.githubToken,
        'push',
        'origin',
        opts.onBranch
      );
    }
    return { branch: opts.onBranch };
  }

  let target = 'deploy-skill';
  try {
    await hostGitRemote(
      workspace,
      opts.githubToken,
      'ls-remote',
      '--exit-code',
      '--heads',
      'origin',
      target
    );
    const stamp = new Date()
      .toISOString()
      .slice(0, 16)
      .replace(/[-:]/g, '')
      .replace('T', '-');
    target = `${target}-${stamp}`;
  } catch {
    // name is free
  }
  await hostGit(workspace, 'checkout', '-B', target);
  await hostGit(workspace, 'add', '-A');
  await hostGit(workspace, 'commit', '-m', 'Add deploy skill');
  await hostGitRemote(workspace, opts.githubToken, 'push', 'origin', target);
  return { branch: target };
}

export type EnvCheck = { ok: boolean; label: string; detail: string };

/** Run the merged check-environment.sh (the reviewed version from the
 *  default branch, never the workspace copy) and parse its OK:/FAIL: lines.
 *  Read-only, secret-free: a button-click preflight for "good to push". */
export async function runEnvironmentCheck(opts: {
  spaceDir: string;
  repoUrl: string;
  mainBranch?: string;
  githubToken: string;
}): Promise<{ ok: boolean; checks: EnvCheck[]; output: string }> {
  const status = await checkDeployStatus(opts);
  if (!status.hasChecker) {
    throw new Error(
      'No environment checker on the default branch. Generate the deploy skill first.'
    );
  }
  const workspace = path.join(opts.spaceDir, 'workspace');
  const script = await hostGit(
    workspace,
    'cat-file',
    '-p',
    `origin/${status.branch}:${CHECKER_PATH}`
  );
  const tmp = path.join(opts.spaceDir, `.env-check.${process.pid}.sh`);
  await fs.writeFile(tmp, script, { mode: 0o700 });
  let ok = true;
  let output = '';
  try {
    // Login-shell execution: environment fixes land in the user's shell
    // init and the check must see them without a runner restart. stdin is
    // closed (execLogin), so dotfile prompts can't hang a headless check.
    const scriptArg = tmp.split(path.sep).join('/');
    const res = await execLogin(`bash ${JSON.stringify(scriptArg)}`, {
      cwd: workspace,
      env: { ...process.env, ...spaceEnv(opts.spaceDir) },
      timeout: 120_000
    });
    output = res.output;
    if (res.code !== 0) ok = false;
  } finally {
    await fs.rm(tmp, { force: true });
  }
  const checks: EnvCheck[] = [];
  for (const line of output.split('\n')) {
    const match = /^(OK|FAIL):\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    const [, verdict, rest] = match;
    const dash = rest.indexOf(' - ');
    checks.push({
      ok: verdict === 'OK',
      label: dash > 0 ? rest.slice(0, dash) : rest,
      detail: dash > 0 ? rest.slice(dash + 3) : ''
    });
    if (verdict === 'FAIL') ok = false;
  }
  return { ok, checks, output: output.trim().slice(-4000) };
}

/** The check failed: let the AI install/configure what the failed checks
 *  need (env setup ONLY - no repo writes, no secrets), then re-run the
 *  merged checker and return the fresh verdict. */
export async function fixEnvironment(
  opts: CreatorOpts
): Promise<{ ok: boolean; checks: EnvCheck[]; output: string }> {
  const { sendLog } = opts;
  const before = await runEnvironmentCheck(opts);
  if (before.ok) return before;

  const status = await checkDeployStatus(opts);
  const workspace = path.join(opts.spaceDir, 'workspace');
  const script = await hostGit(
    workspace,
    'cat-file',
    '-p',
    `origin/${status.branch}:${CHECKER_PATH}`
  );
  const failed = before.checks
    .filter((c) => !c.ok)
    .map((c) => `- ${c.label}${c.detail ? ` (${c.detail})` : ''}`)
    .join('\n');

  sendLog({
    type: 'system',
    content: 'Setting this machine up to pass the environment check...'
  });
  const { result } = await spawnAgent(
    opts.provider,
    hostTarget(opts.spaceDir),
    {
      cwd: workspace,
      prompt: buildPrompt(prompts.deployEnvFix, {
        CHECKS: failed || before.output.slice(-2000),
        SCRIPT: script
      }),
      allowedTools: 'Bash,Read,Grep,Glob,WebSearch,WebFetch',
      // auto: installs are in-scope of the owner's explicit "fix environment"
      // request; the classifier still blocks anything beyond it.
      permissionMode: 'auto',
      includePartialMessages: true,
      env: spaceEnv(opts.spaceDir),
      callbacks: { onLog: (entry) => sendLog(entry) }
    }
  );
  await result;

  sendLog({ type: 'system', content: 'Re-running the environment check...' });
  return runEnvironmentCheck(opts);
}

/** Drop the drafted files and reset the workspace clean. */
export async function discardDeploySkill(opts: {
  spaceDir: string;
}): Promise<{ success: boolean }> {
  const workspace = path.join(opts.spaceDir, 'workspace');
  await hostGit(workspace, 'checkout', '--', '.').catch(() => null);
  await hostGit(workspace, 'clean', '-fd');
  return { success: true };
}
