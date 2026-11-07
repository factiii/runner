import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { boardLabel, describeBoard, findBoard, knownBoards, noteBoard, rekeyBoard } from './boardRegistry';

// A board renamed on the server, against a throwaway runner folder.

const runnerFolder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'board-registry-'));

describe('board registry', () => {
  it('records a board, then moves its folder when the slug changes, and links the old name', () => {
    const dir = runnerFolder();
    fs.mkdirSync(path.join(dir, 'old-name', 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'old-name', 'workspace', 'file'), 'kept');

    assert.equal(noteBoard(dir, 7, 'old-name'), null);
    assert.equal(noteBoard(dir, 7, 'old-name'), null);
    assert.deepEqual(noteBoard(dir, 7, 'new-name'), { from: 'old-name', to: 'new-name' });

    assert.ok(fs.lstatSync(path.join(dir, 'new-name')).isDirectory());
    assert.ok(fs.lstatSync(path.join(dir, 'old-name')).isSymbolicLink());
    // A path held from before the rename still reaches the same file.
    assert.equal(fs.readFileSync(path.join(dir, 'old-name', 'workspace', 'file'), 'utf-8'), 'kept');
    // Listings that read real directories see one board.
    const boards = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    assert.deepEqual(boards, ['new-name']);
  });

  it('moves nothing when the new name is taken, and still reports the rename', () => {
    const dir = runnerFolder();
    fs.mkdirSync(path.join(dir, 'a'));
    fs.mkdirSync(path.join(dir, 'b'));
    noteBoard(dir, 3, 'a');
    assert.deepEqual(noteBoard(dir, 3, 'b'), { from: 'a', to: 'b' });
    assert.ok(fs.lstatSync(path.join(dir, 'a')).isDirectory());
  });

  it('ignores a message without a real id', () => {
    const dir = runnerFolder();
    assert.equal(noteBoard(dir, 0, 'x'), null);
    assert.equal(fs.existsSync(path.join(dir, 'spaces.json')), false);
  });

  it('keeps the space name through a rename, and finds the board by id, its slug or an old slug', () => {
    const dir = runnerFolder();
    noteBoard(dir, 9, 'acme', 'Acme');
    assert.equal(describeBoard(dir, 'acme'), 'Acme');

    // The name changes, and the slug with it.
    assert.deepEqual(noteBoard(dir, 9, 'acme-labs', 'Acme Labs'), { from: 'acme', to: 'acme-labs' });
    assert.deepEqual(findBoard(dir, { id: 9 }), { id: 9, slug: 'acme-labs', name: 'Acme Labs', was: ['acme'] });
    // A terminal started before the rename still names the old slug.
    assert.equal(findBoard(dir, { slug: 'acme' })?.slug, 'acme-labs');
    assert.equal(describeBoard(dir, 'acme'), 'Acme Labs (acme-labs)');
    assert.equal(findBoard(dir, { slug: 'nobody' }), undefined);

    // A message with no name keeps the one it has.
    assert.equal(noteBoard(dir, 9, 'acme-labs'), null);
    assert.equal(findBoard(dir, { id: 9 })?.name, 'Acme Labs');
    // A name change alone is recorded, and is no rename.
    assert.equal(noteBoard(dir, 9, 'acme-labs', 'ACME LABS'), null);
    assert.equal(describeBoard(dir, 'acme-labs'), 'ACME LABS (acme-labs)');

    // Renamed back: the slug it returns to is no longer a former one.
    noteBoard(dir, 9, 'acme', 'Acme');
    assert.deepEqual(findBoard(dir, { id: 9 })?.was, ['acme-labs']);
  });

  it('reads the registry an older runner wrote (slug alone)', () => {
    const dir = runnerFolder();
    fs.writeFileSync(path.join(dir, 'spaces.json'), '{"66":"factiii-board","bad":5}\n');
    assert.deepEqual(knownBoards(dir), [{ id: 66, slug: 'factiii-board' }]);
    assert.equal(describeBoard(dir, 'factiii-board'), 'factiii-board');
    noteBoard(dir, 66, 'factiii-board', 'Factiii Board');
    assert.equal(describeBoard(dir, 'factiii-board'), 'Factiii Board (factiii-board)');
  });

  it('names a board with no name by its slug', () => {
    assert.equal(boardLabel(undefined, 'x'), 'x');
    assert.equal(boardLabel({ slug: 'x', name: 'Ex' }, 'x'), 'Ex (x)');
  });

  it('moves a board-keyed entry to the new slug', () => {
    const grants = { 'old-name': { '5': 'api' }, other: { '6': 'terminals' } };
    assert.deepEqual(rekeyBoard(grants, { from: 'old-name', to: 'new-name' }), {
      other: { '6': 'terminals' },
      'new-name': { '5': 'api' }
    });
    assert.equal(rekeyBoard(grants, { from: 'none', to: 'x' }), grants);
  });
});
