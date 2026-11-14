import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkRoom,
  CPU_CRITICAL_LOAD,
  CPU_WARN_LOAD,
  cpuHealth,
  cpuLevel,
  darwinMemoryPressure,
  darwinPressureLevel,
  DISK_CRITICAL_GB,
  DISK_WARN_GB,
  diskLevel,
  type HealthIo,
  MAX_MEMORY_TOP,
  MAX_SERVICES,
  meminfoLevel,
  meminfoPressure,
  meminfoUse,
  memoryConsumers,
  memoryKind,
  commandLabel,
  containerEngine,
  embedderHealth,
  engineDownRow,
  isEmbedderScript,
  mergeServices,
  nameListeners,
  parseDockerPs,
  parseLaunchctlList,
  plistProgram,
  parseLsofListen,
  parsePm2Jlist,
  parsePsCommands,
  sentService,
  since,
  processLevel,
  readHealth,
  vmStatUse
} from './machineHealth';

// Machine health against made-up disks and memory. Nothing here reads the
// real machine.

const GIB = 1024 ** 3;

describe('machine health', () => {
  it('warns before it is critical', () => {
    assert.ok(DISK_WARN_GB > DISK_CRITICAL_GB);
    assert.equal(diskLevel(DISK_WARN_GB + 1), 'ok');
    assert.equal(diskLevel(DISK_WARN_GB - 1), 'warn');
    assert.equal(diskLevel(DISK_CRITICAL_GB - 1), 'critical');
  });

  it('reads macOS and Linux memory pressure', () => {
    assert.equal(darwinPressureLevel('1\n'), 'ok');
    assert.equal(darwinPressureLevel('2\n'), 'warn');
    assert.equal(darwinPressureLevel('4\n'), 'critical');
    assert.equal(darwinPressureLevel(''), null);
    const meminfo = (available: number) =>
      `MemTotal:       1000000 kB\nMemFree:  1 kB\nMemAvailable:   ${available} kB\n`;
    assert.equal(meminfoLevel(meminfo(500000)), 'ok');
    assert.equal(meminfoLevel(meminfo(100000)), 'warn');
    assert.equal(meminfoLevel(meminfo(10000)), 'critical');
    assert.equal(meminfoLevel('nothing here'), null);
  });

  it('reads memory pressure as a share in use, for the chart', () => {
    // kern.memorystatus_level is the share free.
    assert.equal(darwinMemoryPressure('70\n'), 30);
    assert.equal(darwinMemoryPressure(''), null);
    assert.equal(darwinMemoryPressure('140'), null);
    const meminfo = `MemTotal:       1000000 kB\nMemAvailable:   250000 kB\n`;
    assert.equal(meminfoPressure(meminfo), 75);
    assert.equal(meminfoPressure('nothing here'), null);
  });

  it('names each disk once with what it holds, and takes the worst level', async () => {
    const free: Record<string, number> = { '/runner': 12, '/runner/parts/vault': 12, '/ollama': 300 };
    const io: HealthIo = {
      folders: [
        { use: 'Runner folder', dir: '/runner' },
        { use: 'Vault', dir: '/runner/parts/vault' },
        { use: 'Ollama models', dir: '/ollama' }
      ],
      disk: (dir) => ({
        id: dir.startsWith('/runner') ? 1 : 2,
        freeBytes: free[dir] * GIB,
        totalBytes: 500 * GIB
      }),
      memory: async () => 'ok',
      processes: async () => ({ used: 300, max: 2666 })
    };
    const health = await readHealth(io);
    assert.equal(health.level, 'warn');
    assert.deepEqual(health.disks, [
      { uses: ['Runner folder', 'Vault'], freeGb: 12, totalGb: 500, level: 'warn' },
      { uses: ['Ollama models'], freeGb: 300, totalGb: 500, level: 'ok' }
    ]);
    const pressed = await readHealth({ ...io, disk: () => null, memory: async () => 'critical' });
    assert.equal(pressed.level, 'critical');
    assert.deepEqual(pressed.disks, []);
  });

  it('warns as the process count nears the per-user limit', async () => {
    assert.equal(processLevel(2000, 2666), 'ok');
    assert.equal(processLevel(2200, 2666), 'warn');
    assert.equal(processLevel(2600, 2666), 'critical');
    const io: HealthIo = {
      folders: [],
      disk: () => null,
      memory: async () => 'ok',
      processes: async () => ({ used: 2200, max: 2666 })
    };
    const health = await readHealth(io);
    assert.equal(health.level, 'warn');
    assert.deepEqual(health.processes, { used: 2200, max: 2666, level: 'warn' });
    const unread = await readHealth({ ...io, processes: async () => null });
    assert.equal(unread.processes, null);
    assert.equal(unread.level, 'ok');
  });
});

