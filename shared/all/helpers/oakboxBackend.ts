import type {
  OllamaLibraryModel,
  OllamaLibraryTag,
  RunnerLocalAiJob,
  RunnerLocalAiModels,
  RunnerMachineHealth
} from '../domains/electron';
import type {
  CLAUDE_ASK_EFFORTS,
  CLAUDE_ASK_MODELS,
  CliAskSettings,
  CODEX_ASK_EFFORTS,
  CODEX_ASK_MODELS,
  OakboxBackendMode
} from '../validators/oakboxBackend';
import { LOCAL_AI_MODELS, type LocalAiModelFit } from './localAiModels';

// How Oakbox works for an account (.specs/oakbox.md "Backend"): the rules
// and the words, in one place for Oakbox web and the phone app.
//
// - Factiii: files, Ask and chats on Factiii's servers. With a computer
//   chosen (`runnerId`), search and Ask also reach it: its Vault's files
//   (lock-marked), its models and its chats, which stay on it. Vaults shared
//   with the person are searched too. No other runner is dialed.
// - Runner: the person's own runner is the backend, and Oakbox uses nothing
//   else of Factiii's (`factiiiFeatures`): files, Ask and chats are the
//   runner's, and no plan or Trons apply.

export type OakboxBackend = {
  mode: OakboxBackendMode;
  runnerId: number | null;
  model: string | null;
  /** Claude's and Codex's in Ask on a runner; null is the CLI's default. */
  claudeModel: (typeof CLAUDE_ASK_MODELS)[number] | null;
  claudeEffort: (typeof CLAUDE_ASK_EFFORTS)[number] | null;
  codexModel: (typeof CODEX_ASK_MODELS)[number] | null;
  codexEffort: (typeof CODEX_ASK_EFFORTS)[number] | null;
  /** Factiii's AI features run on `runnerId` by default, not on Trons
   *  ("AI features"). */
  aiOnRunner: boolean;
};

/** An account that never chose. */
export const DEFAULT_OAKBOX_BACKEND: OakboxBackend = {
  mode: 'FACTIII',
  runnerId: null,
  model: null,
  claudeModel: null,
  claudeEffort: null,
  codexModel: null,
  codexEffort: null,
  aiOnRunner: false
};

/** A runner as Oakbox's lists carry it (`runners.vaultOnline`). */
type ListedRunner = { runnerId: number; shared: boolean };

/** Which runners Oakbox may dial: a key for the caches, and the test. */
export type RunnerScope = {
  key: string;
  includes: (runner: ListedRunner) => boolean;
};

/** The runners Oakbox uses in this mode: the computer chosen in Account >
 *  Backend, and none of the person's own until one is; on Factiii, every
 *  vault shared with the person too (accepted in the Shared vault tab). No
 *  other runner is dialed, so a computer is never used without being chosen. */
export function runnerScope(backend: OakboxBackend): RunnerScope {
  switch (backend.mode) {
    case 'FACTIII':
      return {
        key: `factiii:${backend.runnerId ?? 'none'}`,
        includes: (runner) =>
          runner.shared || runner.runnerId === backend.runnerId
      };
    case 'RUNNER':
      return {
        key: `runner:${backend.runnerId ?? 'none'}`,
        includes: (runner) =>
          !runner.shared && runner.runnerId === backend.runnerId
      };
  }
}

/** A computer of the person's own is part of the backend: always in Runner,
 *  and on Factiii once one is chosen. */
export const usesComputer = (backend: OakboxBackend): boolean =>
  backend.mode === 'RUNNER' || backend.runnerId !== null;

/** Where a file added now goes: the chosen runner's Vault in Runner mode,
 *  else Factiii's storage. */
export const addsToRunner = (backend: OakboxBackend): number | null =>
  backend.mode === 'RUNNER' ? backend.runnerId : null;

/** What of Factiii Oakbox uses for this account (.specs/oakbox.md "Backend",
 *  "Runner mode is independent of Factiii"). */
export type FactiiiFeatures = {
  /** Factiii's files, search, upload queue, Categorize, Skills, the cloud
   *  models and their chats, and kept research. */
  content: boolean;
  /** Plans, storage and Trons: the paywall, the storage bar, the balance and
   *  their Account tabs. */
  billing: boolean;
};

