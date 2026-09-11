import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const { version, context } = JSON.parse(readFileSync(0, "utf8"));
if (version !== 1) process.exit(2);
const [mode = "progress", log] = process.argv.slice(2);
if (log)
  appendFileSync(log, JSON.stringify({ cwd: process.cwd(), context }) + "\n");
const { work, dna } = context;
let action = { type: "CONTINUE" };
let effects = [];
if (mode === "invalid-json") {
  process.stdout.write("COMPLETE");
  process.exit(0);
}
if (mode === "exit" || (mode === "child-failure" && work.name === "child"))
  process.exit(7);
if (["fork", "child-failure"].includes(mode) && work.name === "root")
  action = {
    type: "FORK",
    alternatives: [
      { name: "A", assumption: "world alpha", rationale: "alpha rationale" },
      { name: "B", assumption: "world beta", rationale: "beta rationale" },
    ],
  };
else if (
  ["fork", "child-failure"].includes(mode) &&
  work.name === "A" &&
  work.cursor === 0
)
  action = {
    type: "SPAWN",
    work: [{ name: "child", objective: "Return local world" }],
  };
else if (["fork", "child-failure"].includes(mode))
  action = { type: "COMPLETE", result: "done " + dna.join(",") };
else if (mode.startsWith("dirty-")) {
  writeFileSync("pending.txt", "preserve me");
  const type = mode.slice(6);
  action =
    type === "FORK"
      ? {
          type,
          alternatives: [
            { name: "A", assumption: "A", rationale: "A" },
            { name: "B", assumption: "B", rationale: "B" },
          ],
        }
      : type === "SPAWN"
        ? { type, work: [{ name: "child", objective: "child" }] }
        : type === "BLOCK"
          ? { type, reason: { code: "PAUSED", message: "Inspect workspace" } }
          : { type, result: "done" };
} else {
  const file = join(work.artifact.worktree, "progress.txt");
  if (work.cursor === 0) writeFileSync(file, "first\n");
  if (work.cursor === 1) {
    appendFileSync(file, "second\n");
    effects = [{ type: "COMMIT", message: "Add first two progress entries" }];
  }
  if (work.cursor === 2) {
    appendFileSync(file, "third\n");
    effects = [{ type: "COMMIT", message: "Add third progress entry" }];
  }
  if (work.cursor === 3) {
    effects = [{ type: "COMMIT", message: "Confirm progress" }];
    action = { type: "COMPLETE", result: "done" };
  }
}
if (mode === "invalid-action") action = { type: "WIN" };
if (mode === "invalid-envelope")
  effects = [{ type: "SHELL", command: "ignored" }];
// Changes to deserialized input never change engine state.
context.work.status = "DEAD";
context.dna.push("injected");
process.stdout.write(
  JSON.stringify({
    version: mode === "version" ? 2 : 1,
    action,
    effects,
    text: "COMPLETE is just explanatory text",
  }),
);
