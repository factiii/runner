import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";

import type { RunnerService } from "@shared/all/domains/electron";
import { boardHoldsSecrets } from "@shared/all/helpers/board-agent-core/host-secrets";
import {
  exportSecretsBackup,
  restoreSecretsBackup,
} from "@shared/all/helpers/board-agent-core/secrets-backup";

import { boardLabel, knownBoards } from "./boardRegistry";
import { configExists } from "./config";
import { runningServices } from "./machineHealthIo";
import { CONFIG_DIR, safeSlug, spaceDirPath } from "./paths";
import { promptPassword } from "./promptPassword";

// `factiii-runner migrate export | import | check`: move what this runner
// keeps to a new runner (.specs/runner-migration.md).
//
// The file carries each board's secrets (a secrets backup per board, sealed
// under one migration passphrase: secrets-backup.ts), the machine-wide agent
// skills (~/.agents/skills), and a list of the servers running here. It
// never carries the runner's token or pairing: the new machine pairs itself
// (`factiii-runner setup`) and the boards come from the server, as for any
// new runner. Import never overwrites: a board that already has secrets,
// or a skill file that already exists, is left alone and named.

const FORMAT = "factiii-runner-migration";
const VERSION = 1;
/** Synced from claude.ai by the desktop app, per machine: not ours to move. */
const SKIP_SKILL_DIRS = new Set(["synced"]);
/** A skill folder holds text and small scripts; anything this big is a
 *  stray build or model file, and stays behind. */
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;

export type MigrationBoard = {
  id: number;
  slug: string;
  name?: string;
  /** The board's secrets backup, or null when it had none or was skipped. */
  secrets: string | null;
};

export type MigrationService = Pick<
  RunnerService,
  "kind" | "name" | "ports" | "running"
>;

export type Migration = {
  format: typeof FORMAT;
  version: number;
  createdAt: string;
  from: string;
  boards: MigrationBoard[];
  /** Relative path under ~/.agents/skills → base64 contents. */
  skills: Record<string, string>;
  /** The same for ~/.agents/skills-on-request, the skills no CLI lists and
   *  agents read only when named. Absent from older migration files. */
  skillsOnRequest?: Record<string, string>;
  services: MigrationService[];
};

export const skillsRoot = (home = os.homedir()) =>
  path.join(home, ".agents", "skills");

export const skillsOnRequestRoot = (home = os.homedir()) =>
  path.join(home, ".agents", "skills-on-request");

/** Every skill file worth moving, by its path under `root`. Links are
 *  followed for files only; a linked folder is a second name for one that is
 *  already listed, or something outside the skills. */
export async function collectSkills(
  root: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => []);
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && SKIP_SKILL_DIRS.has(e.name)) continue;
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, relPath);
      else if (e.isFile()) {
        const stat = await fs.stat(full);
        if (stat.size <= MAX_SKILL_FILE_BYTES) {
          out[relPath] = (await fs.readFile(full)).toString("base64");
        }
      }
    }
  };
  await walk(root, "");
  return out;
}

/** A relative path from a migration file, refused if it could climb out of
 *  the skills folder. */
export function safeSkillPath(root: string, rel: string): string | null {
  if (rel.includes("\0") || path.isAbsolute(rel)) return null;
  const full = path.resolve(root, rel);
  return full.startsWith(path.resolve(root) + path.sep) ? full : null;
}

/** The servers that ran on the old machine and do not run here, by kind
 *  and name. Ports alone are not compared: a port is often reassigned. */
export function missingServices(
  before: MigrationService[],
  now: MigrationService[],
): MigrationService[] {
  const running = new Set(
    now.filter((s) => s.running).map((s) => `${s.kind}:${s.name}`),
  );
  return before.filter((s) => s.running && !running.has(`${s.kind}:${s.name}`));
}

export function parseMigration(raw: string): Migration {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("That is not a runner migration file.");
  }
  const m = data as Partial<Migration>;
  if (
    m.format !== FORMAT ||
    !Array.isArray(m.boards) ||
    typeof m.skills !== "object"
  ) {
    throw new Error("That is not a runner migration file.");
  }
  if (m.version !== VERSION) {
    throw new Error(
      "This migration file was made by another runner version. Make it again with this one.",
    );
  }
  return m as Migration;
}

const run = (bin: string, args: string[], opts?: { timeoutMs?: number }) =>
  new Promise<{ code: number; output: string }>((resolve) => {
    execFile(
      bin,
      args,
      { timeout: opts?.timeoutMs ?? 5000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, output: String(stdout ?? "") });
      },
    );
  });

const serviceRows = async (): Promise<MigrationService[]> =>
  (await runningServices(run)).map(({ kind, name, ports, running }) => ({
    kind,
    name,
    ports,
    running,
  }));

function printCheck(m: Migration, now: MigrationService[]) {
  const missing = missingServices(m.services, now);
  console.log(
    `\nServers: ${m.services.filter((s) => s.running).length} ran on ${m.from}.`,
  );
  if (missing.length === 0) console.log("  All of them run here too.");
  for (const s of missing) {
    console.log(
      `  Not running here: ${s.kind} ${s.name}${s.ports.length ? ` :${s.ports.join(" :")}` : ""}`,
    );
  }
  console.log(
    "\nThen: factiii-runner doctor, and on each board run a job or two to see its secrets work.",
  );
}