/**
 * Runner mode uses none of Factiii: its files, models and chats are the
 * runner's, and it is free, so no plan, storage or Trons either. What still
 * reaches Factiii is sign-in, this setting, the runner list and who is
 * online, the signalling that connects the device to the runner, and the
 * category tree (`oakboxBackend.categories`) with the person's own category
 * edits (`factiiis.*`): names and rules, never a file or a tag.
 *
 * `null` is a setting not read yet: nothing until it is, so an account in
 * Runner mode never sends a Factiii request on its way in.
 */
export function factiiiFeatures(
  backend: OakboxBackend | null
): FactiiiFeatures {
  const on = backend !== null && backend.mode !== 'RUNNER';
  return { content: on, billing: on };
}

/** Organize in Runner mode, about files added in the other modes. Said
 *  always: knowing whether there are any would mean asking Factiii. */
export const RUNNER_FACTIII_FILES_NOTE =
  'Files you added with Vault · on Factiii are kept there. They show again when you switch back.';

/** Under the ways to add a file in Runner mode, in place of the cloud's AI
 *  notice (FILE_AI_NOTICE). */
export const RUNNER_FILE_NOTICE =
  'Files go to your runner over a direct link. Its own models read them, and nothing is sent to Factiii.';

type ModeCopy = {
  mode: OakboxBackendMode;
  title: string;
  line: string;
  /** Where things are kept, who can read them, what is hidden, and what it
   *  costs: one list, each point said once and not again by `line`. */
  points: string[];
};

// Only what is true today: the privacy policy's sections 4 and 8 for
// Factiii, runner-vault.md and runner-vault-ask.md "Ask with a runner's model"
// for the runner. No price is typed here: plans and Trons come from their own cards.
export const BACKEND_MODES: ModeCopy[] = [
  {
    mode: 'FACTIII',
    title: 'Vault · on Factiii',
    line: 'Easiest. Works on any device, nothing to install.',
    points: [
      'Your files are stored privately. Only you can open them.',
      'The research agent uses models from Anthropic and OpenAI. They don’t train on your files.',
      'A monthly plan for storage, and Trons for the research agent.',
      'Have a computer with Oakbox on it? Its files also show in search, with a lock.'
    ]
  },
  {
    mode: 'RUNNER',
    title: 'Vault · on your computer',
    line: 'Most private. Your files and research agent stay on a computer you own.',
    points: [
      'You install the Oakbox runner on that computer. It needs to be on when you use Oakbox.',
      'Free. No plan and no Trons.',
      'We only sign you in. Your files never reach our servers.',
      'Shared vaults, Skills and cloud models need our servers, so they’re off.'
    ]
  }
];

/** Account > Backend's opening line (its card's note): the choice, before
 *  the modes' own lines. */
export const BACKEND_INTRO =
  'Choose where your files are kept and where your research agent runs.';

export const backendModeCopy = (mode: OakboxBackendMode): ModeCopy =>
  BACKEND_MODES.find((m) => m.mode === mode) ?? BACKEND_MODES[0]!;

/** What Account says over the steps to add one, when Runner mode has no
 *  runner to use (backend/AddRunner.tsx). */
export const NO_RUNNER_NOTE =
  'No computer is connected yet. Install the Oakbox runner on one: it keeps your files and runs your research agent.';

// ── Your computer ──

/** Runner mode with computers but none chosen, beside the menu to choose
 *  one: nothing is used until one is. */
export const CHOOSE_RUNNER_LINE = 'Choose the computer Oakbox uses.';

/** Organize, Ask and adding files in Runner mode with no computer chosen. */
export const CHOOSE_RUNNER_NOTE =
  'No computer is chosen yet. Choose one in Account, under Backend.';

/** Our servers with no computer chosen, beside its add or choose button. */
export const OPTIONAL_RUNNER_LINE = 'Also search a computer you own.';

/** The computer's one status line, under its name and in Change's list. */
export const runnerStatusLine = (online: boolean): string =>
  online ? 'Online' : 'Offline. Turn it on to use Oakbox.';

