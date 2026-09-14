import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TrustedPreparation,
  bookingPreparation,
  executorEnvironment,
  type TrustedProcess,
} from "../src/experiments/preparation.js";

test("trusted preparation, atomic port allocation, secret separation, fixed commands and cleanup", () => {
  const workspace = mkdtempSync(join(tmpdir(), "preparation-test-"));
  const calls: {
    executable: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  }[] = [];
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1",
      scripts: { test: "original" },
    }),
  );
  writeFileSync(join(workspace, "package-lock.json"), "{}");
  const run: TrustedProcess = (executable, args, cwd, env) => {
    assert.equal(cwd, workspace);
    calls.push({ executable, args, env });
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Image: "sha256:image",
          NetworkSettings: { Ports: { "5432/tcp": [{ HostPort: "49152" }] } },
        },
      ]);
    return "container-id";
  };
  try {
    const prep = new TrustedPreparation(bookingPreparation, () => {}, run);
    prep.prepare(workspace);
    prep.prepare(workspace);
    assert.equal(calls.filter((c) => c.args[0] === "ci").length, 1);
    assert.equal(prep.records[0]!.port, 49152);
    assert.ok(
      calls
        .find((c) => c.args[0] === "run" && c.executable === "docker")!
        .args.includes("127.0.0.1::5432"),
    );
    assert.deepEqual(
      prep.records[0]!.steps.map((s) => s.id),
      [
        "dependencies",
        "module-resolution",
        "typecheck",
        "postgres",
        "postgres-identity",
        "database-connectivity",
        "prerequisites",
      ],
    );
    assert.ok(calls.at(-1)!.args.at(-1)!.includes("btree_gist"));
    const base = executorEnvironment(workspace);
    assert.equal(base.DATABASE_URL, undefined);
    assert.equal(base.DOCKER_HOST, undefined);
    const check = { id: "test", executable: "npm", args: ["test"] };
    assert.ok(
      prep.verificationEnvironment(workspace, check, base).DATABASE_URL,
    );
    assert.equal(
      prep.verificationEnvironment(
        workspace,
        { id: "diff", executable: "git", args: ["diff", "--check"] },
        base,
      ).DATABASE_URL,
      undefined,
    );
    assert.throws(
      () =>
        prep.verificationEnvironment(
          workspace,
          { ...check, args: ["test; touch injected"] },
          base,
        ),
      /allowlisted/,
    );
    const original = readFileSync(join(workspace, "package.json"));
    writeFileSync(join(workspace, "package.json"), "{}");
    assert.throws(
      () => prep.verificationEnvironment(workspace, check, base),
      /identity changed/,
    );
    writeFileSync(join(workspace, "package.json"), original);
    prep.cleanup();
    assert.deepEqual(calls.at(-1)!.args.slice(0, 3), [
      "rm",
      "--force",
      "--volumes",
    ]);
    assert.equal(prep.records[0]!.steps.at(-1)!.passed, true);
    assert.ok(!JSON.stringify(prep.records).includes("postgresql://"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
test("failed installation stops before service or executor readiness", () => {
  const workspace = mkdtempSync(join(tmpdir(), "preparation-test-"));
  try {
    writeFileSync(
      join(workspace, "package.json"),
      '{"name":"fixture","version":"1"}',
    );
    writeFileSync(join(workspace, "package-lock.json"), "{}");
    const calls: string[] = [];
    const prep = new TrustedPreparation(
      bookingPreparation,
      () => {},
      (exe) => {
        calls.push(exe);
        throw new Error("registry unavailable");
      },
    );
    assert.throws(() => prep.prepare(workspace), /dependencies/);
    assert.deepEqual(calls, ["npm"]);
    assert.throws(
      () =>
        prep.verificationEnvironment(
          workspace,
          { id: "test", executable: "npm", args: ["test"] },
          executorEnvironment(workspace),
        ),
      /not been prepared/,
    );
    prep.cleanup();
    assert.deepEqual(calls, ["npm"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