/** Commander does not wait on a rejected action: say what went wrong and
 *  exit 1, like the rest of the CLI. */
const guarded =
  <A extends unknown[]>(action: (...args: A) => Promise<void>) =>
  async (...args: A) => {
    try {
      await action(...args);
    } catch (err) {
      console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  };

export function registerMigrateCommands(program: Command) {
  const migrate = program
    .command("migrate")
    .description(
      "Move this runner to a new machine: secrets, skills, and a check of its servers",
    );

  migrate
    .command("export")
    .description(
      "Write a migration file: every board's secrets, ~/.agents/skills (and skills-on-request) and the running servers",
    )
    .option(
      "-o, --out <file>",
      "where to write it (default: the current folder)",
    )
    .action(
      guarded(async (opts: { out?: string }) => {
        const passphrase = await promptPassword("New migration passphrase: ");
        const again = await promptPassword("Migration passphrase again: ");
        if (!passphrase)
          throw new Error(
            "A migration needs a terminal to type the passwords into.",
          );
        if (passphrase !== again) throw new Error("The passphrases differ.");
        const boards: MigrationBoard[] = [];
        for (const b of knownBoards(CONFIG_DIR)) {
          const spaceDir = spaceDirPath(b.slug);
          let secrets: string | null = null;
          if (await boardHoldsSecrets(spaceDir)) {
            const label = boardLabel(b, b.slug);
            const password = await promptPassword(
              `${label} board password (Enter to leave its secrets behind): `,
            );
            if (password) {
              secrets = await exportSecretsBackup({
                spaceDir,
                board: safeSlug(b.slug),
                password,
                passphrase,
              });
            } else {
              console.log(`  ${label}: secrets left behind.`);
            }
          }
          boards.push({ id: b.id, slug: b.slug, name: b.name, secrets });
        }
        const m: Migration = {
          format: FORMAT,
          version: VERSION,
          createdAt: new Date().toISOString(),
          from: os.hostname(),
          boards,
          skills: await collectSkills(skillsRoot()),
          skillsOnRequest: await collectSkills(skillsOnRequestRoot()),
          services: await serviceRows(),
        };
        const file = path.resolve(
          opts.out ??
            `runner-migration-${m.createdAt.slice(0, 10)}.factiii-migration`,
        );
        await fs.writeFile(file, JSON.stringify(m), {
          mode: 0o600,
          flag: "wx",
        });
        console.log(
          `\nWrote ${file}: ${boards.filter((b) => b.secrets).length} boards' secrets, ` +
            `${Object.keys(m.skills).length} skill files, ${m.services.length} servers.\n` +
            "Move it and its passphrase to the new machine separately, then: factiii-runner migrate import <file>\n",
        );
      }),
    );

  migrate
    .command("import <file>")
    .description(
      "On the new machine: restore secrets and skills from a migration file, then check its servers",
    )
    .action(
      guarded(async (file: string) => {
        const m = parseMigration(
          await fs.readFile(path.resolve(file), "utf-8"),
        );
        if (!configExists()) {
          console.log(
            "This runner is not set up yet. Run factiii-runner setup first, then import again.",
          );
          return;
        }
        const passphrase = await promptPassword("Migration passphrase: ");
        if (!passphrase)
          throw new Error(
            "An import needs a terminal to type the passphrase into.",
          );
        for (const b of m.boards.filter((x) => x.secrets)) {
          const spaceDir = spaceDirPath(b.slug);
          const label = boardLabel(b, b.slug);
          if (await boardHoldsSecrets(spaceDir)) {
            console.log(`  ${label}: already has secrets here, left alone.`);
            continue;
          }
          const password = await promptPassword(
            `New ${label} board password: `,
          );
          if (!password) {
            console.log(`  ${label}: skipped.`);
            continue;
          }
          const res = await restoreSecretsBackup({
            spaceDir,
            bundle: b.secrets ?? "",
            passphrase,
            password,
          });
          console.log(
            `  ${label}: ${res.secrets.length} keys and ${res.files.length} files restored.`,
          );
        }
        for (const [root, files] of [
          [skillsRoot(), m.skills],
          [skillsOnRequestRoot(), m.skillsOnRequest ?? {}],
        ] as const) {
          let written = 0;
          const kept: string[] = [];
          for (const [rel, data] of Object.entries(files)) {
            const target = safeSkillPath(root, rel);
            if (!target) continue;
            try {
              await fs.mkdir(path.dirname(target), { recursive: true });
              await fs.writeFile(target, Buffer.from(data, "base64"), {
                flag: "wx",
              });
              written++;
            } catch {
              kept.push(rel);
            }
          }
          if (!written && !kept.length) continue;
          console.log(`\nSkills: ${written} files written to ${root}.`);
          if (kept.length)
            console.log(
              `  Already here, left alone: ${kept.slice(0, 10).join(", ")}${kept.length > 10 ? ` and ${kept.length - 10} more` : ""}`,
            );
        }
        printCheck(m, await serviceRows());
      }),
    );

  migrate
    .command("check <file>")
    .description(
      "Compare the servers running here with the ones in a migration file",
    )
    .action(
      guarded(async (file: string) => {
        const m = parseMigration(
          await fs.readFile(path.resolve(file), "utf-8"),
        );
        printCheck(m, await serviceRows());
      }),
    );
}
