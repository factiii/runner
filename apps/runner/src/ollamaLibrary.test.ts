import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  decodeEntities,
  isCloudTag,
  parseOllamaSearch,
  parseOllamaTags,
  searchUrl,
  sizeToGb,
  tagsUrl
} from './ollamaLibrary';
import { createOllamaLibrary, UNREACHABLE } from './ollamaLibraryFetch';

// ollama.com's pages as saved in October 2026 (test-fixtures/ollama-*.html).
// Nothing here reaches the network: the fetch is a fake that serves them.

const page = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'test-fixtures', `ollama-${name}.html`), 'utf-8');

describe('the search page', () => {
  it('reads each model: name, description, chips and downloads', () => {
    const models = parseOllamaSearch(page('search-qwen'));
    assert.equal(models.length, 20);
    const qwen3 = models.find((m) => m.name === 'qwen3');
    assert.deepEqual(qwen3, {
      name: 'qwen3',
      description:
        'Qwen3 is the latest generation of large language models in Qwen series, offering a comprehensive suite of dense and mixture-of-experts (MoE) models.',
      capabilities: ['tools', 'thinking'],
      sizes: ['0.6b', '1.7b', '4b', '8b', '14b', '30b', '32b', '235b'],
      cloud: false,
      downloads: 40929208
    });
    // Entities in a description are decoded.
    assert.match(models.find((m) => m.name === 'qwen2.5')!.description, /^Qwen2\.5 models are pretrained on Alibaba's/);
  });

  it('reads someone’s own models and embedding chips', () => {
    const models = parseOllamaSearch(page('search-embed'));
    assert.equal(models.length, 20);
    const own = models.filter((m) => m.name.includes('/'));
    assert.ok(own.some((m) => m.name === 'RizwanMalik/qwen3-vl-embedding-2b'));
    assert.ok(models.filter((m) => m.capabilities.includes('embedding')).length >= 10);
    for (const m of models) assert.ok(m.downloads === null || m.downloads >= 0);
  });

  it('finds nothing in a page that is not a search page', () => {
    assert.deepEqual(parseOllamaSearch('<html><body>Maintenance</body></html>'), []);
    // A link whose name is not an Ollama name is skipped.
    assert.deepEqual(
      parseOllamaSearch('<a href="/a/b/c" class="group flex items-start"><p title="x"></p></a>'),
      []
    );
  });
});

describe('the tags page', () => {
  it('reads each tag with its size, and folds tags of the same file', () => {
    const tags = parseOllamaTags(page('tags-qwen3'));
    const by = (tag: string) => tags.find((t) => t.tag === tag);
    // latest, 8b and 8b-q4_K_M are one file, shown as 8b.
    assert.deepEqual(by('qwen3:8b'), {
      tag: 'qwen3:8b',
      aliases: ['qwen3:latest', 'qwen3:8b-q4_K_M'],
      sizeGb: 5.2,
      context: '40K',
      input: 'Text',
      cloud: false
    });
    assert.equal(by('qwen3:0.6b')?.sizeGb, 0.523);
    assert.equal(by('qwen3:235b')?.sizeGb, 142);
    // Quantizations are other files: each keeps its row.
    assert.equal(by('qwen3:8b-q8_0')?.sizeGb, 8.9);
    assert.equal(by('qwen3:8b-fp16')?.sizeGb, 16);
    assert.equal(tags.some((t) => t.tag === 'qwen3:latest'), false);
    assert.equal(tags.some((t) => t.tag === 'qwen3:8b-q4_K_M'), false);
    const all = tags.flatMap((t) => [t.tag, ...t.aliases]);
    assert.equal(all.length, 58);
    assert.equal(new Set(all).size, 58);
  });

  it('marks a cloud tag, which has no size', () => {
    const tags = parseOllamaTags(page('tags-cloud'));
    assert.ok(tags.length >= 1);
    for (const t of tags) {
      assert.equal(t.cloud, true);
      assert.equal(t.sizeGb, null);
    }
  });

  it('keeps someone’s namespace on their tags', () => {
    const tags = parseOllamaTags(page('tags-community'));
    assert.deepEqual(
      tags.map((t) => [t.tag, t.sizeGb, t.input]),
      [
        ['RizwanMalik/qwen3-vl-embedding-2b:q4_0-q8_0', 1.5, 'Text, Image'],
        ['RizwanMalik/qwen3-vl-embedding-2b:q4_k_m-q8_0', 1.5, 'Text, Image'],
        ['RizwanMalik/qwen3-vl-embedding-2b:q5_k_m-q8_0', 1.7, 'Text, Image'],
        ['RizwanMalik/qwen3-vl-embedding-2b:q8_0-q8_0', 2.3, 'Text, Image']
      ]
    );
  });
});

describe('the small parts', () => {
  it('reads sizes, cloud tags and entities', () => {
    assert.equal(sizeToGb('5.2GB'), 5.2);
    assert.equal(sizeToGb('274MB'), 0.274);
    assert.equal(sizeToGb('1.1TB'), 1100);
    assert.equal(sizeToGb('High Usage'), null);
    assert.equal(isCloudTag('glm-5.3:cloud'), true);
    assert.equal(isCloudTag('qwen3-coder:480b-cloud'), true);
    assert.equal(isCloudTag('cloudy:7b'), false);
    assert.equal(decodeEntities('Alibaba&#39;s &amp; &quot;x&quot; &#x27;y&#x27; &bogus;'), 'Alibaba\'s & "x" \'y\' &bogus;');
  });

  it('builds ollama.com URLs only', () => {
    assert.equal(searchUrl(''), 'https://ollama.com/search');
    assert.equal(searchUrl('qwen & co'), 'https://ollama.com/search?q=qwen+%26+co');
    assert.equal(tagsUrl('qwen3'), 'https://ollama.com/library/qwen3/tags');
    assert.equal(tagsUrl('someone/model'), 'https://ollama.com/someone/model/tags');
  });
});

/** A fetch that serves the saved pages and counts what it was asked. */
function fakeFetch(pages: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetchImpl = async (url: string) => {
    asked.push(url);
    const make = pages[url];
    if (!make) return new Response('not found', { status: 404 });
    return make();
  };
  return { fetchImpl, asked };
}

const html = (body: string) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

describe('reading ollama.com', () => {
  it('searches and reads tags, and keeps them a few minutes', async () => {
    let clock = 0;
    const { fetchImpl, asked } = fakeFetch({
      'https://ollama.com/search?q=qwen': html(page('search-qwen')),
      'https://ollama.com/library/qwen3/tags': html(page('tags-qwen3'))
    });
    const library = createOllamaLibrary(fetchImpl, () => clock);
    assert.equal((await library.search('qwen')).length, 20);
    assert.equal((await library.search('QWEN')).length, 20);
    assert.equal((await library.lookup('qwen3:latest'))?.sizeGb, 5.2);
    assert.equal((await library.lookup('qwen3:8b-q8_0'))?.sizeGb, 8.9);
    assert.equal(await library.lookup('qwen3:nope'), null);
    assert.equal((await library.tags('qwen3')).length, tagsCount());
    assert.equal(asked.length, 2);
    clock += 6 * 60_000;
    await library.search('qwen');
    assert.equal(asked.length, 3);
  });

  it('says a model is not on ollama.com, and reads no size for it', async () => {
    const library = createOllamaLibrary(fakeFetch({}).fetchImpl);
    await assert.rejects(library.tags('nothing-here'), /ollama.com has no model named nothing-here/);
    assert.equal(await library.lookup('nothing-here:7b'), null);
  });

  it('answers a plain message when ollama.com cannot be read', async () => {
    const down = createOllamaLibrary(async () => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(down.search('qwen'), { message: UNREACHABLE });
    const broken = createOllamaLibrary(async () => new Response('oops', { status: 502 }));
    await assert.rejects(broken.search(''), { message: UNREACHABLE });
    // A page far past any real one is cut off.
    const huge = createOllamaLibrary(async () => new Response('x'.repeat(3_500_000), { status: 200 }));
    await assert.rejects(huge.search('x'), { message: UNREACHABLE });
    // A failure is not kept: the next ask tries again.
    let up = false;
    const flaky = createOllamaLibrary(async () => {
      if (!up) throw new Error('down');
      return new Response(page('search-qwen'), { status: 200 });
    });
    await assert.rejects(flaky.search('qwen'));
    up = true;
    assert.equal((await flaky.search('qwen')).length, 20);
  });
});

const tagsCount = () => parseOllamaTags(page('tags-qwen3')).length;
