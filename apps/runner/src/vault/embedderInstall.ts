import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { toolDirs } from '@shared/all/helpers/board-agent-core/host-env';

// The Vault's embedder (.specs/runner-vault.md "Embedder"): the cloud's
// services/embedder, built on this machine when the Vault part is added.
// bge-base-en-v1.5 (768-d text) and MobileCLIP2-B (512-d CLIP) are converted
// to Core ML by the cloud's own scripts on a Mac with Apple silicon, and to
// ONNX (convert_onnx.py, the same torch wrappers) on Linux, where ONNX
// Runtime serves them on the CPU. Both pass the same parity check against
// torch, so a vector made here is in the same space as the cloud's.
//
// Python 3.12 comes from uv, inside the part's folder: Homebrew's 3.14 cannot
// build the pins, and the runner never installs through Homebrew. uv itself
// must already be on the machine: the runner never downloads a program to
// run (no uv release from GitHub, no uv wheel from PyPI). Without it the
// install stops and says the command that adds it. torch and the downloads
// are only for the conversion and are deleted after it.

/** Raise to make every runner build the embedder again. 2 (2026-11-07):
 *  Pillow 11.1.0 -> 13.0.0, so installs from before it get the patched one. */
export const EMBEDDER_VERSION = 2;
/** The Linux machines the ONNX build was proven on. */
const LINUX_ARCHES = new Set(['arm64', 'x64']);
const PYTHON = '3.12';
/** What setup.sh adds for the conversion only (never imported to serve). */
const BUILD_PACKAGES = ['torch', 'torchvision', 'open_clip_torch', 'transformers==4.46.3'];
/** Linux: torch from its CPU index (PyPI's x64 wheel pulls in CUDA, about
 *  3 GB), then the rest from PyPI with that torch kept. The pins are the
 *  ones the parity was proven on. */
const TORCH_CPU = [
  '--index-url',
  'https://download.pytorch.org/whl/cpu',
  'torch==2.14.1',
  'torchvision==0.29.1'
];
const ONNX_BUILD_PACKAGES = [
  'open_clip_torch',
  'transformers==4.46.3',
  'onnx',
  'onnxscript',
  'onnxruntime'
];
const STEP_TIMEOUT_MS = 45 * 60_000;

/** The files the cloud's service ships, plus the runner's own: the server
 *  and, for Linux, the ONNX export and backend and their packages. */
const EMBEDDER_SOURCES = [
  'app.py',
  'clip_tokenizer.py',
  'text_tokenizer.py',
  'convert_text.py',
  'convert_clip.py',
  'requirements.txt',
  'serve.py',
  'onnx_backend.py',
  'convert_onnx.py',
  'requirements-onnx.txt',
  'overrides-onnx.txt'
] as const;

/** What the models run on: Core ML on a Mac with Apple silicon, ONNX
 *  Runtime on the CPU on Linux. */
export type EmbedderRuntime = 'coreml' | 'onnx';

export function embedderRuntime(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): EmbedderRuntime | null {
  if (platform === 'darwin' && arch === 'arm64') return 'coreml';
  if (platform === 'linux' && LINUX_ARCHES.has(arch)) return 'onnx';
  return null;
}

/** What the two conversions leave, which serving needs. */
export const EMBEDDER_ARTIFACTS: Record<EmbedderRuntime, readonly string[]> = {
  coreml: ['text.mlmodelc', 'text_tokenizer.json', 'clip_image.mlmodelc', 'clip_text.mlmodelc', 'clip_vocab.txt.gz'],
  onnx: ['text.onnx', 'text_tokenizer.json', 'clip_image.onnx', 'clip_text.onnx', 'clip_vocab.txt.gz']
};

export type EmbedderPaths = {
  root: string;
  /** The serving venv: requirements.txt only. */
  python: string;
  /** Deleted once the build is done. */
  build: string;
  stamp: string;
};

