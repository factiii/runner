import type {
  OllamaLibraryModel,
  OllamaLibraryTag,
  RunnerLocalAiJob,
  RunnerLocalAiModels,
  RunnerMachineHealth,
  RunnerStoreName
} from '../domains/electron';
import { VAULT_DEFINITION } from '../domains/vaultDefinition';
import type { AiCli, AiSource } from '../validators/aiSource';
import type {
  CLAUDE_ASK_EFFORTS,
  CLAUDE_ASK_MODELS,
  CliAskSettings,
  CODEX_ASK_EFFORTS,
  CODEX_ASK_MODELS,
  DataLocation
} from '../validators/oakboxBackend';
import { LOCAL_AI_MODELS, type LocalAiModelFit } from './localAiModels';

// How Oakbox works for an account (.specs/oakbox.md "Backend"): the rules
// and the words, in one place for Oakbox web and the phone app. The account's
// default location (.specs/vault.md "The default location") decides:
//
// - Cloud: files, Ask and chats on Factiii's servers. With a computer
//   chosen (`runnerId`), search and Ask also reach it: its Vault's files
//   (lock-marked), its models and its chats, which stay on it. Vaults shared
//   with the person are searched too. No other runner is dialed. A file can
//   still be added to that computer from the add sheet.
// - Runner Cloud or the Vault (Runner mode, `onRunner`): the person's own
//   runner is the backend, and Oakbox uses nothing else of Factiii's
//   (`factiiiFeatures`): files, Ask and chats are the runner's, and no plan
//   or Trons apply. New files go to that store unless the add sheet says
//   otherwise.

export type OakboxBackend = {
  /** Where new items go; Runner Cloud or the Vault is Runner mode. */
  defaultLocation: DataLocation;
  runnerId: number | null;
  model: string | null;
  /** Claude's and Codex's in Ask on a runner; null is the CLI's default. */
  claudeModel: (typeof CLAUDE_ASK_MODELS)[number] | null;
  claudeEffort: (typeof CLAUDE_ASK_EFFORTS)[number] | null;
  codexModel: (typeof CODEX_ASK_MODELS)[number] | null;
  codexEffort: (typeof CODEX_ASK_EFFORTS)[number] | null;
  /** Factiii's AI features run on `runnerId` by default, not on Trons
   *  ("AI features"). Kept in step with `aiSource` for older apps. */
  aiOnRunner: boolean;
  /** Where Factiii's AI features run by default (.specs/ai-source.md). */
  aiSource: AiSource;
  /** On RUNNER, the CLI it uses; null lets the runner pick. */
  aiCli: AiCli | null;
  /** The runner AI features run on, apart from Oakbox's `runnerId`; null is
   *  that one, else the first online (pickRunner). */
  aiRunnerId: number | null;
};

/** An account that never chose. */
export const DEFAULT_OAKBOX_BACKEND: OakboxBackend = {
  defaultLocation: 'CLOUD',
  runnerId: null,
  model: null,
  claudeModel: null,
  claudeEffort: null,
  codexModel: null,
  codexEffort: null,
  aiOnRunner: false,
  aiSource: 'TRONS',
  aiCli: null,
  aiRunnerId: null
};

/** A runner as Oakbox's lists carry it (`runners.vaultOnline`). */
type ListedRunner = { runnerId: number; shared: boolean };

/** Which runners Oakbox may dial: a key for the caches, and the test. */
export type RunnerScope = {
  key: string;
  includes: (runner: ListedRunner) => boolean;
};

/** Runner mode: a Runner Cloud or Vault default, so the runner is the
 *  backend and nothing of Factiii's content or Trons is used. Premium is still
 *  needed (.specs/oakbox.md "Premium in every mode"). */
export const onRunner = (backend: OakboxBackend): boolean =>
  backend.defaultLocation !== 'CLOUD';

