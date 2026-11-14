import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  MachineScanBrowserCookies,
  MachineScanExtension,
  MachineScanExtensionFlag,
  MachineScanLaunchItem,
  MachineScanNote,
  MachineScanPermission,
  MachineScanPermissionKind,
  MachineScanReport,
  MachineScanSignature,
  MachineScanTrackerCount
} from '@shared/all/domains/machineScan';
import { normalizeHost, trackerOwner } from '@shared/all/helpers/trackerDomains';

// "Scan this computer" (.specs/runner-vault.md "Scan this computer"): what
// the runner can see on its own machine, for its owner. Read-only throughout:
// a locked database is copied to a temp folder and the copy is read; nothing
// is ever deleted or changed, and every finding says how the owner can remove
// it themselves. Cookie rows are counted by host, never read for a value.
// macOS only for now. Every touch of the machine goes through `ScanDeps`, so
// the tests run on Linux against a fixture home.

export interface ScanDeps {
  platform: NodeJS.Platform;
  /** The runner user's home. */
  home: string;
  /** Prefix for the machine-wide folders (`/Library/...`): '' for real,
   *  a fixture folder in tests. */
  root: string;
  machine: string;
  now: () => number;
  /** Rows of `sql` against a SQLite file (already a copy), tab-separated. */
  querySqlite: (file: string, sql: string) => Promise<string[][]>;
  /** A launchd plist's Label and the program it runs. */
  readLaunchPlist: (
    file: string
  ) => Promise<{ label: string | null; program: string | null }>;
  /** `codesign -dv`'s verdict on a program. */
  codesign: (program: string) => Promise<CodesignResult>;
  /** The program the runner runs as, named in the Full Disk Access how-to. */
  execPath: string;
}

export type CodesignResult = { ok: boolean; output: string };

const EXEC_TIMEOUT_MS = 10_000;
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

const run = (file: string, args: string[]) =>
  new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    execFile(
      file,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER },
      (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })
    );
  });

/** The real machine (macOS tools that ship with the OS). */
export const defaultScanDeps = (machine: string): ScanDeps => ({
  platform: process.platform,
  home: os.homedir(),
  root: '',
  machine,
  now: () => Date.now(),
  execPath: process.execPath,
  querySqlite: async (file, sql) => {
    const out = await run('/usr/bin/sqlite3', [
      '-readonly',
      '-separator',
      '\t',
      file,
      sql
    ]);
    if (!out.ok) throw new Error(out.stderr.trim() || 'sqlite3 failed');
    return out.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split('\t'));
  },
  readLaunchPlist: async (file) => {
    const extract = async (key: string) => {
      const out = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file]);
      return out.ok ? out.stdout.trim() || null : null;
    };
    return {
      label: await extract('Label'),
      program: (await extract('Program')) ?? (await extract('ProgramArguments.0'))
    };
  },
  codesign: async (program) => {
    const out = await run('/usr/bin/codesign', ['-dv', '--verbose=2', program]);
    // codesign writes what it found to stderr, on success too.
    return { ok: out.ok, output: `${out.stderr}\n${out.stdout}` };
  }
});

// ── Small helpers ──

const isMissing = (err: unknown) =>
  (err as NodeJS.ErrnoException)?.code === 'ENOENT';
const isDenied = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EACCES';
};

const exists = async (file: string) => {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
};

const listDir = async (dir: string): Promise<string[]> => {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
};

/** A database another program holds open, copied (with its -wal and -shm)
 *  into a fresh temp folder, then read there. The temp folder is removed
 *  whatever happens. */
