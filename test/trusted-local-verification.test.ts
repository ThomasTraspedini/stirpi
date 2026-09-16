import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { invocationFrom } from "../adapters/codex/contract.mjs";
import { TrustedLocalVerification } from "../src/experiments/trusted-local-verification.js";

test("trusted-local evidence with measured duration crosses the Codex invocation boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "stirpi-trusted-local-contract-"));
  writeFileSync(join(root, "candidate.txt"), "candidate\n");
  const times = [100.25, 101.5];
  try {
    const runtime = new TrustedLocalVerification(
      [{ id: "typecheck", executable: "npm", args: ["run", "typecheck"] }],
      {
        prepare() {},
        verificationEnvironment() {
          return { PATH: process.env.PATH };
        },
      },
      { PATH: process.env.PATH },
      undefined,
      () => ({
        status: 0,
        signal: null,
        stdout: "passed",
        stderr: "",
        error: undefined,
      }),
      () => times.shift()!,
    );
    const operation = runtime.perform("typecheck", "w1", root);
    assert.equal(operation.outcome.ok, true);
    if (!operation.outcome.ok) return;
    const evidence = operation.outcome.evidence;
    assert.equal(evidence.durationMs, 2);
    assert.equal(Number.isSafeInteger(evidence.durationMs), true);
    assert.ok(evidence.durationMs >= 0);

    const projected = invocationFrom(
      JSON.stringify({
        version: 1,
        context: {
          work: {
            id: "w1",
            objective: "verify candidate",
            artifact: { worktree: root, cleaned: false },
          },
          dna: [],
          publicEvaluation: {
            description: "Public checks",
            criteria: ["Typecheck passes"],
          },
          results: [],
          verification: {
            available: runtime.available(),
            latest: [evidence],
          },
        },
      }),
    );
    assert.deepEqual(projected.context.verification.latest, [evidence]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted-local attempts are scoped by work and check while workspace digests stay bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "stirpi-trusted-local-test-"));
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "candidate.txt"), "first\n");
  writeFileSync(join(second, "candidate.txt"), "second\n");
  const prepared: string[] = [];
  try {
    const runtime = new TrustedLocalVerification(
      [
        {
          id: "full-postgres-suite",
          executable: "npm",
          args: ["test"],
        },
      ],
      {
        prepare(workspace) {
          prepared.push(workspace);
        },
        verificationEnvironment() {
          return {
            PATH: process.env.PATH,
            DATABASE_URL: "postgresql://secret@localhost/db",
          };
        },
      },
      { PATH: process.env.PATH },
      1000,
      (_check, options) => ({
        status: 1,
        signal: null,
        stdout: `${options.env.DATABASE_URL}\n\u001b[31m` + "x".repeat(70_000),
        stderr: "negative",
        error: undefined,
      }),
    );
    const operations = [
      runtime.perform("full-postgres-suite", "w1", first),
      runtime.perform("full-postgres-suite", "w1", first),
      runtime.perform("full-postgres-suite", "w2", second),
    ];
    assert.deepEqual(runtime.available(), ["full-postgres-suite"]);
    assert.deepEqual(
      operations.map((operation) =>
        operation.outcome.ok ? operation.outcome.evidence.attempt : null,
      ),
      [1, 2, 1],
    );
    assert.equal(
      operations[0]!.request.workspaceDigest,
      operations[1]!.request.workspaceDigest,
    );
    assert.notEqual(
      operations[0]!.request.workspaceDigest,
      operations[2]!.request.workspaceDigest,
    );
    assert.ok(operations.every((operation) => operation.outcome.ok));
    if (!operations[0]!.outcome.ok) return;
    assert.equal(operations[0]!.outcome.evidence.passed, false);
    assert.equal(
      operations[0]!.outcome.evidence.stdout.includes("secret"),
      false,
    );
    assert.equal(
      operations[0]!.outcome.evidence.stdout.includes("\u001b"),
      false,
    );
    assert.equal(operations[0]!.outcome.evidence.stdoutTruncated, true);
    assert.deepEqual(prepared, [first, first, second]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted-local launch and preparation errors are operational failures", () => {
  const root = mkdtempSync(join(tmpdir(), "stirpi-trusted-local-failure-"));
  writeFileSync(join(root, "candidate.txt"), "candidate\n");
  try {
    const runtime = new TrustedLocalVerification(
      [{ id: "typecheck", executable: "npm", args: ["run", "typecheck"] }],
      {
        prepare() {},
        verificationEnvironment() {
          return { PATH: process.env.PATH };
        },
      },
      { PATH: process.env.PATH },
      undefined,
      () => ({
        status: null,
        signal: null,
        stdout: "",
        stderr: "DATABASE_URL=postgresql://secret@localhost/db",
        error: new Error("launch failed"),
      }),
    );
    const operation = runtime.perform("typecheck", "w1", root);
    assert.equal(operation.outcome.ok, false);
    if (operation.outcome.ok) return;
    assert.equal(
      operation.outcome.reason.code,
      "TRUSTED_LOCAL_VERIFICATION_FAILED",
    );
    assert.equal(operation.outcome.reason.message.includes("secret"), false);
    const unknown = runtime.perform("forged", "w1", root);
    assert.equal(unknown.outcome.ok, false);
    if (unknown.outcome.ok) return;
    assert.equal(unknown.outcome.reason.code, "UNKNOWN_VERIFICATION_ID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
