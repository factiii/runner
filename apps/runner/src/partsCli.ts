import type { Command } from 'commander';

import type { RunnerPart, RunnerPartsState } from '@shared/all/domains/electron';
import {
  CLEANUP_SAFE_NOTE,
  cleanupItemLine,
  cleanupSummary,
  diskLine,
  healthHeadline,
  memoryLine,
  processLine
} from '@shared/all/helpers/runnerHealthCopy';
import {
  moduleCost,
  moduleStatusLabel,
  partCost,
  partStatusLabel
} from '@shared/all/helpers/runnerPartsCopy';
import { LOCAL_AI_MODEL_IDS } from '@shared/all/helpers/localAiModels';
import {
  localAiModelIdSchema,
  RUNNER_MODULE_ACTIONS,
  type RunnerModuleAction,
  type RunnerModuleId,
  type RunnerPartAction,
  type RunnerPartId,
  runnerModuleIdSchema,
  runnerPartIdSchema
} from '@shared/all/validators';

import { createPartsManager } from './runnerParts';

// `factiii-runner parts list | add | remove | start | stop | clean`: the same
// actions as the runner's Status > Features, run in this terminal.
// `add` and `remove` take a module (every sub-part, in order) or one part.
// `add local-ai` picks the model that fits this machine and pulls it;
// `--model` picks another from the table. `clean` lists what Free up space
// would remove, and removes it only with `--confirm`.

const LABEL_WIDTH = 16;
const TITLE_WIDTH = 22;
const SUB_INDENT = '    ';

function renderPart(part: RunnerPart, pad: string): string[] {
  const lines = [
    `${pad}  [${partStatusLabel(part)}]`.padEnd(pad.length + LABEL_WIDTH) +
      part.title.padEnd(TITLE_WIDTH) +
      partCost(part)
  ];
  const indent = pad + ' '.repeat(LABEL_WIDTH);
  lines.push(`${indent}${part.description}`);
  if (!part.installed && part.missing.length) {
    lines.push(`${indent}Missing: ${part.missing.join(', ')}`);
  }
  for (const step of part.manual) lines.push(`${indent}Needs you: ${step}`);
  for (const action of part.actions) {
    lines.push(`${indent}factiii-runner parts ${action} ${part.id}`);
  }
  return lines;
}

/** The Local AI module's pick, why, and the other models that fit. */
function renderLocalAi({ localAi }: RunnerPartsState): string[] {
  if (!localAi) return [];
  const lines = [`  ${localAi.reason}`];
  const others = localAi.models.filter((m) => m.fits && m.id !== localAi.picked);
  if (others.length) {
    lines.push(`  Others that fit: ${others.map((m) => m.id).join(', ')}`);
    lines.push('  factiii-runner parts add local-ai --model <id>');
  }
  return lines;
}

/** Machine health over the modules: one line, then each disk. */
function renderHealth({ health }: RunnerPartsState): string[] {
  if (!health) return [];
  return [
    `  Machine health: ${healthHeadline(health)}`,
    ...health.disks.map((d) => `    ${diskLine(d)}`),
    `    ${memoryLine(health.memory)}`,
    ...[processLine(health.processes)].filter(Boolean).map((l) => `    ${l}`),
    ...(health.level === 'ok' ? [] : ['  factiii-runner parts clean']),
    ''
  ];
}

/** The parts as `parts list` and `setup` print them, by module. */
export function renderParts(state: RunnerPartsState): string[] {
  const lines: string[] = renderHealth(state);
  for (const mod of state.modules ?? []) {
    lines.push(
      `  ${mod.title}`.padEnd(LABEL_WIDTH + TITLE_WIDTH) +
        `${moduleStatusLabel(mod)} · ${moduleCost(mod)}`
    );
    lines.push(`  ${mod.description}`);
    for (const action of mod.actions) {
      lines.push(`  factiii-runner parts ${action} ${mod.id}`);
    }
    if (mod.id === 'local-ai' && state.localAi) lines.push(...renderLocalAi(state));
    for (const part of mod.parts) lines.push(...renderPart(part, SUB_INDENT));
    lines.push('');
  }
  return lines;
}