/** The runners Oakbox uses in this mode: the computer chosen in Account >
 *  Backend, and none of the person's own until one is; on Factiii, every
 *  Oakbox shared with the person too (accepted in the Sharing tab). No
 *  other runner is dialed, so a computer is never used without being chosen. */
export function runnerScope(backend: OakboxBackend): RunnerScope {
  if (onRunner(backend)) {
    return {
      key: `runner:${backend.runnerId ?? 'none'}`,
      includes: (runner) =>
        !runner.shared && runner.runnerId === backend.runnerId
    };
  }
  return {
    key: `factiii:${backend.runnerId ?? 'none'}`,
    includes: (runner) => runner.shared || runner.runnerId === backend.runnerId
  };
}

/**
 * The runners Ask may use: its model menu and its runner chats (decided
 * 2026-11-08). Wider than `runnerScope` on Factiii: every runner of the
 * person's own with a Vault online, chosen or not, so a connected runner's
 * Claude, Codex and Ollama show up without first being chosen in Account >
 * Backend. They are dialed only when the menu or the chat list opens, which
 * is the person asking for them. Search and where files go still follow
 * `runnerScope`. Runner mode is unchanged: its chosen runner only.
 */
export function askScope(backend: OakboxBackend): RunnerScope {
  if (onRunner(backend)) return runnerScope(backend);
  return { key: 'factiii:ask', includes: () => true };
}

/** A computer of the person's own is part of the backend: always in Runner,
 *  and on Factiii once one is chosen. */
export const usesComputer = (backend: OakboxBackend): boolean =>
  onRunner(backend) || backend.runnerId !== null;

/** A place a file added now can go: Factiii Cloud, or one of the chosen
 *  runner's two stores (.specs/vault.md "The three places"). */
export type AddPlace = 'cloud' | RunnerStoreName;

const PLACE_OF: Record<DataLocation, AddPlace> = {
  CLOUD: 'cloud',
  RUNNER: 'runner',
  VAULT: 'vault'
};

/** Where an add starts: the account's default location. */
export const defaultAddPlace = (backend: OakboxBackend): AddPlace =>
  PLACE_OF[backend.defaultLocation];

/** The places the add sheet offers, in the order every list names them
 *  (Cloud, Runner Cloud, Vault). On Cloud, the chosen computer's stores join
 *  it; with none chosen, Cloud is the only place (the sheet offers "Add your
 *  computer"). Runner mode offers the runner's two only: it sends nothing to
 *  Factiii. */
export function addPlaces(backend: OakboxBackend): AddPlace[] {
  if (onRunner(backend)) return ['runner', 'vault'];
  return backend.runnerId === null ? ['cloud'] : ['cloud', 'runner', 'vault'];
}

/** The place an add goes to: the pick when it is one on offer, else the
 *  default (a pick from before a change of default or runner never
 *  outlives it). */
export const addPlaceFor = (
  backend: OakboxBackend,
  picked: AddPlace | null
): AddPlace =>
  picked !== null && addPlaces(backend).includes(picked)
    ? picked
    : defaultAddPlace(backend);

/** Where a file added now goes: the chosen runner when the place is one of
 *  its stores (the default, or picked on the add sheet), else Factiii's
 *  Cloud (null). */
export const addsToRunner = (
  backend: OakboxBackend,
  place: AddPlace = defaultAddPlace(backend)
): number | null => (place === 'cloud' ? null : backend.runnerId);

/** The runner and store a file added now goes to, or null for Cloud (or a
 *  runner place with no computer chosen, which takes nothing). */
export type RunnerAddTarget = { runnerId: number; store: RunnerStoreName };

export function runnerAddTarget(
  backend: OakboxBackend,
  place: AddPlace
): RunnerAddTarget | null {
  if (place === 'cloud' || backend.runnerId === null) return null;
  return { runnerId: backend.runnerId, store: place };
}

/** What of Factiii Oakbox uses for this account (.specs/oakbox.md "Backend",
 *  "Runner mode is independent of Factiii"). */
