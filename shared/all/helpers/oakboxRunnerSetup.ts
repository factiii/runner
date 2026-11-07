import type {
  RunnerCliSignins,
  RunnerPart,
  RunnerPartJob,
  RunnerPartsState
} from '../domains/electron';
import type { RunnerPartId } from '../validators/runnerParts';
import { RUNNER_UNKNOWN_ACTION_PREFIX } from './runnerVaultBackup';

// Setting up a runner from Oakbox > Account > Backend (.specs/oakbox.md
// "Backend", "Setting up a runner"): the parts of the runner Oakbox uses, as
// rows, then as Backend shows them (the Files row, each research agent's
// button), and how Oakbox tells a runner with no Vault from any other
// failure. Words for Oakbox web and the phone app.

/** The runner's answer to any Vault call while it has no Vault. Said by the
 *  runner (vault/daemonVault.ts), read by the apps (`isRunnerNoVault`). */
export const RUNNER_NO_VAULT = 'This runner has no Vault yet.';

/** The runner said it has no Vault. A runner from before the Vault has none
 *  either: it answers the action as unknown, and setting it up starts with
 *  its update (`isRunnerOutdated`). */
export const isRunnerNoVault = (message: string | null | undefined): boolean =>
  Boolean(
    message &&
    (message.startsWith(RUNNER_NO_VAULT) || isRunnerOutdated(message))
  );

/** The runner predates the action it was asked for. */
const isRunnerOutdated = (message: string | null | undefined): boolean =>
  Boolean(message?.includes(RUNNER_UNKNOWN_ACTION_PREFIX));

/** What Backend says for a runner from before Oakbox could use it. */
export const RUNNER_OUTDATED =
  'This computer runs an older Factiii runner. Approve its update on the computer’s board in Factiii, then come back.';

/** A Backend failure in words: the update for an outdated runner, else the
 *  runner's own message. */
export const runnerSetupError = (message: string): string =>
  isRunnerOutdated(message) ? RUNNER_OUTDATED : message;

/** The parts Oakbox uses, in install order. Vault search is offered only
 *  where the runner has it (a Mac with Apple silicon, or Linux). `vault` is
 *  storage and search together, from a runner from before modules. Claude
 *  and Codex are Ask's choice, not a need; an added one asks to be signed
 *  in. */
const OAKBOX_PARTS: RunnerPartId[] = [
  'vault-storage',
  'vault-search',
  'vault',
  'local-ai',
  'claude',
  'codex'
];

/** Each part in Backend's words, never its install name ("Vault storage"):
 *  what a job line says it is setting up. */
const PART_NAMES: Partial<Record<RunnerPartId, string>> = {
  'vault-storage': 'file storage',
  'vault-search': 'search by meaning',
  vault: 'file storage',
  'local-ai': 'the research agent on this computer',
  claude: 'Claude',
  codex: 'Codex'
};

type CliPartId = 'claude' | 'codex';
const isCliPart = (id: RunnerPartId): id is CliPartId =>
  id === 'claude' || id === 'codex';

const MB_PER_GB = 1000;

const diskSize = (mb: number) =>
  mb >= MB_PER_GB ? `${(mb / MB_PER_GB).toFixed(1)} GB` : `${mb} MB`;

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type SetupPartRow = {
  id: RunnerPartId;
  /** Its name in Backend's words ("file storage"). */
  name: string;
  /** What an add needs (its disk, or what only a person can do), or that
   *  it is not running; empty when there is nothing to say. */
  line: string;
  /** Added, or null while it offers a button or a job runs. Claude and
   *  Codex are Added once signed in too. */
  state: 'Added' | null;
  /** The one button it offers now. */
  action: 'add' | 'start' | 'signin' | null;
  job: RunnerPartJob | null;
};

function setupRow(
  part: RunnerPart,
  /** Claude's or Codex's sign-in; null while it is not known. */
  signedIn?: boolean | null
): SetupPartRow {
  const busy = part.job?.state === 'running';
  // Ollama installed but its server down: Start, not Added.
  const stopped =
    part.installed && part.running === false && part.actions.includes('start');
  let action: SetupPartRow['action'] = null;
  if (!busy && stopped) action = 'start';
  else if (!busy && !part.installed && part.actions.includes('add')) {
    action = 'add';
  }
  let needs: string[] = [];
  if (!part.installed) {
    needs =
      part.manual.length > 0
        ? part.manual
        : [`About ${diskSize(part.diskMb)} on disk.`];
  }
  let added = part.installed && !stopped && !busy;
  // Added but not signed in: Sign in, not a check. Not known yet: neither.
  if (added && signedIn !== undefined && signedIn !== true) {
    added = false;
    if (signedIn === false) action = 'signin';
  }
  return {
    id: part.id,
    name: PART_NAMES[part.id] ?? part.title,
    line: [...(stopped ? ['It isn’t running.'] : []), ...needs].join(' '),
    state: added ? 'Added' : null,
    action,
    job: part.job
  };
}

