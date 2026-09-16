import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandChecksEvaluator,
  ProcessEvaluator,
  OperationalFailure,
  simulate,
  replay,
  type CheckResult,
  type EvaluationContext,
} from "../src/index.js";
import {
  validatePublicEvaluator,
  type PublicEvaluatorConfig,
} from "../src/experiments/evaluation.js";
import { reference } from "../src/scenarios/index.js";
const criteria = {
  description: "Public verification",
  criteria: ["Checks pass"],
};
const check = {
  id: "check",
  executable: process.execPath,
  args: ["-e", "process.exit(0)"],
};
const config = {
  id: "public",
  criteria,
  checks: [check],
  completionPolicy: "all_checks_pass" as const,
};

test("structured public configuration validates; incomplete frozen D032 config is reported unchanged", () => {
  assert.doesNotThrow(() => validatePublicEvaluator(config));
  const path = "docs/experiments/d032/public-evaluator.json";
  const before = readFileSync(path);
  const frozen = JSON.parse(before.toString());
  assert.equal(frozen.completionPolicy, "all_checks_pass");
  assert.throws(
    () => validatePublicEvaluator(frozen),
    /executable and string args/,
  );
  assert.equal(frozen.criteria, undefined);
  assert.ok(
    frozen.checks.every(
      (c: { command: string }) => typeof c.command === "string",
    ),
  );
  assert.deepEqual(readFileSync(path), before);
  for (const invalid of [
    { ...config, checks: [] },
    { ...config, checks: [check, check] },
    { ...config, completionPolicy: "any" },
    { ...config, checks: [{ ...check, workingDirectory: "/unrelated" }] },
    { ...config, criteria: undefined },
    { ...config, command: { executable: "unused" } },
  ])
    assert.throws(() =>
      validatePublicEvaluator(invalid as PublicEvaluatorConfig),
    );
});

test("external JSON evaluator compares canonical candidate paths and rejects different paths", () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "stirpi-evaluation-")),
  );
  try {
    const workspace = join(directory, "workspace");
    const alias = join(directory, "alias");
    const other = join(directory, "other");
    mkdirSync(workspace);
    mkdirSync(other);
    symlinkSync(workspace, alias, "junction");
    const context: EvaluationContext = {
      result: "not a path",
      criteria,
      workId: "w1",
      lineageId: "l1",
      artifactRef: "canonical",
      workspacePath: alias,
    };
    const evaluator = new ProcessEvaluator(
      {
        executable: process.execPath,
        args: [
          "-e",
          `
      const { readFileSync, realpathSync } = require('node:fs');
      const c = JSON.parse(readFileSync(0, 'utf8'));
      console.log(JSON.stringify({passed: realpathSync(process.cwd()) === realpathSync(c.workspacePath ?? c.result), reason: JSON.stringify(c)}));
    `,
        ],
      },
      other,
      { PATH: process.env.PATH },
      5000,
    );
    const outcome = evaluator.evaluate(context);
    assert.equal(outcome.passed, true);
    assert.deepEqual(JSON.parse(outcome.reason), context);
    // Compare an independently supplied path against the fallback cwd.
    const withoutWorkspace = { ...context };
    delete withoutWorkspace.workspacePath;
    assert.equal(
      evaluator.evaluate({ ...withoutWorkspace, result: alias }).passed,
      false,
    );
    assert.equal(
      evaluator.evaluate({ ...withoutWorkspace, result: other }).passed,
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checks require active artifact context and bound process output and time", () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "stirpi-evaluation-")),
  );
  const context: EvaluationContext = {
    result: directory,
    criteria,
    workId: "w1",
    lineageId: "l1",
    artifactRef: "canonical",
  };
  try {
    assert.throws(
      () => new CommandChecksEvaluator(config).evaluate(context),
      OperationalFailure,
    );
    assert.throws(
      () =>
        new CommandChecksEvaluator(config).evaluate({
          ...context,
          workspacePath: join(directory, "missing"),
        }),
      OperationalFailure,
    );
    const outputs: CheckResult[] = [];
    const bounded = new CommandChecksEvaluator(
      {
        ...config,
        checks: [
          {
            ...check,
            args: [
              "-e",
              "require('fs').writeSync(1, Buffer.alloc(2 * 1024 * 1024, 'x'))",
            ],
          },
        ],
      },
      {},
      5000,
      (result) => outputs.push(result),
    );
    assert.throws(
      () => bounded.evaluate({ ...context, workspacePath: directory }),
      OperationalFailure,
    );
    assert.equal(outputs[0]!.passed, false);
    assert.equal(outputs[0]!.processStatus, "operational_error");
    assert.ok(outputs[0]!.stdout.length <= 1048576);
    assert.equal(outputs[0]!.outputTruncated, true);
    const timeout = new CommandChecksEvaluator(
      { ...config, checks: [{ ...check, args: ["-e", "while(true) {}"] }] },
      {},
      100,
      (result) => outputs.push(result),
    );
    assert.throws(
      () => timeout.evaluate({ ...context, workspacePath: directory }),
      OperationalFailure,
    );
    assert.match(outputs[1]!.error!, /ETIMEDOUT/);
    const redacted = new CommandChecksEvaluator(
      config,
      {},
      5000,
      (result) => outputs.push(result),
      () => ({
        status: 0,
        signal: null,
        stdout: "DATABASE_URL=postgresql://secret@localhost/db\n\u001b[31mok",
        stderr: "",
        error: undefined,
      }),
    ).evaluate({ ...context, workspacePath: directory });
    assert.equal(redacted.passed, true);
    assert.equal(outputs[2]!.stdout.includes("secret"), false);
    assert.equal(outputs[2]!.stdout.includes("\u001b"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("engine context is allowlisted and replay consumes recorded evaluation without invoking it", () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "stirpi-evaluation-")),
  );
  try {
    const marker = join(directory, "calls");
    const contexts: EvaluationContext[] = [];
    const state = simulate(reference, undefined, undefined, {
      evaluate(context) {
        contexts.push(context);
        writeFileSync(marker, "called");
        return { passed: true, reason: "fixture" };
      },
    });
    assert.ok(contexts.length > 0);
    for (const context of contexts) {
      assert.deepEqual(Object.keys(context).sort(), [
        "criteria",
        "lineageId",
        "result",
        "workId",
      ]);
      assert.deepEqual(context.criteria, reference.publicEvaluation);
    }
    rmSync(marker);
    assert.deepEqual(replay(state), state);
    assert.throws(() => readFileSync(marker));
    const tampered = structuredClone(state);
    tampered.events = tampered.events.filter(
      (e) => e.type !== "EVALUATION_OPERATION",
    );
    assert.throws(() => replay(tampered), /Replay mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
