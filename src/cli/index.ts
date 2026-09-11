#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { simulate } from "../engine/index.js";
import { Store, jsonl } from "../persistence/index.js";
import { reference } from "../scenarios/index.js";
import { inspect, tree } from "../render/index.js";
import { replay } from "../replay/index.js";
import {
  GitArtifactBackend,
  assertExternalGitState,
} from "../artifacts/git.js";
import { ProcessExecutor, type ProcessConfig } from "../executor/process.js";
import { GitWorkspaceBackend } from "../artifacts/workspaces.js";
import { demoWork } from "../artifacts/demo.js";
import type { Scenario } from "../domain/index.js";
import { experimentCli } from "../experiments/cli.js";
function main(): void {
  if (process.argv[2] === "experiment")
    return experimentCli(process.argv.slice(3));
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      executor: { type: "string" },
      repo: { type: "string" },
      db: { type: "string", default: "stirpi.sqlite" },
      task: { type: "string" },
      id: { type: "string", default: "run-1" },
      concurrency: { type: "string", default: "1" },
      steps: { type: "string", default: "100" },
      export: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(
      "strpi run <reference|git-reference|scenario.json> [--id run-1] [--task task-id] [--db stirpi.sqlite] [--repo target-repository] [--executor process-config.json] [--concurrency 1] [--steps 100]\nstrpi tree <run> [--db path]\nstrpi inspect <run|run:lineage> [--db path]\nstrpi replay <run> [--db path] [--export events.jsonl]",
    );
    return;
  }
  if (!["run", "tree", "inspect", "replay"].includes(command) || !target)
    throw new Error(
      "Expected run, tree, inspect or replay and a target; use --help",
    );
  if (command === "run" && target === "git-reference" && !values.repo)
    throw new Error("git-reference requires --repo");
  if (command === "run" && values.repo)
    assertExternalGitState(values.repo, [
      values.db!,
      ...(values.export ? [values.export] : []),
    ]);
  if (command === "run" && values.executor && !values.repo)
    throw new Error("--executor requires --repo");
  const store = new Store(values.db!);
  try {
    if (command === "run") {
      const scenario: Scenario =
        target === "reference" || target === "git-reference"
          ? reference
          : JSON.parse(readFileSync(target, "utf8"));
      const state = simulate(
        scenario,
        {
          maxConcurrency: Number(values.concurrency),
          maxSteps: Number(values.steps),
        },
        values.executor
          ? new ProcessExecutor(
              JSON.parse(
                readFileSync(values.executor, "utf8"),
              ) as ProcessConfig,
            )
          : undefined,
        undefined,
        {
          runId: values.id!,
          taskId: values.task ?? `task:${scenario.name}`,
        },
        values.repo
          ? values.executor
            ? new GitWorkspaceBackend(values.repo)
            : new GitArtifactBackend(
                values.repo,
                target === "git-reference" ? demoWork : undefined,
              )
          : undefined,
      );
      store.save(state);
      if (values.export) writeFileSync(values.export, jsonl(state));
      console.log(
        `${values.id}: ${state.status}; ${state.resources.steps} steps\n${tree(state)}`,
      );
      if (state.artifactOperations) {
        console.log(
          JSON.stringify(
            {
              artifacts: state.work.map((w) => ({
                work: w.name,
                status: w.status,
                reason: w.reason,
                artifact: w.artifact,
              })),
            },
            null,
            2,
          ),
        );
      }
      return;
    }
    const [id, lineageId] = target.split(":");
    const state = store.load(id!);
    if (command === "tree") console.log(tree(state));
    else if (command === "inspect")
      console.log(JSON.stringify(inspect(state, lineageId), null, 2));
    else {
      replay(state);
      console.log(
        `Replay verified: ${state.events.length} ordered events and identical state`,
      );
    }
    if (values.export) writeFileSync(values.export, jsonl(state));
  } finally {
    store.close();
  }
}
try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