/** The rows Backend shows for one runner's parts, in OAKBOX_PARTS' order.
 *  `signins`: Claude's and Codex's, read apart (`cliSignins`); null while
 *  not read yet, undefined from a runner that cannot say (the parts alone
 *  then). */
export function oakboxSetupRows(
  state: RunnerPartsState,
  signins?: RunnerCliSignins | null
): SetupPartRow[] {
  // A part sits in its module and, for older apps, in the flat list too.
  const parts = new Map<RunnerPartId, RunnerPart>();
  for (const part of state.parts) parts.set(part.id, part);
  for (const part of state.modules?.flatMap((m) => m.parts) ?? []) {
    parts.set(part.id, part);
  }
  // The split Vault where the runner has modules, else the one Vault.
  const split = parts.has('vault-storage');
  return OAKBOX_PARTS.flatMap((id) => {
    if (split && id === 'vault') return [];
    const part = parts.get(id);
    if (!part) return [];
    let signedIn: boolean | null | undefined;
    if (isCliPart(id) && signins !== undefined) {
      signedIn = signins?.[id].signedIn ?? null;
    }
    return [setupRow(part, signedIn)];
  });
}

/** The heading of the job box under the rows: the running job, else the
 *  last one that failed. Null when there is nothing to show. */
export function setupJobLine(rows: SetupPartRow[]): {
  title: string;
  lines: string[];
} | null {
  const row =
    rows.find((r) => r.job?.state === 'running') ??
    rows.find((r) => r.job?.state === 'failed');
  if (!row?.job) return null;
  const start = row.job.action === 'start';
  if (row.job.state === 'running') {
    const verb = start ? 'Turning on' : 'Setting up';
    return { title: `${verb} ${row.name}…`, lines: row.job.lines };
  }
  const failed = start ? 'turn on' : 'be set up';
  // The last line says why; the rest lead up to it.
  return {
    title: `${capital(row.name)} couldn’t ${failed}.`,
    lines: row.job.lines
  };
}

/** A button on a part, in Backend's words. */
export type PartButton = {
  id: RunnerPartId;
  action: 'add' | 'start' | 'signin';
  label: string;
};

const button = (
  row: SetupPartRow,
  labels: Partial<Record<PartButton['action'], string>>
): PartButton | null => {
  const label = row.action ? labels[row.action] : undefined;
  return row.action && label ? { id: row.id, action: row.action, label } : null;
};

/** Backend's Files row: where the files are, and the one thing to add. */
type BackendFiles = {
  line: string;
  /** Stored, and searchable where this machine can be: a check. */
  ready: boolean;
  /** Being set up now: a spinner. */
  busy: boolean;
  button: PartButton | null;
  /** What the button needs, or what only a person can do. */
  note: string | null;
};

const STORED_SEARCHABLE =
  'Your files are stored and searchable on this computer.';

/** The Vault's parts as one row (storage, then search), or null on a runner
 *  that has neither. */
export function backendFiles(rows: SetupPartRow[]): BackendFiles | null {
  const storage = rows.find(
    (r) => r.id === 'vault-storage' || r.id === 'vault'
  );
  if (!storage) return null;
  const search = rows.find((r) => r.id === 'vault-search');
  if (storage.state !== 'Added') {
    const busy = storage.job?.state === 'running';
    return {
      line: busy
        ? 'Setting up file storage…'
        : 'Your files aren’t stored on this computer yet.',
      ready: false,
      busy,
      button: button(storage, {
        add: 'Set up file storage',
        start: 'Turn it on'
      }),
      note: storage.line || null
    };
  }
  // The one Vault searches too; a machine with no Vault search has no more.
  if (!search || search.state === 'Added') {
    return {
      line:
        storage.id === 'vault' || search
          ? STORED_SEARCHABLE
          : 'Your files are stored on this computer.',
      ready: true,
      busy: false,
      button: null,
      note: null
    };
  }
  const busy = search.job?.state === 'running';
  return {
    line: busy
      ? 'Turning on search by meaning…'
      : 'Your files are stored on this computer.',
    ready: false,
    busy,
    button: button(search, {
      add: 'Turn on search by meaning',
      start: 'Turn it on'
    }),
    note: busy
      ? null
      : ['Search then finds files by what they say.', search.line]
          .filter(Boolean)
          .join(' ')
  };
}

/** The one button a research agent's row offers before it can answer:
 *  setting up the one on this computer, adding Claude or Codex, or signing
 *  in. */
export const agentButton = (row: SetupPartRow): PartButton | null =>
  button(
    row,
    row.id === 'local-ai'
      ? { add: 'Set it up', start: 'Turn it on' }
      : { add: 'Add', signin: 'Sign in' }
  );

/** A code as `factiii-runner setup` prints it: XXXX-XXXX, from whatever was
 *  typed or pasted (lower case, no dash, spaces). */
export function pairingCodeInput(raw: string): string {
  const plain = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return plain.length > 4 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : plain;
}
