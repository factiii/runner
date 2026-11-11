import path from 'node:path';

import { OPS_GROUP, OPS_USER } from './settings';

// The servers registry (.specs/ops-user.md, "Servers registry"): the machine
// services the ops user runs on a host that hosts them, declared once. Today
// that is the Mac mini, and these are its com.factiii.* LaunchAgents as they
// were read on 2026-11-09, moved under the ops home. `ops plists` renders
// LaunchDaemons (UserName=factiii-ops) and systemd units from this list;
// nothing here installs anything.
//
// `{servers}` in a path is `<ops home>/servers`, `{home}` the ops home.

export type ServerRun =
  | { kind: 'keep-alive' }
  | { kind: 'at-load' }
  | { kind: 'interval'; seconds: number }
  | { kind: 'calendar'; weekday?: number; hour: number; minute: number };

export type ServerCredential = {
  /** The name it goes by (an env key, a file). */
  name: string;
  what: string;
  /** Where it is on the host today (the normal user's), for the migration. */
  today: string;
};

export type MachineServer = {
  id: string;
  description: string;
  program: string[];
  workingDir?: string;
  run: ServerRun;
  /** Non-secret env. A secret is a file under the server's dir, 0600 ops. */
  env?: Record<string, string>;
  credentials: ServerCredential[];
  /** The LaunchAgent it replaces (the normal user's), if any. */
  replaces?: string;
  notes?: string;
};

export const MACHINE_SERVERS: readonly MachineServer[] = [
  {
    id: 'embedder',
    description: 'Text/image embedder (uvicorn on 127.0.0.1:8000, Core ML / Neural Engine)',
    program: ['/bin/bash', '{servers}/embedder/services/embedder/start.sh', '8000'],
    workingDir: '{servers}/embedder/services/embedder',
    run: { kind: 'keep-alive' },
    env: { TOKENIZERS_PARALLELISM: 'false' },
    credentials: [
      {
        name: 'EMBEDDER_API_KEY',
        what: 'the key the server sends to the embedder',
        today: '~/factiii-embedder/.env (start.sh reads only this key and COREML_UNITS)'
      }
    ],
    replaces: 'com.factiii.embedder',
    notes: 'Verify Core ML / ANE from a LaunchDaemon with no GUI session before moving it.'
  },
  {
    id: 'embedder-tunnel',
    description: 'Cloudflare tunnel for the embedder and analytics.factiii.com',
    program: [
      '/opt/homebrew/bin/cloudflared',
      'tunnel',
      '--no-autoupdate',
      'run',
      '--token-file',
      '{servers}/embedder/tunnel.token'
    ],
    run: { kind: 'keep-alive' },
    credentials: [
      {
        name: 'tunnel.token',
        what: 'Cloudflare tunnel token (anyone holding it serves the tunnel hostnames)',
        today: '~/factiii-embedder/tunnel.token'
      }
    ],
    replaces: 'com.factiii.embedder-tunnel'
  },
  {
    id: 'frps',
    description: 'frp server for *.dev.factiii.com previews (7443 control, 8081 vhost, admin 127.0.0.1:7500)',
    program: ['{servers}/dev-tunnel/bin/frps', '-c', '{servers}/dev-tunnel/frps.toml'],
    run: { kind: 'keep-alive' },
    credentials: [],
    replaces: 'com.factiii.frps',
    notes: 'No secret in frps.toml: logins and proxies are checked by https://api.factiii.com/frp-auth.'
  },
  {
    id: 'dev-previews-nginx',
    description: 'nginx for *.dev.factiii.com (80/443) in front of frps 8081',
    program: [
      '/opt/homebrew/bin/nginx',
      '-c',
      '{servers}/dev-tunnel/nginx/nginx.conf',
      '-g',
      'daemon off;'
    ],
    run: { kind: 'keep-alive' },
    credentials: [
      {
        name: 'letsencrypt/live/dev.factiii.com/privkey.pem',
        what: 'the *.dev.factiii.com wildcard TLS key',
        today: '~/factiii-dev-tunnel/letsencrypt'
      }
    ],
    replaces: 'sh.brew.nginx (brew services)',
    notes:
      'Not a com.factiii agent today. Needs its own nginx.conf (pid, logs and temp dirs under the server dir) that includes dev-previews.conf.'
  },
  {
    id: 'cloudflare-ddns',
    description: 'Keeps dev.factiii.com and *.dev.factiii.com A records on the home IP',
    program: ['/bin/sh', '{servers}/ddns/cloudflare-ddns.sh'],
    run: { kind: 'interval', seconds: 300 },
    credentials: [
      {
        name: 'CF_DNS_TOKEN',
        what: 'Cloudflare API token, Zone:DNS:Edit on factiii.com',
        today: '~/.config/factiii/cloudflare-ddns.env (with CF_ZONE_ID, CF_RECORDS)'
      }
    ],
    replaces: 'com.factiii.cloudflare-ddns',
    notes: 'The script reads $HOME/.config/factiii/cloudflare-ddns.env; HOME is the ops home.'
  },
  {
    id: 'cert-renew',
    description: 'Renews the *.dev.factiii.com wildcard (DNS-01) weekly and reloads nginx',
    program: ['/bin/bash', '{servers}/dev-tunnel/renew-cert.sh'],
    run: { kind: 'calendar', weekday: 1, hour: 4, minute: 17 },
    credentials: [
      {
        name: 'cloudflare-dns.ini',
        what: 'Cloudflare API token for certbot dns-cloudflare',
        today: '~/factiii-dev-tunnel/cloudflare-dns.ini'
      },
      {
        name: 'letsencrypt/accounts',
        what: "Let's Encrypt account key",
        today: '~/factiii-dev-tunnel/letsencrypt'
      }
    ],
    replaces: 'com.factiii.cert-renew',
    notes:
      'Today runs certbot with `docker run` in Colima `default`, the dev VM, which must not hold the token. Run certbot natively (pipx certbot certbot-dns-cloudflare) and reload with the same nginx -c.'
  },
  {
    id: 'analytics',
    description: 'Boots Colima profile "analytics" (Umami 3.4.1 + Postgres 17 on 127.0.0.1:3110)',
    program: ['/bin/sh', '{servers}/analytics/start.sh'],
    run: { kind: 'at-load' },
    env: { COLIMA_HOME: '{home}/.colima' },
    credentials: [
      {
        name: '/opt/umami/.env (in the VM)',
        what: 'Umami APP_SECRET and the Postgres password',
        today: 'inside the normal user\'s Colima "analytics" VM'
      },
      {
        name: '/opt/umami/admin-password (in the VM)',
        what: 'Umami admin password',
        today: 'inside the same VM'
      }
    ],
    replaces: 'com.factiii.analytics',
    notes:
      "A Colima VM belongs to its user: the ops user gets its own, provisioned like the old one and restored from the last dump. Verify Virtualization.framework from a LaunchDaemon first."
  },
  {
    id: 'analytics-backup',
    description: 'Nightly pg_dump of Umami over colima ssh, 14 days kept',
    program: ['/bin/sh', '{servers}/analytics/backup.sh'],
    run: { kind: 'calendar', hour: 3, minute: 30 },
    env: { COLIMA_HOME: '{home}/.colima' },
    credentials: [
      {
        name: 'the analytics VM ssh key',
        what: "Colima's own key for the VM (ops' Colima home)",
        today: "the normal user's ~/.colima/_lima"
      }
    ],
    replaces: 'com.factiii.analytics-backup',
    notes: 'The dumps hold visitor data: they stay in the ops home.'
  }
];

