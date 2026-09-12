import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pilotEnvelope } from "../src/experiments/preregistration.js";
import { runtimeEvaluator } from "../src/experiments/evaluation.js";

test("pilot limits map exactly to structured policies without aliases or defaults", () => {
  assert.deepEqual(
    pilotEnvelope({
      maxSteps: 20,
      maxExecutorInvocations: 19,
      maxLineages: 3,
      maxItemsPerInvocation: 8,
      maxCommandsPerInvocation: 5,
      maxWallTimePerInvocationMs: 400,
      noProgressMs: 200,
      maxEvaluatorWallTimeMs: 900,
    }),
    {
      budgets: { steps: 20, invocations: 19, lineages: 3 },
      supervision: {
        budgets: { items: 8, commands: 5, wallTimeMs: 400 },
        noProgressMs: 200,
      },
      evaluatorWallTimeMs: 900,
    },
  );
  assert.deepEqual(pilotEnvelope({}), {
    budgets: {},
    supervision: { budgets: {} },
  });
  assert.deepEqual(pilotEnvelope({ maxSteps: 0 }), {
    budgets: { steps: 0 },
    supervision: { budgets: {} },
  });
  for (const limits of [
    { timeoutMs: 10 },
    { tokens: 1 },
    { maxSteps: -1 },
    { maxSteps: null },
    { noProgressMs: 0 },
    { maxEvaluatorWallTimeMs: 0 },
    [],
    null,
  ])
    assert.throws(() => pilotEnvelope(limits), /Preflight/);
});

test("both public evaluator protocols receive independent explicit or disabled wall time", (t) => {
  const timeouts: unknown[] = [];
  t.mock.method(
    childProcess,
    "spawnSync",
    (_exe: string, _args: string[], options: { timeout?: number }) => {
      timeouts.push(options.timeout);
      return {
        status: 0,
        signal: null,
        stdout: '{"passed":true,"reason":"ok"}',
        stderr: "",
      };
    },
  );
  syncBuiltinESMExports();
  try {
    for (const checks of [false, true]) {
      for (const limits of [
        { maxWallTimePerInvocationMs: 1 },
        { maxWallTimePerInvocationMs: 1, maxEvaluatorWallTimeMs: 123 },
      ]) {
        const envelope = pilotEnvelope(limits);
        const criteria = { description: "fixture", criteria: [] };
        const config = checks
          ? {
              id: "fixture",
              criteria,
              checks: [{ id: "check", executable: "fixture", args: [] }],
              completionPolicy: "all_checks_pass" as const,
            }
          : { id: "fixture", criteria, command: { executable: "fixture" } };
        runtimeEvaluator(
          config,
          "/tmp",
          {},
          envelope.evaluatorWallTimeMs,
          [],
          () => {},
        ).evaluate({
          workId: "work",
          lineageId: "lineage",
          artifactRef: "fixture",
          workspacePath: "/tmp",
          criteria,
          result: { text: "done" },
        });
      }
    }
    assert.deepEqual(timeouts, [undefined, 123, undefined, 123]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
