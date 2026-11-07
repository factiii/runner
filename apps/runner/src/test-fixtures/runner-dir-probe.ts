// Spawned by runner-dir.test.ts under a fake HOME, a FACTIII_RUNNER_DIR and a
// fake `security` on PATH. Touches every place the runner keeps state.
import { NPM_PREFIX } from '@shared/all/helpers/board-agent-core/host-env';
import { renderedPluginRoot } from '@shared/all/helpers/board-agent-core/plugin';
import fs from 'fs';
import path from 'path';

import { readRunnerGrants, writeRunnerGrants } from '../access';
import { readRunnerConfig, writeRunnerConfig } from '../config';
import { CONFIG_DIR, spaceDirPath } from '../paths';

writeRunnerGrants(CONFIG_DIR, '1', {});
readRunnerGrants(CONFIG_DIR, '1');
writeRunnerConfig({
  serverUrl: 'http://localhost:5001',
  authToken: 'fake.token.value',
  runnerName: 'probe'
});
const back = readRunnerConfig();
for (const dir of [NPM_PREFIX, renderedPluginRoot(), spaceDirPath('board')]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'probe'), 'x');
}
process.stdout.write(
  JSON.stringify({ configDir: CONFIG_DIR, roundTrip: back?.runnerName === 'probe' })
);
