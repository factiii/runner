import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  collectSkills,
  type MigrationService,
  missingServices,
  parseMigration,
  safeSkillPath
} from './migrate';

const svc = (kind: MigrationService['kind'], name: string, running = true): MigrationService => ({
  kind,
  name,
  ports: [],
  running
});

describe('runner migration', () => {
  it('collects skills, leaving synced/, node_modules and .git behind', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mig-'));
    await fs.mkdir(path.join(root, 'seo', 'adds'), { recursive: true });
    await fs.mkdir(path.join(root, 'synced', 'x'), { recursive: true });
    await fs.mkdir(path.join(root, 'seo', 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(root, 'seo', 'SKILL.md'), 'hi');
    await fs.writeFile(path.join(root, 'seo', 'adds', 'a.md'), 'a');
    await fs.writeFile(path.join(root, 'synced', 'x', 'SKILL.md'), 'no');
    await fs.writeFile(path.join(root, 'seo', 'node_modules', 'm.js'), 'no');
    const got = await collectSkills(root);
    assert.deepEqual(Object.keys(got).sort(), ['seo/SKILL.md', 'seo/adds/a.md']);
    assert.equal(Buffer.from(got['seo/SKILL.md'], 'base64').toString(), 'hi');
  });

  it('refuses a skill path that climbs out of the skills folder', () => {
    assert.equal(safeSkillPath('/h/skills', '../.ssh/id_rsa'), null);
    assert.equal(safeSkillPath('/h/skills', '/etc/passwd'), null);
    assert.equal(safeSkillPath('/h/skills', 'seo/SKILL.md'), path.resolve('/h/skills/seo/SKILL.md'));
  });

  it('names the servers that ran before and do not run now', () => {
    const before = [svc('docker', 'pg'), svc('pm2', 'api'), svc('docker', 'old', false)];
    const now = [svc('docker', 'pg'), svc('pm2', 'api', false)];
    assert.deepEqual(missingServices(before, now).map((s) => s.name), ['api']);
  });

  it('refuses a file that is not a migration, or from another version', () => {
    assert.throws(() => parseMigration('nope'), /not a runner migration/);
    assert.throws(() => parseMigration('{"format":"x"}'), /not a runner migration/);
    assert.throws(
      () => parseMigration(JSON.stringify({ format: 'factiii-runner-migration', version: 9, boards: [], skills: {} })),
      /another runner version/
    );
  });
});
