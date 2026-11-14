import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { Command } from 'commander';
import ts from 'typescript';

import { OWNER_ONLY_ACTIONS } from '@shared/all/helpers/board-agent-core/runner-access';
import { startSecretsBridge } from '@shared/all/helpers/board-agent-core/secrets-bridge';
import {
  ACTION_FEATURE,
  CLIENT_FEATURES,
  RUNNER_FEATURES,
  RUNNER_PROTOCOL,
  runnerInfoFrame,
  SERVER_FEATURES
} from '@shared/all/domains/runnerProtocol';

// The frozen surface of runner 1.0 (.specs/versioning.md "Frozen surface"),
// read off the code and held against apps/runner/protocol-surface.json, the
// surface of the release named in it. A name added or removed since then
// needs a changelog note naming it above that release's heading: an addition
// is a minor, a removal or a rename a major. From 1.0 a removal also needs a
// new major version. Payload fields, file contents and output text are frozen
// too but not checked here.
//
// At a release the snapshot may be retaken (it never has to be):
//   UPDATE_RUNNER_SURFACE=1 pnpm --filter @factiii/runner exec node --import tsx --test src/protocolSurface.test.ts
// which refuses unless package.json is newer than the snapshot and every
// change is noted.
//
// Reads only apps/runner and the shared files the runner imports, so it runs
// in the public source mirror too (scripts/public-mirror.mjs).

const RUNNER = path.join(__dirname, '..');
const ROOT = path.join(RUNNER, '..', '..');
const SNAPSHOT = path.join(RUNNER, 'protocol-surface.json');
const CHANGELOG = path.join(RUNNER, 'CHANGELOG.md');
const ELECTRON = path.join(ROOT, 'shared', 'all', 'domains', 'electron.ts');
const SECRETS_BRIDGE = path.join(
  ROOT,
  'shared',
  'all',
  'helpers',
  'board-agent-core',
  'secrets-bridge.ts'
);
const UPDATE = process.env.UPDATE_RUNNER_SURFACE === '1';
const RETAKE =
  'UPDATE_RUNNER_SURFACE=1 pnpm --filter @factiii/runner exec node --import tsx --test src/protocolSurface.test.ts';

type Surface = Record<string, string[]>;
type Snapshot = { version: string; surface: Surface };

const read = (file: string) => fs.readFileSync(file, 'utf-8');
const uniqueSorted = (names: Iterable<string>) => [...new Set(names)].sort();

/** The keys of an object type in a source file, parsed, not compiled. */
function typeKeys(file: string, typeName: string): string[] {
  const source = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS
  );
  const alias = source.statements.find(
    (s): s is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(s) && s.name.text === typeName
  );
  assert.ok(alias, `${typeName} is no longer in ${path.relative(ROOT, file)}`);
  const parts = ts.isIntersectionTypeNode(alias.type)
    ? alias.type.types
    : [alias.type];
  const keys: string[] = [];
  for (const part of parts) {
    assert.ok(
      ts.isTypeLiteralNode(part),
      `${typeName} is no longer a plain object type: teach protocolSurface.test.ts to read it`
    );
    for (const member of part.members) {
      // `[key: \`log:${string}\`]`: a family of names, kept as its pattern.
      if (ts.isIndexSignatureDeclaration(member)) {
        const key = member.parameters[0]?.type;
        assert.ok(key, `${typeName} has an index signature with no key type`);
        keys.push(key.getText(source).replace(/^`|`$/g, ''));
        continue;
      }
      const name = member.name;
      assert.ok(
        name && (ts.isIdentifier(name) || ts.isStringLiteral(name)),
        `${typeName} has a member with a computed name: teach protocolSurface.test.ts to read it`
      );
      keys.push(name.text);
    }
  }
  return uniqueSorted(keys);
}

/** Every match of `re`'s first group in `files`. */
function matches(files: string[], re: RegExp): string[] {
  return files.flatMap((file) =>
    [...read(file).matchAll(re)].map((m) => m[1])
  );
}

/** The runner's own sources, tests left out. */
function runnerSources(dir = path.join(RUNNER, 'src')): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return runnerSources(full);
    return entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.includes('.testutil.')
      ? [full]
      : [];
  });
}

/** `factiii-runner`'s commands and options, from the program cli.ts builds.
 *  The import runs cli.ts with `parse` stubbed, so no command runs, against
 *  a throwaway runner folder (it makes the agent homes there). */
