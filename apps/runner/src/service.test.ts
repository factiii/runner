import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { supervisorExitCode } from './selfUpdate';
import {
  installService,
  parseLaunchctlPrint,
  parseSchtasksCsv,
  parseSystemctlShow,
  removeService,
  renderLaunchAgent,
  renderService,
  renderSystemdUnit,
  renderWindowsLauncher,
  renderWindowsTask,
  resolveProgram,
  runnerPids,
  SERVICE_MARKER,
  serviceFiles,
  type ServiceIo,
  serviceName,
  servicePath,
  type ServiceSpec,
  serviceStatus
} from './service';

// Nothing here reaches launchd, systemd or the Task Scheduler: the files are
// rendered to strings, and the commands go to a fake that records them.

const NVM_NODE = '/Users/jo/.nvm/versions/node/v24.11.1/bin/node';
const NVM_ENTRY =
  '/Users/jo/.nvm/versions/node/v24.11.1/lib/node_modules/@factiii/runner/bin/factiii-runner.js';

const mac: ServiceSpec = {
  platform: 'darwin',
  home: '/Users/jo',
  user: 'jo',
  uid: 501,
  node: NVM_NODE,
  entry: NVM_ENTRY,
  runnerDir: '/Users/jo/.factiii-runner',
  customDir: false,
  path: '/Users/jo/.nvm/versions/node/v24.11.1/bin:/opt/homebrew/bin:/usr/bin:/bin',
  shell: '/bin/zsh',
  lang: 'en_US.UTF-8'
};

const linux: ServiceSpec = {
  ...mac,
  platform: 'linux',
  home: '/home/jo',
  uid: 1000,
  node: '/usr/bin/node',
  entry: '/usr/lib/node_modules/@factiii/runner/bin/factiii-runner.js',
  runnerDir: '/home/jo/.factiii-runner',
  path: '/usr/bin:/bin',
  shell: '/bin/bash'
};

const windows: ServiceSpec = {
  platform: 'win32',
  home: 'C:\\Users\\Jo Smith',
  user: 'DESK\\Jo Smith',
  uid: -1,
  node: 'C:\\Program Files\\nodejs\\node.exe',
  entry:
    'C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\node_modules\\@factiii\\runner\\bin\\factiii-runner.js',
  runnerDir: 'C:\\Users\\Jo Smith\\.factiii-runner',
  customDir: false,
  path: ''
};

type Call = [string, ...string[]];

/** A machine made of a file map and canned command answers. */
function fakeIo(
  files: Record<string, string> = {},
  answer: (bin: string, args: string[]) => { code: number; output: string } = () => ({
    code: 1,
    output: ''
  })
) {
  const calls: Call[] = [];
  const io: ServiceIo = {
    async run(bin, args) {
      calls.push([bin, ...args]);
      return answer(bin, args);
    },
    read: (file) => files[file] ?? null,
    write(file, content) {
      files[file] = content;
    },
    remove(file) {
      delete files[file];
    }
  };
  const ran = (word: string) => calls.filter((call) => call.includes(word));
  return { io, files, calls, ran };
}

/** launchd that knows the job once `bootstrap` ran and until `bootout`. */
function fakeLaunchd(loadedAtStart: boolean, processList = '') {
  let loaded = loadedAtStart;
  return (bin: string, args: string[]) => {
    if (bin === 'ps') return { code: 0, output: processList };
    if (args[0] === 'bootstrap') loaded = true;
    if (args[0] === 'bootout') loaded = false;
    if (args[0] === 'print') {
      return loaded
        ? { code: 0, output: '\tstate = running\n\tpid = 4242\n' }
        : { code: 113, output: 'Could not find service' };
    }
    return { code: 0, output: '' };
  };
}

const opts = { invoked: '/opt/homebrew/bin/factiii-runner', selfPid: 1 };

