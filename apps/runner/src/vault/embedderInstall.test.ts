import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildPlan,
  conversionDone,
  EMBEDDER_ARTIFACTS,
  EMBEDDER_VERSION,
  embedderInstalled,
  embedderPaths,
  embedderRuntime,
  embedderSupported,
  findSource,
  findUv,
  installEmbedder,
  onPath,
  type RunStep
} from './embedderInstall';

// The embedder's build, with the commands faked: what runs, in what order,
// that the cloud's sources are used as they are, and that only what serves
// is kept. Each runtime's build is played on any machine.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-embedder-'));

/** Plays uv and the conversions: makes the folders and files each
 *  would, and segfaults after convert_text.py as the real one does. */
function fakeRun(log: string[]): RunStep {
  return async (bin, args, { cwd }) => {
    const shown = args.map((a) => {
      if (a.includes('\n')) return 'LOAD_CHECK';
      return a.includes('/') ? path.basename(a) : a;
    });
    log.push([path.basename(bin), ...shown].join(' '));
    if (args[0] === 'venv') {
      const venv = args.at(-1) ?? '';
      fs.mkdirSync(path.join(venv, 'bin'), { recursive: true });
      for (const exe of ['python', 'pip', 'uv']) fs.writeFileSync(path.join(venv, 'bin', exe), '');
    }
    const script = args[0];
    if (cwd && script === 'convert_text.py') {
      fs.mkdirSync(path.join(cwd, 'text.mlmodelc'));
      fs.mkdirSync(path.join(cwd, 'text.mlpackage'));
      fs.writeFileSync(path.join(cwd, 'text_tokenizer.json'), '{}');
      return { code: null, signal: 'SIGSEGV', output: 'text: cosine(coreml, torch) = 1.00000  (dim=768)\nwarming ANE caches...\n' };
    }
    if (cwd && script === 'convert_clip.py') {
      for (const dir of ['clip_image.mlmodelc', 'clip_text.mlmodelc']) fs.mkdirSync(path.join(cwd, dir));
      fs.writeFileSync(path.join(cwd, 'clip_vocab.txt.gz'), '');
      return { code: 0, signal: null, output: 'image: cosine(coreml, torch) = 0.99950\ntext: cosine(coreml, torch) = 0.99990\ndone\n' };
    }
    if (cwd && script === 'convert_onnx.py') {
      const files =
        args[1] === 'text' ? ['text.onnx', 'text_tokenizer.json'] : ['clip_image.onnx', 'clip_text.onnx', 'clip_vocab.txt.gz'];
      for (const file of files) fs.writeFileSync(path.join(cwd, file), '');
      const output =
        args[1] === 'text'
          ? 'text: cosine(onnx, torch) = 1.00000  (dim=768)\ntext: cosine(onnx, torch) = 1.00000  (dim=768)\ndone\n'
          : 'image: cosine(onnx, torch) = 1.00000  (dim=512)\ntext: cosine(onnx, torch) = 1.00000  (dim=512)\ndone\n';
      return { code: 0, signal: null, output };
    }
    if (args[0] === '-c') return { code: null, signal: 'SIGSEGV', output: 'loaded\n' };
    return { code: 0, signal: null, output: '' };
  };
}