async function cliSurface(): Promise<string[]> {
  // Under /tmp, not os.tmpdir(): macOS's is too long for a runner folder
  // (runner-dir.ts keeps sockets under the 104-byte limit).
  const dir = fs.mkdtempSync(path.join('/tmp', 'fr-surface-'));
  process.env.FACTIII_RUNNER_DIR = dir;
  let program: Command | null = null;
  const parse = Command.prototype.parse;
  Command.prototype.parse = function (this: Command) {
    program = this;
    return this;
  };
  try {
    await import('./cli');
  } finally {
    Command.prototype.parse = parse;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const root = program as Command | null;
  assert.ok(root, 'cli.ts no longer builds its program with commander');
  // Placeholder names are help text, not surface.
  const flags = (raw: string) =>
    raw.replace(/<[^>]+>/g, '<v>').replace(/\[[^\]]+\]/g, '[v]');
  const out: string[] = root.options.map((o) => `factiii-runner ${flags(o.flags)}`);
  const walk = (cmd: Command, at: string[]) => {
    for (const sub of cmd.commands) {
      const here = [...at, sub.name()];
      const args = sub.registeredArguments.map((a) => {
        const name = a.variadic ? 'arg...' : 'arg';
        return a.required ? `<${name}>` : `[${name}]`;
      });
      out.push(['factiii-runner', ...here, ...args].join(' '));
      for (const alias of sub.aliases()) {
        out.push(['factiii-runner', ...at, alias, ...args].join(' '));
      }
      for (const option of sub.options) {
        out.push(`factiii-runner ${here.join(' ')} ${flags(option.flags)}`);
      }
      walk(sub, here);
    }
  };
  walk(root, []);
  return uniqueSorted(out);
}