describe('resolveProgram', () => {
  it('keeps the Homebrew bin path, which survives a brew upgrade', () => {
    const links: Record<string, string> = {
      '/opt/homebrew/bin/node': '/opt/homebrew/Cellar/node/24.1.0/bin/node',
      '/opt/homebrew/bin/factiii-runner':
        '/opt/homebrew/lib/node_modules/@factiii/runner/bin/factiii-runner.js'
    };
    assert.deepEqual(
      resolveProgram({
        execPath: '/opt/homebrew/Cellar/node/24.1.0/bin/node',
        invoked: '/opt/homebrew/bin/factiii-runner',
        platform: 'darwin',
        realpath: (file) => links[file] ?? null
      }),
      {
        node: '/opt/homebrew/bin/node',
        entry: '/opt/homebrew/lib/node_modules/@factiii/runner/bin/factiii-runner.js'
      }
    );
  });

  it('resolves an nvm install to its own versioned node and package', () => {
    const invoked = '/Users/jo/.nvm/versions/node/v24.11.1/bin/factiii-runner';
    const links: Record<string, string> = {
      [NVM_NODE]: NVM_NODE,
      [invoked]: NVM_ENTRY
    };
    assert.deepEqual(
      resolveProgram({
        execPath: NVM_NODE,
        invoked,
        platform: 'darwin',
        realpath: (file) => links[file] ?? null
      }),
      { node: NVM_NODE, entry: NVM_ENTRY }
    );
  });

  it('uses the running node when the one beside the command is another', () => {
    assert.equal(
      resolveProgram({
        execPath: '/usr/local/bin/node',
        invoked: '/home/jo/bin/factiii-runner',
        platform: 'linux',
        realpath: (file) => (file.endsWith('/node') ? '/snap/node' : null)
      }).node,
      '/usr/local/bin/node'
    );
  });
});

describe('servicePath', () => {
  it("puts this node's dir first and drops repeats", () => {
    assert.equal(
      servicePath(NVM_NODE, '/opt/homebrew/bin:/usr/bin::/opt/homebrew/bin', 'darwin', undefined, []),
      '/Users/jo/.nvm/versions/node/v24.11.1/bin:/opt/homebrew/bin:/usr/bin'
    );
  });

  // mac-mini-m6, 2026-10-25: installed from a terminal whose PATH had no
  // Homebrew, so neither did the service, and redis-cli read as missing.
  it('adds Homebrew’s dirs behind a PATH that lacks them', () => {
    assert.equal(
      servicePath('/usr/bin/node', '/usr/bin:/bin', 'darwin'),
      '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin'
    );
  });

  it('keeps the dir of the runner command, as for ~/.npm-global', () => {
    assert.equal(
      servicePath(
        NVM_NODE,
        '/usr/bin',
        'darwin',
        '/Users/jo/.npm-global/bin/factiii-runner',
        ['/Applications/Factiii.app/tools', '/opt/homebrew/bin']
      ),
      '/Users/jo/.nvm/versions/node/v24.11.1/bin:/Users/jo/.npm-global/bin:/usr/bin:/Applications/Factiii.app/tools:/opt/homebrew/bin'
    );
  });

  it('adds no Unix dirs on Windows', () => {
    assert.equal(
      servicePath('C:\\node\\node.exe', 'C:\\Windows', 'win32'),
      'C:\\node;C:\\Windows'
    );
  });
});