const gbLeft = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} GB`;

/** The computer's warning, or null when it is fine: low disk, else low
 *  memory. */
export function backendHealthLine(health: RunnerMachineHealth): string | null {
  const low = health.disks.reduce<RunnerMachineHealth['disks'][number] | null>(
    (min, d) => (!min || d.freeGb < min.freeGb ? d : min),
    null
  );
  if (low?.level === 'critical') {
    return `Almost out of space: ${gbLeft(low.freeGb)} left. New files and models can’t be added.`;
  }
  if (low?.level === 'warn') {
    return `Running low on space: ${gbLeft(low.freeGb)} left.`;
  }
  return health.memory && health.memory !== 'ok'
    ? 'This computer is running low on memory.'
    : null;
}

// ── Research agent ──

/** Backend's research-agent block: Runner mode starts Ask on the one on
 *  this computer; Factiii starts it on ours, so these are extras. */
export const AGENTS_COPY = {
  RUNNER: {
    heading: 'Research agent',
    line: 'Answers your questions in Ask. You can switch between these there.'
  },
  FACTIII: {
    heading: 'Also available in Ask',
    line: 'Ask starts on our servers. You can switch to one of these there.'
  }
} as const;

/** Each research agent's name and whose account it uses. */
export const AGENT_TITLES = {
  local: { title: 'On this computer', by: 'Fully private and free.' },
  claude: { title: 'Claude', by: 'Uses your Claude account.' },
  codex: { title: 'Codex', by: 'Uses your ChatGPT account.' }
} as const;

/** The mark on the agent Ask starts with. */
export const USED_IN_ASK = 'Used in Ask';

/** The one on this computer, with its model: "Llama 3.2 3B · fully
 *  private, free". */
export const localAgentLine = (tag: string): string =>
  `${ollamaTitle(tag)} · fully private, free`;

// ── Models ──

/** Over the model search, in the sheet from "Change model". */
export const MODEL_SHEET_NOTE =
  'Models run on this computer. Bigger ones answer better but need more space and memory.';

/** Ollama reads a name with no tag as `:latest`. */
export const ollamaTagKey = (tag: string): string =>
  tag.includes(':') ? tag : `${tag}:latest`;

/** The table's name for a model, else its tag. */
export const ollamaTitle = (tag: string): string =>
  LOCAL_AI_MODELS.find((m) => m.id === tag)?.title ?? tag;

/** The model Ask starts on when none is chosen: the table's largest the
 *  runner holds, else the first other by name. */
export function defaultAskModel(installed: string[]): string | null {
  const rank = (tag: string) => LOCAL_AI_MODELS.findIndex((m) => m.id === tag);
  return (
    [...installed].sort((a, b) => rank(b) - rank(a) || a.localeCompare(b))[0] ??
    null
  );
}

/** One tag as Backend lists it: under its family, or the family's quick
 *  actions. */
export type BackendModelRow = {
  tag: string;
  title: string;
  /** On the runner now. */
  installed: boolean;
  /** Its row in the fixed table, with whether it fits; null for any other
   *  Ollama model. */
  fit: LocalAiModelFit | null;
  /** Ask starts on it. */
  inUse: boolean;
};

type ModelList = Pick<
  RunnerLocalAiModels,
  'installed' | 'models' | 'recommended'
>;

/** One model by its tag: held or not, its table row, and in use or not. */
export function backendModelRow(
  list: Pick<ModelList, 'installed' | 'models'>,
  tag: string,
  inUse: string | null
): BackendModelRow {
  const key = ollamaTagKey(tag);
  return {
    tag,
    title: ollamaTitle(tag),
    installed: list.installed.some((t) => ollamaTagKey(t) === key),
    fit: list.models.find((m) => ollamaTagKey(m.id) === key) ?? null,
    inUse: inUse !== null && ollamaTagKey(inUse) === key
  };
}

/** A model's family on ollama.com: `llama3.2` of `llama3.2:3b`. */
const ollamaFamily = (tag: string): string => {
  const at = tag.lastIndexOf(':');
  return at === -1 ? tag : tag.slice(0, at);
};

/** A tag without its family: `3b` of `llama3.2:3b`, `latest` of `phi3`. */
export const ollamaTagName = (tag: string): string => {
  const key = ollamaTagKey(tag);
  return key.slice(key.lastIndexOf(':') + 1);
};

/** One family as Backend lists it: an ollama.com model, or one the runner
 *  holds that ollama.com's results do not have. */
export type ModelFamily = {
  name: string;
  /** ollama.com's entry; null when its results do not have it. */
  library: OllamaLibraryModel | null;
  /** The runner's tags of it. */
  held: BackendModelRow[];
  /** The table's pick for this machine, when it is of this family. */
  recommended: BackendModelRow | null;
};

/** What the runner holds of one family, and the machine's pick if it is of
 *  it, read from the list as it is now. */
export function familyOf(
  list: ModelList,
  name: string,
  inUse: string | null,
  library: OllamaLibraryModel | null = null
): ModelFamily {
  const pick = list.recommended;
  return {
    name,
    library,
    held: list.installed
      .filter((t) => ollamaFamily(t) === name)
      .map((t) => backendModelRow(list, t, inUse)),
    recommended:
      pick && ollamaFamily(pick) === name
        ? backendModelRow(list, pick, inUse)
        : null
  };
}

/**
 * Backend's one list of models for `query`: the families the runner holds,
 * then the machine's pick from the table, then ollama.com's `results` (the
 * popular list for an empty box). Held and picked families show whatever
 * ollama.com answers, so they still work when it cannot be reached. With
 * text, a held or picked family shows when its name, a tag or its table
 * title matches, or ollama.com found it.
 */
export function modelFamilies(
  list: ModelList,
  query: string,
  inUse: string | null,
  results: OllamaLibraryModel[] | null
): ModelFamily[] {
  const q = query.trim().toLowerCase();
  const found = new Map((results ?? []).map((m) => [m.name, m]));
  const names = [
    ...new Set(list.installed.map(ollamaFamily)),
    ...(list.recommended ? [ollamaFamily(list.recommended)] : [])
  ];
  const own = [...new Set(names)]
    .map((name) => familyOf(list, name, inUse, found.get(name) ?? null))
    .filter(
      (f) =>
        !q ||
        found.has(f.name) ||
        f.name.toLowerCase().includes(q) ||
        [...f.held, f.recommended].some(
          (r) =>
            r &&
            (r.tag.toLowerCase().includes(q) ||
              r.title.toLowerCase().includes(q))
        )
    );
  const shown = new Set(own.map((f) => f.name));
  return [
    ...own,
    ...(results ?? [])
      .filter((m) => !shown.has(m.name))
      .map((m) => familyOf(list, m.name, inUse, m))
  ];
}

/** What the runner holds of a family, in a line: "On this computer: 1b,
 *  3b · Used in Ask: 3b". A family it holds one tag of is that tag's own row
 *  (ModelFamilies.tsx), so this is for two or more. */
export function familyHeldLine(held: BackendModelRow[]): string | null {
  if (held.length === 0) return null;
  const using = held.find((r) => r.inUse);
  const ask = using ? `${USED_IN_ASK}: ${ollamaTagName(using.tag)}` : null;
  const tags = held.map((r) => ollamaTagName(r.tag)).join(', ');
  return [`On this computer: ${tags}`, ask].filter(Boolean).join(' · ');
}

/** The line under one model named by its tag: in use, or whether it fits.
 *  Its size, not its parameters: the tag already says "3b". A held one's
 *  Remove says it is on the runner, so the line does not; null when there
 *  is nothing else to say. */
export function modelRowLine(row: BackendModelRow): string | null {
  if (row.fit && !row.fit.fits && !row.installed) {
    return row.fit.blocker ?? 'Does not fit';
  }
  let lead: string | null = 'Fits';
  if (row.inUse) lead = USED_IN_ASK;
  else if (row.installed) lead = null;
  const size = row.fit ? `about ${row.fit.diskGb} GB` : null;
  return [lead, size].filter(Boolean).join(' · ') || null;
}

/** "5.2 GB", "523 MB". */
export const modelSizeLabel = (gb: number): string =>
  gb < 1
    ? `${Math.round(gb * 1000)} MB`
    : `${gb < 10 ? Math.round(gb * 10) / 10 : Math.round(gb)} GB`;

/** "40.9M", "12.4K", "512": a search result's downloads, as ollama.com
 *  shows them. */
export function downloadsLabel(n: number): string {
  const short = (v: number, unit: string) =>
    `${v < 100 ? Math.round(v * 10) / 10 : Math.round(v)}${unit}`;
  if (n >= 1e9) return short(n / 1e9, 'B');
  if (n >= 1e6) return short(n / 1e6, 'M');
  if (n >= 1e3) return short(n / 1e3, 'K');
  return String(n);
}

/** A tag's facts in a line: "5.2 GB · 40K context · Text, Image". */
export function libraryTagFacts(tag: OllamaLibraryTag): string {
  let size: string | null = tag.cloud ? 'Cloud' : null;
  if (tag.sizeGb !== null) size = modelSizeLabel(tag.sizeGb);
  return [size, tag.context ? `${tag.context} context` : null, tag.input]
    .filter(Boolean)
    .join(' · ');
}

/** Whether a tag can be added here, in a line. */
export function libraryTagStatus(
  tag: OllamaLibraryTag,
  row: Pick<BackendModelRow, 'installed' | 'inUse'>
): string {
  if (row.inUse) return USED_IN_ASK;
  if (row.installed) return 'On this computer';
  if (!tag.fits) return tag.blocker ?? 'Too big for this computer.';
  // The row already shows its name and size, and the panel the low disk.
  return tag.sizeGb === null ? 'Its size shows once it is pulled.' : 'Fits';
}

/** What the last pull or remove is doing, in a line. */
export function modelJobLine(job: RunnerLocalAiJob): string {
  const title = ollamaTitle(job.tag);
  const verb = job.action === 'pull' ? 'Adding' : 'Removing';
  if (job.state === 'running') return `${verb} ${title}…`;
  if (job.state === 'done')
    return job.action === 'pull' ? `${title} is ready.` : `Removed ${title}.`;
  return `${verb} ${title} did not finish.`;
}

// ── Claude and Codex ──

type CliEngine = 'claude' | 'codex';

/** A CLI's own model or effort, where none is picked. */
export const CLI_AUTOMATIC = 'Automatic';

/** The names Backend and Ask's menu give the models and efforts. */
export const CLI_MODEL_LABELS: Record<
  (typeof CLAUDE_ASK_MODELS)[number] | (typeof CODEX_ASK_MODELS)[number],
  string
> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  'gpt-6.1-sol': 'GPT-6.1 Sol',
  'gpt-6-astra': 'GPT-6 Astra',
  'gpt-6-luna': 'GPT-6 Luna'
};

export const CLI_EFFORT_LABELS: Record<
  (typeof CLAUDE_ASK_EFFORTS)[number],
  string
> = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };

/** One CLI's choice, as saved. */
export function cliChoice(
  engine: CliEngine,
  backend: OakboxBackend
): CliAskSettings {
  return engine === 'claude'
    ? { model: backend.claudeModel, effort: backend.claudeEffort }
    : { model: backend.codexModel, effort: backend.codexEffort };
}

/** What one Ask turn on `engine` carries: none while both are the CLI's
 *  default, so an older runner is sent nothing new. */
export function cliAskSettings(
  engine: CliEngine,
  backend: OakboxBackend
): CliAskSettings | undefined {
  const choice = cliChoice(engine, backend);
  return choice.model || choice.effort ? choice : undefined;
}

/** The model Ask's menu names beside Claude or Codex ("Sonnet"), or null
 *  for the CLI's default. */
export function cliModelLabel(
  engine: CliEngine,
  backend: OakboxBackend
): string | null {
  const { model } = cliChoice(engine, backend);
  return model ? CLI_MODEL_LABELS[model] : null;
}

// ── AI features: Trons or the person's runner ──
// (.specs/oakbox.md "Backend" → AI features). The words the switch says, for
// the web and the phone app.

type AiTargetChoice = 'TRONS' | 'RUNNER';

/** One side of the switch: "Trons", or the runner by name. */
export const aiTargetLabel = (
  target: AiTargetChoice,
  runnerName: string
): string => (target === 'RUNNER' ? runnerName : 'Trons');

/** Under the switch, while this use is not the default. */
export const aiTargetMakeDefault = (
  target: AiTargetChoice,
  runnerName: string
): string =>
  target === 'RUNNER'
    ? `Use ${runnerName} for all AI`
    : 'Use Trons for all AI';

/** Under the switch on the runner side: what it costs, and why it can fail. */
export const aiOnRunnerLine = (runnerName: string, online: boolean): string =>
  online
    ? `Runs on ${runnerName}'s own Claude, Codex or Ollama. No Trons.`
    : `${runnerName} is offline, so Trons will answer instead.`;

/** A runner that could not answer, so Trons did. */
export const aiRunnerFellBack = (message: string): string =>
  `Your runner could not answer (${message.replace(/\.$/, '')}), so Trons did.`;
