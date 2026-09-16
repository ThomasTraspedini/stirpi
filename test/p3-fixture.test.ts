import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { dna } from "../src/domain/index.js";
import { replayExperiment } from "../src/experiments/evaluation.js";
import { git, initRepository, sha256 } from "../src/experiments/inputs.js";
import { bookingPreparation } from "../src/experiments/preparation.js";
import { runExperimentLocally } from "../src/experiments/run.js";

const actor = resolve("test/fixtures/p3/fork-replay.mjs");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const jsonLines = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test("P3 preflight rejects an evaluator hash mismatch before creating output", () => {
  const directory = mkdtempSync(join(tmpdir(), "stirpi-p3-preflight-"));
  const runtime = join(directory, "runtime");
  const output = join(
    "/private/tmp/stirpi-p3-c01",
    `hash-mismatch-${directory.split("/").at(-1)}`,
  );
  try {
    for (const path of ["scripts/p3", "src"])
      cpSync(resolve(path), join(runtime, path), { recursive: true });
    cpSync(
      resolve("docs/experiments/d032"),
      join(runtime, "docs/experiments/d032"),
      { recursive: true },
    );
    writeFileSync(
      join(runtime, "docs/experiments/d032/public-evaluator-v2.json"),
      readFileSync(
        resolve("docs/experiments/d032/public-evaluator-v2.json"),
        "utf8",
      ) + "\n",
    );

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        resolve("node_modules/tsx/dist/loader.mjs"),
        "scripts/p3/booking-preflight.mts",
        "--source",
        "/does-not-need-to-exist-for-this-regression",
        "--output",
        output,
      ],
      {
        cwd: runtime,
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Frozen evaluator SHA-256 does not match P3 authority/,
    );
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("P3 deterministic fixture exercises trusted-local FORK descendants, commits, evaluation, and replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stirpi-p3-fixture-"));
  const source = join(directory, "source");
  const output = join(directory, "evidence");
  try {
    initRepository(source);
    git(source, "remote", "add", "origin", "https://github.com/fixture/p3.git");
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({ name: "p3-fixture", version: "1.0.0" }),
    );
    writeFileSync(join(source, "package-lock.json"), "{}\n");
    writeFileSync(join(source, "base.txt"), "fixture baseline\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "Fixture frozen baseline");
    const base = git(source, "rev-parse", "HEAD");
    writeFileSync(join(source, "future.txt"), "must not reach fixture\n");
    git(source, "add", "future.txt");
    git(source, "commit", "-m", "Fixture future history");
    const future = git(source, "rev-parse", "HEAD");
    writeFileSync(
      join(source, "source-dirty.txt"),
      "source remains untouched\n",
    );

    const task = "P3 infrastructure fixture.\n";
    const taskFile = join(directory, "task.txt");
    writeFileSync(taskFile, task);
    const manifest = join(directory, "manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        id: "p3-fixture",
        sourceRepository: "fixture/p3",
        sourceCommit: base,
        taskFile: "task.txt",
        taskSha256: sha256(task),
      }),
    );
    const checks = [
      { id: "full-postgres-suite", executable: "npm", args: ["test"] },
      { id: "typecheck", executable: "npm", args: ["run", "typecheck"] },
      { id: "diff-check", executable: "git", args: ["diff", "--check"] },
    ] as const;
    const preparationCalls: string[][] = [];
    const checkCalls: string[] = [];
    const run = await runExperimentLocally(
      {
        manifest,
        condition: "T",
        verificationMode: "trusted-local",
        preparation: bookingPreparation,
        source,
        output,
        executor: {
          id: "p3-deterministic-fixture",
          executable: process.execPath,
          args: [actor],
        },
        publicEvaluator: {
          id: "p3-public-v1",
          criteria: {
            description: "Fixture contract",
            criteria: ["All public checks pass"],
          },
          checks: [...checks],
          completionPolicy: "all_checks_pass",
        },
        maxSteps: 12,
      },
      (executable, args) => {
        preparationCalls.push([executable, ...args]);
        if (executable === "docker" && args[0] === "inspect")
          return JSON.stringify([
            {
              Image: "fixture-postgres-image",
              NetworkSettings: {
                Ports: { "5432/tcp": [{ HostPort: "49153" }] },
              },
            },
          ]);
        return "fixture-process";
      },
      (check) => {
        checkCalls.push(check.id);
        return {
          status: 0,
          signal: null,
          stdout: `${check.id} passed\n`,
          stderr: "",
          error: undefined,
        };
      },
    );

    assert.equal(run.result.error, null);
    assert.equal(run.result.runtimeOutcome, "COMPLETED");
    assert.deepEqual(
      run.state!.lineages.map((lineage) => lineage.status),
      ["BRANCHED", "COMPLETED", "COMPLETED"],
    );
    assert.deepEqual(
      run.state!.lineages.slice(1).map((lineage) => lineage.assumption),
      [
        "Treat capacity as fixed for this conditional world.",
        "Treat capacity as elastic for this conditional world.",
      ],
    );
    assert.deepEqual(dna(run.state!, run.state!.lineages[1]!.id), [
      "Treat capacity as fixed for this conditional world.",
    ]);
    assert.deepEqual(dna(run.state!, run.state!.lineages[2]!.id), [
      "Treat capacity as elastic for this conditional world.",
    ]);
    assert.equal(run.result.resources.scheduledLineages, 3);
    const descendants = run.state!.work.filter((work) => work.name !== "root");
    assert.equal(descendants.length, 2);
    assert.notEqual(
      descendants[0]!.artifact!.ref,
      descendants[1]!.artifact!.ref,
    );
    for (const work of descendants) {
      assert.match(work.artifact!.ref, /^[a-f0-9]{40}$/);
      assert.match(
        git(
          join(run.directory, "artifacts"),
          "show",
          "--format=",
          "--name-only",
          work.artifact!.ref,
        ),
        new RegExp(`${work.name}\\.txt`),
      );
    }
    assert.deepEqual(checkCalls, [
      "full-postgres-suite",
      ...checks.map((check) => check.id),
      ...checks.map((check) => check.id),
    ]);
    assert.ok(preparationCalls.some((call) => call.join(" ") === "npm ci"));
    assert.ok(
      preparationCalls.some(
        (call) => call[0] === "docker" && call[1] === "run",
      ),
    );
    assert.equal(
      preparationCalls.filter(
        (call) => call[0] === "docker" && call[1] === "rm",
      ).length,
      3,
    );

    const invocations = jsonLines(join(run.directory, "invocations.jsonl"));
    assert.equal(JSON.stringify(invocations).includes(future), false);
    const started = new Map(
      invocations
        .filter((record) => record.type === "started")
        .map((record) => [record.index, record]),
    );
    const returned = invocations.filter((record) => record.type === "returned");
    for (const [name, assumption, sibling] of [
      [
        "alpha",
        "Treat capacity as fixed for this conditional world.",
        "Treat capacity as elastic for this conditional world.",
      ],
      [
        "beta",
        "Treat capacity as elastic for this conditional world.",
        "Treat capacity as fixed for this conditional world.",
      ],
    ] as const) {
      const childStarted = [...started.values()].find(
        (record) =>
          record.input.work.name === name && record.input.work.cursor === 0,
      );
      assert.ok(childStarted, `missing initial ${name} invocation`);
      assert.deepEqual(childStarted.input.dna, [assumption]);
      assert.equal(childStarted.input.work.artifact.ref, base);
      assert.equal(JSON.stringify(childStarted.input).includes(sibling), false);
      const childReturned = returned.find(
        (record) => record.index === childStarted.index,
      );
      assert.ok(childReturned, `missing initial ${name} response`);
      const observation = JSON.parse(childReturned.response.text);
      assert.deepEqual(observation.dna, [assumption]);
      assert.equal(observation.head, base);
      assert.equal(observation.taskSha256, sha256(task));
      assert.equal(observation.files.includes("future.txt"), false);
      const siblingFile = name === "alpha" ? "beta.txt" : "alpha.txt";
      assert.equal(observation.files.includes(siblingFile), false);
    }
    const records = json(join(run.directory, "preparation.json"));
    assert.equal(records.length, 3);
    for (const record of records) {
      assert.equal(record.imageId, "fixture-postgres-image");
      assert.deepEqual(
        record.steps.map((step: { id: string }) => step.id),
        [
          "dependencies",
          "module-resolution",
          "typecheck",
          "postgres",
          "postgres-identity",
          "database-connectivity",
          "prerequisites",
          "cleanup",
        ],
      );
      assert.ok(record.steps.every((step: { passed: boolean }) => step.passed));
    }
    const evaluations = json(join(run.directory, "runtime-evaluations.json"));
    assert.equal(evaluations.length, 2);
    assert.ok(
      evaluations.every(
        (entry: { evaluation: { passed: boolean } }) => entry.evaluation.passed,
      ),
    );
    assert.equal(git(source, "rev-parse", "HEAD"), future);
    assert.equal(
      readFileSync(join(source, "source-dirty.txt"), "utf8"),
      "source remains untouched\n",
    );

    for (const work of descendants) {
      assert.equal(
        git(
          join(run.directory, "artifacts"),
          "show",
          `${work.artifact!.ref}:${work.name}.txt`,
        ),
        `${work.name} fixture artifact`,
      );
      assert.equal(
        git(
          join(run.directory, "artifacts"),
          "rev-parse",
          `${work.artifact!.ref}^`,
        ),
        base,
      );
      git(
        join(run.directory, "artifacts"),
        "merge-base",
        "--is-ancestor",
        base,
        work.artifact!.ref,
      );
    }

    rmSync(join(run.directory, "artifacts"), { recursive: true });
    rmSync(join(run.directory, "worlds"), { recursive: true });
    assert.deepEqual(replayExperiment(run.directory), run.state);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