/** Why these stay with the normal user (spec, "Servers registry"). */
export const NORMAL_USER_SERVICES: readonly { name: string; why: string }[] = [
  { name: 'Ollama', why: "the AI's local model server: no credential, serves the sessions, wants the GPU and a large model cache" },
  { name: 'Tailscale', why: 'a system network extension, already machine-wide; moving it changes nothing' },
  { name: 'per-board Valkey', why: 'session state for terminals and boards, no prod data' },
  { name: 'frpc', why: 'previews of dev servers that run in the normal user; the access token comes per tunnel from tunnel-token' }
];

export function serverLabel(id: string): string {
  return `com.factiii.ops.${id}`;
}

const fill = (text: string, opsHome: string) =>
  text.replaceAll('{servers}', path.join(opsHome, 'servers')).replaceAll('{home}', opsHome);

const xml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The env every ops process gets. No secret: those are files. */
export function opsEnv(opsHome: string): Record<string, string> {
  return {
    HOME: opsHome,
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    // Jobs run under $SHELL -lc (execLogin); the account's own shell is
    // /usr/bin/false.
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8'
  };
}

/** A LaunchDaemon plist for `/Library/LaunchDaemons`, run as factiii-ops. */
export function renderLaunchDaemon(opts: {
  label: string;
  program: string[];
  run: ServerRun;
  opsHome: string;
  log: string;
  workingDir?: string;
  env?: Record<string, string>;
  group?: string;
  /** Children outlive the job: the update helper (updater.ts) restarts the
   *  service it was started from and must see the restart through. */
  abandonProcessGroup?: boolean;
}): string {
  const env = { ...opsEnv(opts.opsHome), ...(opts.env ?? {}) };
  const dict = (entries: [string, string][]) =>
    entries.map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(fill(v, opts.opsHome))}</string>`).join('\n');
  const run = (() => {
    switch (opts.run.kind) {
      case 'keep-alive':
        return '  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>10</integer>';
      case 'at-load':
        return '  <key>RunAtLoad</key><true/>';
      case 'interval':
        return `  <key>RunAtLoad</key><true/>\n  <key>StartInterval</key><integer>${opts.run.seconds}</integer>`;
      case 'calendar': {
        const parts: [string, number][] = [
          ...(opts.run.weekday === undefined ? [] : [['Weekday', opts.run.weekday] as [string, number]]),
          ['Hour', opts.run.hour],
          ['Minute', opts.run.minute]
        ];
        return `  <key>StartCalendarInterval</key>\n  <dict>\n${parts
          .map(([k, v]) => `    <key>${k}</key><integer>${v}</integer>`)
          .join('\n')}\n  </dict>`;
      }
    }
  })();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by factiii-runner ops plists (.specs/ops-user.md). -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(opts.label)}</string>
  <key>UserName</key><string>${OPS_USER}</string>
  <key>GroupName</key><string>${xml(opts.group ?? OPS_USER)}</string>
  <key>ProgramArguments</key>
  <array>
${opts.program.map((a) => `    <string>${xml(fill(a, opts.opsHome))}</string>`).join('\n')}
  </array>
${opts.workingDir ? `  <key>WorkingDirectory</key><string>${xml(fill(opts.workingDir, opts.opsHome))}</string>\n` : ''}  <key>EnvironmentVariables</key>
  <dict>
${dict(Object.entries(env))}
  </dict>
  <key>Umask</key><integer>63</integer>
${opts.abandonProcessGroup ? '  <key>AbandonProcessGroup</key><true/>\n' : ''}${run}
  <key>StandardOutPath</key><string>${xml(fill(opts.log, opts.opsHome))}</string>
  <key>StandardErrorPath</key><string>${xml(fill(opts.log, opts.opsHome))}</string>
</dict>
</plist>
`;
}

