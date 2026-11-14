import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  actionAllowed,
  OWNER_ONLY_ACTIONS,
  RELAY_SCAN_REFUSAL,
  relaySecretsRefusal
} from '@shared/all/helpers/board-agent-core/runner-access';

import {
  type CodesignResult,
  extensionFlags,
  parseBinaryCookieDomains,
  parseCodesign,
  scanMachine,
  type ScanDeps,
  summarizeCookieHosts
} from './machineScan';

// A fixture home on any OS: the scan reads macOS paths, every tool it calls
// (sqlite3, plutil, codesign) is faked, and nothing outside the temp folder
// is touched.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (file: string, content: string | Buffer = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/** A Safari cookies file with one page holding these domains. */
function binaryCookies(domains: string[]): Buffer {
  const records = domains.map((domain) => {
    const header = Buffer.alloc(56);
    const text = Buffer.from(`${domain}\0name\0/\0value\0`, 'utf8');
    header.writeUInt32LE(56 + text.length, 0);
    header.writeUInt32LE(56, 16); // domain right after the header
    return Buffer.concat([header, text]);
  });
  const offsetsSize = 8 + records.length * 4 + 4;
  const page = Buffer.alloc(offsetsSize);
  page.writeUInt32BE(0x100, 0);
  page.writeUInt32LE(records.length, 4);
  let at = offsetsSize;
  records.forEach((record, i) => {
    page.writeUInt32LE(at, 8 + i * 4);
    at += record.length;
  });
  const body = Buffer.concat([page, ...records]);
  const head = Buffer.alloc(12);
  head.write('cook', 0, 'latin1');
  head.writeUInt32BE(1, 4);
  head.writeUInt32BE(body.length, 8);
  return Buffer.concat([head, body]);
}

function fixture() {
  const home = path.join(tmp, 'home');
  const root = path.join(tmp, 'root');
  const support = path.join(home, 'Library', 'Application Support');
  write(path.join(support, 'Google/Chrome/Default/Network/Cookies'), 'chrome-db');
  write(path.join(support, 'Firefox/Profiles/abc.default/cookies.sqlite'), 'ff-db');
  write(path.join(home, 'Library/Cookies/Cookies.binarycookies'), binaryCookies(['.doubleclick.net', 'example.org', '.doubleclick.net']));
  write(
    path.join(support, 'Google/Chrome/Default/Extensions/abcdef/1.2.0_0/manifest.json'),
    JSON.stringify({ name: '__MSG_appName__', default_locale: 'en', version: '1.2.0', permissions: ['cookies', 'webRequest'], host_permissions: ['<all_urls>'] })
  );
  write(
    path.join(support, 'Google/Chrome/Default/Extensions/abcdef/1.2.0_0/_locales/en/messages.json'),
    JSON.stringify({ appName: { message: 'Coupon Helper' } })
  );
  write(
    path.join(support, 'Google/Chrome/Default/Extensions/quiet/0.1/manifest.json'),
    JSON.stringify({ name: 'Dark Mode', version: '0.1', permissions: ['storage'] })
  );
  const signedBin = path.join(tmp, 'bin', 'signed');
  const unsignedBin = path.join(tmp, 'bin', 'unsigned');
  write(signedBin, 'x');
  write(unsignedBin, 'x');
  write(path.join(home, 'Library/LaunchAgents/com.factiii.runner.plist'), 'plist');
  write(path.join(home, 'Library/LaunchAgents/com.sketchy.helper.plist'), 'plist');
  write(path.join(root, 'Library/LaunchDaemons/com.vendor.daemon.plist'), 'plist');
  write(path.join(support, 'com.apple.TCC/TCC.db'), 'tcc-db');

  const queried: { file: string; sql: string }[] = [];
  const plists: Record<string, { label: string; program: string }> = {
    'com.factiii.runner.plist': { label: 'com.factiii.runner', program: signedBin },
    'com.sketchy.helper.plist': { label: 'com.sketchy.helper', program: unsignedBin },
    'com.vendor.daemon.plist': { label: 'com.vendor.daemon', program: path.join(tmp, 'bin', 'gone') }
  };
  const deps: ScanDeps = {
    platform: 'darwin',
    home,
    root,
    machine: 'Test Mac',
    now: () => 1_000,
    execPath: '/usr/local/bin/node',
    querySqlite: async (file, sql) => {
      queried.push({ file, sql });
      const content = fs.readFileSync(file, 'utf8');
      if (content === 'chrome-db') return [['.doubleclick.net', '3'], ['.google-analytics.com', '2'], ['example.com', '5']];
      if (content === 'ff-db') return [['.scorecardresearch.com', '1'], ['news.example', '4']];
      if (content === 'tcc-db') {
        return [
          ['kTCCServiceMicrophone', 'us.zoom.xos', '2'],
          ['kTCCServiceCamera', 'com.example.cam', '0'],
          ['kTCCServiceAccessibility', 'ignored', '2']
        ];
      }
      return [];
    },
    readLaunchPlist: async (file) => plists[path.basename(file)] ?? { label: null, program: null },
    codesign: async (program): Promise<CodesignResult> =>
      program === signedBin
        ? { ok: true, output: 'Authority=Developer ID Application: Factiii (TEAM123)\nTeamIdentifier=TEAM123' }
        : { ok: false, output: `${program}: code object is not signed at all` }
  };
  return { deps, queried, home };
}