async function currentSurface(): Promise<Surface> {
  const sources = runnerSources();
  const daemon = [path.join(RUNNER, 'src', 'daemon.ts')];
  return {
    protocol: [`RUNNER_PROTOCOL ${RUNNER_PROTOCOL}`],
    runnerFeatures: uniqueSorted(RUNNER_FEATURES),
    serverFeatures: uniqueSorted(SERVER_FEATURES),
    clientFeatures: uniqueSorted(CLIENT_FEATURES),
    // What an app may dispatch, and the events it hears back.
    actions: typeKeys(ELECTRON, 'BoardAgentActionMap'),
    appEvents: typeKeys(ELECTRON, 'BoardAgentEventMap'),
    // Runner <-> server, on the runner's socket.io connection.
    socketEvents: uniqueSorted(
      matches(
        sources,
        /\.(?:emit|emitWithAck|on|once)\(\s*'(runner(?::[a-z-]+|[A-Z][A-Za-z]+))'/g
      )
    ),
    // Runner <-> app, on the data channel: what the daemon reads and sends.
    frames: uniqueSorted([
      runnerInfoFrame('0.0.0').type,
      ...matches(daemon, /\.type\s*[!=]==\s*'([a-z-]+)'/g),
      ...matches(daemon, /\btype:\s*'(runner-[a-z-]+|result|event)'/g)
    ]),
    // A session's helpers -> the runner, on <space>/state/secrets.sock.
    secretsSocketOps: uniqueSorted(
      matches([SECRETS_BRIDGE], /request\.op === '([a-z-]+)'/g)
    ),
    cli: await cliSurface()
  };
}

/** What the changelog must say for a change to `name`. */
function noteFor(category: string, name: string): string {
  if (category === 'protocol') return 'RUNNER_PROTOCOL';
  if (category !== 'cli') return name;
  const words = name.split(' ').slice(1);
  const flag = words.find((w) => w.startsWith('-'));
  if (flag) {
    // `-o, --out <v>`: the long name when there is one.
    const long = words.find((w) => w.startsWith('--'));
    return (long ?? flag).replace(/,$/, '');
  }
  return words.filter((w) => !/^[<[]/.test(w)).join(' ');
}

type Change = { category: string; name: string; added: boolean };

function diff(from: Surface, to: Surface): Change[] {
  const changes: Change[] = [];
  for (const category of uniqueSorted([
    ...Object.keys(from),
    ...Object.keys(to)
  ])) {
    const before = new Set(from[category] ?? []);
    const after = new Set(to[category] ?? []);
    for (const name of after) {
      if (!before.has(name)) changes.push({ category, name, added: true });
    }
    for (const name of before) {
      if (!after.has(name)) changes.push({ category, name, added: false });
    }
  }
  return changes;
}

const semver = (v: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  assert.ok(m, `not a version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const newer = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** The changelog above `version`'s heading: [Unreleased] and any release
 *  after it. */
function notesSince(version: string): string {
  const text = read(CHANGELOG);
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm');
  const at = text.search(heading);
  assert.ok(
    at >= 0,
    `apps/runner/CHANGELOG.md has no "## [${version}]" heading, the release protocol-surface.json was taken at`
  );
  return text.slice(0, at);
}

const describeChange = (c: Change) =>
  `  ${c.added ? '+' : '-'} ${c.category} ${c.name} (${c.added ? 'minor' : 'major'}: the notes must name ${noteFor(c.category, c.name)})`;

const runnerVersion = () =>
  (JSON.parse(read(path.join(RUNNER, 'package.json'))) as { version: string })
    .version;

let computed: Promise<Surface> | null = null;
const surface = () => (computed ??= currentSurface());

const readSnapshot = (): Snapshot | null =>
  fs.existsSync(SNAPSHOT) ? (JSON.parse(read(SNAPSHOT)) as Snapshot) : null;

describe('the frozen runner surface', () => {
  it('is read off the code', async () => {
    const now = await surface();
    // Each source is still where this test looks: a list that comes back
    // empty or short means a reader broke, not that the surface shrank.
    assert.equal(typeof startSecretsBridge, 'function');
    for (const action of [
      ...Object.keys(ACTION_FEATURE),
      ...OWNER_ONLY_ACTIONS
    ]) {
      assert.ok(now.actions.includes(action), `action ${action} not read`);
    }
    for (const event of ['runner:hello', 'runner:heartbeat', 'runnerOffer']) {
      assert.ok(now.socketEvents.includes(event), `socket event ${event} not read`);
    }
    for (const frame of ['dispatch', 'client-hello', 'runner-info', 'result']) {
      assert.ok(now.frames.includes(frame), `frame ${frame} not read`);
    }
    for (const op of ['tunnel-token', 'git-credential', 'job-call']) {
      assert.ok(now.secretsSocketOps.includes(op), `secrets op ${op} not read`);
    }
    for (const line of [
      'factiii-runner job [arg]',
      'factiii-runner job --param <v>',
      'factiii-runner doctor --json'
    ]) {
      assert.ok(now.cli.includes(line), `CLI ${line} not read`);
    }
    assert.ok(now.appEvents.includes('session-update'));
  });

  it('names every change since the snapshot in the changelog', async () => {
    const now = await surface();
    const version = runnerVersion();
    const snapshot = readSnapshot();
    if (UPDATE && !snapshot) {
      fs.writeFileSync(
        SNAPSHOT,
        `${JSON.stringify({ version, surface: now }, null, 2)}\n`
      );
      return;
    }
    assert.ok(snapshot, `apps/runner/protocol-surface.json is missing: ${RETAKE}`);
    const notes = notesSince(snapshot.version);
    const unnoted = diff(snapshot.surface, now).filter(
      (c) => !notes.includes(noteFor(c.category, c.name))
    );
    assert.deepEqual(
      unnoted,
      [],
      [
        `The runner's frozen surface changed since ${snapshot.version} (apps/runner/protocol-surface.json), and apps/runner/CHANGELOG.md does not say so above "## [${snapshot.version}]":`,
        ...unnoted.map(describeChange),
        'Name each one in the [Unreleased] notes. An addition is a minor (announce it in the handshake: .specs/versioning.md "Protocol"); a removal or a rename is a major (.specs/versioning.md "Frozen surface").'
      ].join('\n')
    );
    if (
      UPDATE &&
      (version !== snapshot.version || diff(snapshot.surface, now).length > 0)
    ) {
      assert.ok(
        newer(version, snapshot.version),
        `The snapshot is retaken at a release only: apps/runner/package.json (${version}) is not newer than it (${snapshot.version}).`
      );
      fs.writeFileSync(
        SNAPSHOT,
        `${JSON.stringify({ version, surface: now }, null, 2)}\n`
      );
    }
  });

  it('takes a removal only in a new major version, from 1.0', async () => {
    const snapshot = readSnapshot();
    if (!snapshot) return;
    const [major] = semver(snapshot.version);
    // Before 1.0 nothing was promised.
    if (major < 1) return;
    const removed = diff(snapshot.surface, await surface()).filter(
      (c) => !c.added
    );
    const version = runnerVersion();
    assert.ok(
      removed.length === 0 || semver(version)[0] > major,
      [
        `Removed or renamed since ${snapshot.version}, which only a new major version may do (apps/runner/package.json is ${version}):`,
        ...removed.map(describeChange),
        'Keep the old name working beside the new one, or ship it as the next major (.specs/versioning.md "What counts as what").'
      ].join('\n')
    );
  });
});
