// Probe: the child's memory after PGlite + migrations, with and without
// --liftoff-only, before any Prisma client is made.
import { fork } from "node:child_process";
import path from "node:path";

const engineDir = path.join(__dirname, "engine");
for (const flags of [["--liftoff-only"], []]) {
  const child = fork(path.join(__dirname, "ipcChild.ts"), [engineDir, "ipc"], {
    execArgv: [...process.execArgv, ...flags],
    serialization: "advanced",
  });
  child.once("message", () => {
    child.send({ id: 9, op: "rss" });
    child.on("message", (m: { id: number; result: number }) => {
      if (m.id !== 9) return;
      console.log(
        flags.join(" ") || "(no flag)",
        "child rss after migrate:",
        (m.result / 1e6).toFixed(0),
        "MB",
      );
      child.kill();
    });
  });
}