async function listParts(json: boolean): Promise<void> {
  const state = await createPartsManager().list();
  if (json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log('\nParts on this runner\n');
  for (const line of renderParts(state)) console.log(line);
  console.log('');
}

/** `parts clean`: the dry run, and with `--confirm` the run of exactly what
 *  it listed. */
async function clean(confirm: boolean): Promise<void> {
  const manager = createPartsManager();
  const plan = await manager.cleanup({});
  console.log('\nFree up space\n');
  for (const item of plan.items) console.log(`  ${cleanupItemLine(item)}`);
  console.log(`  ${cleanupSummary(plan)}`);
  console.log(`  ${CLEANUP_SAFE_NOTE}\n`);
  if (!plan.items.length) process.exit(0);
  if (!confirm) {
    console.log('  Nothing was removed. To remove it:\n  factiii-runner parts clean --confirm\n');
    process.exit(0);
  }
  const after = await manager.cleanup(
    { confirm: true, ids: plan.items.map((i) => i.id) },
    (line) => console.log(`  ${line}`)
  );
  console.log(after.items.length ? `\n  Left: ${cleanupSummary(after)}\n` : '\n  Done.\n');
  process.exit(0);
}

const isModuleAction = (action: RunnerPartAction): action is RunnerModuleAction =>
  (RUNNER_MODULE_ACTIONS as readonly string[]).includes(action);

/** `--model`: pick it before the add. Exits on a model the table lacks, or
 *  one that does not fit. */
async function pickFirst(
  manager: ReturnType<typeof createPartsManager>,
  target: { partId?: RunnerPartId; moduleId?: RunnerModuleId; action: RunnerPartAction },
  model: string | undefined
): Promise<void> {
  if (!model) return;
  const parsed = localAiModelIdSchema.safeParse(model);
  if (!parsed.success) {
    console.error(`\nUnknown model "${model}". Models: ${LOCAL_AI_MODEL_IDS.join(', ')}\n`);
    process.exit(1);
  }
  try {
    await manager.pickModel(target, parsed.data);
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

/** `parts add <module>` / `parts remove <module>`: each sub-part in turn. */
async function actModule(
  action: RunnerModuleAction,
  moduleId: RunnerModuleId,
  model?: string
): Promise<void> {
  const manager = createPartsManager();
  await pickFirst(manager, { moduleId, action }, model);
  const mod = (await manager.list()).modules?.find((m) => m.id === moduleId);
  if (!mod) {
    console.error(`\n${moduleId} is not offered on this machine.\n`);
    process.exit(1);
  }
  if (!mod.actions.includes(action)) {
    console.error(`\n${mod.title} cannot ${action} now (${moduleStatusLabel(mod)}).\n`);
    process.exit(1);
  }
  const ok = await manager.runModule(mod.id, action, (line) => console.log(`  ${line}`));
  process.exit(ok ? 0 : 1);
}

async function act(action: RunnerPartAction, raw: string, model?: string): Promise<void> {
  // A module first: `local-ai` names both, and the module also pulls the
  // model.
  const moduleId = runnerModuleIdSchema.safeParse(raw);
  if (isModuleAction(action) && moduleId.success) {
    return actModule(action, moduleId.data, model);
  }
  const parsed = runnerPartIdSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(
      `\nUnknown part "${raw}". Modules: ${runnerModuleIdSchema.options.join(', ')}. Parts: ${runnerPartIdSchema.options.join(', ')}\n`
    );
    process.exit(1);
  }
  const manager = createPartsManager();
  await pickFirst(manager, { partId: parsed.data, action }, model);
  const state = await manager.list();
  const part =
    state.modules?.flatMap((m) => m.parts).find((p) => p.id === parsed.data) ??
    state.parts.find((p) => p.id === parsed.data);
  if (!part) {
    console.error(`\n${raw} is not offered on this machine.\n`);
    process.exit(1);
  }
  if (!part.actions.includes(action)) {
    console.error(
      `\n${part.title} cannot ${action} now (${partStatusLabel(part)}).\n`
    );
    process.exit(1);
  }
  const ok = await manager.run(part.id, action, (line) => console.log(`  ${line}`));
  process.exit(ok ? 0 : 1);
}

export function registerPartsCommands(program: Command): void {
  const parts = program
    .command('parts')
    .description('List, add, remove, start or stop what this runner can do, or free up space');

  parts
    .command('list')
    .description('Each part: what it does, whether it is installed, its cost')
    .option('--json', 'print the list as JSON')
    .action((opts: { json?: boolean }) => listParts(Boolean(opts.json)));

  parts
    .command('clean')
    .description(
      'List what the runner made and can make again (old builds, idle job checkouts, old logs, unused models); never the vault or secrets'
    )
    .option('--confirm', 'remove what it lists')
    .action((opts: { confirm?: boolean }) => clean(Boolean(opts.confirm)));

  const verbs: [RunnerPartAction, string][] = [
    ['add', 'Install a module, or what one part needs (tools only; the rest is printed)'],
    ['remove', 'Uninstall what the runner installed for a module or a part'],
    ['start', 'Start a part that runs a process'],
    ['stop', 'Stop a part the runner started']
  ];
  for (const [action, description] of verbs) {
    const command = parts
      .command(`${action} <${isModuleAction(action) ? 'module|part' : 'part'}>`)
      .description(description);
    if (action === 'add') {
      command.option(
        '--model <id>',
        `Local AI: pull this model instead of the one picked for this machine (${LOCAL_AI_MODEL_IDS.join(', ')})`
      );
    }
    command.action((part: string, opts: { model?: string }) => act(action, part, opts.model));
  }
}
