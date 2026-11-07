import type { ChildProcess } from 'child_process';

import type {
  AskImage,
  BoardAgentActionMap,
  BoardConversationSummary
} from '../../domains/electron';
import {
  assertAgentSignedIn,
  checkAskImages,
  generateBranchName,
  generateCommitMessage,
  spawnAgent
} from '../board-agent-core/agent';
import { readSpacePorts } from '../board-agent-core/exec';
import {
  addWorktree,
  extractDiff,
  setGitIdentity
} from '../board-agent-core/git';
import { killTree } from '../board-agent-core/host-env';
import type { ModeEngine } from '../board-agent-core/mode';
import { buildPrompt } from '../board-agent-core/prompt';
import prompts from '../board-agent-core/prompts.json';
import type { AgentProvider } from '../board-agent-core/providers';
import type {
  AgentEventSink,
  BaseSession,
  LogEntry,
  SessionSummary
} from '../board-agent-core/session';
import { toSummary } from '../board-agent-core/session';
import type { SpaceCore } from '../board-agent-core/space-core';
import type { CardRecord } from '../board-agent-core/state';
import { BoardConversations } from './board-conversations';
import { putSessionCard, teardownSession } from './card-session';
import { installFrpcHarness } from './frpc';
import type { ClaudeSession } from './session';

/** AI pipeline mode: automated research→implement→review pipeline + Ask Board
 *  chat, driven by the space's configured provider CLI. */
export class ClaudeModeEngine implements ModeEngine {
  private sessions = new Map<string, ClaudeSession>();
  /** The Board AI's conversations (see board-conversations.ts). */
  private asks: BoardConversations;
  /** The headless CLI answering each conversation that has a turn in flight. */
  private askProcs = new Map<string, ChildProcess>();

  private static readonly QUESTION_MARKER = 'AWAITING_INPUT';
  private static readonly FULL_TOOLS =
    'Read,Grep,Glob,Agent,Edit,Write,Bash,TodoWrite';

  constructor(
    private core: SpaceCore,
    private emitter: AgentEventSink
  ) {
    this.asks = new BoardConversations(() => this.core.target());
  }

  /** The pipeline loop should stop: the session was removed (kill/dismiss) or
   *  handed off to a terminal. Both mean "don't advance or report error". */
  private stopped(s: ClaudeSession): boolean {
    return !this.sessions.has(s.postId) || !!s.handedOff;
  }

  private putCard(s: ClaudeSession): Promise<void> {
    return putSessionCard(s, this.core.target(), s.prompt);
  }

  /** Fire-and-forget full-record write on a phase/id change. */
  private syncCard(s: ClaudeSession): void {
    void this.putCard(s);
  }

  /** Rebuild sessions from redis after a runner restart and resume each from its
   *  recorded phase (see resumeAfterRestart); the conversation + worktree survive. */
  hydrate(records: CardRecord[]): void {
    for (const r of records) {
      if (r.mode !== 'claude' || this.sessions.has(r.postId)) continue;
      const session: ClaudeSession = {
        taskId: r.taskId,
        postId: r.postId,
        phase: r.phase,
        mode: 'claude',
        step: 1,
        logs: [],
        diff: '',
        changedFiles: [],
        commitMessage: '',
        previewUrl: '',
        previewRunning: false,
        reproSteps: '',
        pendingQuestion: r.pendingQuestion,
        error: '',
        startedAt: r.startedAt,
        taskTitle: r.taskTitle,
        targetBranch: r.targetBranch,
        effort: 'high',
        todos: [],
        provider: r.provider,
        workspacePath: r.worktreePath,
        agentSessionId: r.agentSessionId,
        answerResolver: null,
        proc: null,
        prompt: r.prompt
      };
      this.sessions.set(r.postId, session);
      this.emitter.emitSessionUpdate(session);
      this.resumeAfterRestart(session);
    }
  }