export function embedderPaths(runnerDir: string): EmbedderPaths {
  const root = path.join(runnerDir, 'parts', 'vault', 'embedder');
  return {
    root,
    python: path.join(root, 'venv', 'bin', 'python'),
    build: path.join(root, '.build'),
    stamp: path.join(root, 'installed.json')
  };
}

export const embedderSupported = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
) => embedderRuntime(platform, arch) !== null;

export function embedderInstalled(
  paths: EmbedderPaths,
  runtime: EmbedderRuntime | null = embedderRuntime()
): boolean {
  if (!runtime) return false;
  try {
    const stamp = JSON.parse(fs.readFileSync(paths.stamp, 'utf-8')) as { version?: unknown };
    return (
      stamp.version === EMBEDDER_VERSION &&
      fs.existsSync(paths.python) &&
      EMBEDDER_ARTIFACTS[runtime].every((name) => fs.existsSync(path.join(paths.root, name)))
    );
  } catch {
    return false;
  }
}

/** Where each source file is: beside the built cli.js once packed
 *  (`pnpm bundle:embedder`), else in the checkout. Exported for the tests,
 *  as are onPath and conversionDone. */
export function findSource(name: string, from: string = __dirname): string | null {
  const dirs = [
    path.join(from, '..', 'embedder'),
    path.join(from, '..', '..', 'embedder'),
    path.join(from, '..', '..', '..', 'services', 'embedder'),
    path.join(from, '..', '..', '..', '..', 'services', 'embedder')
  ];
  return dirs.map((dir) => path.join(dir, name)).find((file) => fs.existsSync(file)) ?? null;
}

export type StepResult = { code: number | null; signal: string | null; output: string };

export type RunStep = (
  bin: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; onLine: (line: string) => void }
) => Promise<StepResult>;

/** One command, its lines passed on as they come, the last of them kept. */
export const runStep: RunStep = (bin, args, { cwd, env, onLine }) =>
  new Promise((resolve) => {
    let tail = '';
    let pending = '';
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (chunk: Buffer) => {
      const text = pending + chunk.toString();
      const lines = text.split(/\r?\n|\r/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line.trim());
      tail = (tail + chunk.toString()).slice(-4000);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGKILL'), STEP_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, output: err.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (pending.trim()) onLine(pending.trim());
      resolve({ code, signal, output: tail });
    });
  });

/** An executable named `name` on PATH, or null. */
export function onPath(name: string, envPath = process.env.PATH ?? ''): string | null {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return null;
}

const failed = (what: string, result: StepResult) =>
  new Error(
    `${what} failed (${result.signal ?? `exit ${result.code}`}): ${
      result.output.trim().split('\n').pop() ?? ''
    }`
  );

const MIN_PARITY = 0.99;

/** A conversion counts when each model passed its parity check (cosine with
 *  torch above 0.99, as the script's own bar; Core ML's or ONNX's) and its
 *  files are there, even if the process then died: convert_text.py segfaults
 *  while warming the Neural Engine, after the compiled model is written. The
 *  models are loaded in a fresh process afterwards (the last step) to prove
 *  them. */
export function conversionDone(
  result: StepResult,
  root: string,
  files: readonly string[],
  models: number
): boolean {
  const parity = [...result.output.matchAll(/cosine\((?:coreml|onnx), torch\) = ([\d.]+)/g)].map((m) =>
    Number(m[1])
  );
  return (
    !result.output.includes('PARITY FAILED') &&
    parity.length >= models &&
    parity.every((cos) => cos > MIN_PARITY) &&
    files.every((name) => fs.existsSync(path.join(root, name)))
  );
}

/** Loads every model and tokenizer the way serve.py does, in the serving
 *  venv. Prints `loaded`; the exit after it may segfault the same way. */