export type FactiiiFeatures = {
  /** Factiii's files, search, upload queue, Categorize, Skills, the cloud
   *  models and their chats, and kept research. */
  content: boolean;
  /** Storage and Trons: the storage bar, the balance and their Account tabs.
   *  Not the paywall or the plan, which apply in every mode. */
  billing: boolean;
};

/**
 * Runner mode uses none of Factiii's content: its files, models and chats are
 * the runner's, so no storage bar or Trons either. The Premium gate and the
 * plan in Account are asked in every mode (.specs/oakbox.md "Premium in every
 * mode"). What still reaches Factiii is sign-in, the Premium check
 * (`onedriveEmbed.status`) and the plan, this setting, the runner list and
 * who is online, the signalling that connects the device to the runner, and the
 * category tree (`oakboxBackend.categories`) with the person's own category
 * edits (`factiiis.*`): names and rules, never a file or a tag.
 *
 * `null` is a setting not read yet: nothing until it is, so an account in
 * Runner mode never sends a Factiii request on its way in.
 */
export function factiiiFeatures(
  backend: OakboxBackend | null
): FactiiiFeatures {
  const on = backend !== null && !onRunner(backend);
  return { content: on, billing: on };
}

/** Organize in Runner mode, about files added in the other modes. Said
 *  always: knowing whether there are any would mean asking Factiii. */
export const RUNNER_FACTIII_FILES_NOTE =
  'Files you added to the Cloud are kept there. They show again when you switch back.';

/** Under the ways to add a file in Runner mode, in place of the cloud's AI
 *  notice (FILE_AI_NOTICE). */
export const RUNNER_FILE_NOTICE =
  'Files go to your runner over a direct link, and nothing is sent to Factiii.';

/** The places a file can go (.specs/vault.md "The three places"), as the
 *  add sheet names them, each with what AI can read it. In the order every
 *  list shows them. */
export const ADD_PLACE_CHOICES: {
  id: AddPlace;
  label: string;
  line: string;
}[] = [
  {
    id: 'cloud',
    label: 'Cloud',
    line: 'In the Cloud. Synced everywhere.'
  },
  {
    id: 'runner',
    label: 'Runner Cloud',
    line: 'On your computer. Any AI you choose can read it, Claude and Codex included.'
  },
  {
    id: 'vault',
    label: 'Vault',
    line: 'On your computer. Only private AI on your computer can read it.'
  }
];

/** Over the add sheet's place pick. */
export const ADD_PLACE_PICK_LABEL = 'Add to';

/** The add sheet's entry when Cloud is the only place (no computer chosen):
 *  it opens Account > Backend. */
export const ADD_YOUR_COMPUTER = 'Add your computer';
export const ADD_YOUR_COMPUTER_LINE =
  'Keep files on a computer of your own too, free: in Runner Cloud or your Vault.';

export const addPlaceChoice = (place: AddPlace) =>
  ADD_PLACE_CHOICES.find((c) => c.id === place) ?? ADD_PLACE_CHOICES[0]!;

/** The add sheet's choices for this account (`addPlaces`). */
export const addPlaceChoices = (backend: OakboxBackend) => {
  const places = addPlaces(backend);
  return ADD_PLACE_CHOICES.filter((c) => places.includes(c.id));
};

type LocationCopy = {
  location: DataLocation;
  title: string;
  line: string;
  /** Where things are kept, who can read them, what is hidden, and what it
   *  costs: one list, each point said once and not again by `line`. */
  points: string[];
};

/** What a Runner Cloud and a Vault default share: Runner mode. */
const RUNNER_MODE_POINTS = [
  'You install the Oakbox runner on that computer. It needs to be on when you use Oakbox.',
  'Free. No plan and no Trons.',
  'We only sign you in. Your files never reach our servers.',
  'Sharing, Skills and cloud models need our servers, so they’re off.'
];