  /** Continue a rehydrated card: implement/review resume the conversation,
   *  research/starting re-drive from the stored prompt, awaiting-input stays
   *  parked, settled phases do nothing. */
  private resumeAfterRestart(session: ClaudeSession): void {
    const onError = (err: unknown) => {
      if (this.stopped(session)) return;
      session.phase = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      this.syncCard(session);
      this.emitter.addLog(session, 'error', session.error);
      this.emitter.emitSessionUpdate(session);
    };

    if (session.phase === 'implement' || session.phase === 'review') {
      this.emitter.addLog(session, 'system', '── Resuming after restart ──');
      this.runImplementation(
        session,
        buildPrompt(prompts.implement),
        '── Resumed'
      ).catch(onError);
      return;
    }

    if (session.phase === 'complete') {
      // Finished, awaiting review/push: the diff isn't persisted, so re-extract
      // it from the surviving worktree or the review + Push UI shows nothing.
      void extractDiff(this.core.target(), session.workspacePath || undefined)
        .then(({ diff, changedFiles }) => {
          if (this.stopped(session)) return;
          session.diff = diff;
          session.changedFiles = changedFiles;
          this.emitter.emitSessionUpdate(session);
        })
        .catch(() => {});
      return;
    }

    if (session.phase === 'starting' || session.phase === 'research') {
      if (!session.prompt) {
        // Legacy record without a stored prompt: can't re-drive research, but
        // the worktree + thread survive, so a terminal takeover still recovers.
        session.phase = 'error';
        session.error =
          'Interrupted by a runner restart. Open a terminal to resume.';
        this.emitter.emitSessionUpdate(session);
        return;
      }
      this.emitter.addLog(session, 'system', '── Resuming after restart ──');
      this.runResearch(
        session,
        buildPrompt(prompts.research, { task: session.prompt }),
        session.agentSessionId || undefined
      )
        .then(() => {
          if (this.stopped(session)) return;
          return this.runImplementation(
            session,
            buildPrompt(prompts.implement),
            '── Resumed'
          );
        })
        .catch(onError);
    }
    // awaiting-input / complete / done / error: leave as restored.
  }

  // ── Board AI ("Ask Board") ──

  async ask(
    params: {
      question: string;
      boardContext?: string;
      componentSchema?: string;
      provider?: AgentProvider;
      images?: AskImage[];
      conversationId?: string;
    },
    sendLog: (entry: { type: string; content: string }) => void
  ): Promise<string> {
    // Before anything is recorded: a refused image must not leave a turn
    // behind in the conversation.
    const images = checkAskImages(params.images);
    await this.core.ensureSpaceWorkspace();
    const conversation = await this.asks.beginTurn(params.conversationId);
    try {
      // Provider is locked to the conversation: a resume keeps its own; only a
      // fresh conversation honors a newly picked one.
      const provider =
        conversation.provider ??
        (conversation.sessionId ? undefined : params.provider) ??
        this.core.agentProvider();
      this.asks.setProvider(conversation, provider);
      const askCwd = this.boardCwd();
      await assertAgentSignedIn(provider, this.core.target());

      this.asks.addUserMessage(conversation, {
        role: 'user',
        content: params.question,
        ...(images.length > 0 && { imageCount: images.length })
      });

      let prompt: string;
      if (conversation.sessionId) {
        prompt = params.question;
      } else {
        const parts = [
          'Here is the board data:',
          '',
          params.boardContext || ''
        ];
        parts.push('', params.question);
        prompt = parts.join('\n');
      }

      const systemPrompt = [
        params.componentSchema,
        buildPrompt(prompts.boardAI)
      ]
        .filter(Boolean)
        .join('\n\n');

      const { proc, result } = await spawnAgent(provider, this.core.target(), {
        cwd: askCwd,
        prompt,
        allowedTools: 'Read,Grep,Glob,Agent',
        model: 'claude-opus-4-6',
        includePartialMessages: true,
        appendSystemPrompt: systemPrompt,
        images,
        resumeSessionId: conversation.sessionId || undefined,
        callbacks: {
          // Tagged, because several conversations stream down one channel.
          onLog: (entry) =>
            sendLog(
              Object.assign({}, entry, { conversationId: conversation.id })
            )
        }
      });

      this.askProcs.set(conversation.id, proc);
      const { text, sessionId } = await result;
      this.asks.addAnswer(conversation, text, sessionId);
      return text;
    } finally {
      this.askProcs.delete(conversation.id);
      this.asks.setBusy(conversation.id, false);
    }
  }

