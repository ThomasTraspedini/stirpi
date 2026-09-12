import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { verifyExecutor } from "../src/experiments/executor-identity.js";
import { sha256 } from "../src/experiments/inputs.js";

test("executor byte identity validates independent version/hash pins and records actual evidence", (t) => {
  const bytes = Buffer.from("synthetic executor bytes");
  const digest = sha256(bytes);
  let reported = "codex-cli 1.2.3\n";
  const probes: string[] = [];
  const reads: string[] = [];
  t.mock.method(fs, "statSync", (path: string) => {
    if (path === "/missing") throw new Error("ENOENT");
    return { isFile: () => path !== "/directory" };
  });
  t.mock.method(fs, "accessSync", () => {});
  t.mock.method(fs, "readFileSync", (path: string) => {
    reads.push(path);
    return bytes;
  });
  t.mock.method(
    childProcess,
    "execFileSync",
    (path: string, args: string[]) => {
      assert.equal(reads.at(-1), path, "hash bytes before probing/launching");
      assert.deepEqual(args, ["--version"]);
      probes.push(path);
      return reported;
    },
  );
  syncBuiltinESMExports();
  try {
    const config = {
      executable: "/node",
      args: ["/adapter.mjs", "--codex", "/executor"],
    };
    const pin = {
      adapter: "codex",
      executableVersion: "1.2.3",
      executableSha256: digest,
    };
    const result = verifyExecutor(config, pin);
    assert.deepEqual(result.evidence, {
      executablePath: "/executor",
      executableVersion: "codex-cli 1.2.3",
      executableSha256: digest,
    });
    assert.deepEqual(probes, ["/executor"]);
    assert.throws(
      () =>
        verifyExecutor(config, { ...pin, executableSha256: "0".repeat(64) }),
      /Preflight:.*SHA256 mismatch/,
    );
    reported = "codex-cli 9.9.9\n";
    assert.throws(
      () => verifyExecutor(config, pin),
      /Preflight:.*version mismatch/,
    );
    reported = "codex-cli 1.2.3\n";
    const relocated = verifyExecutor(
      {
        ...config,
        args: ["/adapter.mjs", "--codex=/elsewhere"],
      },
      pin,
    );
    assert.deepEqual(relocated.evidence, {
      ...result.evidence,
      executablePath: "/elsewhere",
    });
    assert.deepEqual(
      verifyExecutor(config, {
        adapter: "codex",
        executableVersion: "1.2.3",
      }).evidence,
      result.evidence,
    );
    assert.throws(
      () => verifyExecutor(config, { ...pin, executableSha256: "bad" }),
      /invalid executor identity pin/,
    );
    for (const path of ["/missing", "/directory"])
      assert.throws(
        () => verifyExecutor({ executable: path }),
        /executable unavailable/,
      );
    reported = "v24.0.0\n";
    assert.equal(
      verifyExecutor(
        { executable: "/node" },
        {
          executableVersion: "v24.0.0",
          executableSha256: digest,
        },
      ).evidence.executablePath,
      "/node",
    );
    assert.equal(
      verifyExecutor({ executable: "/node" }).evidence.executableSha256,
      digest,
    );
    reported = "";
    assert.throws(
      () => verifyExecutor({ executable: "/node" }),
      /version probe failed/,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
