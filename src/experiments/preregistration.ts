import {
  bindTrustedLocal,
  assertLocalOptions,
} from "./trusted-local-contract.js";
import {
  defaultLocalTools,
  verifyLocalTools,
} from "./trusted-local-identity.js";
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
import { parseVerificationProfilePin } from "../verification/preflight.js";
import {
  authorityObject,
  closedAuthorityObject,
  parseAuthorityJson,
} from "../authority/json.js";
import { validatePreregisteredProfile } from "./profile-authority.js";

/** Parses the additive schema-2 profile pin without treating historical pilots as profile-backed. */
export const schema2VerificationProfile = parseVerificationProfilePin;

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
  const pilot = authorityObject(
    parseAuthorityJson(bytes),
    "Preflight: preregistration",
  );
  if (pilot.schemaVersion === 3) {
    const localTools = options.trustedLocalTools ?? defaultLocalTools();
    const binding = bindTrustedLocal(
      pilot,
      process.cwd(),
      false,
      localTools.git,
    );
    const contract = binding.contract;
    assertLocalOptions(options, contract, process.cwd(), localTools.git);
    if (pilot.condition !== options.condition || testcase !== contract.testcase)
      throw new Error("Preflight: trusted-local condition/testcase mismatch");
    const tools = verifyLocalTools(contract, localTools);
    const derived = pilotEnvelope(contract.limits);
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
    const args = options.executor.args ?? [];
    const adapter = resolve(process.cwd(), contract.executor.adapterPath);
    const expected = [
      adapter,
      "--codex",
      args[2],
      "--model",
      contract.executor.model,
      "--effort",
      contract.executor.effort,
      "--timeout-ms",
      String(contract.executor.timeoutMs),
    ];
    const auth =
      args.length === 11 &&
      args[9] === "--auth-file" &&
      typeof args[10] === "string" &&
      args[10].startsWith("/")
        ? args.slice(9)
        : [];
    if (
      !args[2]?.startsWith("/") ||
      !isDeepStrictEqual(args, [...expected, ...auth]) ||
      sha256(readFileSync(options.executor.executable)) !==
        contract.toolchain.node.sha256 ||
      Object.keys(options.executor).some(
        (k) => !["id", "executable", "args"].includes(k),
      )
    )
      throw new Error(
        "Preflight: trusted-local executor override/adapter mismatch",
      );
    const executor = verifyExecutor(
      { ...options.executor, executable: tools.node },
      {
        adapter: contract.executor.adapter,
        executableVersion: contract.executor.executableVersion,
        executableSha256: contract.executor.executableSha256,
      },
    );
    return {
      options: {
        ...options,
        ...derived,
        maxConcurrency: 1,
        executor: executor.command,
        metadata: {
          model: contract.executor.model,
          effort: contract.executor.effort,
        },
        trustedLocalTools: tools,
      },
      evidence: {
        verified: true,
        executor: executor.evidence,
        preregistration: {
          path: resolve(options.preregistration),
          sha256: sha256(bytes),
          document: pilot,
          schemaVersion: 3,
          verificationProfile: null,
        },
        preregisteredLimits: contract.limits,
        budgets: derived.budgets,
        supervision: derived.supervision,
        evaluator: {
          wallTimeMs: derived.evaluatorWallTimeMs ?? null,
          scope: "per-public-evaluator-process",
        },
        trustedLocal: {
          contractSha256: sha256(binding.bytes),
          contents: binding.bytes.toString("utf8"),
          contract,
          inputs: Object.fromEntries(
            Object.entries(binding.inputs).map(([key, value]) => [
              key,
              { contents: value.toString("utf8"), sha256: sha256(value) },
            ]),
          ),
          tools,
        },
      },
    };
  }
  const schema2 = pilot?.schemaVersion === 2;
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
    ...(schema2 ? ["schemaVersion", "verificationProfile"] : []),
  ];
  for (const field of Object.keys(pilot))
    if (!fields.includes(field))
      throw new Error(`Preflight: unsupported pilot field ${field}`);
  if ("schemaVersion" in pilot && !schema2)
    throw new Error("Preflight: unsupported preregistration schema");
  const verificationProfile = schema2
    ? validatePreregisteredProfile(pilot, process.cwd())
    : null;
  if (
    schema2 &&
    Object.hasOwn(
      authorityObject(pilot.limits, "Preflight: limits"),
      "maxEvaluatorWallTimeMs",
    )
  )
    throw new Error(
      "Preflight: schema-2 evaluator wall-time belongs to profile operations",
    );
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
    const pin = closedAuthorityObject(
      pilot.publicEvaluator,
      ["file", "sha256"],
      "Preflight: public evaluator pin",
    );
    if (!pin || typeof pin.file !== "string" || typeof pin.sha256 !== "string")
      throw new Error("Preflight: invalid public evaluator pin");
    const evaluatorBytes = readFileSync(
      resolve(dirname(options.preregistration), pin.file),
    );
    if (
      sha256(evaluatorBytes) !== pin.sha256 ||
      !isDeepStrictEqual(
        parseAuthorityJson(evaluatorBytes),
        options.publicEvaluator,
      )
    )
      throw new Error("Preflight: public evaluator pin mismatch");
  }
  if (schema2 && pilot.executor !== undefined) {
    const executorPin = authorityObject(
      pilot.executor,
      "Preflight: executor pin",
    );
    if (
      Object.keys(executorPin).some(
        (key) =>
          !["adapter", "executableVersion", "executableSha256"].includes(key),
      )
    )
      throw new Error("Preflight: unknown executor pin field");
  }
  const executor = verifyExecutor(
    options.executor,
    pilot.executor as Parameters<typeof verifyExecutor>[1],
  );
  const executorConfiguration = executor.evidence.configuration;
  if (
    executorConfiguration &&
    ((options.metadata?.model !== undefined &&
      options.metadata.model !== executorConfiguration.model) ||
      (options.metadata?.effort !== undefined &&
        options.metadata.effort !== executorConfiguration.effort))
  )
    throw new Error(
      "Preflight: metadata model/effort contradict Codex executor configuration",
    );
  const effective = {
    ...options,
    ...derived,
    executor: executor.command,
    ...(executorConfiguration
      ? {
          metadata: {
            ...options.metadata,
            model: executorConfiguration.model,
            effort: executorConfiguration.effort,
          },
        }
      : {}),
  };
  const evidence = {
    verified: true,
    executor: executor.evidence,
    preregistration: {
      path: resolve(options.preregistration),
      sha256: sha256(bytes),
      document: pilot,
      schemaVersion: schema2 ? 2 : 1,
      verificationProfile,
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