  /** Stop the CLI answering a conversation, if one is. */
  private stopAsk(conversationId: string): void {
    const proc = this.askProcs.get(conversationId);
    if (!proc) return;
    try {
      killTree(proc, 'SIGTERM');
    } catch {
      // already exited
    }
    this.askProcs.delete(conversationId);
  }

  /** Where the Ask agent sits: the primary clone for git spaces, else the
   *  workspace root. Shared by ask() and the terminal handoff so a resumed CLI
   *  lands in the exact cwd the thread was keyed to. */
  private boardCwd(): string {
    const config = this.core.readConfig();
    // Git repo when connected, else home.
    const paths = this.core.target().paths;
    return config.repoUrl && config.githubToken ? paths.repo : paths.root;
  }

  /** cwd for the board's Ask terminal, resolved by the board key. */
  boardTerminalTarget(): { cwd: string } {
    return { cwd: this.boardCwd() };
  }

  /**
   * Take the Ask conversation over in a terminal: ensure the space container,
   * stop the headless ask process (so the resumed CLI doesn't collide), and
   * return the resume id + provider. The sessionId is kept so the terminal
   * resumes the exact thread at the ask cwd.
   */
  async boardHandoff(conversationId?: string): Promise<{
    sessionId: string | null;
    provider: AgentProvider;
  }> {
    await this.core.ensureSpaceWorkspace();
    const conversation = await this.asks.find(conversationId);
    if (conversation) this.stopAsk(conversation.id);
    // One-way: the conversation moves to a terminal (resumed by id from the
    // on-disk session) and leaves Ask Board, so the same thread is never driven
    // from two places. Capture what the terminal needs, then drop it here.
    const handoff = {
      sessionId: conversation?.sessionId ?? null,
      provider: conversation?.provider ?? this.core.agentProvider()
    };
    if (conversation) await this.asks.remove(conversation.id);
    return handoff;
  }

  /** One Ask Board conversation for the client to hydrate on open. */
  async boardSession(
    conversationId?: string
  ): Promise<BoardAgentActionMap['boardSession']['result']> {
    const conversation = await this.asks.find(conversationId);
    if (!conversation) return { messages: [], conversationId, busy: false };
    return {
      messages: conversation.messages.slice(),
      conversationId: conversation.id,
      busy: this.asks.isBusy(conversation.id)
    };
  }

  boardSessions(): Promise<BoardConversationSummary[]> {
    return this.asks.list();
  }

  async boardSessionUpdate(
    payload: BoardAgentActionMap['boardSessionUpdate']['payload']
  ): Promise<void> {
    const { conversationId, ...patch } = payload;
    // Setting one aside mid-answer would leave a CLI nobody is reading.
    if (patch.archived) this.stopAsk(conversationId);
    await this.asks.update(conversationId, patch);
  }

  async boardSessionDelete(conversationId: string): Promise<void> {
    this.stopAsk(conversationId);
    await this.asks.remove(conversationId);
  }

  /** From a client older than conversations, whose "New conversation" used to
   *  wipe the one thread: set the current one aside instead. */
  async resetBoardSession(): Promise<void> {
    const conversation = await this.asks.find(undefined);
    if (!conversation) return;
    this.stopAsk(conversation.id);
    await this.asks.update(conversation.id, { archived: true });
  }

  // ── Pipeline runner ──

