import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { CommandCheckProcess } from "../src/evaluation/commands.js";
import { git, sha256 } from "../src/experiments/inputs.js";
import type { TrustedProcess } from "../src/experiments/preparation.js";
import type { TrustedLocalContract } from "../src/experiments/trusted-local-contract.js";
import {
  runSchema3Preflight,
  type Schema3PreflightEvidence,
} from "../scripts/p3/schema3-preflight.mts";
import { bindingFixture } from "./fixtures/p3/binding-fixture.js";

type Fixture = ReturnType<typeof bindingFixture>;

function installContract(f: Fixture, contract: TrustedLocalContract) {
  const bytes = JSON.stringify(contract);
  writeFileSync(join(f.runtime, f.pilot.trustedLocalContract.path), bytes);
  git(f.runtime, "add", f.pilot.trustedLocalContract.path);
  if (git(f.runtime, "status", "--porcelain"))
    git(f.runtime, "commit", "-m", "Fixture preflight authority");
  const pilot = {
    ...f.pilot,
    stirpiCommit: git(f.runtime, "rev-parse", "HEAD"),
    trustedLocalContract: {
      ...f.pilot.trustedLocalContract,
      sha256: sha256(bytes),
    },
  };
  writeFileSync(f.preregistration, JSON.stringify(pilot));
  return contract;
}

function processFake(
  contract: TrustedLocalContract,
  calls: { executable: string; args: string[] }[],
  options: { wrongImage?: boolean; cleanupFailure?: boolean } = {},
): TrustedProcess {
  return (executable, args) => {
    calls.push({ executable, args: [...args] });
    assert.equal(
      [executable, ...args].some((value) =>
        /codex|gpt-6-astra|adapter\.mjs|experiment run/i.test(value),
      ),
      false,
      `solver boundary reached: ${executable} ${args.join(" ")}`,
    );
    if (args[0] === "--version") return contract.toolchain.node.version;
    if (args.at(-1) === "--version") return contract.toolchain.npm.version;
    if (args[0] === "image")
      return JSON.stringify([
        options.wrongImage
          ? {
              Id: "sha256:" + "0".repeat(64),
              Os: "linux",
              Architecture: "amd64",
            }
          : {
              Id: contract.preparation.postgres.imageId,
              Os: "linux",
              Architecture: "arm64",
            },
      ]);
    if (args[0] === "run") return "fixture-container";
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Image: contract.preparation.postgres.imageId,
          NetworkSettings: {
            Ports: {
              "5432/tcp": [{ HostPort: "32123", HostIp: "127.0.0.1" }],
            },
          },
        },
      ]);
    if (args[0] === "rm" && options.cleanupFailure)
      throw new Error("fixture cleanup unavailable");
    return "fixture";
  };
}

function checkFake(calls: string[], failedId?: string): CommandCheckProcess {
  return (check) => {
    calls.push(check.id);
    return {
      status: check.id === failedId ? 1 : 0,
      signal: null,
      stdout: check.id,
      stderr: "",
      error: undefined,
    };
  };
}

function execute(
  f: Fixture,
  suffix: string,
  contract: TrustedLocalContract,
  processOptions: { wrongImage?: boolean; cleanupFailure?: boolean } = {},
  failedCheck?: string,
) {
  const processCalls: { executable: string; args: string[] }[] = [];
  const checkCalls: string[] = [];
  const report = runSchema3Preflight(
    {
      runtime: f.runtime,
      pilot: f.preregistration,
      source: f.source,
      output: join(f.directory, `schema3-${suffix}`),
      tools: f.tools,
    },
    {
      trustedProcess: processFake(contract, processCalls, processOptions),
      publicCheckProcess: checkFake(checkCalls, failedCheck),
    },
  );
  return { report, processCalls, checkCalls };
}

function evidence(report: Schema3PreflightEvidence) {
  return JSON.parse(
    readFileSync(
      join(report.output, "schema3-preflight-evidence.json"),
      "utf8",
    ),
  ) as Schema3PreflightEvidence;
}

