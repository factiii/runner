import type {
  AgentState,
  CardAIMode,
  CardAISessionPhase,
  ExposedPort,
  RunnerActivity,
  RunnerActivityState,
  SessionGitSummary
} from '../domains/electron';

// Everything the Running jobs panel needs that isn't painting. Web and mobile
// render the same list with different primitives (Tailwind classes vs hex,
// <button> vs <Pressable>), so the labels, the working/idle split, and the
// grouping live here and each app supplies only the colors.

/** One live card session, as the panel knows it after aggregating the wire. */
export type ActiveSession = {
  runnerId: number;
  runnerName: string;
  spaceSlug: string;
  /** The space's name as the runner reported it with the frame. Absent from
   *  older runners: show the slug then. */
  spaceName?: string;
  postId: string;
  taskTitle: string;
  phase: CardAISessionPhase | null;
  mode: CardAIMode;
  startedAt: number;
  /** See SessionSummary.agentState. Undefined when no plugin has reported. */
  agentState?: AgentState;
  /** See SessionSummary.exposed. Undefined from a runner too old to report. */
  exposed?: ExposedPort[];
  /** See SessionSummary.agentActivity. */
  agentActivity?: string;
  /** See SessionSummary.git. */
  git?: SessionGitSummary;
};

/** Everything else the runner is doing: Ask Board, deploys, setup, indexing,
 *  sign-ins. Sessions are card-keyed and open a terminal; these are not. */
export type ActiveActivity = RunnerActivity & {
  runnerId: number;
  runnerName: string;
  spaceSlug: string;
  /** See ActiveSession.spaceName. */
  spaceName?: string;
};

/** Self-update lifecycle a runner reports while applying an approved update. */
export type RunnerUpdateState = 'installing' | 'restarting' | 'failed';

/**
 * What a row means, independent of how it is painted. Each app maps these to
 * its own palette — a shared hex would be wrong on one of them, and a shared
 * Tailwind class is meaningless in React Native.
 */
export type JobTone =
  | 'ai' // the agent is thinking
  | 'bare' // a user-driven terminal, producing output right now
  | 'quiet' // alive but silent - nothing is running in it
  | 'attention' // blocked on the user
  | 'review' // finished, waiting to be looked at
  | 'error'
  | 'idle';

type JobLook = { tone: JobTone; label: string; working: boolean };

const PHASE_LABEL: Partial<Record<CardAISessionPhase, string>> = {
  starting: 'Starting',
  research: 'Researching',
  'awaiting-input': 'Awaiting input',
  implement: 'Implementing',
  review: 'Review',
  complete: 'Complete',
  error: 'Error',
  'bare-active': 'Bare session',
  'bare-review': 'Review'
};

// Phases where the AI is actually thinking. These get a spinner; every other
// phase gets a plain dot, so "working" reads at a glance.
const WORKING_PHASES = new Set<CardAISessionPhase>([
  'starting',
  'research',
  'implement'
]);

/**
 * `agentState` is what the CLI itself reported through the factiii plugin's
 * hooks. It only refines `bare-active`: an idle terminal is alive but doing
 * nothing, which a green dot claimed was work, and a terminal waiting on a
 * permission prompt needs you rather than time. Undefined means no plugin, or
 * no hook yet, so the dot stays as it was.
 */
export function phaseLook(
  phase: CardAISessionPhase | null,
  agentState?: AgentState
): JobLook {
  const label = phase ? PHASE_LABEL[phase] || phase : 'Pending';
  const working = phase ? WORKING_PHASES.has(phase) : false;
  switch (phase) {
    case 'starting':
    case 'research':
    case 'implement':
      return { tone: 'ai', label, working };
    case 'bare-active':
      if (agentState === 'working') {
        return { tone: 'bare', label: 'Working', working: true };
      }
      if (agentState === 'blocked') {
        return { tone: 'attention', label: 'Needs you', working: false };
      }
      if (agentState === 'idle') {
        return { tone: 'quiet', label: 'Idle', working: false };
      }
      return { tone: 'bare', label, working };
    case 'awaiting-input':
      return { tone: 'attention', label, working };
    case 'review':
    case 'bare-review':
      return { tone: 'review', label, working };
    case 'error':
      return { tone: 'error', label, working };
    default:
      return { tone: 'idle', label, working };
  }
}

/** Same visual language as a session's phase: spin while it works, sit still
 *  and colored when it needs you or broke. */
export function activityLook(state: RunnerActivityState | null): JobLook {
  switch (state) {
    case 'awaiting-input':
      return { tone: 'attention', label: 'Needs you', working: false };
    case 'error':
      return { tone: 'error', label: 'Error', working: false };
    default:
      return { tone: 'ai', label: 'Working', working: true };
  }
}