describe('renderLaunchAgent', () => {
  const plist = renderLaunchAgent(mac);

  it('runs the installed node and script with `start`', () => {
    assert.match(plist, /<key>Label<\/key><string>com\.factiii\.runner<\/string>/);
    assert.ok(
      plist.includes(
        `<array>\n    <string>${NVM_NODE}</string>\n    <string>${NVM_ENTRY}</string>\n    <string>start</string>\n  </array>`
      )
    );
  });

  it('starts at login and restarts only after a failure', () => {
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(
      plist,
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>\s*<\/dict>/
    );
  });

  it('carries PATH, SHELL and LANG, and logs to the runner folder', () => {
    assert.ok(plist.includes(`<key>PATH</key><string>${mac.path}</string>`));
    assert.ok(plist.includes('<key>SHELL</key><string>/bin/zsh</string>'));
    assert.ok(plist.includes('<key>LANG</key><string>en_US.UTF-8</string>'));
    const log = '/Users/jo/.factiii-runner/logs/runner.log';
    assert.ok(plist.includes(`<key>StandardOutPath</key><string>${log}</string>`));
    assert.ok(plist.includes(`<key>StandardErrorPath</key><string>${log}</string>`));
    // The default dir is the default: no override to carry.
    assert.ok(!plist.includes('FACTIII_RUNNER_DIR'));
  });

  it('is marked as its own', () => {
    assert.ok(plist.includes(SERVICE_MARKER));
  });

  it('carries Factiii Desktop’s tools folder when there is one', () => {
    assert.ok(!plist.includes('FACTIII_TOOLS_DIR'));
    const desktop = renderLaunchAgent({ ...mac, toolsDir: '/Users/jo/Factiii/tools' });
    assert.ok(
      desktop.includes('<key>FACTIII_TOOLS_DIR</key><string>/Users/jo/Factiii/tools</string>')
    );
  });

  it('escapes a path with a space and an ampersand', () => {
    const odd = renderLaunchAgent({
      ...mac,
      node: '/Users/jo/My Tools & More/node',
      path: '/Users/jo/My Tools & More:/usr/bin'
    });
    assert.ok(odd.includes('<string>/Users/jo/My Tools &amp; More/node</string>'));
    assert.ok(
      odd.includes('<key>PATH</key><string>/Users/jo/My Tools &amp; More:/usr/bin</string>')
    );
  });

  it('gives a second runner its own label, file, dir and log', () => {
    const dev = { ...mac, runnerDir: '/Users/jo/.factiii-runner-dev', customDir: true };
    const label = serviceName(dev);
    assert.match(label, /^com\.factiii\.runner\.[0-9a-f]{8}$/);
    assert.equal(
      serviceFiles(dev).definition,
      `/Users/jo/Library/LaunchAgents/${label}.plist`
    );
    const devPlist = renderLaunchAgent(dev);
    assert.ok(
      devPlist.includes(
        '<key>FACTIII_RUNNER_DIR</key><string>/Users/jo/.factiii-runner-dev</string>'
      )
    );
    assert.ok(devPlist.includes('/Users/jo/.factiii-runner-dev/logs/runner.log'));
  });
});

describe('renderSystemdUnit', () => {
  const unit = renderSystemdUnit(linux);

  it('is a user unit that restarts after a failure', () => {
    assert.equal(
      serviceFiles(linux).definition,
      '/home/jo/.config/systemd/user/factiii-runner.service'
    );
    assert.ok(
      unit.includes(
        'ExecStart="/usr/bin/node" "/usr/lib/node_modules/@factiii/runner/bin/factiii-runner.js" start'
      )
    );
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.ok(unit.startsWith(`# ${SERVICE_MARKER}`));
  });

  // The default (control-group) would end tmux, and every terminal, on a restart.
  it('stops the supervisor and its worker, and nothing that detached', () => {
    assert.match(unit, /^KillMode=process$/m);
    assert.match(unit, /^ExecStop=\/bin\/kill -TERM -- -\$\{MAINPID\}$/m);
  });

  it('carries the environment and logs to the runner folder', () => {
    assert.ok(unit.includes('Environment="PATH=/usr/bin:/bin"'));
    assert.ok(unit.includes('Environment="SHELL=/bin/bash"'));
    assert.match(
      unit,
      /^StandardOutput=append:\/home\/jo\/\.factiii-runner\/logs\/runner\.log$/m
    );
  });

  it('quotes spaces, and escapes what systemd would expand', () => {
    const odd = renderSystemdUnit({
      ...linux,
      node: '/opt/my node/100%/$bin/node',
      runnerDir: '/srv/runner two',
      customDir: true
    });
    assert.ok(odd.includes('ExecStart="/opt/my node/100%%/$$bin/node" '));
    assert.ok(odd.includes('Environment="FACTIII_RUNNER_DIR=/srv/runner two"'));
    assert.match(serviceName({ ...linux, customDir: true }), /^factiii-runner-[0-9a-f]{8}\.service$/);
  });
});