const LOAD_CHECK = [
  'import coremltools as ct',
  'from coremltools.models import CompiledMLModel',
  'from clip_tokenizer import ClipTokenizer',
  'from text_tokenizer import TextTokenizer',
  "[CompiledMLModel(f'{n}.mlmodelc', compute_units=ct.ComputeUnit.CPU_AND_NE) for n in ('text', 'clip_image', 'clip_text')]",
  'ClipTokenizer(); TextTokenizer()',
  "print('loaded', flush=True)"
].join('\n');

/** The same on Linux: serve.py itself (app.py behind its Core ML stand-in),
 *  the ONNX models, and what /read needs. */
const ONNX_LOAD_CHECK = [
  'import serve',
  'import pypdfium2, rapidocr_onnxruntime',
  'from clip_tokenizer import ClipTokenizer',
  'from text_tokenizer import TextTokenizer',
  "[serve.OnnxModel(f'{n}.onnx') for n in ('text', 'clip_image', 'clip_text')]",
  'ClipTokenizer(); TextTokenizer()',
  "print('loaded', flush=True)"
].join('\n');

type Conversion = { args: string[]; files: readonly string[]; models: number };

/** How each runtime builds: the build venv's installs, the conversions, the
 *  serving venv's install, and the load check, from the part's folder
 *  `root`. Exported for the tests. */
export function buildPlan(runtime: EmbedderRuntime, root: string) {
  const requirements = path.join(root, 'requirements.txt');
  if (runtime === 'coreml') {
    return {
      tools: [{ what: 'Installing the conversion tools (about 1 GB, deleted after)', args: [...BUILD_PACKAGES, '-r', requirements] }],
      conversions: [
        { args: ['convert_text.py'], files: ['text.mlmodelc', 'text_tokenizer.json'], models: 1 },
        { args: ['convert_clip.py'], files: ['clip_image.mlmodelc', 'clip_text.mlmodelc', 'clip_vocab.txt.gz'], models: 2 }
      ] satisfies Conversion[],
      serve: ['-r', requirements],
      loadCheck: LOAD_CHECK
    };
  }
  return {
    tools: [
      { what: 'Installing torch for the CPU (about 900 MB, deleted after)', args: TORCH_CPU },
      { what: 'Installing the conversion tools (deleted after)', args: ONNX_BUILD_PACKAGES }
    ],
    conversions: [
      { args: ['convert_onnx.py', 'text'], files: ['text.onnx', 'text_tokenizer.json'], models: 1 },
      { args: ['convert_onnx.py', 'clip'], files: ['clip_image.onnx', 'clip_text.onnx', 'clip_vocab.txt.gz'], models: 2 }
    ] satisfies Conversion[],
    serve: [
      '-r',
      path.join(root, 'requirements-onnx.txt'),
      '--override',
      path.join(root, 'overrides-onnx.txt')
    ],
    loadCheck: ONNX_LOAD_CHECK
  };
}

/** uv on this machine, found the way every other tool is (host-env.ts
 *  toolDirs): Factiii Desktop's tools folder and Homebrew's dirs first, then
 *  PATH, since a runner started as a login service often has a PATH without
 *  Homebrew's. Null when it is not installed. */
export function findUv(
  envPath = process.env.PATH ?? '',
  dirs: string[] = toolDirs()
): string | null {
  return onPath('uv', [...dirs, envPath].join(path.delimiter));
}

/** The command that installs uv, for the missing-tool message. */
function uvInstallCommand(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'brew install uv' : 'pipx install uv';
}

/** uv is not on this machine: the install stops here and says how to add it. */
function uvMissing(platform: NodeJS.Platform): Error {
  return new Error(
    `The vault’s search needs uv, which is not installed on this machine. Install it with \`${uvInstallCommand(platform)}\`, then add search again.`
  );
}

export type InstallDeps = {
  run: RunStep;
  runnerDir: string;
  /** uv on this machine; looked for (findUv) when left out, null when it
   *  is not installed. */
  uv?: string | null;
  /** This machine's, unless a test plays another. */
  platform?: NodeJS.Platform;
  arch?: string;
};