/** A runner restarting itself stops every job on it, so it gets a row too. */
export function updateLook(state: RunnerUpdateState): JobLook {
  return state === 'failed'
    ? { tone: 'error', label: 'Update failed', working: false }
    : { tone: 'ai', label: 'Updating runner', working: true };
}

export function updateLabel(runnerName: string, state: RunnerUpdateState) {
  return state === 'failed'
    ? `${runnerName}: update failed`
    : `${runnerName}: updating runner`;
}

/**
 * The whole fleet as one state, so the Running jobs section (and its collapsed
 * icon) can be read without expanding it.
 *  - `attention`: something is blocked on the user. Painted amber and still.
 *  - `working`: something is running. The only state that animates.
 *  - `idle`: nothing needs watching.
 */
export type JobRollUp = 'attention' | 'working' | 'idle';

/**
 * Waiting beats working: one job blocked on an answer needs the user, and the
 * jobs still running beside it do not. Built from the same looks the rows
 * paint, so the roll-up can never disagree with the list under it.
 */
export function rollUpJobs(
  sessions: Pick<ActiveSession, 'phase' | 'agentState'>[],
  activities: Pick<ActiveActivity, 'state'>[],
  updates: RunnerUpdateState[] = []
): JobRollUp {
  const looks = [
    ...sessions.map((s) => phaseLook(s.phase, s.agentState)),
    ...activities.map((a) => activityLook(a.state)),
    ...updates.map(updateLook)
  ];
  if (looks.some((l) => l.tone === 'attention')) return 'attention';
  if (looks.some((l) => l.working)) return 'working';
  return 'idle';
}

const parseVersion = (v: string): [number, number, number] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** True when `latest` is a higher version than `current` (prerelease ignored).
 *  Shared so the web and mobile update banners cannot disagree about whether
 *  the same runner is behind. */
export function isRunnerBehind(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

// One board (Space) in the panel: its live work. Grouping by board (not by
// runner) is what lets several boards — each possibly on a different runner —
// read cleanly side by side.
type JobBoardGroup = {
  key: string;
  /** null for work the runner reported without a board to attribute it to. */
  slug: string | null;
  /** What the header says: the space's name when a runner reported one,
   *  else the slug. */
  label: string | null;
  sessions: ActiveSession[];
  activities: ActiveActivity[];
};

const UNATTRIBUTED = '__unattributed__';

/**
 * Sessions and activities bucketed per board, ordered so the most relevant
 * board is first. `currentSlug` is the board being viewed, if any — mobile
 * passes null, since its list never sits on a board screen.
 */
export function buildJobGroups(
  sessions: ActiveSession[],
  activities: ActiveActivity[],
  currentSlug: string | null
): JobBoardGroup[] {
  const groups = new Map<string, JobBoardGroup>();
  const ensure = (slug: string | null): JobBoardGroup => {
    const key = slug ?? UNATTRIBUTED;
    let g = groups.get(key);
    if (!g) {
      g = { key, slug, label: slug, sessions: [], activities: [] };
      groups.set(key, g);
    }
    return g;
  };
  for (const s of sessions) {
    const g = ensure(s.spaceSlug || null);
    g.sessions.push(s);
    if (s.spaceName) g.label = s.spaceName;
  }
  for (const a of activities) {
    const g = ensure(a.spaceSlug || null);
    g.activities.push(a);
    if (a.spaceName) g.label = a.spaceName;
  }

  const load = (g: JobBoardGroup) => g.sessions.length + g.activities.length;
  return [...groups.values()].sort((a, b) => {
    // The board you're looking at pins to the top.
    const ac = a.slug && a.slug === currentSlug ? 0 : 1;
    const bc = b.slug && b.slug === currentSlug ? 0 : 1;
    if (ac !== bc) return ac - bc;
    // Then boards with the most live work, then unattributed last, then name.
    if (load(b) !== load(a)) return load(b) - load(a);
    if ((a.key === UNATTRIBUTED) !== (b.key === UNATTRIBUTED)) {
      return a.key === UNATTRIBUTED ? 1 : -1;
    }
    return (a.label ?? '').localeCompare(b.label ?? '');
  });
}

/** Header summary shared by both panels, e.g. "8 jobs · 2 runners". */
export function jobSummary(jobCount: number, runnerCount: number): string {
  const jobs = `${jobCount} ${jobCount === 1 ? 'job' : 'jobs'}`;
  const runners = `${runnerCount} runner${runnerCount === 1 ? '' : 's'}`;
  return `${jobs} · ${runners}`;
}
