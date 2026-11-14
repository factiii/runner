import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { RunnerVaultFile } from '@shared/all/domains/electron';
import { storeErrorAction } from '@shared/all/helpers/storeErrors';
import { RUNNER_DISK_FULL, RUNNER_NO_FFMPEG } from '@shared/all/validators';

import { JobRegistry } from '../activity/registry';
import { roomRefusal } from './daemonVault';
import { openVaultDb, type VaultDb } from './db';
import { FsObjectStore } from '@shared/vault-core/objectStore';
import { findFfmpeg, type RunTool } from './recordingTrim';
import { DISK_HEADROOM_BYTES, RunnerVault, type RunnerVaultOptions } from './service';

// A screen recording kept on this runner (.specs/screen-recording.md → Where
// a recording is stored): refused before a byte is sent when the disk has no
// room or a trim has no ffmpeg; trimmed here when asked; its words stored as
// its own rows, so the runner embeds and searches them; its save in Activity
// (a Vault one as metadata only).

const OWNER = { role: 'owner' as const, userId: '1', name: 'Owner' };
const GIB = 1024 ** 3;
const ENGINE = path.resolve(__dirname, '../..');
const TOOLS = { ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' };

let db: VaultDb;
const jobs = new JobRegistry({ history: null });
const calls: { file: string; args: string[] }[] = [];

/** ffprobe answers keyframes every second; ffmpeg writes "CUT" as the cut. */
const fakeTools: RunTool = async (file, args) => {
  calls.push({ file, args });
  if (file === TOOLS.ffprobe) return '0.000000,K_\n1.000000,K_\n2.000000,K_\n';
  fs.writeFileSync(args[args.length - 1]!, 'CUT');
  return '';
};

const vaultWith = (options: RunnerVaultOptions) =>
  new RunnerVault(
    db,
    new FsObjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-rec-'))),
    '1',
    () => undefined,
    null,
    null,
    null,
    null,
    { storeName: 'runner', startJob: (input) => jobs.start(input), ...options }
  );

async function save(
  vault: RunnerVault,
  body: string,
  recording: Record<string, unknown>
): Promise<RunnerVaultFile> {
  const bytes = Buffer.from(body);
  const { ticket } = (await vault.handle(
    'vaultUploadStart',
    { name: 'screen-recording.mp4', size: bytes.length, contentType: 'video/mp4', recording },
    OWNER
  )) as { ticket: string };
  const { file } = (await vault.handle(
    'vaultWrite',
    { ticket, offset: 0, content: bytes.toString('base64'), last: true },
    OWNER
  )) as { file: RunnerVaultFile };
  return file;
}

before(async () => {
  db = await openVaultDb({ dataDir: 'memory://', engineDir: ENGINE });
});
after(async () => {
  await db.close();
});

describe('recordings kept on the runner', () => {
  it('refuses a save the disk has no room for, before a byte is sent', async () => {
    const vault = vaultWith({ freeBytes: () => DISK_HEADROOM_BYTES });
    await assert.rejects(
      vault.handle(
        'vaultUploadStart',
        { name: 'take.mp4', size: 10, contentType: 'video/mp4' },
        OWNER
      ),
      (err: Error) => err.message === RUNNER_DISK_FULL
    );
  });

  it("refuses a file that would leave under 5 GB free as the disk full, so the app offers Keep it on Cloud", () => {
    // An untrimmed 1 GB take with 4 GB free: the daemon's floor refuses it
    // before the store's own check would, in the same words.
    const refused = roomRefusal(4, GIB, 'take.mp4');
    assert.ok(refused?.startsWith(RUNNER_DISK_FULL));
    assert.equal(storeErrorAction(refused), 'useCloud');
    assert.equal(roomRefusal(100, GIB, 'take.mp4'), null);
  });

  it('refuses a trim with no ffmpeg on the runner', async () => {
    const vault = vaultWith({ ffmpeg: () => null });
    await assert.rejects(
      vault.handle(
        'vaultUploadStart',
        {
          name: 'take.mp4',
          size: 10,
          contentType: 'video/mp4',
          recording: { trim: { startSec: 1, endSec: 2 } }
        },
        OWNER
      ),
      (err: Error) => err.message === RUNNER_NO_FFMPEG
    );
  });

  it('keeps the words as the file’s rows, and shows the save in Activity', async () => {
    const vault = vaultWith({ freeBytes: () => null });
    const file = await save(vault, 'MP4BYTES', { transcript: 'the login button is broken' });
    const rows = await db.query<{ seq: number; text: string }>(
      `SELECT pc."seq", pc."text" FROM "_postUploads" pu
         JOIN "PostContent" pc ON pc."postId" = pu."A"
        WHERE pu."B" = $1 ORDER BY pc."seq"`,
      [file.id]
    );
    assert.deepEqual(rows, [
      { seq: 1, text: 'screen-recording.mp4' },
      { seq: 2, text: 'the login button is broken' }
    ]);
    const [upload] = await db.query<{ transcriptSource: string }>(
      'SELECT "transcriptSource" FROM "Upload" WHERE "id" = $1',
      [file.id]
    );
    assert.equal(upload?.transcriptSource, 'SPEECH');
    const found = (await vault.handle('vaultFiles', { query: 'login button' }, OWNER)) as {
      files: RunnerVaultFile[];
    };
    assert.ok(found.files.some((f) => f.id === file.id));
    const job = jobs.recent().find((j) => j.type === 'recording');
    assert.equal(job?.status, 'done');
    assert.equal(job?.vault, false);
  });

  it('trims the take with the runner’s ffmpeg and stores the cut', async () => {
    calls.length = 0;
    const vault = vaultWith({ ffmpeg: () => TOOLS, runTool: fakeTools });
    const file = await save(vault, 'THE WHOLE TAKE', { trim: { startSec: 1.5, endSec: 2.5 } });
    assert.equal(file.size, 3);
    assert.deepEqual(
      calls.map((call) => call.file),
      [TOOLS.ffprobe, TOOLS.ffmpeg]
    );
    // A copy from the keyframe at 1 s, the server's plan.
    const ffmpegArgs = calls[1]!.args;
    assert.equal(ffmpegArgs[ffmpegArgs.indexOf('-ss') + 1], '1.000000');
    assert.ok(ffmpegArgs.includes('copy'));
  });

  it('keeps a Vault save to its type in Activity', async () => {
    const vault = new RunnerVault(
      db,
      new FsObjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-rec-vault-'))),
      '1',
      () => undefined,
      null,
      null,
      null,
      null,
      { storeName: 'vault', startJob: (input) => jobs.start(input) }
    );
    await save(vault, 'SECRET', { transcript: 'private words' });
    const job = jobs.recent().find((j) => j.type === 'recording' && j.vault);
    assert.equal(job?.title, 'Recording');
  });
});

describe('findFfmpeg', () => {
  it('finds ffmpeg and ffprobe in one folder, PATH first', () => {
    const present = new Set(['/opt/homebrew/bin/ffmpeg', '/opt/homebrew/bin/ffprobe', '/x/ffmpeg']);
    assert.deepEqual(findFfmpeg({ PATH: '/x:/y' }, (file) => present.has(file)), {
      ffmpeg: '/opt/homebrew/bin/ffmpeg',
      ffprobe: '/opt/homebrew/bin/ffprobe'
    });
    assert.equal(findFfmpeg({ PATH: '' }, () => false), null);
  });
});
