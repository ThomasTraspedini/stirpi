#!/usr/bin/env node
// Explicit opt-in only. Never imported by the automated test suite.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import {
  simulateAsync,
  ProcessExecutor,
  GitWorkspaceBackend,
  replay,
} from "../../dist/index.js";

const { values } = parseArgs({
  options: {
    "real-agent": { type: "boolean" },
    codex: { type: "string" },
    "auth-file": { type: "string" },
    model: { type: "string" },
  },
});
if (!values["real-agent"] || !values.codex)
  throw new Error(
    "Requires --real-agent --codex /absolute/executable [--auth-file /absolute/auth.json] [--model model]",
  );
const directory = realpathSync(
  mkdtempSync(join(tmpdir(), "stirpi-codex-smoke-")),
);
const repo = join(directory, "fixture");
mkdirSync(repo);
const git = (...args) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
git("init", "--template=", "-b", "main");
git("config", "user.name", "Adapter smoke");
git("config", "user.email", "smoke@example.invalid");
git("config", "core.hooksPath", "/dev/null");
writeFileSync(
  join(repo, "README.md"),
  "Temporary pure function fixture. No dependencies. Use node --test.\n",
);
git("add", ".");
git("-c", "commit.gpgsign=false", "commit", "-m", "Add fixture description");
const base = git("rev-parse", "HEAD");
const task =
  "Add twice.mjs exporting a pure named function twice(n) that returns n * 2. Add twice.test.mjs using node:test and node:assert/strict covering zero, positive and negative numbers. Run node --test twice.test.mjs. Request one coherent COMMIT effect, then return COMPLETE. Do not run git commit yourself.\n";
writeFileSync(join(directory, "task.txt"), task);
const args = [
  fileURLToPath(new URL("adapter.mjs", import.meta.url)),
  "--codex",
  values.codex,
];
for (const key of ["auth-file", "model"])
  if (values[key]) args.push(`--${key}`, values[key]);
const observations = [],
  evaluations = [];
const operational = [];
let processCompleted = false;
const executor = new ProcessExecutor(
  { executable: process.execPath, args, id: "codex-adapter-smoke" },
  {
    observeEvent(event) {
      operational.push({ event, beforeProcessCompletion: !processCompleted });
    },
    observe(o) {
      processCompleted = true;
      observations.push(o);
    },
  },
);
const backend = new GitWorkspaceBackend(repo);
let workspace, canonical;
const started = Date.now();
const state = await simulateAsync(
  {
    name: "pure-function-smoke",
    objective: task,
    publicEvaluation: {
      description: "twice(n) returns n * 2; focused tests pass",
      criteria: [
        "Create twice.mjs and twice.test.mjs",
        "Zero, positive and negative inputs pass independently executed checks",
        "Publish changes through COMMIT effects",
      ],
    },
    hiddenEvaluation: { requiredText: "" },
    scripts: {},
  },
  { maxConcurrency: 1, maxSteps: 1 },
  executor,
  {
    evaluate() {
      let passed = false;
      try {
        assert.ok(workspace && canonical && canonical !== base);
        assert.equal(
          readFileSync(join(workspace, "twice.test.mjs"), "utf8").length > 0,
          true,
        );
        execFileSync(process.execPath, ["--test", "twice.test.mjs"], {
          cwd: workspace,
          stdio: "pipe",
        });
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "import assert from 'node:assert/strict'; import {twice} from './twice.mjs'; for (const n of [0, 1, -1, 7, -9]) assert.equal(twice(n), n * 2);",
          ],
          { cwd: workspace, stdio: "pipe" },
        );
        passed = true;
      } catch {
        /* Evaluation failure stays an evaluation outcome. */
      }
      const result = {
        passed,
        reason: passed
          ? "Focused tests and independent arithmetic checks passed on committed workspace"
          : "Fixture verification failed",
      };
      evaluations.push(result);
      return result;
    },
  },
  undefined,
  {
    perform(request) {
      const outcome = backend.perform(request);
      if (outcome.ok && request.type === "OPEN")
        workspace = outcome.artifact.worktree;
      if (outcome.ok && request.type === "COMMIT")
        canonical = outcome.artifact.ref;
      return outcome;
    },
  },
);
const evidence = observations.map((o) => {
  try {
    return JSON.parse(o.stderr);
  } catch {
    return null;
  }
});
const report = {
  directory,
  taskSha256: createHash("sha256").update(task).digest("hex"),
  tool: values.codex,
  version: evidence[0]?.version ?? null,
  model: values.model ?? null,
  runtimeOutcome: state.status,
  action: evidence[0]?.response?.action ?? null,
  effects: evidence[0]?.response?.effects ?? null,
  base,
  resultingCommit: canonical ?? null,
  evaluation: evaluations,
  wallTimeMs: Date.now() - started,
  usage: evidence[0]?.usage ?? null,
  monetaryCost: evidence[0]?.monetaryCost ?? null,
  adapterEvidence: evidence,
  operational,
  eventsBeforeCompletion: operational.filter(
    (o) => o.beforeProcessCompletion && o.event.kind !== "process",
  ).length,
};
writeFileSync(
  join(directory, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
writeFileSync(
  join(directory, "state.json"),
  JSON.stringify(state, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
assert.equal(
  state.status,
  "COMPLETED",
  "Real smoke failed; inspect retained evidence, do not proceed to a larger task",
);
assert.equal(git("rev-list", "--count", `${base}..${canonical}`), "1");
assert.equal(git("rev-parse", "HEAD"), base);
assert.equal(git("status", "--porcelain"), "");
assert.deepEqual(
  replay(state, {
    evaluate() {
      return evaluations[0];
    },
  }),
  state,
);