describe('what the Status tab shows', () => {
  it('rates CPU load per core and leaves it out of the level', async () => {
    assert.ok(CPU_CRITICAL_LOAD > CPU_WARN_LOAD);
    assert.equal(cpuLevel(0.5), 'ok');
    assert.equal(cpuLevel(CPU_WARN_LOAD), 'warn');
    assert.equal(cpuLevel(CPU_CRITICAL_LOAD), 'critical');
    assert.deepEqual(cpuHealth(10, 3), { load: 3.33, cores: 3, level: 'critical' });
    assert.equal(cpuHealth(1, 0), null);
    const health = await readHealth({
      folders: [],
      disk: () => null,
      memory: async () => 'ok',
      processes: async () => null,
      cpu: () => ({ load1: 32, cores: 8 })
    });
    assert.deepEqual(health.cpu, { load: 4, cores: 8, level: 'critical' });
    assert.equal(health.level, 'ok');
  });

  it('reads memory in use from vm_stat and /proc/meminfo', () => {
    const vmStat = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                   264981.',
      'Pages active:                                 131072.',
      'Pages inactive:                               197910.',
      'Pages wired down:                              65536.',
      'Pages stored in compressor:                   574895.',
      'Pages occupied by compressor:                  65536.'
    ].join('\n');
    // (131072 + 65536 + 65536) pages of 16 KiB = 4 GiB.
    assert.deepEqual(vmStatUse(vmStat, 16 * GIB), { usedGb: 4, totalGb: 16 });
    assert.equal(vmStatUse('no header', 16 * GIB), null);
    const meminfo = 'MemTotal:       16777216 kB\nMemFree:  1 kB\nMemAvailable:   12582912 kB\n';
    assert.deepEqual(meminfoUse(meminfo), { usedGb: 4, totalGb: 16 });
    assert.equal(meminfoUse('nothing here'), null);
  });

  it('reads docker ps json lines, with host ports only', () => {
    const output = [
      JSON.stringify({
        Names: 'factiii_postgres',
        Image: 'pgvector/pgvector:pg16',
        State: 'running',
        Status: 'Up 2 days',
        Ports: '0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp'
      }),
      JSON.stringify({
        Names: 'factiii-staging',
        Image: 'factiii:staging',
        State: 'exited',
        Status: 'Exited (0) 3 hours ago',
        Ports: '5001/tcp'
      }),
      JSON.stringify({
        Names: 'range',
        Image: 'x',
        State: 'running',
        Status: 'Up',
        Ports: '127.0.0.1:8001-8002->8001-8002/tcp, 0.0.0.0:53->53/udp'
      }),
      'Cannot connect to the Docker daemon. Is the docker daemon running?'
    ].join('\n');
    assert.deepEqual(parseDockerPs(output), [
      {
        kind: 'docker',
        name: 'factiii_postgres',
        detail: 'pgvector/pgvector:pg16 · Up 2 days',
        running: true,
        ports: [5432]
      },
      {
        kind: 'docker',
        name: 'factiii-staging',
        detail: 'factiii:staging · Exited (0) 3 hours ago',
        running: false,
        ports: []
      },
      { kind: 'docker', name: 'range', detail: 'x · Up', running: true, ports: [8001, 8002] }
    ]);
    assert.deepEqual(parseDockerPs('Cannot connect to the Docker daemon.'), []);
  });

  it('reads lsof -F listeners, one row per process, without Docker', () => {
    const output = [
      'p1085',
      'cnode',
      'f20',
      'n*:3000',
      'f21',
      'n127.0.0.1:9229',
      'f22',
      'n[::]:3000',
      'p2000',
      'credis-server',
      'f6',
      'n127.0.0.1:6379',
      'p2001',
      'cnode',
      'f7',
      'n[::1]:5173',
      'p300',
      'ccom.docker.backend',
      'f9',
      'n*:5432',
      'p301',
      'cOrbStack Helper',
      'f9',
      'n*:6379'
    ].join('\n');
    assert.deepEqual(parseLsofListen(output), [
      { kind: 'port', name: 'node', detail: '*:3000', running: true, ports: [3000, 9229], pid: 1085 },
      {
        kind: 'port',
        name: 'redis-server',
        detail: '127.0.0.1:6379',
        running: true,
        ports: [6379],
        pid: 2000
      },
      { kind: 'port', name: 'node', detail: '[::1]:5173', running: true, ports: [5173], pid: 2001 }
    ]);
    assert.deepEqual(parseLsofListen(''), []);
  });

  it('reads pm2 jlist: state, uptime, restarts, and what is wrong', () => {
    const now = Date.UTC(2026, 9, 24);
    const output = `>>>> In-memory PM2 is out-of-date\n${JSON.stringify([
      {
        name: 'embedder',
        pid: 1008,
        pm2_env: {
          status: 'online',
          restart_time: 0,
          unstable_restarts: 0,
          pm_uptime: now - 8 * 24 * 3600_000,
          pm_exec_path: '/Users/jon/factiii/services/embedder/start.sh'
        }
      },
      { name: 'tunnel', pid: 0, pm2_env: { status: 'errored', restart_time: 15 } },
      { name: 'old', pid: 0, pm2_env: { status: 'stopped', restart_time: 1 } },
      { name: 'flappy', pid: 7, pm2_env: { status: 'online', restart_time: 4, unstable_restarts: 2, pm_uptime: now - 120_000 } },
      { pid: 9 }
    ])}`;
    assert.deepEqual(parsePm2Jlist(output, now), [
      {
        kind: 'pm2',
        name: 'embedder',
        detail: 'online · up 8 days · 0 restarts',
        running: true,
        ports: [],
        pid: 1008,
        script: '/Users/jon/factiii/services/embedder/start.sh'
      },
      { kind: 'pm2', name: 'tunnel', detail: 'errored · 15 restarts', running: false, ports: [], level: 'critical' },
      { kind: 'pm2', name: 'old', detail: 'stopped · 1 restart', running: false, ports: [], level: 'warn' },
      {
        kind: 'pm2',
        name: 'flappy',
        detail: 'online · up 2 min · 4 restarts',
        running: true,
        ports: [],
        level: 'warn',
        pid: 7
      }
    ]);
    assert.deepEqual(parsePm2Jlist('[PM2] Spawning PM2 daemon', now), []);
    assert.deepEqual(parsePm2Jlist('[]\n[PM2] Spawning PM2 daemon', now), []);
    const afterNotice = `[PM2] Spawning PM2 daemon\n${JSON.stringify([{ name: 'a', pm2_env: { status: 'online' } }])}`;
    assert.equal(parsePm2Jlist(afterNotice, now).length, 1);
    assert.deepEqual(parsePm2Jlist('zsh: command not found: pm2', now), []);
  });

  it('reads launchctl list for the user’s own agents', () => {
    const output = [
      'PID\tStatus\tLabel',
      '890\t0\tcom.factiii.tunnel-staging',
      '-\t0\tcom.factiii.cert-renew',
      '-\t78\tcom.factiii.cloudflare-ddns',
      '123\t0\tcom.apple.something'
    ].join('\n');
    assert.deepEqual(
      parseLaunchctlList(output, [
        'com.factiii.cert-renew',
        'com.factiii.cloudflare-ddns',
        'com.factiii.gone',
        'com.factiii.tunnel-staging'
      ]),
      [
        { kind: 'launchd', name: 'com.factiii.cert-renew', detail: 'not running · last exit 0', running: false, ports: [] },
        {
          kind: 'launchd',
          name: 'com.factiii.cloudflare-ddns',
          detail: 'not running · last exit 78',
          running: false,
          ports: [],
          level: 'warn'
        },
        { kind: 'launchd', name: 'com.factiii.gone', detail: 'not loaded', running: false, ports: [] },
        { kind: 'launchd', name: 'com.factiii.tunnel-staging', detail: 'running', running: true, ports: [], pid: 890 }
      ]
    );
  });

  it('folds a listener into the pm2 or launchd row that runs it', () => {
    const merged = mergeServices([
      { kind: 'pm2', name: 'embedder', detail: 'online', running: true, ports: [], pid: 1008 },
      { kind: 'launchd', name: 'com.factiii.tunnel-staging', detail: 'running', running: true, ports: [], pid: 890 },
      { kind: 'port', name: 'Python', detail: '127.0.0.1:8000', running: true, ports: [8000], pid: 1008 },
      { kind: 'port', name: 'cloudflared', detail: '127.0.0.1:20241', running: true, ports: [20241], pid: 890 },
      { kind: 'port', name: 'node', detail: '*:3000', running: true, ports: [3000], pid: 5 }
    ]).map(sentService);
    assert.deepEqual(merged, [
      { kind: 'pm2', name: 'embedder', detail: 'online', running: true, ports: [8000] },
      { kind: 'launchd', name: 'com.factiii.tunnel-staging', detail: 'running', running: true, ports: [20241] },
      { kind: 'port', name: 'node', detail: '*:3000', running: true, ports: [3000] }
    ]);
  });

  it('names a listener by what it runs', () => {
    const commands = parsePsCommands(
      [
        ' 1085 /usr/local/bin/node /Users/jon/.npm-global/lib/node_modules/@factiii/runner/index/index.js',
        '28535 node /w/link3d/node_modules/.bin/react-native start --port 51787',
        '27970 /bin/node --require /w/node_modules/tsx/dist/preflight.cjs --import file:///w/tsx/loader.mjs /w/apps/server/src/index.ts',
        '42155 verdaccio   '
      ].join('\n')
    );
    assert.equal(commandLabel(commands.get(1085) ?? ''), '@factiii/runner index/index.js');
    assert.equal(commandLabel(commands.get(28535) ?? ''), 'react-native start');
    assert.equal(commandLabel(commands.get(27970) ?? ''), 'server/src/index.ts');
    assert.equal(commandLabel(commands.get(42155) ?? ''), null);
    assert.equal(
      commandLabel(
        '/opt/homebrew/opt/openjdk@17/bin/java -Xmx2g -cp /Users/jon/.gradle/wrapper/dists/gradle-8.10/lib/gradle-launcher-8.10.jar -Dfile.encoding=UTF-8 org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10'
      ),
      'GradleDaemon'
    );
    assert.deepEqual(
      nameListeners(
        [
          { kind: 'port', name: 'node', detail: '*:1', running: true, ports: [1], pid: 1085 },
          { kind: 'port', name: 'verdaccio', detail: '*:2', running: true, ports: [2], pid: 42155 }
        ],
        commands
      ).map((r) => r.name),
      ['@factiii/runner index/index.js', 'verdaccio']
    );
  });

  it('names the container engine and says when it is down', () => {
    assert.equal(containerEngine('orbstack\n'), 'OrbStack');
    assert.equal(containerEngine('colima'), 'Colima');
    assert.equal(containerEngine('desktop-linux'), 'Docker');
    assert.equal(containerEngine(''), 'Docker');
    const down = {
      code: 1,
      output:
        'failed to connect to the docker API at unix:///Users/jon/.orbstack/run/docker.sock'
    };
    assert.deepEqual(engineDownRow(down, 'OrbStack'), {
      kind: 'docker',
      name: 'OrbStack',
      detail: 'not running: its containers are down',
      running: false,
      ports: [],
      level: 'warn'
    });
    // Up, or no docker CLI at all (ENOENT: no output): no row.
    assert.equal(engineDownRow({ code: 0, output: '' }, 'OrbStack'), null);
    assert.equal(engineDownRow({ code: 1, output: '' }, 'Docker'), null);
  });

  it('reads the embedder’s health', () => {
    assert.deepEqual(embedderHealth({ model_loaded: true, compute: 'ne' }), {
      health: 'Model loaded · Neural Engine'
    });
    assert.deepEqual(embedderHealth({ model_loaded: false }), {
      health: 'Model not loaded',
      level: 'critical'
    });
    assert.deepEqual(embedderHealth(null), { health: 'Model not loaded', level: 'critical' });
    assert.equal(isEmbedderScript('/Users/jon/factiii/services/embedder/start.sh'), true);
    assert.equal(isEmbedderScript('/usr/bin/node'), false);
    assert.equal(since(30_000), '1 min');
    assert.equal(since(3 * 3600_000), '3 h');
    assert.equal(since(24 * 3600_000), '1 day');
  });

  it('knows the embedder a launch agent runs, or a listener’s command', () => {
    const plist = `<?xml version="1.0"?><plist><dict>
      <key>Label</key><string>com.factiii.embedder</string>
      <key>ProgramArguments</key>
      <array>
        <string>/bin/bash</string>
        <string>/Users/jon/factiii-embedder/services/embedder/start.sh</string>
      </array>
    </dict></plist>`;
    const program = plistProgram(plist);
    assert.equal(program, '/bin/bash /Users/jon/factiii-embedder/services/embedder/start.sh');
    assert.equal(isEmbedderScript(program), true);
    assert.equal(
      plistProgram('<dict><key>Program</key><string>/opt/homebrew/bin/nginx</string></dict>'),
      '/opt/homebrew/bin/nginx'
    );
    assert.equal(plistProgram('bplist00'), undefined);

    const [row] = parseLaunchctlList(
      '412\t0\tcom.factiii.embedder',
      ['com.factiii.embedder'],
      new Map([['com.factiii.embedder', program ?? '']])
    );
    assert.equal(row.script, program);
    assert.equal(row.pid, 412);

    const [listener] = nameListeners(
      [{ kind: 'port', name: 'Python', detail: '*:8000', running: true, ports: [8000], pid: 9 }],
      new Map([[9, '/Users/jon/factiii-embedder/services/embedder/.venv/bin/python serve.py']])
    );
    assert.equal(isEmbedderScript(listener.script), true);
  });

  it('caps the services and reads none from an older io', async () => {
    const io: HealthIo = {
      folders: [],
      disk: () => null,
      memory: async () => 'ok',
      processes: async () => null
    };
    const bare = await readHealth(io);
    assert.equal(bare.cpu, null);
    assert.equal(bare.memoryUse, null);
    assert.deepEqual(bare.services, []);
    const many = await readHealth({
      ...io,
      services: async () =>
        Array.from({ length: 50 }, (_, i) => ({
          kind: 'port' as const,
          name: `s${i}`,
          detail: '',
          running: true,
          ports: []
        }))
    });
    assert.equal(many.services?.length, MAX_SERVICES);
  });
});

