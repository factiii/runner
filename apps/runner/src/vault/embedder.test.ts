import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EmbedderError, type EmbedderState, LocalEmbedder } from './embedder';

// The embedder process's life: started by the first call, kept while in use,
// stopped when quiet, started again after. A small Node server stands in for
// serve.py, with its routes and its key.

const FAKE = `
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const key = process.env.VAULT_EMBEDDER_KEY;
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
http.createServer((req, res) => {
  if (req.url === '/health') return res.end(JSON.stringify({ loaded: true, pid: process.pid }));
  if (req.headers.authorization !== 'Bearer ' + key) { res.statusCode = 401; return res.end('{}'); }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body);
    if (req.url === '/embed' && json.text === 'bad') { res.statusCode = 422; return res.end(JSON.stringify({ detail: 'could not embed: bad' })); }
    if (req.url === '/embed') return res.end(JSON.stringify({ vector: [process.pid] }));
    if (req.url === '/read') return res.end(JSON.stringify({ pages: [{ text: json.ext, source: 'TEXT_LAYER' }] }));
    res.statusCode = 404; res.end('{}');
  });
}).listen(port, '127.0.0.1');
`;

const make = (state: () => EmbedderState = () => 'ready', idleMs = 60_000) =>
  new LocalEmbedder({
    state,
    idleMs,
    command: () => ({ bin: process.execPath, args: ['-e', FAKE, '--'], cwd: process.cwd() })
  });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('local embedder', () => {
  it('starts on the first call and reuses the process', async () => {
    const embedder = make();
    assert.equal(embedder.isRunning(), false);
    const [first] = await embedder.embed({ text: 'a' });
    const [second] = await embedder.embed({ text: 'b' });
    assert.equal(first, second, 'one process for both calls');
    assert.deepEqual(await embedder.read(Buffer.from('x'), 'docx'), [{ text: 'docx', source: 'TEXT_LAYER' }]);
    embedder.stop();
  });

  it('stops after a quiet spell and starts again on the next call', async () => {
    const embedder = make(() => 'ready', 150);
    const [first] = await embedder.embed({ text: 'a' });
    await wait(400);
    assert.equal(embedder.isRunning(), false);
    const [second] = await embedder.embed({ text: 'b' });
    assert.notEqual(first, second, 'a new process');
    embedder.stop();
  });

  it('says a bad file is the file, and a missing embedder is not', async () => {
    const embedder = make();
    await assert.rejects(
      embedder.embed({ text: 'bad' }),
      (err: unknown) => err instanceof EmbedderError && !err.transient && err.message === 'could not embed: bad'
    );
    embedder.stop();
    const missing = make(() => 'missing');
    await assert.rejects(
      missing.embed({ text: 'a' }),
      (err: unknown) => err instanceof EmbedderError && err.transient
    );
    assert.equal(missing.isRunning(), false, 'nothing is started');
  });
});
