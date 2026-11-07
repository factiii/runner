import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractPages, isPhoto, isReadable, UnreadableError } from './extract';

// The cloud's reading rules, on the runner.

const noDocuments = async () => {
  throw new Error('not a document');
};

describe('vault extract', () => {
  it('opens the cloud’s document types and photos, and attaches the rest', () => {
    for (const name of ['a.pdf', 'b.DOCX', 'c.txt', 'd.md', 'e.csv', 'f.rst', 'g.html', 'h.htm', 'i.JPG', 'j.webp']) {
      assert.equal(isReadable(name), true, name);
    }
    for (const name of ['k.zip', 'l.mov', 'm.heic', 'n.xlsx', 'noext']) {
      assert.equal(isReadable(name), false, name);
    }
    assert.equal(isPhoto('x/y.png'), true);
    assert.equal(isPhoto('x/y.pdf'), false);
  });

  it('reads plain text and HTML here', async () => {
    assert.deepEqual(await extractPages('a.md', Buffer.from('  # Title \n'), noDocuments), [
      { text: '# Title', source: 'TEXT_LAYER' }
    ]);
    assert.deepEqual(
      await extractPages('a.html', Buffer.from('<style>p{}</style><p>Fish &amp; chips</p>'), noDocuments),
      [{ text: 'Fish & chips', source: 'TEXT_LAYER' }]
    );
  });

  it('hands a PDF or a docx to the embedder', async () => {
    const seen: string[] = [];
    const pages = await extractPages('lease.docx', Buffer.from('PK'), async (_b, ext) => {
      seen.push(ext);
      return [{ text: 'clause', source: 'TEXT_LAYER' }];
    });
    assert.deepEqual(seen, ['docx']);
    assert.equal(pages[0].text, 'clause');
  });

  it('gives a photo its name as its page', async () => {
    assert.deepEqual(await extractPages('Trips/a.jpeg', Buffer.from([1]), noDocuments), [
      { text: 'Photo: Trips/a.jpeg', source: 'VISION' }
    ]);
  });

  it('refuses an empty file and an unknown type for good', async () => {
    await assert.rejects(extractPages('a.txt', Buffer.from(' \n'), noDocuments), UnreadableError);
    await assert.rejects(extractPages('a.html', Buffer.from('<p> </p>'), noDocuments), UnreadableError);
    await assert.rejects(extractPages('a.zip', Buffer.from('PK'), noDocuments), UnreadableError);
  });
});
