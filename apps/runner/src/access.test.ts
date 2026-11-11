import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { levelChangeCuts, readRunnerGrants, writeRunnerGrants } from './access';

// The member levels on disk: what an upgraded runner reads from the files
// the two switches left behind, and what a write keeps.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-access-'));
const put = (dir: string, name: string, text: string) =>
  fs.writeFileSync(path.join(dir, name), text);

describe('runner access on disk', () => {
  it('reads a dir with no file as no grants, and writes nothing', () => {
    const dir = tmp();
    assert.deepEqual(readRunnerGrants(dir, '7'), {});
    assert.equal(fs.existsSync(path.join(dir, 'access.json')), false);
  });

  // Decided with the levels: reset to None, no conversion.
  it('reads the old two switches as no grants, whatever they said', () => {
    for (const old of [
      '{"apiAccess":true,"shareTerminals":true}',
      '{"apiAccess":true,"shareTerminals":false}',
      '{"apiAccess":false,"shareTerminals":true}'
    ]) {
      const dir = tmp();
      put(dir, 'access.json', `${old}\n`);
      assert.deepEqual(readRunnerGrants(dir, '7'), {});
    }
  });

  it('never reads the older shared.json', () => {
    for (const old of ['{"shared":true}', '{"shared":false}']) {
      const dir = tmp();
      put(dir, 'config.json', '{}');
      put(dir, 'shared.json', `${old}\n`);
      assert.deepEqual(readRunnerGrants(dir, '7'), {});
      // Not converted and not persisted: the next read is the same.
      assert.equal(fs.existsSync(path.join(dir, 'access.json')), false);
    }
  });

  it('reads a file that is not JSON, or not an object, as no grants', () => {
    for (const text of ['', 'not json', '[]', 'null', '"screens"', '{"grants":7}', '{"owner":"7","grants":7}']) {
      const dir = tmp();
      put(dir, 'access.json', text);
      assert.deepEqual(readRunnerGrants(dir, '7'), {});
    }
  });

  it('keeps a level per board and user across a write', () => {
    const dir = tmp();
    const grants = {
      alpha: { '12': 'shell', '13': 'jobs' },
      beta: { '12': 'jobs' }
    } as const;
    writeRunnerGrants(dir, '7', grants);
    assert.deepEqual(readRunnerGrants(dir, '7'), grants);
    assert.equal(fs.statSync(path.join(dir, 'access.json')).mode & 0o777, 0o600);
  });

  it('replaces the old switches on the first grant', () => {
    const dir = tmp();
    put(dir, 'access.json', '{"apiAccess":true,"shareTerminals":true}\n');
    writeRunnerGrants(dir, '7', { alpha: { '12': 'jobs' } });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, 'access.json'), 'utf-8')),
      { owner: '7', grants: { alpha: { '12': 'jobs' } } }
    );
  });

  // Before 2026-11: four levels and a Dangerous jobs list. Read as the three
  // levels, the list dropped, and written in the new shape on the next save.
  it('reads a file from the four levels as the three, without its dangerous list', () => {
    const dir = tmp();
    put(
      dir,
      'access.json',
      '{"owner":"7","grants":{"alpha":{"12":"api","13":"terminals","14":"screens","15":"root"}},"dangerous":{"alpha":["12"]}}\n'
    );
    const grants = readRunnerGrants(dir, '7');
    assert.deepEqual(grants, { alpha: { '12': 'jobs', '13': 'shell', '14': 'shell' } });
    writeRunnerGrants(dir, '7', grants);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, 'access.json'), 'utf-8')),
      { owner: '7', grants: { alpha: { '12': 'jobs', '13': 'shell', '14': 'shell' } } }
    );
  });

  it('reads a malformed dangerous list without failing', () => {
    for (const dangerous of ['true', '"x"', '[1]', '{"alpha":"12"}', 'null']) {
      const dir = tmp();
      put(dir, 'access.json', `{"owner":"7","grants":{"alpha":{"12":"jobs"}},"dangerous":${dangerous}}`);
      assert.deepEqual(readRunnerGrants(dir, '7'), { alpha: { '12': 'jobs' } });
    }
  });

  // A runner paired again to another account keeps its config dir.
  it('gives nothing from a file written for another owner, or with no owner known', () => {
    const dir = tmp();
    writeRunnerGrants(dir, '7', { alpha: { '12': 'shell' } });
    assert.deepEqual(readRunnerGrants(dir, '8'), {});
    assert.deepEqual(readRunnerGrants(dir, null), {});
    assert.deepEqual(readRunnerGrants(dir, ''), {});
    put(dir, 'access.json', '{"grants":{"alpha":{"12":"shell"}}}');
    assert.deepEqual(readRunnerGrants(dir, '7'), {});
  });
});

// What setGrant (daemon.ts) cuts at once: below Shell the member's terminals
// and AI sessions on that board (engine stopMemberSessions), below Jobs the
// video stream too.
describe('levelChangeCuts', () => {
  it('Shell -> Jobs stops their sessions and keeps the stream', () => {
    assert.deepEqual(levelChangeCuts('shell', 'jobs'), {
      shells: true,
      stream: false
    });
  });

  it('-> None also takes the stream', () => {
    assert.deepEqual(levelChangeCuts('shell', 'none'), {
      shells: true,
      stream: true
    });
    assert.deepEqual(levelChangeCuts('jobs', 'none'), {
      shells: false,
      stream: true
    });
  });

  it('a raise cuts nothing', () => {
    for (const [before, after] of [
      ['none', 'jobs'],
      ['none', 'shell'],
      ['jobs', 'shell']
    ] as const) {
      assert.deepEqual(levelChangeCuts(before, after), {
        shells: false,
        stream: false
      });
    }
  });
});
