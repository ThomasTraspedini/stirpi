import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PublicCriteria, State } from "../domain/index.js";
import type { Evaluation, Evaluator } from "../evaluation/index.js";
import type { ProcessConfig } from "../executor/process.js";
import { OperationalFailure } from "../executor/protocol.js";
import { replay } from "../replay/index.js";

export interface PublicEvaluatorConfig {
  id: string;
  criteria: PublicCriteria;
  command: ProcessConfig;
}
export interface EvaluationRecord {
  result: string;
  criteria: PublicCriteria;
  startedAt: string;
  completedAt: string;
  evaluation: Evaluation | null;
  error: string | null;
  status: number | null;
}
export function runtimeEvaluator(
  config: PublicEvaluatorConfig,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
  records: EvaluationRecord[],
  save: () => void,
): Evaluator {
  return {
    evaluate(result, criteria) {
      const record: EvaluationRecord = {
        result,
        criteria,
        startedAt: new Date().toISOString(),
        completedAt: "",
        evaluation: null,
        error: null,
        status: null,
      };
      try {
        const processResult = spawnSync(
          config.command.executable,
          config.command.args ?? [],
          {
            cwd,
            env,
            input: JSON.stringify({ result, criteria }) + "\n",
            encoding: "utf8",
            shell: false,
            timeout,
            maxBuffer: 1024 * 1024,
          },
        );
        record.status = processResult.status;
        if (processResult.error || processResult.status !== 0)
          throw new Error("Public evaluator process failed");
        const evaluation: Evaluation = JSON.parse(processResult.stdout);
        if (
          typeof evaluation?.passed !== "boolean" ||
          typeof evaluation.reason !== "string"
        )
          throw new Error("Invalid public evaluator response");
        record.evaluation = {
          passed: evaluation.passed,
          reason: evaluation.reason,
        };
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
  let cursor = 0;
  const verified = replay(state, {
    evaluate(result, criteria) {
      const record = records[cursor++];
      if (
        !record ||
        record.result !== result ||
        !isDeepStrictEqual(record.criteria, criteria)
      )
        throw new Error("Replay public evaluation mismatch");
      if (record.error)
        throw new OperationalFailure({
          code: "PUBLIC_EVALUATOR_FAILED",
          message: record.error,
        });
      if (!record.evaluation)
        throw new Error("Missing public evaluation outcome");
      return structuredClone(record.evaluation);
    },
  });
  if (cursor !== records.length)
    throw new Error("Replay has unused public evaluations");
  return verified;
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
