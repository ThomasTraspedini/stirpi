import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const [mode] = process.argv.slice(2);
const input = JSON.parse(readFileSync(0, "utf8"));
if (mode === "evaluate") {
  process.stdout.write(
    JSON.stringify({
      passed: input.result.startsWith("done"),
      reason: "Fixture public contract: result starts with done",
    }),
  );
  process.exit(0);
}
if (mode === "evaluate-error") process.exit(9);
if (mode === "reject") {
  process.stdout.write(
    JSON.stringify({ passed: false, reason: "Fixture public rejection" }),
  );
  process.exit(0);
}
if (mode === "post") {
  process.stdout.write(JSON.stringify({ received: input, observed: true }));
  process.exit(0);
}
if (mode === "exit") process.exit(7);
if (mode === "timeout") {
  while (true) {
    /* Deterministic timeout fixture. */
  }
}
const { context } = input;
const { work, dna } = context;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const history = git("log", "--all", "--format=%H %s");
const objectIds = git(
  "cat-file",
  "--batch-all-objects",
  "--batch-check=%(objectname)",
);
const observation = {
  taskSha256: createHash("sha256").update(context.task).digest("hex"),
  objectiveSha256: createHash("sha256").update(work.objective).digest("hex"),
  head: git("rev-parse", "HEAD"),
  status: git("status", "--porcelain"),
  history,
  objectIds,
  files: git("ls-tree", "--name-only", "HEAD"),
  remotes: git("remote"),
  envKeys: Object.keys(process.env),
};
let action;
let effects = [];
if (mode === "spawn" && work.name === "root" && work.cursor === 0) {
  process.stdout.write(
    JSON.stringify({
      version: 1,
      effects,
      action: {
        type: "SPAWN",
        work: [{ name: "child", objective: "Produce fixture child" }],
      },
      text: JSON.stringify(observation),
    }),
  );
  process.exit(0);
}
if (mode === "spawn" && work.name === "root") {
  const child = context.results[0];
  if (
    git("show", `${child.artifacts[0]}:single.txt`) !== "single fixture result"
  )
    process.exit(8);
}
if (mode === "H")
  action = {
    type: "BLOCK",
    reason: {
      code: "HUMAN_DECISION_REQUIRED",
      message: "Fixture requires a human-owned decision",
    },
  };
else if ((mode === "T" || mode === "forbidden") && work.name === "root")
  action = {
    type: "FORK",
    alternatives: [
      {
        name: "alpha",
        assumption: "fixture alpha world",
        rationale: "fixture alpha exploration",
      },
      {
        name: "beta",
        assumption: "fixture beta world",
        rationale: "fixture beta exploration",
      },
    ],
  };
else if (mode === "dirty") {
  writeFileSync("pending.txt", "uncommitted fixture evidence\n");
  action = {
    type: "BLOCK",
    reason: { code: "INPUT_REQUIRED", message: "Preserve pending work" },
  };
} else if (mode === "verify" && work.cursor === 0) {
  effects = [{ type: "VERIFY", id: "full-postgres-suite" }];
  action = { type: "CONTINUE" };
} else {
  const name = dna.length ? work.name : "single";
  writeFileSync(`${name}.txt`, `${name} fixture result\n`);
  effects = [{ type: "COMMIT", message: `Add ${name} fixture result` }];
  action =
    work.cursor === 0
      ? { type: "CONTINUE" }
      : { type: "COMPLETE", result: `done ${name}` };
}
process.stderr.write("fixture diagnostic\n");
process.stdout.write(
  JSON.stringify({
    version: 1,
    action,
    effects,
    text: JSON.stringify(observation),
  }),
);