  private async runAgentPhase(
    session: ClaudeSession,
    prompt: string,
    tools: string,
    resumeSessionId?: string,
    options?: {
      permissionMode?: string;
      disallowedTools?: string;
    }
  ): Promise<{ text: string; sessionId: string }> {
    const provider = session.provider;
    await assertAgentSignedIn(provider, this.core.target());
    const { proc, result } = await spawnAgent(provider, this.core.target(), {
      cwd: session.workspacePath || undefined,
      prompt,
      allowedTools: tools,
      disallowedTools: options?.disallowedTools,
      permissionMode: options?.permissionMode,
      appendSystemPrompt: buildPrompt(prompts.system),
      effort: session.effort,
      model: 'opus',
      resumeSessionId,
      callbacks: {
        // Tasks persist across the resumed phases; seed each phase's parser
        // with the session's list so later TaskUpdates land.
        initialTodos: session.todos,
        onLog: (entry) => {
          if (entry.type === 'text-append') {
            this.emitter.appendTextLog(session, entry.content);
          } else {
            this.emitter.addLog(session, entry.type, entry.content);
          }
        },
        onTodos: (todos) => {
          session.todos = todos;
          this.emitter.emitSessionUpdate(session);
        }
      }
    });

    session.proc = proc;

    try {
      return await result;
    } finally {
      session.proc = null;
    }
  }

  // ── Research with Q&A ──

  private async runResearch(
    session: ClaudeSession,
    prompt: string,
    resumeSessionId?: string
  ): Promise<void> {
    if (this.stopped(session)) return;

    const { text, sessionId } = await this.runAgentPhase(
      session,
      prompt,
      'Read,Grep,Glob,Agent,TodoWrite',
      resumeSessionId,
      { permissionMode: 'plan', disallowedTools: 'AskUserQuestion' }
    );
    session.agentSessionId = sessionId;
    this.syncCard(session);

    if (this.stopped(session)) return;

    const markerIdx = text.lastIndexOf(ClaudeModeEngine.QUESTION_MARKER);
    if (markerIdx === -1) return;

    session.phase = 'awaiting-input';
    // The protocol puts the question AFTER the marker, but models sometimes
    // write it before and end with a bare marker - take whichever side has it.
    session.pendingQuestion =
      text.slice(markerIdx + ClaudeModeEngine.QUESTION_MARKER.length).trim() ||
      text.slice(0, markerIdx).trim();
    this.emitter.emitSessionUpdate(session);
    this.emitter.addLog(
      session,
      'system',
      'The agent has a question - waiting for your input.'
    );

    const answer = await new Promise<string>((resolve) => {
      session.answerResolver = resolve;
    });

    if (this.stopped(session)) return;

    session.phase = 'research';
    session.pendingQuestion = '';
    session.answerResolver = null;
    this.emitter.emitSessionUpdate(session);
    this.emitter.addLog(session, 'system', 'Resuming research...');

    return this.runResearch(session, answer, sessionId);
  }

  // ── Pipeline ──

  private async runPipeline(
    session: ClaudeSession,
    prompt: string,
    baseBranch: string
  ): Promise<void> {
    if (!this.core.isReady()) {
      throw new Error(
        'Environment not initialized. Open Board AI Settings and click "Initialize Environment".'
      );
    }

    const config = this.core.readConfig();
    const hasGit = Boolean(config.repoUrl && config.githubToken);

    this.emitter.addLog(session, 'system', 'Preparing environment...');
    // ensureSpaceWorkspace emits its own setup-status lines and provisions the git clone.
    await this.core.ensureSpaceWorkspace();
    await assertAgentSignedIn(session.provider, this.core.target());

    if (hasGit) {
      // A fresh worktree per card off current origin.
      const { path } = await addWorktree(
        this.core.target(),
        session.taskId,
        baseBranch || config.mainBranch || 'main',
        'card'
      );
      session.workspacePath = path;
      await setGitIdentity(
        this.core.target(),
        config.gitName,
        config.gitEmail,
        path
      );
      this.emitter.addLog(session, 'system', 'Worktree ready.');
    } else {
      // No git: the card works in the space home.
      session.workspacePath = '';
      this.emitter.addLog(session, 'system', 'Workspace ready.');
    }
    await this.putCard(session);

    this.emitter.addLog(session, 'system', 'Workspace ready.');

    // ── Step 1: Research (with Q&A) ──
    session.phase = 'research';
    session.step = 1;
    this.emitter.emitSessionUpdate(session);
    this.emitter.addLog(session, 'system', '── Step 1: Research ──');

    await this.runResearch(
      session,
      buildPrompt(prompts.research, { task: prompt })
    );
    if (this.stopped(session)) return;

    await this.runImplementation(
      session,
      buildPrompt(prompts.implement),
      '── Step'
    );
  }

