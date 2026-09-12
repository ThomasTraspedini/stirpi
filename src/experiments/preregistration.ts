import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { RunOptions } from "./run.js";
import { sha256 } from "./inputs.js";
import { verifyExecutor } from "./executor-identity.js";
import {
  validatePolicy,
  type RunBudgets,
  type InvocationPolicy,
} from "../supervision/index.js";

const runFields = {
  maxSteps: "steps",
  maxExecutorInvocations: "invocations",
  maxLineages: "lineages",
} as const;
const invocationFields = {
  maxItemsPerInvocation: "items",
  maxCommandsPerInvocation: "commands",
  maxWallTimePerInvocationMs: "wallTimeMs",
} as const;
export function pilotEnvelope(limits: unknown) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits))
    throw new Error("Preflight: limits must be an object");
  const values = limits as Record<string, number>;
  const supported = [
    ...Object.keys(runFields),
    ...Object.keys(invocationFields),
    "noProgressMs",
    "maxEvaluatorWallTimeMs",
  ];
  for (const [key, value] of Object.entries(values)) {
    if (!supported.includes(key))
      throw new Error(`Preflight: unsupported limit ${key}`);
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      ((key === "noProgressMs" || key === "maxEvaluatorWallTimeMs") &&
        value < 1) ||
      (key === "maxEvaluatorWallTimeMs" && value > 2147483647)
    )
      throw new Error(`Preflight: invalid limit ${key}`);
  }
  const budgets: RunBudgets = {};
  const supervision: InvocationPolicy = { budgets: {} };
  for (const [from, to] of Object.entries(runFields))
    if (values[from] !== undefined) budgets[to] = values[from];
  for (const [from, to] of Object.entries(invocationFields))
    if (values[from] !== undefined) supervision.budgets![to] = values[from];
  if (values.noProgressMs !== undefined)
    supervision.noProgressMs = values.noProgressMs;
  validatePolicy(supervision);
  return {
    budgets,
    supervision,
    ...(values.maxEvaluatorWallTimeMs !== undefined
      ? { evaluatorWallTimeMs: values.maxEvaluatorWallTimeMs }
      : {}),
  };
}

// Read once, validate before any execution, and retain the exact public input.
export function preregisteredOptions(options: RunOptions, testcase: string) {
  if (!options.preregistration) return { options, evidence: null };
  const bytes = readFileSync(options.preregistration);
  const pilot = JSON.parse(bytes.toString("utf8"));
  if (
    !pilot ||
    pilot.class !== "pilot" ||
    typeof pilot.id !== "string" ||
    !pilot.id ||
    pilot.testcase !== testcase ||
    pilot.condition !== options.condition ||
    pilot.hiddenEvaluationDuringRun !== false
  )
    throw new Error(
      "Preflight: contradictory or invalid pilot identity/condition/evaluation policy",
    );
  if (options.maxSteps !== undefined || options.timeoutMs !== undefined)
    throw new Error(
      "Preflight: compatibility aliases are forbidden for preregistered runs",
    );
  for (const field of [
    "budgets",
    "supervision",
    "evaluatorWallTimeMs",
    "maxSteps",
    "timeoutMs",
  ])
    if (field in pilot)
      throw new Error(`Preflight: unsupported duplicate policy ${field}`);
  const fields = [
    "id",
    "class",
    "testcase",
    "condition",
    "stirpiCommit",
    "executor",
    "publicEvaluator",
    "limits",
    "hiddenEvaluationDuringRun",
  ];
  for (const field of Object.keys(pilot))
    if (!fields.includes(field))
      throw new Error(`Preflight: unsupported pilot field ${field}`);
  const derived = pilotEnvelope(pilot.limits);
  for (const field of [
    "budgets",
    "supervision",
    "evaluatorWallTimeMs",
  ] as const)
    if (
      options[field] !== undefined &&
      !isDeepStrictEqual(options[field], derived[field])
    )
      throw new Error(`Preflight: contradictory ${field}`);
  if (pilot.publicEvaluator !== undefined) {
    const pin = pilot.publicEvaluator;
    if (!pin || typeof pin.file !== "string" || typeof pin.sha256 !== "string")
      throw new Error("Preflight: invalid public evaluator pin");
    const evaluatorBytes = readFileSync(
      resolve(dirname(options.preregistration), pin.file),
    );
    if (
      sha256(evaluatorBytes) !== pin.sha256 ||
      !isDeepStrictEqual(
        JSON.parse(evaluatorBytes.toString("utf8")),
        options.publicEvaluator,
      )
    )
      throw new Error("Preflight: public evaluator pin mismatch");
  }
  const executor = verifyExecutor(options.executor, pilot.executor);
  const effective = { ...options, ...derived, executor: executor.command };
  const evidence = {
    verified: true,
    executor: executor.evidence,
    preregistration: {
      path: resolve(options.preregistration),
      sha256: sha256(bytes),
      document: pilot,
    },
    preregisteredLimits: pilot.limits,
    budgets: derived.budgets,
    supervision: derived.supervision,
    evaluator: {
      wallTimeMs: derived.evaluatorWallTimeMs ?? null,
      scope: "per-public-evaluator-process",
    },
  };
  return { options: effective, evidence };
}
