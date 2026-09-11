import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { runExperiment, type RunOptions } from "./run.js";
import { evaluateAfterRun, replayExperiment } from "./evaluation.js";
import type { Condition } from "./protocol.js";
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
export function experimentCli(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      condition: { type: "string" },
      source: { type: "string" },
      executor: { type: "string" },
      output: { type: "string" },
      "public-evaluator": { type: "string" },
      metadata: { type: "string" },
      steps: { type: "string" },
      concurrency: { type: "string" },
      "timeout-ms": { type: "string" },
      "private-data": { type: "string" },
      hook: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(
      "strpi experiment run <manifest> --condition H|S|T --source <local-repo|URL> --executor <config.json> --public-evaluator <config.json> --output <directory> [--metadata config.json] [--steps 100] [--concurrency 1] [--timeout-ms 60000]\nstrpi experiment replay <run-directory>\nstrpi experiment evaluate <run-directory> --private-data <path> --hook <command.json>",
    );
    return;
  }
  if (!target || positionals.length !== 2)
    throw new Error("Expected command and one target; use experiment --help");
  if (command === "run") {
    if (values["private-data"] || values.hook)
      throw new Error(
        "Private evaluation is post-run only; use experiment evaluate",
      );
    if (
      !values.condition ||
      !values.source ||
      !values.executor ||
      !values.output ||
      !values["public-evaluator"]
    )
      throw new Error("Missing run configuration; use experiment --help");
    const options: RunOptions = {
      manifest: target,
      condition: values.condition as Condition,
      source: values.source,
      executor: read(values.executor),
      output: values.output,
      publicEvaluator: read(values["public-evaluator"]),
    };
    if (values.metadata) options.metadata = read(values.metadata);
    if (values.steps) options.maxSteps = Number(values.steps);
    if (values.concurrency) options.maxConcurrency = Number(values.concurrency);
    if (values["timeout-ms"]) options.timeoutMs = Number(values["timeout-ms"]);
    const run = runExperiment(options);
    console.log(
      JSON.stringify({
        directory: run.directory,
        outcome: run.result.runtimeOutcome,
        error: run.result.error,
      }),
    );
    if (run.result.error) process.exitCode = 1;
  } else if (command === "replay") {
    replayExperiment(target);
    console.log("Experiment replay verified without external execution");
  } else if (command === "evaluate") {
    if (!values["private-data"] || !values.hook)
      throw new Error("Post-run evaluation requires private-data and hook");
    const result = evaluateAfterRun(
      target,
      values["private-data"],
      read(values.hook),
    );
    console.log(JSON.stringify({ status: result.status, error: result.error }));
    if (result.status !== 0 || result.error) process.exitCode = 1;
  } else throw new Error("Unknown experiment command");
}