  private async runImplementation(
    session: ClaudeSession,
    implementPrompt: string,
    logPrefix: string
  ): Promise<void> {
    const tools = ClaudeModeEngine.FULL_TOOLS;

    session.phase = 'implement';
    session.step = 2;
    this.syncCard(session);
    this.emitter.emitSessionUpdate(session);
    this.emitter.addLog(session, 'system', `${logPrefix} 2: Implement ──`);

    const implResult = await this.runAgentPhase(
      session,
      implementPrompt,
      tools,
      session.agentSessionId
    );
    session.agentSessionId = implResult.sessionId || session.agentSessionId;
    if (this.stopped(session)) return;

    session.phase = 'review';
    session.step = 3;
    this.syncCard(session);
    this.emitter.emitSessionUpdate(session);
    this.emitter.addLog(session, 'system', `${logPrefix} 3: Review ──`);

    const reviewResult = await this.runAgentPhase(
      session,
      buildPrompt(prompts.review),
      tools,
      session.agentSessionId
    );
    session.agentSessionId = reviewResult.sessionId || session.agentSessionId;
    if (this.stopped(session)) return;

    session.reproSteps = reviewResult.text.trim();
    await this.extractAndComplete(session);
  }

  // On-demand dev-server preview: reuses the live container + Claude session,
  // maps the port (or a public frpc tunnel), stores the URL. Stays in `complete`.
  private async runPreview(session: ClaudeSession): Promise<void> {
    const tools = ClaudeModeEngine.FULL_TOOLS;

    session.previewRunning = true;
    this.emitter.addLog(session, 'system', 'Setting up live preview...');
    this.emitter.emitSessionUpdate(session);

    // Read the reservation directly: FACTIII_PORTS is injected into agent
    // spawns via agentEnv(), so a plain shell would not see it.
    const portsEnv = readSpacePorts(this.core.spaceDir()).join(',');

    let publicPreviewEnabled = this.core.canExpose;
    if (publicPreviewEnabled) {
      try {
        await installFrpcHarness({
          target: this.core.target(),
          taskId: session.taskId
        });
      } catch (err) {
        // Non-fatal, matching terminal mode: the preview still works locally.
        publicPreviewEnabled = false;
        this.emitter.addLog(
          session,
          'system',
          `Public preview unavailable: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const previewResult = await this.runAgentPhase(
      session,
      buildPrompt(prompts.preview, {
        ports: portsEnv,
        publicPreviewBlock: publicPreviewEnabled
          ? prompts.previewPublic.join('\n')
          : ''
      }),
      tools,
      session.agentSessionId
    );
    session.agentSessionId = previewResult.sessionId || session.agentSessionId;
    if (this.stopped(session)) return;

    const portMatch = previewResult.text.match(/PREVIEW_PORT:\s*(\d+)/);
    const previewPort = portMatch ? portMatch[1] : '3000';
    const urlMatch = previewResult.text.match(/PREVIEW_URL:\s*(\S+)/);

    if (publicPreviewEnabled && urlMatch) {
      session.previewUrl = urlMatch[1];
      this.emitter.addLog(
        session,
        'system',
        `Public preview available at ${session.previewUrl}`
      );
    } else {
      // The agent binds a real host port, so there is no mapping to look up.
      // localhost only means anything on the machine the runner is on.
      session.previewUrl = `http://localhost:${previewPort}`;
      this.emitter.addLog(
        session,
        'system',
        `Preview available at ${session.previewUrl}`
      );
    }

    this.emitter.emitSessionUpdate(session);
  }

  private async extractAndComplete(session: ClaudeSession): Promise<void> {
    // No git worktree: no diff to extract or commit. Just complete.
    if (!session.workspacePath) {
      session.diff = '';
      session.changedFiles = [];
      session.commitMessage = '';
      session.phase = 'complete';
      this.emitter.emitSessionUpdate(session);
      return;
    }

    this.emitter.addLog(session, 'system', 'Extracting changes...');

    const { diff, changedFiles } = await extractDiff(
      this.core.target(),
      session.workspacePath || undefined
    );
    session.diff = diff;
    session.changedFiles = changedFiles;

    if (changedFiles.length > 0) {
      this.emitter.addLog(
        session,
        'system',
        `${changedFiles.length} file${changedFiles.length !== 1 ? 's' : ''} changed.`
      );
      this.emitter.addLog(session, 'system', 'Generating commit message...');
      const provider = session.provider;
      const cwd = session.workspacePath || undefined;
      // Commit message and (if no branch was picked) branch name are both
      // derived from the diff with no dependency - run the two spawns together.
      const [commitMessage, branchName] = await Promise.all([
        generateCommitMessage(provider, this.core.target(), diff, cwd),
        session.targetBranch
          ? Promise.resolve('')
          : generateBranchName(
              provider,
              this.core.target(),
              diff,
              session.taskTitle,
              cwd
            )
      ]);
      session.commitMessage = commitMessage;
      if (branchName) {
        session.targetBranch = branchName;
        this.emitter.addLog(
          session,
          'system',
          `Suggested branch: ${branchName}`
        );
      }
    } else {
      this.emitter.addLog(session, 'system', 'No files changed.');
    }

    session.phase = 'complete';
    this.syncCard(session);
    this.emitter.emitSessionUpdate(session);
  }

  // ── Lifecycle / ModeEngine ──

  start(base: BaseSession, args: { prompt: string; baseBranch: string }): void {
    const session: ClaudeSession = {
      ...base,
      agentSessionId: '',
      answerResolver: null,
      proc: null,
      prompt: args.prompt
    };
    this.sessions.set(session.postId, session);
    this.emitter.emitSessionUpdate(session);

    const onError = (err: unknown) => {
      if (this.stopped(session)) return;
      session.phase = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      this.syncCard(session);
      this.emitter.addLog(session, 'error', session.error);
      this.emitter.emitSessionUpdate(session);
    };

    this.runPipeline(session, args.prompt, args.baseBranch).catch(onError);
  }

  /**
   * Reconcile several completed sessions' diffs into one changeset on the
   * merged card. Runs as the implement step so review + extractAndComplete
   * land a normal 'complete' session (diff viewer + push unchanged).
   */
  startMerge(
    base: BaseSession,
    args: { sources: { title: string; diff: string }[] }
  ): void {
    const session: ClaudeSession = {
      ...base,
      agentSessionId: '',
      answerResolver: null,
      proc: null,
      // Merge re-drives its own diffs, not a task prompt; no research to resume.
      prompt: ''
    };
    this.sessions.set(session.postId, session);
    this.emitter.emitSessionUpdate(session);

    const onError = (err: unknown) => {
      if (this.stopped(session)) return;
      session.phase = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      this.syncCard(session);
      this.emitter.addLog(session, 'error', session.error);
      this.emitter.emitSessionUpdate(session);
    };

    this.runMergePipeline(session, args.sources).catch(onError);
  }

  private async runMergePipeline(
    session: ClaudeSession,
    sources: { title: string; diff: string }[]
  ): Promise<void> {
    if (!this.core.isReady()) {
      throw new Error(
        'Environment not initialized. Open Board AI Settings and click "Initialize Environment".'
      );
    }

    const config = this.core.readConfig();
    if (!config.repoUrl || !config.githubToken) {
      throw this.core.notConnectedError(
        'Merging card changes requires a git-backed space.'
      );
    }

    // Merge runs like a git card: a fresh worktree in the space container.
    this.emitter.addLog(session, 'system', 'Preparing environment...');
    await this.core.ensureSpaceWorkspace();
    await assertAgentSignedIn(session.provider, this.core.target());
    const { path } = await addWorktree(
      this.core.target(),
      session.taskId,
      config.mainBranch || 'main',
      'card'
    );
    session.workspacePath = path;
    await setGitIdentity(
      this.core.target(),
      config.gitName,
      config.gitEmail,
      path
    );
    await this.putCard(session);

    // Patches live outside the worktree (namespaced by task so concurrent
    // merges in the shared container never collide) so they never diff.
    const patchDir = `${this.core.target().paths.root}/patches/${session.taskId}`;
    const cardLines: string[] = [];
    for (let i = 0; i < sources.length; i++) {
      const patchPath = `${patchDir}/${i + 1}.patch`;
      await this.core.target().writeFile(patchPath, sources[i].diff);
      cardLines.push(
        `${i + 1}. "${sources[i].title || 'Untitled card'}" - ${patchPath}`
      );
    }
    this.emitter.addLog(
      session,
      'system',
      `Merging changes from ${sources.length} card${sources.length !== 1 ? 's' : ''}...`
    );

    await this.runImplementation(
      session,
      buildPrompt(prompts.mergeDiffs, { cards: cardLines.join('\n') }),
      '── Merge'
    );
  }

  // Triggered from the review (complete) phase; returns the live preview URL.
  async cardStartPreview({
    postId: rawPostId
  }: {
    postId: string;
  }): Promise<{ previewUrl: string }> {
    const postId = String(rawPostId);
    const session = this.sessions.get(postId);
    if (!session) throw new Error('No active session for this card.');
    if (session.phase !== 'complete')
      throw new Error('Preview is only available once changes are ready.');
    if (!session.agentSessionId)
      throw new Error('No agent session to resume for preview.');
    // Already spinning up (e.g. the modal was reopened): don't start a second
    // run, just hand back the current URL so the client can show its logs.
    if (session.previewRunning || session.proc)
      return { previewUrl: session.previewUrl };

    try {
      await this.runPreview(session);
    } finally {
      session.previewRunning = false;
      if (this.sessions.has(postId)) this.emitter.emitSessionUpdate(session);
    }
    return { previewUrl: session.previewUrl };
  }

  /**
   * Push-failure recovery: let the agent repair the workspace (fetch +
   * rebase, conflict resolution, leftover markers) so the engine can retry
   * the commit + push. Ends with all changes uncommitted in the working tree.
   */
  async resolvePushIssue(
    postId: string,
    branchName: string,
    errorMessage: string
  ): Promise<void> {
    const session = this.sessions.get(String(postId));
    if (!session) throw new Error('No active session for this card.');

    this.emitter.addLog(
      session,
      'system',
      'Asking the agent to resolve the push issue...'
    );
    const { text, sessionId } = await this.runAgentPhase(
      session,
      buildPrompt(prompts.pushRecovery, {
        branch: branchName,
        error: errorMessage
      }),
      ClaudeModeEngine.FULL_TOOLS,
      session.agentSessionId
    );
    session.agentSessionId = sessionId || session.agentSessionId;
    if (text.trim()) {
      this.emitter.addLog(session, 'system', text.trim());
    }
  }

  cardAnswerQuestion({
    postId: rawPostId,
    answer
  }: {
    postId: string;
    answer: string;
  }): void {
    const postId = String(rawPostId);
    const session = this.sessions.get(postId);
    if (
      !session ||
      session.phase !== 'awaiting-input' ||
      !session.answerResolver
    )
      return;
    session.answerResolver(answer);
  }

  cardFeedback({
    postId: rawPostId,
    feedback
  }: {
    postId: string;
    feedback: string;
  }): void {
    const postId = String(rawPostId);
    const session = this.sessions.get(postId);
    if (!session || session.phase !== 'complete') return;
    if (!session.agentSessionId) return;

    session.diff = '';
    session.changedFiles = [];
    session.commitMessage = '';
    session.reproSteps = '';

    const prompt = `The user reviewed your changes and has the following feedback:\n\n${feedback}\n\n${buildPrompt(prompts.implement)}`;
    this.runImplementation(session, prompt, '── Follow-up').catch((err) => {
      if (!this.sessions.has(postId)) return;
      session.phase = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      this.emitter.addLog(session, 'error', session.error);
      this.emitter.emitSessionUpdate(session);
    });
  }

  listSummaries(): Record<string, SessionSummary> {
    const result: Record<string, SessionSummary> = {};
    for (const [postId, session] of this.sessions) {
      result[postId] = toSummary(session);
    }
    return result;
  }

  get(postId: string): BaseSession | undefined {
    return this.sessions.get(postId);
  }

  sessionWithLogs(
    postId: string
  ): (SessionSummary & { logs: LogEntry[] }) | null {
    const session = this.sessions.get(postId);
    if (!session) return null;
    return { ...toSummary(session), logs: session.logs };
  }

  has(postId: string): boolean {
    return this.sessions.has(postId);
  }

  isRunning(postId: string): boolean {
    const s = this.sessions.get(postId);
    return (
      !!s &&
      (s.phase === 'starting' ||
        s.phase === 'research' ||
        s.phase === 'implement')
    );
  }

  remove(postId: string): void {
    this.sessions.delete(postId);
  }

  /** Hand the card to a terminal: stop the headless agent but keep the session +
   *  worktree + agentSessionId so `--resume` picks up the thread. Marks it
   *  `handedOff` (halts the pipeline via `stopped`) and settles phase to complete. */
  async handoff(postId: string): Promise<void> {
    const session = this.sessions.get(String(postId));
    if (!session) return;
    session.handedOff = true;

    if (session.answerResolver) {
      session.answerResolver('');
      session.answerResolver = null;
    }
    if (session.proc) {
      try {
        killTree(session.proc, 'SIGTERM');
      } catch {
        // already exited
      }
      session.proc = null;
    }

    // Settled, non-error phase: the user is now driving in the terminal, and
    // the worktree + thread are intact for them. Keep everything else.
    session.phase = 'complete';
    this.syncCard(session);
    this.emitter.emitSessionUpdate(session);
  }

  async kill(postId: string): Promise<void> {
    let session = this.sessions.get(postId);
    if (!session) {
      for (const [, s] of this.sessions) {
        if (s.taskId === postId) {
          session = s;
          break;
        }
      }
    }
    if (!session) return;

    if (session.answerResolver) {
      session.answerResolver('');
      session.answerResolver = null;
    }

    if (session.proc) {
      try {
        killTree(session.proc, 'SIGTERM');
      } catch {
        // process may have already exited
      }
      session.proc = null;
    }

    await teardownSession(session, this.core.target());

    const removedPostId = session.postId;
    this.sessions.delete(removedPostId);
    this.emitter.emitSessionRemoved(removedPostId);
  }

  destroy(): void {
    // The conversations stay in the store; only their CLIs die with us.
    for (const conversationId of [...this.askProcs.keys()]) {
      this.stopAsk(conversationId);
    }

    for (const [, session] of this.sessions) {
      if (session.proc) {
        try {
          killTree(session.proc, 'SIGTERM');
        } catch {
          /* already exited */
        }
      }
    }
    this.sessions.clear();
  }
}
