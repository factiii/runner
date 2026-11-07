import { spawnSync } from 'node:child_process';
import os from 'node:os';

import type { Command } from 'commander';

import {
  NUKE_PHRASE,
  NUKE_PHRASE_REFUSAL,
  nukePhraseMatches,
  nukePlanLines,
  nukeProgressLine
} from '@shared/all/helpers/runnerNuke';

import { run } from './machine';
import { nukeDirRefusal, nukeSessionRefusal, readNukePlan, runNuke } from './nuke';
import { machineNukeHost, stopTmuxSessionsIn, unpairFromConfig } from './nukeHost';
import { CONFIG_DIR } from './paths';
import { promptLine } from './promptPassword';

// `factiii-runner nuke` (.specs/runner-setup.md "Nuke a runner"). Shows the
// plan, then asks for the phrase on the terminal. `--confirm "<phrase>"` is
// the scripted road; there is no --yes. The phrase is compared exactly as
// typed. Last, and only here, it offers to uninstall the npm package.

export function registerNukeCommand(program: Command): void {
  program
    .command('nuke')
    .description(
      `Erase everything this runner holds, secrets included, and unpair it. Asks you to type "${NUKE_PHRASE}".`
    )
    .option('--confirm <phrase>', `for scripts: the phrase, exactly "${NUKE_PHRASE}"`)
    .action(async (opts: { confirm?: string }) => {
      const refusal =
        nukeSessionRefusal(process.env) ??
        nukeDirRefusal(CONFIG_DIR, { expectedDir: CONFIG_DIR, home: os.homedir() });
      if (refusal) {
        console.error(`\n${refusal}\n`);
        process.exit(1);
      }
      const host = machineNukeHost({
        dir: CONFIG_DIR,
        exec: (bin, args) => run(bin, args, { timeoutMs: 60_000 }),
        unpair: unpairFromConfig(),
        // The daemon, if one runs, exits on the server's `runnerRevoked`
        // from the unpair, and its caffeinate (`-w <pid>`) with it. What is
        // left is the runner's tmux sessions.
        stopWork: () => stopTmuxSessionsIn(CONFIG_DIR, (bin, args) => run(bin, args, { timeoutMs: 30_000 }))
      });
      const plan = await readNukePlan(CONFIG_DIR, host);
      console.log('\nThis erases the runner. What goes:\n');
      for (const line of nukePlanLines(plan)) console.log(`  ${line}`);
      console.log('');

      let typed = opts.confirm;
      if (typed === undefined) {
        if (!process.stdin.isTTY) {
          console.error(
            `No terminal to type into. For a script: factiii-runner nuke --confirm "${NUKE_PHRASE}"\n`
          );
          process.exit(1);
        }
        typed = await promptLine(`Type ${NUKE_PHRASE} to erase it all: `);
      }
      if (!nukePhraseMatches(typed)) {
        console.error(`\n${NUKE_PHRASE_REFUSAL}\n`);
        process.exit(1);
      }

      try {
        await runNuke({
          dir: CONFIG_DIR,
          expectedDir: CONFIG_DIR,
          host,
          onProgress: (progress) => {
            console.log(nukeProgressLine(progress));
            for (const line of progress.lines) console.log(`    ${line}`);
          }
        });
      } catch (err) {
        console.error(
          `\n${err instanceof Error ? err.message : String(err)}\nRun factiii-runner nuke again to finish: every step that is done stays done.\n`
        );
        process.exit(1);
      }

      // Last, and only in the CLI: the package itself.
      const uninstall = 'npm uninstall -g @factiii/runner';
      if (process.stdin.isTTY && opts.confirm === undefined) {
        const answer = (await promptLine(`Also remove the npm package (${uninstall})? [y/N] `))
          .trim()
          .toLowerCase();
        if (answer === 'y' || answer === 'yes') {
          const res = spawnSync('npm', ['uninstall', '-g', '@factiii/runner'], { stdio: 'inherit' });
          process.exit(res.status ?? 1);
        }
      }
      console.log(`\nThe package stays installed. To remove it too: ${uninstall}\n`);
      process.exit(0);
    });
}