test("schema-3 preflight-only verifies R, target transfer, pinned preparation, public checks and zero solver", () => {
  const f = bindingFixture();
  try {
    const contract = installContract(f, {
      ...structuredClone(f.contract),
      status: "unfrozen",
    });
    const { report, processCalls, checkCalls } = execute(f, "passed", contract);
    assert.equal(report.status, "passed");
    assert.equal(report.contract?.status, "unfrozen");
    assert.equal(
      report.runtime.pinnedCommit,
      git(f.runtime, "rev-parse", "HEAD"),
    );
    assert.equal(report.transfer?.head, contract.source.commit);
    assert.deepEqual(checkCalls, [
      "full-postgres-suite",
      "typecheck",
      "diff-check",
    ]);
    assert.equal(report.cleanup, "passed");
    assert.equal(report.executorInvocations, 0);
    assert.equal(report.modelInvocations, 0);
    assert.equal(report.lineagesCreated, 0);
    assert.ok(
      processCalls.some(
        ({ args }) =>
          args[0] === "run" &&
          args.includes("--pull=never") &&
          args.includes("--platform") &&
          args.includes("linux/arm64") &&
          args.includes("127.0.0.1::5432"),
      ),
    );
    assert.ok(processCalls.some(({ args }) => args[0] === "ci"));
    assert.ok(
      processCalls.some(
        ({ args }) => args[0] === "run" && args[1] === "typecheck",
      ),
    );
    assert.ok(
      processCalls.some(({ args }) =>
        args.some((arg) => arg.includes("require.resolve")),
      ),
    );
    assert.ok(
      processCalls.some(({ args }) =>
        args.some((arg) => arg.includes("CREATE EXTENSION IF NOT EXISTS")),
      ),
    );
    assert.deepEqual(evidence(report), report);
  } finally {
    f.close();
  }
});

test("schema-3 preflight-only fails closed on missing or drifting pins before target preparation", () => {
  for (const [name, mutate, pattern] of [
    [
      "missing-node",
      (contract: TrustedLocalContract) => {
        contract.toolchain.node.sha256 = null;
      },
      /node bytes mismatch\/missing/,
    ],
    [
      "npm-drift",
      (contract: TrustedLocalContract) => {
        contract.toolchain.npm.treeSha256 = "0".repeat(64);
      },
      /npm closure mismatch\/missing/,
    ],
  ] as const) {
    const f = bindingFixture();
    try {
      const contract = structuredClone(f.contract);
      mutate(contract);
      installContract(f, contract);
      const { report, processCalls, checkCalls } = execute(f, name, contract);
      assert.equal(report.status, "failed");
      assert.equal(report.primaryFailure?.category, "operational");
      assert.match(report.primaryFailure!.message, pattern);
      assert.equal(report.transfer, null);
      assert.equal(processCalls.length, 0);
      assert.equal(checkCalls.length, 0);
      assert.equal(report.executorInvocations, 0);
      assert.deepEqual(evidence(report), report);
    } finally {
      f.close();
    }
  }
});

test("schema-3 preflight-only distinguishes wrong image, failed public check and cleanup failure", () => {
  for (const scenario of ["image", "check", "cleanup"] as const) {
    const f = bindingFixture();
    try {
      const contract = installContract(f, structuredClone(f.contract));
      const { report, processCalls, checkCalls } = execute(
        f,
        scenario,
        contract,
        {
          wrongImage: scenario === "image",
          cleanupFailure: scenario === "cleanup",
        },
        scenario === "check" ? "typecheck" : undefined,
      );
      assert.equal(report.status, "failed");
      assert.equal(report.executorInvocations, 0);
      if (scenario === "image") {
        assert.equal(report.primaryFailure?.category, "operational");
        assert.match(report.primaryFailure!.message, /image ID\/platform/);
        assert.equal(checkCalls.length, 0);
        assert.equal(
          processCalls.some(({ args }) => args[0] === "run"),
          false,
        );
        assert.equal(report.cleanup, "passed");
      } else if (scenario === "check") {
        assert.equal(report.primaryFailure?.category, "public-check");
        assert.deepEqual(checkCalls, [
          "full-postgres-suite",
          "typecheck",
          "diff-check",
        ]);
        assert.equal(report.cleanup, "passed");
        assert.equal(report.cleanupFailure, null);
      } else {
        assert.equal(report.primaryFailure, null);
        assert.equal(report.cleanup, "failed");
        assert.equal(report.cleanupFailure?.category, "cleanup");
      }
      assert.deepEqual(evidence(report), report);
    } finally {
      f.close();
    }
  }
});