describe('the Windows task', () => {
  it('runs a launcher that sets the env, logs, and passes the exit code on', () => {
    const lines = renderWindowsLauncher({
      ...windows,
      runnerDir: 'D:\\Runner Two',
      customDir: true
    }).split('\r\n');
    assert.ok(lines.includes('set "FACTIII_RUNNER_DIR=D:\\Runner Two"'));
    assert.ok(lines.includes('set "PATH=C:\\Program Files\\nodejs;%PATH%"'));
    assert.ok(
      lines.includes(
        `"C:\\Program Files\\nodejs\\node.exe" "${windows.entry}" start >> "D:\\Runner Two\\logs\\runner.log" 2>&1`
      )
    );
    assert.ok(lines.includes('exit /b %ERRORLEVEL%'));
    assert.ok(lines[1].includes(SERVICE_MARKER));
  });

  it('starts at logon for this user and restarts on failure', () => {
    const task = renderWindowsTask(windows);
    assert.match(task, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>DESK\\Jo Smith<\/UserId>/);
    assert.match(task, /<LogonType>InteractiveToken<\/LogonType>/);
    assert.match(task, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(task, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>/);
    assert.match(task, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
    assert.ok(
      task.includes(
        '<Arguments>/d /s /c ""C:\\Users\\Jo Smith\\.factiii-runner\\service\\run.cmd""</Arguments>'
      )
    );
    assert.ok(task.includes(SERVICE_MARKER));
  });
});

describe('status parsing', () => {
  it('reads launchctl print', () => {
    assert.deepEqual(
      parseLaunchctlPrint(
        'gui/501/com.factiii.runner = {\n\tactive count = 1\n\tstate = running\n\n\tprogram = /usr/bin/node\n\tpid = 73412\n}\n'
      ),
      { running: true, pid: 73412 }
    );
    assert.deepEqual(
      parseLaunchctlPrint('\tstate = not running\n\tlast exit code = 1\n'),
      { running: false, pid: null }
    );
  });

  it('reads systemctl show', () => {
    assert.deepEqual(
      parseSystemctlShow('MainPID=912\nActiveState=active\nUnitFileState=enabled\n'),
      { loaded: true, running: true, pid: 912 }
    );
    assert.deepEqual(
      parseSystemctlShow('MainPID=0\nActiveState=inactive\nUnitFileState=disabled\n'),
      { loaded: false, running: false, pid: null }
    );
  });

  it('reads schtasks CSV', () => {
    assert.equal(parseSchtasksCsv('"\\FactiiiRunner","N/A","Running"\r\n').running, true);
    assert.equal(parseSchtasksCsv('"\\FactiiiRunner","N/A","Ready"\r\n').running, false);
  });

  it('reports a loaded, running LaunchAgent and the command in its file', async () => {
    const file = serviceFiles(mac).definition;
    const { io, calls } = fakeIo({ [file]: renderLaunchAgent(mac) }, fakeLaunchd(true));
    const status = await serviceStatus(mac, io);
    assert.deepEqual(status, {
      name: 'com.factiii.runner',
      file,
      log: '/Users/jo/.factiii-runner/logs/runner.log',
      installed: 'yes',
      loaded: true,
      running: true,
      pid: 4242,
      command: `${NVM_NODE} ${NVM_ENTRY} start`
    });
    assert.deepEqual(calls, [['launchctl', 'print', 'gui/501/com.factiii.runner']]);
  });

  it('reports nothing installed', async () => {
    const status = await serviceStatus(linux, fakeIo().io);
    assert.equal(status.installed, 'no');
    assert.equal(status.loaded, false);
    assert.equal(status.running, false);
    assert.equal(status.command, '');
  });

  it('tells a Windows task it did not create from its own', async () => {
    const foreign = fakeIo({}, () => ({ code: 0, output: '<Task><Description>Mine</Description></Task>' }));
    assert.equal((await serviceStatus(windows, foreign.io)).installed, 'foreign');
    const own = fakeIo({}, (_bin, args) =>
      args.includes('/XML')
        ? { code: 0, output: renderWindowsTask(windows) }
        : { code: 0, output: '"\\FactiiiRunner","N/A","Running"' }
    );
    const status = await serviceStatus(windows, own.io);
    assert.equal(status.installed, 'yes');
    assert.equal(status.running, true);
  });
});

describe('runnerPids', () => {
  const list = [
    '  501 /sbin/launchd',
    ' 7001 node /opt/homebrew/bin/factiii-runner start',
    ' 7002 /opt/homebrew/bin/node /opt/homebrew/bin/factiii-runner start',
    ' 7003 node /opt/homebrew/bin/factiii-runner status',
    ' 7004 node /somewhere/else/cli.js start',
    ' 7005 node /opt/homebrew/bin/factiii-runner service install'
  ].join('\n');

  it('finds a `start` of this runner and nothing else', () => {
    assert.deepEqual(runnerPids(list, ['/opt/homebrew/bin/factiii-runner'], 7005), [
      7001, 7002
    ]);
  });

  it('never counts itself', () => {
    assert.deepEqual(runnerPids(list, ['/opt/homebrew/bin/factiii-runner'], 7001), [7002]);
  });
});

describe('installService', () => {
  const file = serviceFiles(mac).definition;

  it('writes the file and loads it', async () => {
    const { io, files, ran } = fakeIo({}, fakeLaunchd(false));
    const outcome = await installService(mac, io, opts);
    assert.equal(outcome.ok, true);
    assert.equal(files[file], renderLaunchAgent(mac));
    assert.deepEqual(ran('bootstrap'), [['launchctl', 'bootstrap', 'gui/501', file]]);
    assert.deepEqual(Object.keys(files), [file]);
  });

  it('changes nothing the second time', async () => {
    const { io, files, ran } = fakeIo({}, fakeLaunchd(false));
    await installService(mac, io, opts);
    const before = { ...files };
    const again = await installService(mac, io, opts);
    assert.equal(again.ok, true);
    assert.match(again.lines[0], /Already installed/);
    assert.deepEqual(files, before);
    assert.equal(ran('bootstrap').length, 1);
    assert.equal(ran('bootout').length, 0);
  });

  it('refuses a file it did not write, and touches nothing', async () => {
    const theirs = '<plist><!-- hand written --></plist>';
    const { io, files, calls } = fakeIo({ [file]: theirs }, fakeLaunchd(true));
    const outcome = await installService(mac, io, opts);
    assert.equal(outcome.ok, false);
    assert.equal(files[file], theirs);
    assert.deepEqual(
      calls.filter(([, verb]) => verb !== 'print'),
      []
    );
  });

  it('replaces its own file when the node moved: unload, write, load', async () => {
    const old = renderLaunchAgent({ ...mac, node: '/old/node' });
    const { io, files, calls } = fakeIo({ [file]: old }, fakeLaunchd(true));
    const outcome = await installService(mac, io, opts);
    assert.equal(outcome.ok, true);
    assert.equal(files[file], renderLaunchAgent(mac));
    const verbs = calls.map(([, verb]) => verb).filter((verb) => verb !== 'print');
    assert.deepEqual(verbs, ['bootout', 'bootstrap']);
  });

  it('does not start a second runner beside one started by hand', async () => {
    const byHand = ' 900 node /opt/homebrew/bin/factiii-runner start\n';
    const { io, files, ran } = fakeIo({}, fakeLaunchd(false, byHand));
    const outcome = await installService(mac, io, opts);
    assert.equal(outcome.ok, true);
    assert.equal(files[file], renderLaunchAgent(mac));
    assert.equal(ran('bootstrap').length, 0);
    assert.ok(outcome.lines.some((line) => line.includes('pid 900')));
  });

  it('reports a load that failed, with what launchctl said', async () => {
    const { io } = fakeIo({}, (_bin, args) =>
      args[0] === 'bootstrap'
        ? { code: 5, output: 'Bootstrap failed: 5: Input/output error' }
        : { code: 1, output: '' }
    );
    const outcome = await installService(mac, io, opts);
    assert.equal(outcome.ok, false);
    assert.ok(outcome.lines.join('\n').includes('Input/output error'));
  });

  it('enables a systemd user unit, and only enables it beside a running runner', async () => {
    const fresh = fakeIo({}, () => ({ code: 0, output: '' }));
    await installService(linux, fresh.io, opts);
    assert.deepEqual(
      fresh.calls.filter(([bin, , verb]) => bin === 'systemctl' && verb !== 'show'),
      [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', 'factiii-runner.service']
      ]
    );
    const busy = fakeIo({}, (bin) => ({
      code: 0,
      output: bin === 'ps' ? ` 900 node ${linux.entry} start\n` : ''
    }));
    await installService(linux, busy.io, opts);
    assert.deepEqual(busy.ran('enable'), [
      ['systemctl', '--user', 'enable', 'factiii-runner.service']
    ]);
  });

  it('registers the Windows task from its XML and runs it', async () => {
    const { io, files, calls } = fakeIo({}, (bin, args) => ({
      code: bin === 'schtasks' && args[0] === '/Query' ? 1 : 0,
      output: ''
    }));
    const outcome = await installService(windows, io, opts);
    assert.equal(outcome.ok, true);
    const { definition, launcher } = serviceFiles(windows);
    assert.deepEqual(Object.keys(files).sort(), [launcher, definition].sort());
    assert.deepEqual(
      calls.filter(([bin, verb]) => bin === 'schtasks' && verb !== '/Query'),
      [
        ['schtasks', '/Create', '/TN', 'FactiiiRunner', '/XML', definition, '/F'],
        ['schtasks', '/Run', '/TN', 'FactiiiRunner']
      ]
    );
  });
});

describe('removeService', () => {
  const file = serviceFiles(mac).definition;

  it('unloads and deletes its own file, and nothing else', async () => {
    const neighbour = '/Users/jo/Library/LaunchAgents/com.factiii.frps.plist';
    const log = serviceFiles(mac).log;
    const { io, files, ran } = fakeIo(
      { [file]: renderLaunchAgent(mac), [neighbour]: '<plist/>', [log]: 'lines' },
      fakeLaunchd(true)
    );
    const outcome = await removeService(mac, io);
    assert.equal(outcome.ok, true);
    assert.deepEqual(Object.keys(files).sort(), [log, neighbour].sort());
    assert.deepEqual(ran('bootout'), [
      ['launchctl', 'bootout', 'gui/501/com.factiii.runner']
    ]);
  });

  it('leaves a file it did not write, and unloads nothing', async () => {
    const { io, files, ran } = fakeIo({ [file]: '<plist/>' }, fakeLaunchd(true));
    const outcome = await removeService(mac, io);
    assert.equal(outcome.ok, false);
    assert.equal(files[file], '<plist/>');
    assert.equal(ran('bootout').length, 0);
  });

  it('does nothing when nothing is installed', async () => {
    const { io, calls } = fakeIo({}, fakeLaunchd(false));
    const outcome = await removeService(mac, io);
    assert.equal(outcome.ok, true);
    assert.deepEqual(
      calls.filter(([, verb]) => verb !== 'print'),
      []
    );
  });

  it('keepRunning deletes the file and stops nothing', async () => {
    const { io, files, ran } = fakeIo(
      { [file]: renderLaunchAgent(mac) },
      fakeLaunchd(true)
    );
    const outcome = await removeService(mac, io, { keepRunning: true });
    assert.equal(outcome.ok, true);
    assert.equal(files[file], undefined);
    assert.equal(ran('bootout').length, 0);

    const unit = fakeIo({}, () => ({ code: 0, output: '' }));
    for (const { file: path, content } of renderService(linux)) {
      unit.files[path] = content;
    }
    await removeService(linux, unit.io, { keepRunning: true });
    assert.deepEqual(unit.ran('disable'), [
      ['systemctl', '--user', 'disable', serviceName(linux)]
    ]);
    assert.equal(unit.ran('--now').length, 0);

    const task = fakeIo({}, (_bin, args) => ({
      code: 0,
      output: args.includes('/XML') ? renderWindowsTask(windows) : ''
    }));
    for (const { file: path, content } of renderService(windows)) {
      task.files[path] = content;
    }
    await removeService(windows, task.io, { keepRunning: true });
    assert.equal(task.ran('/End').length, 0);
    assert.equal(task.ran('/Delete').length, 1);
  });

  it('deletes exactly the files install wrote, on every platform', async () => {
    for (const spec of [mac, linux, windows]) {
      const { io, files } = fakeIo(
        {},
        spec.platform === 'darwin'
          ? fakeLaunchd(true)
          : (_bin, args) => ({
              code: 0,
              output: args.includes('/XML') ? renderWindowsTask(windows) : ''
            })
      );
      for (const { file: path, content } of renderService(spec)) files[path] = content;
      await removeService(spec, io);
      assert.deepEqual(files, {}, spec.platform);
    }
  });
});

describe('supervisorExitCode', () => {
  // The service restarts the runner after a failure only.
  it('is clean for a stop someone asked for', () => {
    assert.equal(supervisorExitCode(null, 'SIGTERM'), 0);
    assert.equal(supervisorExitCode(null, 'SIGINT'), 0);
    assert.equal(supervisorExitCode(0, null), 0);
  });

  it('is a failure for a crash, a kill, and a worker that exited non-zero', () => {
    assert.equal(supervisorExitCode(null, 'SIGKILL'), 1);
    assert.equal(supervisorExitCode(null, 'SIGSEGV'), 1);
    assert.equal(supervisorExitCode(1, null), 1);
  });
});