/** Build the embedder into `<runner dir>/parts/vault/embedder`. */
export async function installEmbedder(
  {
    run,
    runnerDir,
    uv: knownUv,
    platform = process.platform,
    arch = process.arch
  }: InstallDeps,
  onLine: (line: string) => void
): Promise<void> {
  const runtime = embedderRuntime(platform, arch);
  if (!runtime) {
    throw new Error('The vault’s search needs a Mac with Apple silicon, or Linux.');
  }
  const paths = embedderPaths(runnerDir);
  const plan = buildPlan(runtime, paths.root);
  fs.mkdirSync(paths.build, { recursive: true, mode: 0o700 });
  for (const name of EMBEDDER_SOURCES) {
    const source = findSource(name);
    if (!source) throw new Error(`The embedder’s ${name} is missing from this runner.`);
    fs.copyFileSync(source, path.join(paths.root, name));
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UV_PYTHON_INSTALL_DIR: path.join(paths.root, 'python'),
    UV_CACHE_DIR: path.join(paths.build, 'uv-cache'),
    UV_NO_CONFIG: '1',
    HF_HOME: path.join(paths.build, 'hf'),
    PYTHONNOUSERSITE: '1',
    // Piped stdout is block-buffered: without this, the `done` a conversion
    // prints is lost in the buffer when it segfaults at exit.
    PYTHONUNBUFFERED: '1'
  };
  const step = async (what: string, bin: string, args: string[], cwd?: string) => {
    onLine(`${what}…`);
    const result = await run(bin, args, { cwd, env, onLine });
    if (result.code !== 0) throw failed(what, result);
    return result;
  };

  const uv = knownUv === undefined ? findUv() : knownUv;
  if (!uv) throw uvMissing(platform);

  const buildVenv = path.join(paths.build, 'venv');
  const buildPython = path.join(buildVenv, 'bin', 'python');
  await step(`Installing Python ${PYTHON}`, uv, ['venv', '--python', PYTHON, '--managed-python', '--clear', buildVenv]);
  for (const { what, args } of plan.tools) {
    await step(what, uv, ['pip', 'install', '--python', buildPython, ...args]);
  }

  for (const { args, files, models } of plan.conversions) {
    const script = args.join(' ');
    onLine(`Building the search model (${script})…`);
    const result = await run(buildPython, args, { cwd: paths.root, env, onLine });
    if (result.code !== 0 && !conversionDone(result, paths.root, files, models)) {
      throw failed(script, result);
    }
  }

  await step('Installing the embedder', uv, [
    'venv',
    '--python',
    PYTHON,
    '--managed-python',
    '--clear',
    path.join(paths.root, 'venv')
  ]);
  await step('Installing what it serves with', uv, ['pip', 'install', '--python', paths.python, ...plan.serve]);
  onLine('Checking the models load…');
  const check = await run(paths.python, ['-c', plan.loadCheck], { cwd: paths.root, env, onLine });
  if (!/(^|\n)loaded/.test(check.output)) throw failed('Loading the models', check);

  // Only the compiled models serve; the packages and the downloads go. (The
  // ONNX export leaves only what serves.)
  for (const name of fs.readdirSync(paths.root)) {
    if (name.endsWith('.mlpackage')) fs.rmSync(path.join(paths.root, name), { recursive: true, force: true });
  }
  fs.rmSync(paths.build, { recursive: true, force: true });
  fs.writeFileSync(paths.stamp, `${JSON.stringify({ version: EMBEDDER_VERSION })}\n`, { mode: 0o600 });
  if (!embedderInstalled(paths, runtime)) throw new Error('The embedder did not install.');
  onLine('The vault’s search is installed.');
}

/** The whole embedder: Python, its packages and the models. */
export function removeEmbedder(runnerDir: string): void {
  fs.rmSync(embedderPaths(runnerDir).root, { recursive: true, force: true });
}