describe('top memory consumers', () => {
  const MB = 1024;
  it('names what a process is, with the safe stop where there is one', () => {
    assert.deepEqual(
      memoryKind(
        '/Users/jon/Library/Developer/CoreSimulator/Devices/58D5/data/Containers/Bundle/Application/603A/Factiii.app/Factiii'
      ),
      { label: 'iOS Simulator', stop: 'simulators' }
    );
    assert.equal(memoryKind('claude --permission-mode auto --resume 25e7').label, 'Claude Code');
    assert.match(memoryKind('/Users/jon/.local/bin/claude').hint ?? '', /Running now/);
    assert.equal(memoryKind('next-server (v16.4.3)').label, 'Dev servers');
    assert.equal(
      memoryKind('node /w/node_modules/.bin/expo start --port 63751').label,
      'Dev servers'
    );
    assert.equal(memoryKind('node --env-file=../../.env --import tsx src/app.ts').label, 'Dev servers');
    assert.equal(
      memoryKind('node /opt/homebrew/lib/node_modules/@factiii/runner/dist/index.js').label,
      'Factiii runner'
    );
    assert.equal(
      memoryKind('/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer).app/Contents/MacOS/x')
        .label,
      'Chrome'
    );
    // The desktop app is not the CLI.
    assert.equal(memoryKind('/Applications/Claude.app/Contents/MacOS/Claude').label, 'Claude');
    assert.equal(
      memoryKind('/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon').label,
      'WindowServer'
    );
  });

  it('groups ps by kind, biggest first, and leaves out the small', () => {
    const ps = [
      ` ${3000 * MB} next-server (v16.4.3)`,
      ` ${1000 * MB} node /w/node_modules/.bin/expo start`,
      ` ${700 * MB} claude --resume a`,
      ` ${400 * MB} claude`,
      ` ${1300 * MB} /Users/jon/Library/Developer/CoreSimulator/Devices/1/data/App`,
      `  ${10 * MB} /usr/sbin/tiny`,
      '      0 [kthreadd]',
      'garbage'
    ].join('\n');
    assert.deepEqual(memoryConsumers(ps), [
      { label: 'Dev servers', bytes: 4000 * MB * 1024, count: 2, hint: memoryKind('next-server').hint },
      { label: 'iOS Simulator', bytes: 1300 * MB * 1024, count: 1, stop: 'simulators' },
      { label: 'Claude Code', bytes: 1100 * MB * 1024, count: 2, hint: memoryKind('claude').hint }
    ]);
    const many = Array.from({ length: 20 }, (_, i) => ` ${(100 + i) * MB} /bin/app${i}`).join('\n');
    assert.equal(memoryConsumers(many).length, MAX_MEMORY_TOP);
  });

  it('reads the top and the pressure only where the io has them', async () => {
    const io: HealthIo = {
      folders: [],
      disk: () => null,
      memory: async () => 'ok',
      processes: async () => null
    };
    const bare = await readHealth(io);
    assert.equal(bare.memoryPressure, null);
    assert.equal('memoryTop' in bare, false);
    const full = await readHealth({
      ...io,
      memoryPressure: async () => 42,
      memoryTop: async () => [{ label: 'Claude Code', bytes: 1, count: 1 }]
    });
    assert.equal(full.memoryPressure, 42);
    assert.deepEqual(full.memoryTop, [{ label: 'Claude Code', bytes: 1, count: 1 }]);
  });
});

describe('room before an action', () => {
  it('refuses what would leave the disk critical, and warns when it leaves it low', () => {
    const refused = checkRoom(10, 6, 'Llama 3.1 8B');
    assert.match(refused.refuse ?? '', /^Llama 3\.1 8B needs about 6 GB; 10 GB is free\. That would leave under 5 GB/);
    assert.equal(refused.warn, null);
    const low = checkRoom(30, 15, 'Vault search');
    assert.equal(low.refuse, null);
    assert.equal(low.warn, 'Vault search needs about 15 GB; 30 GB is free. Disk space will be low after it.');
    assert.deepEqual(checkRoom(200, 1, 'Claude'), { refuse: null, warn: null });
  });
});
