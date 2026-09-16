import { authorityObject, parseAuthorityJson } from "../authority/json.js";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { runExperiment, type RunOptions } from "./run.js";
import { evaluateAfterRun, replayExperiment } from "./evaluation.js";
import type { Condition } from "./protocol.js";
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
export async function experimentCli(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      condition: { type: "string" },
      "verification-mode": { type: "string" },
      preregistration: { type: "string" },
      "evaluator-wall-time-ms": { type: "string" },
      source: { type: "string" },
      executor: { type: "string" },
      output: { type: "string" },
      "public-evaluator": { type: "string" },
      metadata: { type: "string" },
      steps: { type: "string" },
      budgets: { type: "string" },
      supervision: { type: "string" },
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
      "strpi experiment run <manifest> --condition H|S|T --verification-mode none|trusted-local --source <local-repo|URL> --executor <config.json> --public-evaluator <config.json> --output <directory> [--preregistration pilot.json] [--evaluator-wall-time-ms N] [--metadata config.json] [--steps N] [--budgets config.json] [--supervision config.json] [--concurrency 1] [--timeout-ms 60000]\nstrpi experiment replay <run-directory>\nstrpi experiment evaluate <run-directory> --private-data <path> --hook <command.json>",
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
      !values["verification-mode"] ||
      !values.source ||
      !values.executor ||
      !values.output ||
      !values["public-evaluator"]
    )
      throw new Error("Missing run configuration; use experiment --help");
    for (const name of Object.keys(values)) {
      if (
        args.filter(
          (arg) => arg === `--${name}` || arg.startsWith(`--${name}=`),
        ).length > 1
      )
        throw new Error(`Duplicate run option --${name}`);
    }
    const dedicated =
      values.preregistration &&
      authorityObject(
        parseAuthorityJson(readFileSync(values.preregistration)),
        "Preregistration",
      ).schemaVersion === 3;
    const readConfig = (path: string) =>
      dedicated ? parseAuthorityJson(readFileSync(path)) : read(path);
    const options: RunOptions = {
      manifest: target,
      condition: values.condition as Condition,
      verificationMode: values[
        "verification-mode"
      ] as RunOptions["verificationMode"],
      source: values.source,
      executor: readConfig(values.executor) as RunOptions["executor"],
      output: values.output,
      publicEvaluator: readConfig(
        values["public-evaluator"],
      ) as RunOptions["publicEvaluator"],
    };
    if (values.preregistration)
      options.preregistration = values.preregistration;
    if (values["evaluator-wall-time-ms"])
      options.evaluatorWallTimeMs = Number(values["evaluator-wall-time-ms"]);
    if (values.budgets)
      options.budgets = readConfig(values.budgets) as NonNullable<
        RunOptions["budgets"]
      >;
    if (values.supervision)
      options.supervision = readConfig(values.supervision) as NonNullable<
        RunOptions["supervision"]
      >;
    if (values.metadata)
      options.metadata = readConfig(values.metadata) as NonNullable<
        RunOptions["metadata"]
      >;
    if (values.steps) options.maxSteps = Number(values.steps);
    if (values.concurrency) options.maxConcurrency = Number(values.concurrency);
    if (values["timeout-ms"]) options.timeoutMs = Number(values["timeout-ms"]);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    let run;
    try {
      run = await runExperiment({ ...options, signal: controller.signal });
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
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