describe('embedder install', () => {
  it('runs on Core ML on Apple silicon Macs and on ONNX on Linux', () => {
    assert.equal(embedderRuntime('darwin', 'arm64'), 'coreml');
    assert.equal(embedderRuntime('linux', 'arm64'), 'onnx');
    assert.equal(embedderRuntime('linux', 'x64'), 'onnx');
    assert.equal(embedderRuntime('darwin', 'x64'), null);
    assert.equal(embedderRuntime('linux', 'arm'), null);
    assert.equal(embedderRuntime('win32', 'x64'), null);
    assert.equal(embedderSupported('linux', 'x64'), true);
    assert.equal(embedderSupported('darwin', 'x64'), false);
  });

  it('counts as installed only with its own runtime’s models', () => {
    const paths = embedderPaths(tmp());
    fs.mkdirSync(path.dirname(paths.python), { recursive: true });
    fs.writeFileSync(paths.python, '');
    fs.writeFileSync(paths.stamp, JSON.stringify({ version: EMBEDDER_VERSION }));
    for (const name of EMBEDDER_ARTIFACTS.onnx) fs.writeFileSync(path.join(paths.root, name), '');
    assert.equal(embedderInstalled(paths, 'onnx'), true);
    assert.equal(embedderInstalled(paths, 'coreml'), false, 'a Mac needs the .mlmodelc');
    assert.equal(embedderInstalled(paths, null), false);
    // An install from before the last EMBEDDER_VERSION raise builds again.
    fs.writeFileSync(paths.stamp, JSON.stringify({ version: EMBEDDER_VERSION - 1 }));
    assert.equal(embedderInstalled(paths, 'onnx'), false);
  });

  it('serves Linux without Core ML or pyobjc, and keeps torch off PyPI there', () => {
    const plan = buildPlan('onnx', '/p');
    assert.deepEqual(plan.serve, ['-r', '/p/requirements-onnx.txt', '--override', '/p/overrides-onnx.txt']);
    assert.ok(plan.tools[0].args.includes('https://download.pytorch.org/whl/cpu'));
    assert.ok(!plan.tools[1].args.some((a) => a.startsWith('torch')), 'the CPU torch is kept');
    const reqs = fs.readFileSync(findSource('requirements-onnx.txt') ?? '', 'utf-8');
    assert.doesNotMatch(reqs, /^(coremltools|pyobjc)/m);
    assert.match(reqs, /^onnxruntime/m);
    // The pins that change a vector match the cloud's.
    const cloud = fs.readFileSync(findSource('requirements.txt') ?? '', 'utf-8');
    for (const pin of ['pillow==', 'numpy>=', 'tokenizers>=', 'ftfy>=', 'regex>=']) {
      const line = (text: string) => text.split('\n').find((l) => l.startsWith(pin));
      assert.equal(line(reqs), line(cloud), pin);
    }
  });

  it('finds the cloud’s sources and the runner’s server in a checkout', () => {
    assert.match(findSource('app.py') ?? '', /services\/embedder\/app\.py$/);
    assert.match(findSource('serve.py') ?? '', /apps\/runner\/embedder\/serve\.py$/);
    assert.equal(findSource('nope.py'), null);
  });

  it('finds an executable on PATH', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'uv'), '', { mode: 0o755 });
    assert.equal(onPath('uv', `/nowhere${path.delimiter}${dir}`), path.join(dir, 'uv'));
    assert.equal(onPath('uv', '/nowhere'), null);
  });

  it('finds uv on PATH, never fetches one, and says how to install it', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'uv'), '', { mode: 0o755 });
    assert.equal(findUv(`/nowhere${path.delimiter}${dir}`, []), path.join(dir, 'uv'));
    assert.equal(findUv('/nowhere', [dir]), path.join(dir, 'uv'), 'the tool dirs are searched too');
    for (const platform of ['darwin', 'linux'] as const) {
      const log: string[] = [];
      await assert.rejects(
        installEmbedder({ run: fakeRun(log), runnerDir: tmp(), uv: null, platform, arch: 'arm64' }, () => {}),
        platform === 'darwin' ? /needs uv.*`brew install uv`/ : /needs uv.*`pipx install uv`/
      );
      assert.deepEqual(log, [], 'nothing runs without uv');
    }
  });

  it('takes a conversion that passed parity and died warming the Neural Engine', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'text.mlmodelc'));
    const crashed = {
      code: null,
      signal: 'SIGSEGV',
      output: 'text: cosine(coreml, torch) = 1.00000  (dim=768)\nwarming ANE caches...\n'
    };
    assert.equal(conversionDone(crashed, dir, ['text.mlmodelc'], 1), true);
    assert.equal(conversionDone(crashed, dir, ['text.mlmodelc'], 2), false, 'a model never checked');
    const low = { ...crashed, output: 'text: cosine(coreml, torch) = 0.91000\nPARITY FAILED\n' };
    assert.equal(conversionDone(low, dir, ['text.mlmodelc'], 1), false);
    assert.equal(conversionDone(crashed, dir, ['text.mlmodelc', 'text_tokenizer.json'], 1), false);
  });

  it('reads the ONNX export’s parity lines the same way', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'text.onnx'), '');
    const ok = { code: 1, signal: null, output: 'text: cosine(onnx, torch) = 0.99998  (dim=768)\n' };
    assert.equal(conversionDone(ok, dir, ['text.onnx'], 1), true);
    const low = { ...ok, output: 'text: cosine(onnx, torch) = 0.98000  (dim=768)\nPARITY FAILED\n' };
    assert.equal(conversionDone(low, dir, ['text.onnx'], 1), false);
  });

  it('builds with uv on Python 3.12, keeps only what serves', async () => {
    const runnerDir = tmp();
    const log: string[] = [];
    const lines: string[] = [];
    await installEmbedder(
      { run: fakeRun(log), runnerDir, uv: '/opt/homebrew/bin/uv', platform: 'darwin', arch: 'arm64' },
      (l) => lines.push(l)
    );
    assert.deepEqual(log, [
      'uv venv --python 3.12 --managed-python --clear venv',
      'uv pip install --python python torch torchvision open_clip_torch transformers==4.46.3 -r requirements.txt',
      'python convert_text.py',
      'python convert_clip.py',
      'uv venv --python 3.12 --managed-python --clear venv',
      'uv pip install --python python -r requirements.txt',
      'python -c LOAD_CHECK'
    ]);
    const paths = embedderPaths(runnerDir);
    assert.equal(embedderInstalled(paths, 'coreml'), true);
    assert.equal(fs.existsSync(paths.build), false, 'the build tools and downloads are gone');
    assert.equal(fs.existsSync(path.join(paths.root, 'text.mlpackage')), false);
    for (const name of EMBEDDER_ARTIFACTS.coreml) assert.ok(fs.existsSync(path.join(paths.root, name)), name);
    // The cloud's app.py, byte for byte.
    assert.equal(
      fs.readFileSync(path.join(paths.root, 'app.py'), 'utf-8'),
      fs.readFileSync(findSource('app.py') ?? '', 'utf-8')
    );
    assert.equal(lines.at(-1), 'The vault’s search is installed.');
  });

  it('builds on Linux with the machine’s uv, CPU torch and ONNX', async () => {
    const runnerDir = tmp();
    const log: string[] = [];
    await installEmbedder(
      { run: fakeRun(log), runnerDir, uv: '/usr/local/bin/uv', platform: 'linux', arch: 'arm64' },
      () => {}
    );
    assert.deepEqual(log, [
      'uv venv --python 3.12 --managed-python --clear venv',
      'uv pip install --python python --index-url cpu torch==2.14.1 torchvision==0.29.1',
      'uv pip install --python python open_clip_torch transformers==4.46.3 onnx onnxscript onnxruntime',
      'python convert_onnx.py text',
      'python convert_onnx.py clip',
      'uv venv --python 3.12 --managed-python --clear venv',
      'uv pip install --python python -r requirements-onnx.txt --override overrides-onnx.txt',
      'python -c LOAD_CHECK'
    ]);
    const paths = embedderPaths(runnerDir);
    assert.equal(embedderInstalled(paths, 'onnx'), true);
    assert.equal(fs.existsSync(paths.build), false);
  });

  it('stops at a failed step and installs nothing', async () => {
    const runnerDir = tmp();
    const run: RunStep = async (bin, args, options) =>
      args[0] === 'pip' && args[1] === 'install' && args.includes('torch')
        ? { code: 1, signal: null, output: 'error: no matching distribution' }
        : fakeRun([])(bin, args, options);
    await assert.rejects(
      installEmbedder({ run, runnerDir, uv: '/usr/local/bin/uv', platform: 'darwin', arch: 'arm64' }, () => {}),
      /conversion tools.*no matching distribution/
    );
    assert.equal(embedderInstalled(embedderPaths(runnerDir), 'coreml'), false);
  });
});