/** A systemd unit for the same server on a Linux host. Interval and
 *  calendar runs also need a .timer; only the service is rendered. */
export function renderSystemdUnit(server: MachineServer, opsHome: string): string {
  const env = { ...opsEnv(opsHome), ...(server.env ?? {}) };
  const quote = (a: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, '\\$1')}"`);
  return `# Written by factiii-runner ops plists (.specs/ops-user.md).
[Unit]
Description=Factiii ${server.description}
After=network-online.target

[Service]
User=${OPS_USER}
Group=${OPS_USER}
ExecStart=${server.program.map((a) => quote(fill(a, opsHome))).join(' ')}
${server.workingDir ? `WorkingDirectory=${fill(server.workingDir, opsHome)}\n` : ''}${Object.entries(env)
    .map(([k, v]) => `Environment=${quote(`${k}=${fill(v, opsHome)}`)}`)
    .join('\n')}
${server.run.kind === 'keep-alive' ? 'Restart=always\nRestartSec=10' : 'Type=oneshot'}
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${opsHome}

[Install]
WantedBy=multi-user.target
`;
}

/** Every server's LaunchDaemon, by file name. */
export function serverPlists(opsHome: string): { file: string; content: string }[] {
  return MACHINE_SERVERS.map((server) => ({
    file: `${serverLabel(server.id)}.plist`,
    content: renderLaunchDaemon({
      label: serverLabel(server.id),
      program: server.program,
      run: server.run,
      opsHome,
      log: `{home}/logs/${server.id}.log`,
      workingDir: server.workingDir,
      env: server.env
    })
  }));
}

/** The ops service itself: `factiii-runner ops serve`, group factiii so the
 *  socket it makes is the group's. */
export function opsServicePlist(opts: {
  opsHome: string;
  program: string[];
  /** ELECTRON_RUN_AS_NODE=1 and FACTIII_OPS_APP when the program is
   *  Factiii.app's own Electron (Factiii Desktop's setup). */
  env?: Record<string, string>;
}): string {
  return renderLaunchDaemon({
    label: OPS_SERVICE_LABEL,
    program: opts.program,
    run: { kind: 'keep-alive' },
    opsHome: opts.opsHome,
    log: '{home}/logs/ops.log',
    workingDir: opts.opsHome,
    group: OPS_GROUP,
    env: opts.env,
    abandonProcessGroup: true
  });
}

export const OPS_SERVICE_LABEL = 'com.factiii.ops';