// Only what is true today: the privacy policy's sections 4 and 8 for
// Factiii, runner-vault.md and runner-vault-ask.md "Ask with a runner's model"
// for the runner. No price is typed here: plans and Trons come from their own cards.
// Names (card a9bec1e7, 2026-11-11): Cloud is Factiii's servers, never called a
// vault (card 7b54ebdc); a runner holds a Vault and Runner Cloud.
/** The default location's choices in Account > Backend (.specs/vault.md
 *  "The default location"), which replaced the backend modes. */
export const DEFAULT_LOCATIONS: LocationCopy[] = [
  {
    location: 'CLOUD',
    title: 'Cloud',
    line: 'Easiest. Works on any device, nothing to install.',
    points: [
      'Your files are stored privately. Only you can open them.',
      'The research agent uses models from Anthropic and OpenAI. They don’t train on your files.',
      'A monthly plan for storage, and Trons for the research agent.',
      'Have a computer with Oakbox on it? Its files also show in search, with a lock, and you can add files to it.'
    ]
  },
  {
    location: 'RUNNER',
    title: 'Runner Cloud',
    line: 'Free. New files go to Runner Cloud, on a computer you own.',
    points: [
      'Any AI you choose can read Runner Cloud, Claude and Codex included. You can still add a file to your Vault instead.',
      ...RUNNER_MODE_POINTS
    ]
  },
  {
    location: 'VAULT',
    title: 'Vault',
    line: 'Most private. New files go to your Vault, on a computer you own.',
    points: [
      VAULT_DEFINITION,
      'You can still add a file to Runner Cloud instead.',
      ...RUNNER_MODE_POINTS
    ]
  }
];

/** Account > Backend's opening line (its card's note): the choice, before
 *  the modes' own lines. */
export const BACKEND_INTRO =
  'Choose where new files go and where your research agent runs. You can pick another place each time you add.';

/** The default locations Account > Backend offers: all three once the
 *  account has a runner; with none, Cloud only (and "Add your computer"
 *  under it), keeping a runner default already saved so it still shows. */
export function defaultLocationChoices(
  backend: OakboxBackend,
  hasRunner: boolean
): LocationCopy[] {
  if (hasRunner) return DEFAULT_LOCATIONS;
  return DEFAULT_LOCATIONS.filter(
    (l) => l.location === 'CLOUD' || l.location === backend.defaultLocation
  );
}

export const locationCopy = (location: DataLocation): LocationCopy =>
  DEFAULT_LOCATIONS.find((m) => m.location === location) ??
  DEFAULT_LOCATIONS[0]!;

/** What Account says over the steps to add one, when Runner mode has no
 *  runner to use (backend/AddRunner.tsx). */
export const NO_RUNNER_NOTE =
  'No computer is connected yet. Install the Oakbox runner on one: it keeps your files and runs your research agent.';

// ── Your computer ──

/** Runner mode with computers but none chosen, beside the menu to choose
 *  one: nothing is used until one is. */
export const CHOOSE_RUNNER_LINE = 'Choose the computer Oakbox uses.';

/** Why Ask's paperclip is greyed out: the chat's model is a runner's, which
 *  takes no file from this device yet (Upload still stores one). */
export const ASK_FILES_RUNNER_MODEL_NOTE =
  "This computer's model can't take a file from here yet. Use Upload to store it, then ask about it.";

/** Why Ask's paperclip is greyed out: the chosen computer is offline. */
export const ASK_FILES_RUNNER_OFFLINE_NOTE =
  'Your computer is offline. Start it to add a file to the question.';

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
 *  this computer; Cloud starts it on ours, so these are extras. */
const AGENTS_COPY = {
  RUNNER: {
    heading: 'Research agent',
    line: 'Answers your questions in Ask. You can switch between these there.'
  },
  CLOUD: {
    heading: 'Also available in Ask',
    line: 'Ask starts on our servers. You can switch to one of these there.'
  }
} as const;

