import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PublicCriteria, State } from "../domain/index.js";
import type {
  Evaluation,
  Evaluator,
  EvaluationContext,
  EvaluationOperation,
  CheckResult,
} from "../evaluation/index.js";
import {
  ProcessExecutor,
  type ProcessConfig,
  type ProcessObservation,
} from "../executor/process.js";
import {
  CommandChecksEvaluator,
  validateChecks,
  type CommandChecksConfig,
} from "../evaluation/commands.js";
import { ProcessEvaluator } from "../evaluation/process.js";
import { OperationalFailure } from "../executor/protocol.js";
import { replay } from "../replay/index.js";

export type PublicEvaluatorConfig = {
  id: string;
  criteria: PublicCriteria;
} & (
  | { command: ProcessConfig; checks?: never; completionPolicy?: never }
  | (CommandChecksConfig & { command?: never })
);
export function validatePublicEvaluator(config: PublicEvaluatorConfig): void {
  if (!config || typeof config.id !== "string" || !config.id.trim())
    throw new Error("Explicit public/runtime evaluator id required");
  if (config.checks !== undefined) {
    if (config.command !== undefined)
      throw new Error("Choose process evaluator or public checks");
    validateChecks(config);
  } else {
    if (config.completionPolicy !== undefined)
      throw new Error("completionPolicy requires checks");
    new ProcessExecutor(config.command);
  }
  if (
    typeof config.criteria?.description !== "string" ||
    !Array.isArray(config.criteria.criteria) ||
    !config.criteria.criteria.every((c) => typeof c === "string")
  )
    throw new Error("Explicit public evaluation criteria required");
}
export interface EvaluationRecord {
  context: EvaluationContext;
  startedAt: string;
  completedAt: string;
  evaluation: Evaluation | null;
  checks: CheckResult[];
  process: ProcessObservation | null;
  error: string | null;
}
export function runtimeEvaluator(
  config: PublicEvaluatorConfig,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
  records: EvaluationRecord[],
  save: () => void,
): Evaluator {
  validatePublicEvaluator(config);
  return {
    evaluate(context) {
      const record: EvaluationRecord = {
        context: structuredClone(context),
        startedAt: new Date().toISOString(),
        completedAt: "",
        evaluation: null,
        checks: [],
        process: null,
        error: null,
      };
      try {
        const evaluator =
          config.checks !== undefined
            ? new CommandChecksEvaluator(config, env, timeout, (check) => {
                record.checks.push(check);
              })
            : new ProcessEvaluator(
                config.command,
                cwd,
                env,
                timeout,
                (process) => {
                  record.process = process;
                },
              );
        record.evaluation = evaluator.evaluate(context);
        return record.evaluation;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        throw new OperationalFailure({
          code: "PUBLIC_EVALUATOR_FAILED",
          message: record.error,
        });
      } finally {
        record.completedAt = new Date().toISOString();
        records.push(record);
        save();
      }
    },
  };
}
export function replayExperiment(directory: string) {
  const state: State = JSON.parse(
    readFileSync(join(directory, "state.json"), "utf8"),
  );
  const records: EvaluationRecord[] = JSON.parse(
    readFileSync(join(directory, "runtime-evaluations.json"), "utf8"),
  );
  const operations = state.events
    .filter((e) => e.type === "EVALUATION_OPERATION")
    .map((e) => e.data as EvaluationOperation);
  if (records.length !== operations.length)
    throw new Error("Replay public evaluation count mismatch");
  for (const [index, operation] of operations.entries()) {
    const record = records[index]!;
    if (
      !isDeepStrictEqual(record.context, operation.context) ||
      (operation.outcome.ok
        ? record.error !== null ||
          !isDeepStrictEqual(record.evaluation, operation.outcome.evaluation)
        : record.error !== operation.outcome.reason.message ||
          record.evaluation !== null) ||
      (record.evaluation?.checks &&
        !isDeepStrictEqual(record.checks, record.evaluation.checks))
    )
      throw new Error("Replay public evaluation mismatch");
  }
  return replay(state);
}
// Separate command, invoked only after the solver phase. Private input is never
// an argument of runExperiment, and this hook never rewrites runtime state.
export function evaluateAfterRun(
  directory: string,
  privatePath: string,
  command: ProcessConfig,
) {
  const run = resolve(directory);
  if (existsSync(join(run, "running")))
    throw new Error("Solver execution is still active");
  const result = JSON.parse(readFileSync(join(run, "result.json"), "utf8"));
  if (result.phase !== "finished" || !result.completedAt)
    throw new Error("Post-run evaluation requires a finished run");
  if (existsSync(join(run, "post-evaluation.json")))
    throw new Error("Post-run evaluation already recorded");
  const output = spawnSync(command.executable, command.args ?? [], {
    cwd: run,
    input:
      JSON.stringify({ runDirectory: run, privatePath: resolve(privatePath) }) +
      "\n",
    encoding: "utf8",
    shell: false,
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH },
  });
  const report = {
    completedAt: new Date().toISOString(),
    status: output.status,
    signal: output.signal,
    error: output.error?.message ?? null,
    stdout: output.stdout,
    stderr: output.stderr,
  };
  writeFileSync(
    join(run, "post-evaluation.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return report;
}
