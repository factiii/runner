import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  codexNoticeStore,
  markCodexNoticeSeen,
  readCodexNoticeSeen
} from './codexNotice';

// The one-time Codex notice on disk: who has seen it, once per runner.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notice-'));

describe('codex notice on disk', () => {
  it('reads a dir with no file as nobody, and writes nothing', () => {
    const dir = tmp();
    assert.deepEqual([...readCodexNoticeSeen(dir)], []);
    assert.equal(fs.existsSync(path.join(dir, 'codex-notice.json')), false);
  });

  it('reads a damaged file as nobody, so the notice shows again', () => {
    for (const text of ['', 'not json', '[]', 'null', '{"seen":7}', '{"seen":[7,""]}']) {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'codex-notice.json'), text);
      assert.deepEqual([...readCodexNoticeSeen(dir)], []);
    }
  });

  it('keeps each person once, across writes', () => {
    const dir = tmp();
    markCodexNoticeSeen(dir, '12');
    markCodexNoticeSeen(dir, '13');
    markCodexNoticeSeen(dir, '12');
    assert.deepEqual([...readCodexNoticeSeen(dir)].sort(), ['12', '13']);
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, 'codex-notice.json'), 'utf-8')
    ) as { seen: string[] };
    assert.deepEqual(raw.seen.sort(), ['12', '13']);
  });

  it('records no one for an empty id', () => {
    const dir = tmp();
    markCodexNoticeSeen(dir, '');
    assert.equal(fs.existsSync(path.join(dir, 'codex-notice.json')), false);
  });

  it('writes the file for the runner user only', { skip: process.platform === 'win32' }, () => {
    const dir = tmp();
    markCodexNoticeSeen(dir, '12');
    const mode = fs.statSync(path.join(dir, 'codex-notice.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('is one store for every board: a mark from one is seen by another', () => {
    const dir = tmp();
    const boardA = codexNoticeStore(dir);
    const boardB = codexNoticeStore(dir);
    assert.equal(boardB.seen('7'), false);
    boardA.markSeen('7');
    assert.equal(boardB.seen('7'), true);
    assert.equal(boardB.seen('8'), false);
  });
});