async function withCopy<T>(
  file: string,
  read: (copy: string) => Promise<T>
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'factiii-scan-'));
  try {
    const copy = path.join(dir, path.basename(file));
    await fs.copyFile(file, copy);
    for (const suffix of ['-wal', '-shm']) {
      try {
        await fs.copyFile(file + suffix, copy + suffix);
      } catch {
        // No journal beside it: nothing to copy.
      }
    }
    return await read(copy);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const FULL_DISK_ACCESS_HOW = (execPath: string) =>
  `Open System Settings > Privacy & Security > Full Disk Access, add ${execPath} (the program your runner runs as), then scan again.`;

// ── Cookies ──

/** Chromium-family browsers by their folder under Application Support. */
const CHROMIUM_BROWSERS: { name: string; dir: string; scheme: string }[] = [
  { name: 'Chrome', dir: 'Google/Chrome', scheme: 'chrome' },
  { name: 'Edge', dir: 'Microsoft Edge', scheme: 'edge' },
  { name: 'Brave', dir: 'BraveSoftware/Brave-Browser', scheme: 'brave' },
  { name: 'Arc', dir: 'Arc/User Data', scheme: 'arc' },
  { name: 'Vivaldi', dir: 'Vivaldi', scheme: 'vivaldi' },
  { name: 'Chromium', dir: 'Chromium', scheme: 'chrome' }
];

const isChromiumProfile = (name: string) =>
  name === 'Default' || /^Profile \d+$/.test(name);

/** Per-host cookie counts into the report's shape, trackers busiest first. */
export function summarizeCookieHosts(
  rows: { host: string; count: number }[]
): Pick<MachineScanBrowserCookies, 'cookies' | 'sites' | 'trackers'> {
  const byOwner = new Map<string, { cookies: number; domains: Set<string> }>();
  let cookies = 0;
  const sites = new Set<string>();
  for (const { host, count } of rows) {
    const clean = normalizeHost(host);
    cookies += count;
    sites.add(clean);
    const owner = trackerOwner(clean);
    if (!owner) continue;
    const entry = byOwner.get(owner) ?? { cookies: 0, domains: new Set() };
    entry.cookies += count;
    entry.domains.add(clean);
    byOwner.set(owner, entry);
  }
  const trackers: MachineScanTrackerCount[] = [...byOwner.entries()]
    .map(([owner, entry]) => ({
      owner,
      cookies: entry.cookies,
      domains: [...entry.domains].sort()
    }))
    .sort((a, b) => b.cookies - a.cookies || a.owner.localeCompare(b.owner));
  return { cookies, sites: sites.size, trackers };
}

const hostCounts = (rows: string[][]) =>
  rows.map(([host, count]) => ({ host: host ?? '', count: Number(count) || 0 }));

async function chromiumCookies(
  deps: ScanDeps,
  notes: MachineScanNote[]
): Promise<MachineScanBrowserCookies[]> {
  const found: MachineScanBrowserCookies[] = [];
  const support = path.join(deps.home, 'Library', 'Application Support');
  for (const browser of CHROMIUM_BROWSERS) {
    const base = path.join(support, browser.dir);
    for (const profile of (await listDir(base)).filter(isChromiumProfile)) {
      const dir = path.join(base, profile);
      const candidates = [path.join(dir, 'Network', 'Cookies'), path.join(dir, 'Cookies')];
      let file: string | null = null;
      for (const candidate of candidates) {
        if (await exists(candidate)) {
          file = candidate;
          break;
        }
      }
      if (!file) continue;
      try {
        const rows = await withCopy(file, (copy) =>
          deps.querySqlite(copy, 'SELECT host_key, COUNT(*) FROM cookies GROUP BY host_key')
        );
        found.push({
          browser: browser.name,
          profile,
          ...summarizeCookieHosts(hostCounts(rows)),
          remove: `In ${browser.name}: Settings > Privacy and security > Delete browsing data > Cookies and other site data, or remove one site's at ${browser.scheme}://settings/content/all.`
        });
      } catch (err) {
        notes.push({
          area: 'cookies',
          text: `Could not read ${browser.name} (${profile}) cookies: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    }
  }
  return found;
}

async function firefoxCookies(
  deps: ScanDeps,
  notes: MachineScanNote[]
): Promise<MachineScanBrowserCookies[]> {
  const base = path.join(deps.home, 'Library', 'Application Support', 'Firefox', 'Profiles');
  const found: MachineScanBrowserCookies[] = [];
  for (const profile of await listDir(base)) {
    const file = path.join(base, profile, 'cookies.sqlite');
    if (!(await exists(file))) continue;
    try {
      const rows = await withCopy(file, (copy) =>
        deps.querySqlite(copy, 'SELECT host, COUNT(*) FROM moz_cookies GROUP BY host')
      );
      found.push({
        browser: 'Firefox',
        profile,
        ...summarizeCookieHosts(hostCounts(rows)),
        remove:
          'In Firefox: Settings > Privacy & Security > Cookies and Site Data > Manage Data, then remove the sites you do not want.'
      });
    } catch (err) {
      notes.push({
        area: 'cookies',
        text: `Could not read Firefox (${profile}) cookies: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }
  return found;
}

/**
 * The domain of every cookie in a Safari `Cookies.binarycookies` file, and
 * nothing else: the format is a list of pages of cookie records, each record
 * holding the offset of its domain string at byte 16.
 */
export function parseBinaryCookieDomains(buf: Buffer): string[] {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'cook') {
    throw new Error('Not a Safari cookies file.');
  }
  const pageCount = buf.readUInt32BE(4);
  const sizes: number[] = [];
  for (let i = 0; i < pageCount; i++) sizes.push(buf.readUInt32BE(8 + i * 4));
  const domains: string[] = [];
  let pageStart = 8 + pageCount * 4;
  for (const size of sizes) {
    const page = buf.subarray(pageStart, pageStart + size);
    pageStart += size;
    if (page.length < 8) continue;
    const count = page.readUInt32LE(4);
    for (let i = 0; i < count; i++) {
      const offsetAt = 8 + i * 4;
      if (offsetAt + 4 > page.length) break;
      const start = page.readUInt32LE(offsetAt);
      if (start + 20 > page.length) continue;
      const domainAt = start + page.readUInt32LE(start + 16);
      const end = page.indexOf(0, domainAt);
      if (domainAt >= page.length || end < 0) continue;
      domains.push(page.toString('utf8', domainAt, end));
    }
  }
  return domains;
}

async function safariCookies(
  deps: ScanDeps,
  notes: MachineScanNote[]
): Promise<MachineScanBrowserCookies[]> {
  const files = [
    path.join(deps.home, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Cookies', 'Cookies.binarycookies'),
    path.join(deps.home, 'Library', 'Cookies', 'Cookies.binarycookies')
  ];
  for (const file of files) {
    let buf: Buffer;
    try {
      buf = await fs.readFile(file);
    } catch (err) {
      if (isDenied(err)) {
        notes.push({
          area: 'cookies',
          text: `Safari's cookies need Full Disk Access. ${FULL_DISK_ACCESS_HOW(deps.execPath)}`,
          needsFullDiskAccess: true
        });
        return [];
      }
      continue;
    }
    try {
      const counts = new Map<string, number>();
      for (const domain of parseBinaryCookieDomains(buf)) {
        counts.set(domain, (counts.get(domain) ?? 0) + 1);
      }
      return [
        {
          browser: 'Safari',
          profile: 'Default',
          ...summarizeCookieHosts([...counts].map(([host, count]) => ({ host, count }))),
          remove:
            'In Safari: Settings > Privacy > Manage Website Data, then remove the sites you do not want.'
        }
      ];
    } catch (err) {
      notes.push({
        area: 'cookies',
        text: `Could not read Safari's cookies: ${err instanceof Error ? err.message : String(err)}`
      });
      return [];
    }
  }
  return [];
}

// ── Extensions ──

type Manifest = {
  name?: unknown;
  version?: unknown;
  default_locale?: unknown;
  permissions?: unknown;
  optional_permissions?: unknown;
  host_permissions?: unknown;
  content_scripts?: unknown;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const ALL_SITES = new Set(['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']);

/** The wide permissions a manifest asks for, in a fixed order. */
export function extensionFlags(manifest: Manifest): MachineScanExtensionFlag[] {
  const permissions = new Set([
    ...strings(manifest.permissions),
    ...strings(manifest.optional_permissions),
    ...strings(manifest.host_permissions)
  ]);
  const scripts = Array.isArray(manifest.content_scripts)
    ? manifest.content_scripts.flatMap((entry) =>
        strings((entry as { matches?: unknown })?.matches)
      )
    : [];
  const flags: MachineScanExtensionFlag[] = [];
  if ([...permissions, ...scripts].some((p) => ALL_SITES.has(p))) flags.push('all-sites');
  if (permissions.has('webRequest') || permissions.has('webRequestBlocking')) flags.push('webRequest');
  if (permissions.has('cookies')) flags.push('cookies');
  if (permissions.has('history')) flags.push('history');
  return flags;
}

/** `__MSG_appName__` from the extension's default locale, else the raw name. */
async function extensionName(dir: string, manifest: Manifest): Promise<string> {
  const raw = typeof manifest.name === 'string' ? manifest.name : '';
  const key = /^__MSG_(.+)__$/.exec(raw)?.[1];
  if (!key) return raw || 'Unnamed extension';
  const locale = typeof manifest.default_locale === 'string' ? manifest.default_locale : 'en';
  try {
    const messages = JSON.parse(
      await fs.readFile(path.join(dir, '_locales', locale, 'messages.json'), 'utf8')
    ) as Record<string, { message?: unknown }>;
    const entry = Object.entries(messages).find(([k]) => k.toLowerCase() === key.toLowerCase());
    const message = entry?.[1]?.message;
    return typeof message === 'string' && message ? message : raw;
  } catch {
    return raw;
  }
}

async function chromiumExtensions(deps: ScanDeps): Promise<MachineScanExtension[]> {
  const found: MachineScanExtension[] = [];
  const support = path.join(deps.home, 'Library', 'Application Support');
  for (const browser of CHROMIUM_BROWSERS) {
    const base = path.join(support, browser.dir);
    for (const profile of (await listDir(base)).filter(isChromiumProfile)) {
      const extDir = path.join(base, profile, 'Extensions');
      for (const id of await listDir(extDir)) {
        const versions = await listDir(path.join(extDir, id));
        const version = versions[versions.length - 1];
        if (!version) continue;
        const dir = path.join(extDir, id, version);
        let manifest: Manifest;
        try {
          manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
        } catch {
          continue;
        }
        const name = await extensionName(dir, manifest);
        found.push({
          browser: browser.name,
          profile,
          id,
          name,
          version: typeof manifest.version === 'string' ? manifest.version : version,
          flags: extensionFlags(manifest),
          remove: `Open ${browser.scheme}://extensions in ${browser.name} and click Remove on ${name}.`
        });
      }
    }
  }
  return found.sort((a, b) => b.flags.length - a.flags.length || a.name.localeCompare(b.name));
}

// ── Login items and background agents ──

const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'env', 'osascript', 'python', 'python3', 'perl', 'ruby', 'node'
]);

/** `codesign -dv`'s output, read into a verdict. */
export function parseCodesign(result: CodesignResult): {
  signature: MachineScanSignature;
  signer: string | null;
} {
  const out = result.output;
  if (/not signed at all/i.test(out)) return { signature: 'unsigned', signer: null };
  if (/No such file or directory/i.test(out)) return { signature: 'missing', signer: null };
  if (!result.ok) return { signature: 'unknown', signer: null };
  const authority = /^Authority=(.+)$/m.exec(out)?.[1]?.trim() ?? null;
  if (/^Signature=adhoc/m.test(out)) return { signature: 'ad-hoc', signer: null };
  if (authority?.startsWith('Developer ID Application')) {
    return { signature: 'developer-id', signer: authority };
  }
  // Apple's own: `Software Signing`, `macOS Software Signing`, `Apple …`.
  if (authority && (/Software Signing$/.test(authority) || authority.startsWith('Apple '))) {
    return { signature: 'apple', signer: authority };
  }
  return { signature: 'unknown', signer: authority };
}

const LAUNCH_FOLDERS = (deps: ScanDeps) =>
  [
    { dir: path.join(deps.home, 'Library', 'LaunchAgents'), kind: 'user-agent' as const },
    { dir: path.join(deps.root, '/Library/LaunchAgents'), kind: 'agent' as const },
    { dir: path.join(deps.root, '/Library/LaunchDaemons'), kind: 'daemon' as const }
  ];

async function launchItems(deps: ScanDeps): Promise<MachineScanLaunchItem[]> {
  const found: MachineScanLaunchItem[] = [];
  for (const { dir, kind } of LAUNCH_FOLDERS(deps)) {
    for (const name of (await listDir(dir)).filter((n) => n.endsWith('.plist'))) {
      const plist = path.join(dir, name);
      const { label, program } = await deps.readLaunchPlist(plist);
      let verdict: { signature: MachineScanSignature; signer: string | null };
      if (!program) verdict = { signature: 'unknown', signer: null };
      else if (!(await exists(program))) verdict = { signature: 'missing', signer: null };
      else if (INTERPRETERS.has(path.basename(program))) verdict = { signature: 'script', signer: null };
      else verdict = parseCodesign(await deps.codesign(program));
      const itemLabel = label ?? name.replace(/\.plist$/, '');
      const domain = kind === 'daemon' ? 'system' : 'gui/$(id -u)';
      const sudo = kind === 'user-agent' ? '' : 'sudo ';
      found.push({
        label: itemLabel,
        plist,
        kind,
        program,
        ...verdict,
        flagged: verdict.signature !== 'apple' && verdict.signature !== 'developer-id',
        factiii: itemLabel.startsWith('com.factiii.'),
        remove: `If you do not want it: ${sudo}launchctl bootout ${domain} "${plist}", then move the plist to the Trash. Apps that own it may also list it in System Settings > General > Login Items & Extensions.`
      });
    }
  }
  return found.sort((a, b) => Number(b.flagged) - Number(a.flagged) || a.label.localeCompare(b.label));
}

// ── App permissions (TCC) ──

const TCC_SERVICES: Record<string, { kind: MachineScanPermissionKind; pane: string }> = {
  kTCCServiceScreenCapture: { kind: 'screen', pane: 'Screen & System Audio Recording' },
  kTCCServiceMicrophone: { kind: 'microphone', pane: 'Microphone' },
  kTCCServiceCamera: { kind: 'camera', pane: 'Camera' }
};

async function permissions(
  deps: ScanDeps,
  notes: MachineScanNote[]
): Promise<MachineScanPermission[]> {
  const dbs = [
    path.join(deps.home, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'),
    path.join(deps.root, '/Library/Application Support/com.apple.TCC/TCC.db')
  ];
  const services = Object.keys(TCC_SERVICES).map((s) => `'${s}'`).join(',');
  const found = new Map<string, MachineScanPermission>();
  let denied = false;
  for (const db of dbs) {
    try {
      await fs.access(db);
    } catch (err) {
      if (isDenied(err)) denied = true;
      continue;
    }
    try {
      const rows = await withCopy(db, (copy) =>
        deps.querySqlite(copy, `SELECT service, client, auth_value FROM access WHERE service IN (${services})`)
      );
      for (const [service, client, auth] of rows) {
        const known = service ? TCC_SERVICES[service] : undefined;
        if (!known || !client) continue;
        found.set(`${known.kind}:${client}`, {
          kind: known.kind,
          client,
          // 2 is "allowed"; 0 denied; others are limited or ask again.
          allowed: auth === '2',
          remove: `System Settings > Privacy & Security > ${known.pane}: switch off ${client}.`
        });
      }
    } catch (err) {
      if (isDenied(err) || /authorization denied|unable to open/i.test(String(err))) denied = true;
      else if (!isMissing(err)) {
        notes.push({ area: 'permissions', text: `Could not read app permissions: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }
  if (denied) {
    notes.push({
      area: 'permissions',
      text: `App permissions (screen recording, microphone, camera) need Full Disk Access. ${FULL_DISK_ACCESS_HOW(deps.execPath)}`,
      needsFullDiskAccess: true
    });
  }
  notes.push({
    area: 'permissions',
    text: 'Location permissions are kept by macOS outside TCC.db, where the runner cannot read them. See System Settings > Privacy & Security > Location Services.'
  });
  return [...found.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.client.localeCompare(b.client));
}

// ── The scan ──

export async function scanMachine(deps: ScanDeps): Promise<MachineScanReport> {
  const base = {
    platform: deps.platform,
    scannedAt: deps.now(),
    machine: deps.machine
  };
  if (deps.platform !== 'darwin') {
    return {
      ...base,
      supported: false,
      cookies: [],
      extensions: [],
      launchItems: [],
      permissions: [],
      notes: [
        {
          area: 'cookies',
          text: `Scan this computer is not supported on ${deps.platform} yet: it reads macOS folders only.`
        }
      ]
    };
  }
  const notes: MachineScanNote[] = [];
  const cookies = [
    ...(await chromiumCookies(deps, notes)),
    ...(await firefoxCookies(deps, notes)),
    ...(await safariCookies(deps, notes))
  ];
  return {
    ...base,
    supported: true,
    cookies,
    extensions: await chromiumExtensions(deps),
    launchItems: await launchItems(deps),
    permissions: await permissions(deps, notes),
    notes
  };
}