export const agentsCopy = (backend: OakboxBackend) =>
  AGENTS_COPY[onRunner(backend) ? 'RUNNER' : 'CLOUD'];

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

/**
 * The Ollama model Factiii's AI features answer with on a runner holding
 * `installed` (.specs/ai-source.md "Which Ollama model"): Backend's `model`
 * while the runner holds it, else `defaultAskModel`. The one rule for the
 * runner (vault/aiPrompt.ts), the AI picker's "Ollama · <model>" and the
 * model list on Settings > AI and the runner's Status > AI.
 */
export function ollamaModelInUse(
  model: string | null,
  installed: string[]
): string | null {
  if (model) {
    const key = ollamaTagKey(model);
    const held = installed.find((tag) => ollamaTagKey(tag) === key);
    if (held) return held;
  }
  return defaultAskModel(installed);
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

const SIZE_UNITS: Record<string, number> = {
  B: 1e-9,
  KB: 1e-6,
  MB: 1e-3,
  GB: 1
};

/** One layer's line of `ollama pull`: "pulling 74701a8c35f6:  45% ▕██  ▏
 *  590 MB/1.3 GB  30 MB/s  22s", or "… 100% ▕████▏ 1.3 GB" once it is in. */
const PULL_LAYER_LINE =
  /^pulling ([0-9a-f]+):\s*(\d{1,3})%[^\d]*(?:[\d.]+\s*[KMG]?B\s*\/\s*)?([\d.]+)\s*([KMG]?B)?/;

/**
 * How far a running pull is, 0 to 100, from its output lines; null until
 * Ollama prints a layer's percent. Each layer counts by its size (the model's
 * weights are nearly all of it), at its newest line.
 */
export function modelJobPercent(job: RunnerLocalAiJob): number | null {
  const layers = new Map<string, { percent: number; gb: number }>();
  for (const line of job.lines) {
    const m = PULL_LAYER_LINE.exec(line);
    if (!m) continue;
    const unit = SIZE_UNITS[m[4] ?? ''] ?? 0;
    layers.set(m[1]!, {
      percent: Math.min(100, Number(m[2])),
      gb: Number(m[3]) * unit
    });
  }
  if (layers.size === 0) return null;
  const all = [...layers.values()];
  const total = all.reduce((sum, l) => sum + l.gb, 0);
  const share =
    total > 0
      ? all.reduce((sum, l) => sum + l.percent * l.gb, 0) / total
      : all[all.length - 1]!.percent;
  return Math.round(share);
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

// ── Private AI setup (card a9bec1e7 step 10) ──

/** The model the runner picked for this machine (the largest of the table
 *  that fits its memory and disk), offered in one tap while Ollama holds
 *  none. Null once a model is there, while a pull runs, or when nothing
 *  fits: then "Choose a model" is the only way on. */
export function recommendedModel(
  list: RunnerLocalAiModels
): LocalAiModelFit | null {
  if (!list.ollama || list.installed.length > 0) return null;
  if (list.job?.state === 'running' || !list.recommended) return null;
  return list.models.find((m) => m.id === list.recommended && m.fits) ?? null;
}

/** The row's line while it offers the pick. */
export const recommendedModelLine = (model: LocalAiModelFit): string =>
  `Recommended for this computer: ${model.title}, ${model.diskGb} GB.`;

/** Asked before the pick is pulled: a download never starts unasked. */
export function recommendedModelConfirm(
  model: LocalAiModelFit,
  list: RunnerLocalAiModels
): { title: string; body: string; confirmLabel: string } {
  const memory = list.machine ? ` (${list.machine.memoryGb} GB)` : '';
  return {
    title: `Add ${model.title}?`,
    body: `It downloads about ${model.diskGb} GB to this computer and runs there, fully private. It fits this computer’s memory${memory}. You can change it any time.`,
    confirmLabel: 'Add it'
  };
}