describe('scanMachine', () => {
  it('counts tracker cookies per browser from a copy, never reading a value', async () => {
    const { deps, queried, home } = fixture();
    const report = await scanMachine(deps);
    assert.equal(report.supported, true);
    const chrome = report.cookies.find((c) => c.browser === 'Chrome');
    assert.deepEqual(chrome?.trackers, [{ owner: 'Google', cookies: 5, domains: ['doubleclick.net', 'google-analytics.com'] }]);
    assert.equal(chrome?.cookies, 10);
    assert.equal(chrome?.sites, 3);
    const firefox = report.cookies.find((c) => c.browser === 'Firefox');
    assert.deepEqual(firefox?.trackers.map((t) => t.owner), ['comScore']);
    const safari = report.cookies.find((c) => c.browser === 'Safari');
    assert.deepEqual(safari?.trackers, [{ owner: 'Google', cookies: 2, domains: ['doubleclick.net'] }]);
    for (const { file, sql } of queried) {
      assert.ok(!file.startsWith(home), `read the original ${file}`);
      if (/cookies/i.test(sql)) assert.doesNotMatch(sql, /\bvalue\b|encrypted_value/i);
    }
    // The copies are gone.
    for (const { file } of queried) assert.equal(fs.existsSync(file), false);
  });

  it('flags extensions with wide permissions, with their real names', async () => {
    const { deps } = fixture();
    const report = await scanMachine(deps);
    assert.equal(report.extensions[0]?.name, 'Coupon Helper');
    assert.deepEqual(report.extensions[0]?.flags, ['all-sites', 'webRequest', 'cookies']);
    assert.deepEqual(report.extensions.find((e) => e.name === 'Dark Mode')?.flags, []);
    assert.match(report.extensions[0]!.remove, /chrome:\/\/extensions/);
  });

  it('flags unsigned and missing launch items and knows its own', async () => {
    const { deps } = fixture();
    const report = await scanMachine(deps);
    const byLabel = Object.fromEntries(report.launchItems.map((i) => [i.label, i]));
    assert.equal(byLabel['com.factiii.runner']?.signature, 'developer-id');
    assert.equal(byLabel['com.factiii.runner']?.factiii, true);
    assert.equal(byLabel['com.factiii.runner']?.flagged, false);
    assert.equal(byLabel['com.sketchy.helper']?.signature, 'unsigned');
    assert.equal(byLabel['com.sketchy.helper']?.flagged, true);
    assert.equal(byLabel['com.vendor.daemon']?.signature, 'missing');
    assert.equal(byLabel['com.vendor.daemon']?.kind, 'daemon');
    assert.match(byLabel['com.vendor.daemon']!.remove, /sudo launchctl bootout system/);
  });

  it('reads screen, mic and camera permissions and says where location lives', async () => {
    const { deps } = fixture();
    const report = await scanMachine(deps);
    assert.deepEqual(
      report.permissions.map((p) => [p.kind, p.client, p.allowed]),
      [['camera', 'com.example.cam', false], ['microphone', 'us.zoom.xos', true]]
    );
    assert.ok(report.notes.some((n) => /Location/.test(n.text)));
  });

  it('says Linux and Windows are not supported yet, and reads nothing', async () => {
    const { deps, queried } = fixture();
    for (const platform of ['linux', 'win32'] as const) {
      const report = await scanMachine({ ...deps, platform });
      assert.equal(report.supported, false);
      assert.equal(report.cookies.length + report.launchItems.length, 0);
      assert.match(report.notes[0]!.text, /not supported/);
    }
    assert.equal(queried.length, 0);
  });
});

describe('machineScan parts', () => {
  it('reads codesign output', () => {
    assert.equal(parseCodesign({ ok: true, output: 'Authority=Software Signing\nAuthority=Apple Code Signing Certification Authority' }).signature, 'apple');
    assert.equal(parseCodesign({ ok: true, output: 'Signature size=4202\nAuthority=macOS Software Signing' }).signature, 'apple');
    assert.equal(parseCodesign({ ok: true, output: 'Signature=adhoc\n' }).signature, 'ad-hoc');
    assert.equal(parseCodesign({ ok: false, output: 'x: code object is not signed at all' }).signature, 'unsigned');
    assert.equal(parseCodesign({ ok: true, output: 'Authority=Some CA' }).signature, 'unknown');
  });

  it('treats a content script on every site as all sites', () => {
    assert.deepEqual(extensionFlags({ content_scripts: [{ matches: ['https://*/*'] }], permissions: ['history'] }), ['all-sites', 'history']);
  });

  it('parses only domains from a Safari cookies file', () => {
    assert.deepEqual(parseBinaryCookieDomains(binaryCookies(['a.com', '.b.org'])), ['a.com', '.b.org']);
    assert.throws(() => parseBinaryCookieDomains(Buffer.from('nope')));
  });

  it('summarizes hosts by company', () => {
    const summary = summarizeCookieHosts([{ host: '.adnxs.com', count: 2 }, { host: 'bat.bing.com', count: 1 }]);
    assert.deepEqual(summary.trackers, [{ owner: 'Microsoft', cookies: 3, domains: ['adnxs.com', 'bat.bing.com'] }]);
  });

  it('is the owner\'s alone and never on the relay', () => {
    assert.ok(OWNER_ONLY_ACTIONS.has('machineScan'));
    for (const level of ['none', 'jobs', 'shell'] as const) {
      assert.equal(actionAllowed(level, 'machineScan'), false);
    }
    assert.equal(relaySecretsRefusal('socket', 'machineScan', {}), RELAY_SCAN_REFUSAL);
    assert.equal(relaySecretsRefusal('webrtc', 'machineScan', {}), null);
  });
});
