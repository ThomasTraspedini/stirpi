import { parseTrustedLocalContract } from "./trusted-local-contract.js";
import { sha256 } from "./inputs.js";
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
  type CommandCheckProcess,
} from "../evaluation/commands.js";
import { ProcessEvaluator } from "../evaluation/process.js";
import { OperationalFailure } from "../executor/protocol.js";
import type { ExecutorOperation } from "../executor/protocol.js";
import { replay } from "../replay/index.js";
import {
  experimentAccounting,
  type ExecutorInvocationRecord,
  type IndexedOperationalObservation,
} from "./accounting.js";

const jsonLines = (path: string): unknown[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

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
  timeout: number | undefined,
  records: EvaluationRecord[],
  save: () => void,
  checkEnvironment?: (
    workspace: string,
    check: import("../evaluation/commands.js").PublicCheck,
  ) => NodeJS.ProcessEnv,
  checkProcess?: CommandCheckProcess,
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
            ? new CommandChecksEvaluator(
                config,
                checkEnvironment ?? env,
                timeout,
                (check) => {
                  record.checks.push(check);
                },
                checkProcess,
              )
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
  const resultPath = join(directory, "result.json");
  const result = existsSync(resultPath)
    ? JSON.parse(readFileSync(resultPath, "utf8"))
    : null;
  if (result) {
    if (result.evidence?.preparation) {
      const bytes = readFileSync(join(directory, "preparation.json"));
      if (sha256(bytes) !== result.evidence.preparationSha256)
        throw new Error("Replay preparation evidence mismatch");
      // Evidence is an observation, never a request to repeat external effects.
      JSON.parse(bytes.toString());
    }
  }
  const metadata = JSON.parse(
    readFileSync(join(directory, "metadata.json"), "utf8"),
  );
  if (metadata.preflight?.runtime) {
    const evidence = JSON.parse(
      readFileSync(join(directory, "preflight.json"), "utf8"),
    );
    const registration = evidence.preregistration;
    if (
      !isDeepStrictEqual(metadata.preflight, evidence) ||
      evidence.runtime.actualCommit !== evidence.runtime.pinnedCommit ||
      evidence.runtime.pinnedCommit !== registration.document.stirpiCommit ||
      !/^[a-f0-9]{40}$/.test(registration.containingCommit) ||
      sha256(registration.contents) !== registration.sha256 ||
      !isDeepStrictEqual(
        JSON.parse(registration.contents),
        registration.document,
      )
    )
      throw new Error("Replay experiment/runtime identity mismatch");
  }
  const local = metadata.preflight?.trustedLocal;
  if (local) {
    const contract = parseTrustedLocalContract(local.contents);
    if (
      sha256(local.contents) !== local.contractSha256 ||
      !isDeepStrictEqual(contract, local.contract) ||
      metadata.preflight.preregistration.document.trustedLocalContract
        .sha256 !== local.contractSha256
    )
      throw new Error("Replay trusted-local contract mismatch");
    for (const [key, pin] of Object.entries(contract.inputs)) {
      const input = local.inputs[key];
      if (
        !input ||
        input.sha256 !== pin.sha256 ||
        sha256(input.contents) !== pin.sha256
      )
        throw new Error("Replay trusted-local input mismatch");
    }
    if (
      sha256(readFileSync(join(directory, "task.txt"))) !==
      contract.inputs.task.sha256
    )
      throw new Error("Replay trusted-local task mismatch");
    const promptRecords = jsonLines(join(directory, "invocations.jsonl")) as {
      type: string;
      index: number;
      effectivePromptIdentity?: {
        taskSha256: string;
        governanceSha256: string;
        promptSha256: string;
      };
      input?: { governance?: { text: string; sha256: string } };
      governanceSha256?: string;
      prompt?: string;
      promptSha256?: string;
    }[];
    for (const record of promptRecords) {
      if (record.type !== "started") continue;
      if (
        !isDeepStrictEqual(record.input?.governance, {
          text: local.inputs.governance.contents,
          sha256: contract.inputs.governance.sha256,
        }) ||
        record.governanceSha256 !== contract.inputs.governance.sha256 ||
        typeof record.prompt !== "string" ||
        sha256(record.prompt) !== record.promptSha256 ||
        !record.prompt.includes(local.inputs.governance.contents)
      )
        throw new Error("Replay trusted-local governance/prompt mismatch");
      if (
        promptRecords.some(
          (row) => row.type === "returned" && row.index === record.index,
        ) &&
        !isDeepStrictEqual(
          promptRecords.find(
            (row) => row.type === "process" && row.index === record.index,
          )?.effectivePromptIdentity,
          {
            taskSha256: contract.inputs.task.sha256,
            governanceSha256: contract.inputs.governance.sha256,
            promptSha256: record.promptSha256,
          },
        )
      )
        throw new Error("Replay trusted-local effective prompt mismatch");
    }
  }
  const state: State = JSON.parse(
    readFileSync(join(directory, "state.json"), "utf8"),
  );
  const records: EvaluationRecord[] = JSON.parse(
    readFileSync(join(directory, "runtime-evaluations.json"), "utf8"),
  );
  const evaluationOperations = state.events
    .filter((e) => e.type === "EVALUATION_OPERATION")
    .map((e) => e.data as EvaluationOperation);
  if (records.length !== evaluationOperations.length)
    throw new Error("Replay public evaluation count mismatch");
  for (const [index, operation] of evaluationOperations.entries()) {
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
  const invocationPath = join(directory, "invocations.jsonl");
  const invocations = jsonLines(invocationPath)
    .filter(
      (record): record is Record<string, unknown> =>
        !!record &&
        typeof record === "object" &&
        (record as Record<string, unknown>).type === "started",
    )
    .map((record, position): ExecutorInvocationRecord => {
      const index = record.index;
      const workId = record.workId;
      const lineageId = record.lineageId;
      if (
        index !== position + 1 ||
        typeof workId !== "string" ||
        typeof lineageId !== "string"
      )
        throw new Error("Replay invocation evidence mismatch");
      return { index, workId, lineageId };
    });
  const executorOperations = state.events
    .filter((event) => event.type === "EXECUTOR_OPERATION")
    .map((event) => event.data as ExecutorOperation);
  if (invocations.length !== executorOperations.length)
    throw new Error("Replay invocation/state evidence mismatch");
  for (const [position, invocation] of invocations.entries()) {
    const operation = executorOperations[position]!;
    if (
      operation.context.work.id !== invocation.workId ||
      operation.context.work.lineageId !== invocation.lineageId
    )
      throw new Error("Replay invocation/state evidence mismatch");
  }
  const operationalPath = join(directory, "operational.jsonl");
  const expected = executorOperations.flatMap((operation, index) =>
    (operation.observations ?? []).map((event) => ({
      index: index + 1,
      event,
    })),
  );
  let recorded: IndexedOperationalObservation[] = [];
  if (existsSync(operationalPath)) {
    recorded = jsonLines(operationalPath) as IndexedOperationalObservation[];
    const ordered = expected.map((entry, index) => ({
      sequence: index + 1,
      ...entry,
    }));
    if (!isDeepStrictEqual(recorded, ordered))
      throw new Error("Replay operational evidence mismatch");
  } else throw new Error("Replay operational evidence missing");
  const accounting = experimentAccounting(
    invocations,
    recorded,
    state.lineages,
    state.work,
  );
  const reported = result?.resources;
  if (
    !reported ||
    !isDeepStrictEqual(
      {
        executorInvocations: reported.executorInvocations,
        logicalLineages: reported.logicalLineages,
        scheduledLineages: reported.scheduledLineages,
        lineageCounts: reported.lineageCounts,
        tokens: reported.tokens,
        usageCoverage: reported.usageCoverage,
      },
      {
        executorInvocations: invocations.length,
        logicalLineages: accounting.lineageCounts.created,
        scheduledLineages: accounting.lineageCounts.scheduled,
        lineageCounts: accounting.lineageCounts,
        tokens: accounting.tokens,
        usageCoverage: accounting.usageCoverage,
      },
    )
  )
    throw new Error("Replay experiment accounting mismatch");
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
