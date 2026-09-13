import { assertRuntimeCheckout } from "../src/experiments/runtime-identity.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  mkdtempSync,
  cpSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { experimentCli } from "../src/experiments/cli.js";
import { runExperiment, type RunOptions } from "../src/experiments/run.js";
import {
  frozenInput,
  git,
  initRepository,
  sha256,
  verifyStart,
} from "../src/experiments/inputs.js";
import {
  replayExperiment,
  evaluateAfterRun,
} from "../src/experiments/evaluation.js";
import type { Condition } from "../src/experiments/protocol.js";
const actor = resolve("test/fixtures/experiment.mjs");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "stirpi-experiment-test-"));
  const source = join(dir, "source");
  initRepository(source);
  git(
    source,
    "remote",
    "add",
    "origin",
    "https://github.com/fixture/source.git",
  );
  writeFileSync(join(source, "base.txt"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "Frozen initial state");
  const base = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "future-answer.txt"), "future-answer-sentinel\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "future-answer-sentinel");
  const future = git(source, "rev-parse", "HEAD");
  const futureBlob = git(source, "rev-parse", "HEAD:future-answer.txt");
  writeFileSync(
    join(source, "dirty.txt"),
    "normal checkout must remain untouched\n",
  );
  const task = Buffer.from("Frozen task.\r\nPreserve exact bytes: è.\n\n");
  writeFileSync(join(dir, "task.txt"), task);
  const manifest = {
    id: "fixture",
    sourceRepository: "fixture/source",
    sourceCommit: base,
    taskFile: "task.txt",
    taskSha256: sha256(task),
  };
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  const command = (mode: string) => ({
    id: "deterministic-fixture",
    executable: process.execPath,
    args: [actor, mode],
  });
  const options = (condition: Condition, mode: string = condition) => ({
    manifest: path,
    condition,
    source,
    output: join(dir, "runs"),
    executor: command(mode),
    publicEvaluator: {
      id: "fixture-public-v1",
      criteria: {
        description: "Fixture public contract",
        criteria: ["Result starts with done"],
      },
      command: command("evaluate"),
    },
    maxSteps: 12,
  });
  return {
    dir,
    source,
    base,
    future,
    futureBlob,
    task,
    manifest,
    path,
    command,
    options,
    close() {
      // Test owns all retained fixture workspaces.
      const runs = join(dir, "runs");
      if (existsSync(runs))
        for (const run of readdirSync(runs)) {
          const stateFile = join(runs, run, "state.json");
          if (existsSync(stateFile))
            for (const work of json(stateFile).work)
              if (work.artifact?.worktree)
                rmSync(join(work.artifact.worktree, ".."), {
                  recursive: true,
                  force: true,
                });
        }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function calls(directory: string) {
  return readFileSync(join(directory, "invocations.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("frozen public D032 identity and bytes match the manifest", async () => {
  const input = frozenInput("docs/experiments/d032/manifest.json");
  assert.equal(input.manifest.id, "booking-invariants-d032-001");
  assert.equal(
    input.manifest.sourceCommit,
    "bd9ae09ac74374199c48d22ec36c739600cfee59",
  );
  assert.deepEqual(Buffer.from(input.task), input.bytes);
});

test("hash mismatch aborts before execution or output creation", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "task.txt"), "changed");
    await assert.rejects(
      () => runExperiment(f.options("H")),
      /SHA-256 mismatch/,
    );
    assert.equal(existsSync(join(f.dir, "runs")), false);
  } finally {
    f.close();
  }
});

test("unavailable source commit and wrong repository identity abort without invoking executor", async () => {
  const f = fixture();
  try {
    writeFileSync(
      f.path,
      JSON.stringify({ ...f.manifest, sourceCommit: "0".repeat(40) }),
    );
    const badCommit = await runExperiment(f.options("S"));
    assert.equal(badCommit.result.runtimeOutcome, "OPERATIONAL_FAILURE");
    assert.equal(badCommit.result.resources.executorInvocations, 0);
    writeFileSync(
      f.path,
      JSON.stringify({ ...f.manifest, sourceRepository: "other/repo" }),
    );
    const badIdentity = await runExperiment(f.options("S"));
    assert.match(badIdentity.result.error!, /identity mismatch/);
    assert.equal(badIdentity.result.resources.executorInvocations, 0);
    assert.throws(() => verifyStart(f.source, f.base), /commit mismatch/);
  } finally {
    f.close();
  }
});

test("H/S/T deterministic pilots: identical input, isolated T0 history and siblings, evidence and effect-free replay", async () => {
  const f = fixture();
  const previous = process.env.PRIVATE_ORACLE_TEST;
  process.env.PRIVATE_ORACLE_TEST = "private-environment-sentinel";
  try {
    for (const condition of ["H", "S", "T"] as const) {
      const run = await runExperiment(f.options(condition));
      assert.equal(run.result.error, null);
      assert.equal(run.result.kind, "pilot");
      assert.equal(run.result.sourceCommit, f.base);
      assert.deepEqual(readFileSync(join(run.directory, "task.txt")), f.task);
      const evidence = calls(run.directory);
      const inputs = evidence.filter((e) => e.type === "started");
      assert.deepEqual(
        inputs.map((e) => e.index),
        inputs.map((_, i) => i + 1),
      );
      for (const input of inputs) {
        assert.deepEqual(Buffer.from(input.input.task), f.task);
        assert.equal(
          JSON.stringify(input).includes("future-answer-sentinel"),
          false,
        );
        assert.equal(JSON.stringify(input).includes(f.future), false);
        assert.equal(
          JSON.stringify(input).includes("private-environment-sentinel"),
          false,
        );
        assert.notEqual(input.input.work.artifact.worktree, f.source);
        assert.equal(
          input.input.control.actions.includes("FORK"),
          condition === "T",
        );
        const returned = evidence.find(
          (e) => e.type === "returned" && e.index === input.index,
        );
        const observed = JSON.parse(returned.response.text);
        assert.equal(observed.taskSha256, f.manifest.taskSha256);
        assert.equal(observed.objectiveSha256, f.manifest.taskSha256);
        assert.equal(observed.history.includes(f.future), false);
        assert.equal(observed.objectIds.includes(f.futureBlob), false);
        assert.equal(observed.objectIds.includes(f.future), false);
        assert.equal(observed.remotes, "");
        assert.equal(observed.envKeys.includes("PRIVATE_ORACLE_TEST"), false);
        if (input.input.work.cursor === 0) {
          assert.equal(observed.head, f.base);
          assert.equal(observed.status, "");
        }
        if (input.input.work.name === "beta") {
          assert.equal(observed.history.includes("alpha"), false);
          assert.equal(observed.files.includes("alpha"), false);
          assert.equal(
            JSON.stringify(input.input).includes("fixture alpha world"),
            false,
          );
        }
      }
      assert.equal(run.result.resources.executorInvocations, inputs.length);
      assert.equal(run.result.resources.tokens, null);
      assert.equal(run.result.resources.monetaryCost, null);
      assert.equal(run.result.resources.humanInterventions, 0);
      assert.ok(run.result.resources.wallTimeMs > 0);
      assert.equal("score" in run.result, false);
      assert.equal("evaluation" in run.result, false);
      if (condition === "H") {
        assert.equal(run.result.runtimeOutcome, "BLOCKED");
        assert.equal(run.result.humanIntervention.required, true);
        assert.equal(inputs.length, 1);
      } else {
        assert.equal(run.result.runtimeOutcome, "COMPLETED");
        assert.equal(
          run.result.resources.artifactCommits,
          condition === "T" ? 2 : 1,
        );
      }
      if (condition === "T") {
        assert.deepEqual(
          run.state!.lineages.map((l) => l.status),
          ["BRANCHED", "COMPLETED", "COMPLETED"],
        );
        assert.equal(run.result.resources.logicalLineages, 3);
        assert.equal(run.result.resources.scheduledLineages, 3);
        assert.notEqual(
          run.state!.work[1]!.artifact!.ref,
          run.state!.work[2]!.artifact!.ref,
        );
        assert.match(
          readFileSync(join(run.directory, "tree.txt"), "utf8"),
          /FORK alpha/,
        );
        assert.ok(
          evidence.some(
            (e) => e.type === "artifact" && e.request.type === "COMMIT",
          ),
        );
      }
      assert.equal(git(f.source, "rev-parse", "HEAD"), f.future);
      assert.equal(
        readFileSync(join(f.source, "dirty.txt"), "utf8"),
        "normal checkout must remain untouched\n",
      );
      const before = readFileSync(
        join(run.directory, "invocations.jsonl"),
        "utf8",
      );
      // Delete artifact databases: replay must not need Git or either process.
      rmSync(join(run.directory, "artifacts"), { recursive: true });
      rmSync(join(run.directory, "worlds"), { recursive: true });
      assert.deepEqual(replayExperiment(run.directory), run.state);
      assert.equal(
        readFileSync(join(run.directory, "invocations.jsonl"), "utf8"),
        before,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.PRIVATE_ORACLE_TEST;
    else process.env.PRIVATE_ORACLE_TEST = previous;
    f.close();
  }
});

test("H and S reject FORK before applying artifact effects", async () => {
  const f = fixture();
  try {
    for (const condition of ["H", "S"] as const) {
      const run = await runExperiment(f.options(condition, "forbidden"));
      assert.equal(run.state!.lineages.length, 1);
      assert.equal(run.state!.work[0]!.reason!.code, "ACTION_UNAVAILABLE");
      assert.equal(run.result.resources.artifactCommits, 0);
      assert.deepEqual(replayExperiment(run.directory), run.state);
    }
  } finally {
    f.close();
  }
});

test("public evaluator can reject COMPLETE; post-run hook never changes runtime outcome", async () => {
  const f = fixture();
  try {
    const options = f.options("S");
    options.publicEvaluator.command = f.command("reject");
    const run = await runExperiment(options);
    assert.equal(run.state!.work[0]!.reason!.code, "EVALUATION_FAILED");
    assert.deepEqual(replayExperiment(run.directory), run.state);
    const before = readFileSync(join(run.directory, "result.json"));
    writeFileSync(join(run.directory, "running"), "active");
    assert.throws(
      () =>
        evaluateAfterRun(
          run.directory,
          join(f.dir, "private"),
          f.command("post"),
        ),
      /still active/,
    );
    assert.equal(
      existsSync(join(run.directory, "post-evaluation.json")),
      false,
    );
    rmSync(join(run.directory, "running"));
    const post = evaluateAfterRun(
      run.directory,
      join(f.dir, "private"),
      f.command("post"),
    );
    assert.equal(post.status, 0);
    assert.throws(
      () =>
        evaluateAfterRun(
          run.directory,
          join(f.dir, "private"),
          f.command("post"),
        ),
      /already recorded/,
    );
    assert.equal(
      JSON.parse(post.stdout).received.privatePath,
      join(f.dir, "private"),
    );
    assert.deepEqual(readFileSync(join(run.directory, "result.json")), before);
    assert.equal(
      readFileSync(join(run.directory, "invocations.jsonl"), "utf8").includes(
        join(f.dir, "private"),
      ),
      false,
    );
  } finally {
    f.close();
  }
});

test("dirty blocked work, process failures and budgets remain observable", async () => {
  const f = fixture();
  try {
    const dirty = await runExperiment(f.options("S", "dirty"));
    assert.equal(dirty.state!.work[0]!.artifact!.cleaned, false);
    assert.equal(
      readFileSync(
        join(dirty.state!.work[0]!.artifact!.worktree!, "pending.txt"),
        "utf8",
      ),
      "uncommitted fixture evidence\n",
    );
    assert.match(
      readFileSync(join(dirty.directory, "w1.status.txt"), "utf8"),
      /pending.txt/,
    );
    const failed = await runExperiment(f.options("S", "exit"));
    assert.equal(failed.state!.work[0]!.reason!.code, "PROCESS_EXIT_FAILED");
    assert.ok(
      calls(failed.directory).some(
        (e) => e.type === "process" && e.status === 7,
      ),
    );
    const timeout = await runExperiment({
      ...f.options("S", "timeout"),
      timeoutMs: 100,
    });
    assert.ok(
      calls(timeout.directory).some((e) => e.type === "process" && e.error),
    );
    const budget = await runExperiment({ ...f.options("T"), maxSteps: 1 });
    assert.equal(budget.result.resources.logicalLineages, 3);
    assert.equal(budget.result.resources.scheduledLineages, 1);
    for (const run of [dirty, failed, timeout, budget])
      assert.deepEqual(replayExperiment(run.directory), run.state);
  } finally {
    f.close();
  }
});

test("output state cannot be placed in source repository", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () =>
        runExperiment({
          ...f.options("H"),
          output: join(f.source, "evidence"),
        }),
      /outside/,
    );
    assert.equal(existsSync(join(f.source, "evidence")), false);
    const pending = join(f.dir, "pending");
    mkdirSync(pending);
    writeFileSync(
      join(pending, "result.json"),
      JSON.stringify({ phase: "running" }),
    );
    assert.throws(
      () => evaluateAfterRun(pending, "unused", f.command("post")),
      /finished run/,
    );
  } finally {
    f.close();
  }
});

test("single-path SPAWN returns inspectable child artifacts and public evaluator process errors replay", async () => {
  const f = fixture();
  try {
    const spawned = await runExperiment(f.options("S", "spawn"));
    assert.equal(spawned.result.error, null);
    assert.equal(spawned.result.runtimeOutcome, "COMPLETED");
    assert.equal(spawned.state!.lineages.length, 1);
    assert.equal(spawned.state!.work.length, 2);
    assert.deepEqual(replayExperiment(spawned.directory), spawned.state);
    const options = f.options("S");
    options.publicEvaluator.command = f.command("evaluate-error");
    const failed = await runExperiment(options);
    assert.equal(
      failed.state!.work[0]!.reason!.code,
      "PUBLIC_EVALUATOR_FAILED",
    );
    assert.deepEqual(replayExperiment(failed.directory), failed.state);
  } finally {
    f.close();
  }
});

test("unsupported config and credential flags are rejected before evidence creation", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () =>
        runExperiment({
          ...f.options("S"),
          executor: {
            ...f.command("S"),
            args: ["--api-key", "must-not-be-recorded"],
          },
        }),
      /Credentials/,
    );
    assert.equal(existsSync(join(f.dir, "runs")), false);
  } finally {
    f.close();
  }
});

test("artifact-aware checks target each candidate, preserve evidence, and replay without programs", async () => {
  const f = fixture();
  try {
    const script = join(f.dir, "check.mjs");
    writeFileSync(
      script,
      `
      import { readFileSync, realpathSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      import assert from 'node:assert/strict';
      const context = JSON.parse(readFileSync(0, 'utf8'));
      assert.deepEqual(Object.keys(context).sort(), ['artifactRef','criteria','lineageId','result','workId','workspacePath']);
      assert.equal(realpathSync(process.cwd()), realpathSync(context.workspacePath));
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), context.artifactRef);
      const name = context.result.slice(5);
      assert.equal(readFileSync(name + '.txt', 'utf8'), name + ' fixture result\\n');
      assert.equal(process.env.PRIVATE_ORACLE_TEST, undefined);
      process.stdout.write(JSON.stringify(context));
      process.stderr.write('check diagnostic');
    `,
    );
    const options = f.options("T");
    const config = {
      id: "artifact-checks",
      criteria: options.publicEvaluator.criteria,
      checks: [
        { id: "candidate", executable: process.execPath, args: [script] },
        {
          id: "independent",
          executable: process.execPath,
          args: [
            "-e",
            "console.log('second'); console.error('second diagnostic')",
          ],
        },
      ],
      completionPolicy: "all_checks_pass" as const,
    };
    const run = await runExperiment({ ...options, publicEvaluator: config });
    assert.equal(run.result.runtimeOutcome, "COMPLETED");
    const records = json(join(run.directory, "runtime-evaluations.json"));
    assert.equal(records.length, 2);
    for (const record of records) {
      const work = run.state!.work.find((w) => w.id === record.context.workId)!;
      assert.equal(record.context.lineageId, work.lineageId);
      assert.equal(record.context.artifactRef, work.artifact!.ref);
      assert.equal(record.context.workspacePath, work.artifact!.worktree);
      assert.equal(record.error, null);
      assert.equal(record.evaluation.passed, true);
      assert.deepEqual(record.evaluation.checks, record.checks);
      assert.deepEqual(
        record.checks.map((c: { exitStatus: number }) => c.exitStatus),
        [0, 0],
      );
      assert.deepEqual(JSON.parse(record.checks[0].stdout), record.context);
      assert.equal(record.checks[0].stderr, "check diagnostic");
      assert.equal(record.checks[1].stdout, "second\n");
      for (const check of record.checks) {
        assert.ok(check.startedAt <= check.completedAt);
        assert.equal(check.processStatus, "exited");
        assert.equal(check.passed, true);
        assert.equal(check.error, null);
      }
      for (const sibling of run.state!.work.filter((w) => w.id !== work.id)) {
        if (sibling.artifact?.worktree)
          assert.equal(
            JSON.stringify(record.context).includes(sibling.artifact.worktree),
            false,
          );
      }
      assert.equal(JSON.stringify(record.context).includes(f.source), false);
    }
    rmSync(script);
    rmSync(join(run.directory, "artifacts"), { recursive: true });
    rmSync(join(run.directory, "worlds"), { recursive: true });
    assert.deepEqual(replayExperiment(run.directory), run.state);
    records[0].context.artifactRef = "wrong";
    writeFileSync(
      join(run.directory, "runtime-evaluations.json"),
      JSON.stringify(records),
    );
    assert.throws(() => replayExperiment(run.directory), /mismatch/);
  } finally {
    f.close();
  }
});

test("negative checks and launch errors remain distinct and retain every check outcome", async () => {
  const f = fixture();
  try {
    for (const launchFailure of [false, true]) {
      const options = f.options("S");
      const run = await runExperiment({
        ...options,
        publicEvaluator: {
          id: "failure-checks",
          criteria: options.publicEvaluator.criteria,
          completionPolicy: "all_checks_pass",
          checks: [
            {
              id: "fails",
              executable: launchFailure
                ? join(f.dir, "missing-executable")
                : process.execPath,
              args: [
                "-e",
                "console.log('negative stdout'); console.error('negative stderr'); process.exit(7)",
              ],
            },
            {
              id: "still-runs",
              executable: process.execPath,
              args: ["-e", "console.log('independent')"],
            },
          ],
        },
      });
      assert.equal(run.result.runtimeOutcome, "BLOCKED");
      assert.equal(
        run.state!.work[0]!.reason!.code,
        launchFailure ? "PUBLIC_EVALUATOR_FAILED" : "EVALUATION_FAILED",
      );
      const [record] = json(join(run.directory, "runtime-evaluations.json"));
      assert.equal(record.checks.length, 2);
      assert.equal(record.checks[1].passed, true);
      assert.equal(record.checks[0].passed, false);
      if (launchFailure) {
        assert.equal(record.evaluation, null);
        assert.match(record.error, /ENOENT/);
        assert.equal(record.checks[0].processStatus, "operational_error");
        assert.equal(record.checks[0].exitStatus, null);
      } else {
        assert.equal(record.error, null);
        assert.equal(record.evaluation.passed, false);
        assert.equal(record.checks[0].exitStatus, 7);
        assert.equal(record.checks[0].stdout, "negative stdout\n");
        assert.equal(record.checks[0].stderr, "negative stderr\n");
      }
      assert.deepEqual(replayExperiment(run.directory), run.state);
    }
  } finally {
    f.close();
  }
});

test("cancellation persists ordered incremental evidence and an inspectable dirty workspace", async () => {
  const f = fixture();
  const controller = new AbortController();
  let observedBeforeCompletion = false;
  try {
    const script = join(f.dir, "cancel.mjs");
    writeFileSync(
      script,
      `
      import { writeFileSync, writeSync } from 'node:fs';
      writeFileSync('pending.txt', 'retained cancellation evidence');
      writeSync(3, JSON.stringify({ kind: 'command', scope: '${sha256("command")}', status: 'started' }) + '\\n');
      setInterval(() => {}, 100);
    `,
    );
    const run = await runExperiment({
      ...f.options("S"),
      executor: { executable: process.execPath, args: [script] },
      signal: controller.signal,
      observeEvent(event) {
        if (event.kind !== "command") return;
        const directory = join(
          f.dir,
          "runs",
          readdirSync(join(f.dir, "runs"))[0]!,
        );
        const records = readFileSync(
          join(directory, "operational.jsonl"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(records.at(-1).event.kind, "command");
        assert.equal(existsSync(join(directory, "running")), true);
        observedBeforeCompletion = true;
        controller.abort();
      },
    });
    assert.equal(observedBeforeCompletion, true);
    assert.equal(run.state!.work[0]!.reason!.code, "EXECUTOR_CANCELLED");
    assert.equal(run.state!.work[0]!.status, "BLOCKED");
    assert.equal(
      run.state!.events.some((e) => e.type === "ACTION"),
      false,
    );
    const workspace = run.state!.work[0]!.artifact!;
    assert.equal(workspace.cleaned, false);
    assert.equal(
      readFileSync(join(workspace.worktree!, "pending.txt"), "utf8"),
      "retained cancellation evidence",
    );
    assert.equal(
      readFileSync(
        join(run.directory, "pending-workspaces", "w1", "pending.txt"),
        "utf8",
      ),
      "retained cancellation evidence",
    );
    const path = join(run.directory, "operational.jsonl");
    const records = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((r) => r.sequence),
      records.map((_, i) => i + 1),
    );
    assert.equal(run.result.resources.operational.commandCount, 1);
    assert.equal(
      json(join(run.directory, "metadata.json")).limits.executorWallTimeMs,
      null,
    );
    assert.equal(
      json(join(run.directory, "metadata.json")).limits.evaluatorWallTimeMs,
      null,
    );
    rmSync(script);
    assert.deepEqual(replayExperiment(run.directory), run.state);
    records.reverse();
    writeFileSync(
      path,
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    assert.throws(
      () => replayExperiment(run.directory),
      /operational evidence mismatch/,
    );
  } finally {
    f.close();
  }
});

test("preregistered fixture preflight and runtime retain exactly the declared envelope", async () => {
  const f = fixture();
  try {
    const preregistration = join(f.dir, "pilot.json");
    const pilot = {
      id: "fixture-pilot",
      class: "pilot",
      testcase: "fixture",
      condition: "T",
      hiddenEvaluationDuringRun: false,
      limits: {
        maxSteps: 2,
        maxExecutorInvocations: 0,
        maxLineages: 4,
        maxItemsPerInvocation: 9,
        maxCommandsPerInvocation: 8,
        maxWallTimePerInvocationMs: 700,
        noProgressMs: 600,
        maxEvaluatorWallTimeMs: 500,
      },
    };
    writeFileSync(preregistration, JSON.stringify(pilot));
    const base: RunOptions = f.options("T");
    delete base.maxSteps;
    const run = await runExperiment({ ...base, preregistration });
    assert.equal(run.result.error, null);
    assert.equal(run.result.resources.executorInvocations, 0);
    const evidence = json(join(run.directory, "preflight.json"));
    const metadata = json(join(run.directory, "metadata.json"));
    assert.equal(evidence.verified, true);
    assert.deepEqual(evidence.executor, {
      executablePath: process.execPath,
      executableVersion: process.version,
      executableSha256: sha256(readFileSync(process.execPath)),
    });
    assert.deepEqual(metadata.executorIdentity, evidence.executor);
    assert.equal(metadata.executorVersion, process.version);
    assert.deepEqual(evidence.preregisteredLimits, pilot.limits);
    assert.deepEqual(evidence.budgets, {
      steps: 2,
      invocations: 0,
      lineages: 4,
    });
    assert.deepEqual(evidence.supervision, {
      budgets: { items: 9, commands: 8, wallTimeMs: 700 },
      noProgressMs: 600,
    });
    assert.equal(evidence.evaluator.wallTimeMs, 500);
    assert.deepEqual(metadata.preflight, evidence);
    assert.deepEqual(metadata.limits.budgets, evidence.budgets);
    assert.deepEqual(metadata.limits.supervision, evidence.supervision);
    assert.equal(metadata.limits.evaluatorWallTimeMs, 500);
    assert.equal("maxSteps" in metadata.limits, false);
    assert.deepEqual(run.state?.config.budgets, evidence.budgets);
  } finally {
    f.close();
  }
});

test("unsupported and contradictory preregistrations fail before executor or output creation", async () => {
  const f = fixture();
  try {
    const preregistration = join(f.dir, "pilot.json");
    const pilot = {
      id: "fixture-pilot",
      class: "pilot",
      testcase: "fixture",
      condition: "T",
      hiddenEvaluationDuringRun: false,
      limits: { maxSteps: 2 },
    };
    const base: RunOptions = f.options("T");
    delete base.maxSteps;
    for (const change of [
      { limits: { unsupported: 1 } },
      { condition: "S" },
      { budgets: { steps: 2 } },
      { testcase: "other" },
    ]) {
      writeFileSync(preregistration, JSON.stringify({ ...pilot, ...change }));
      await assert.rejects(
        runExperiment({ ...base, preregistration }),
        /Preflight/,
      );
    }
    writeFileSync(preregistration, JSON.stringify(pilot));
    for (const override of [
      { maxSteps: 2 },
      { timeoutMs: 1 },
      { budgets: { steps: 3 } },
      { supervision: { noProgressMs: 1 } },
      { evaluatorWallTimeMs: 60000 },
    ])
      await assert.rejects(
        runExperiment({ ...base, preregistration, ...override }),
        /Preflight/,
      );
    assert.equal(existsSync(join(f.dir, "runs")), false);
  } finally {
    f.close();
  }
});

test("CLI consumes a pilot file without manual limit mapping and leaves omissions disabled", async (t) => {
  const f = fixture();
  try {
    const preregistration = join(f.dir, "pilot.json");
    const executor = join(f.dir, "executor.json");
    const evaluator = join(f.dir, "evaluator.json");
    writeFileSync(
      preregistration,
      JSON.stringify({
        id: "fixture-pilot",
        class: "pilot",
        testcase: "fixture",
        condition: "T",
        hiddenEvaluationDuringRun: false,
        limits: { maxExecutorInvocations: 0 },
      }),
    );
    writeFileSync(executor, JSON.stringify(f.options("T").executor));
    writeFileSync(evaluator, JSON.stringify(f.options("T").publicEvaluator));
    const logs: string[] = [];
    t.mock.method(console, "log", (line: string) => logs.push(line));
    await experimentCli([
      "run",
      f.path,
      "--condition",
      "T",
      "--source",
      f.source,
      "--executor",
      executor,
      "--public-evaluator",
      evaluator,
      "--output",
      join(f.dir, "runs"),
      "--preregistration",
      preregistration,
    ]);
    const { directory, error } = JSON.parse(logs[0]!);
    assert.equal(error, null);
    const evidence = json(join(directory, "preflight.json"));
    assert.deepEqual(evidence.budgets, { invocations: 0 });
    assert.deepEqual(evidence.supervision, { budgets: {} });
    assert.equal(evidence.evaluator.wallTimeMs, null);
    const metadata = json(join(directory, "metadata.json"));
    assert.equal(metadata.limits.evaluatorWallTimeMs, null);
    assert.equal("maxSteps" in metadata.limits, false);
    assert.equal("timeoutMs" in metadata.limits, false);
    assert.deepEqual(json(join(directory, "state.json")).config.budgets, {
      invocations: 0,
    });
    assert.deepEqual(
      calls(directory).filter((call) => call.type === "started"),
      [],
    );
  } finally {
    f.close();
  }
});

test("committed later preregistration executes pinned runtime and retains both identities", async () => {
  const f = fixture();
  const repository = join(f.dir, "runtime");
  try {
    initRepository(repository);
    cpSync(resolve("src"), join(repository, "src"), { recursive: true });
    for (const name of ["package.json", "tsconfig.json"])
      cpSync(resolve(name), join(repository, name));
    const runFile = join(repository, "src/experiments/run.ts");
    // Preserve compatibility with runtime revisions predating this launcher.
    const source = readFileSync(runFile, "utf8");
    const wrapperStart = source.indexOf("export async function runExperiment(");
    const localStart = source.indexOf(
      "export async function runExperimentLocally(",
    );
    writeFileSync(
      runFile,
      (source.slice(0, wrapperStart) + source.slice(localStart))
        .replace(
          'import { runPinnedRuntime } from "./runtime-identity.js";\n',
          "",
        )
        .replace(
          "export async function runExperimentLocally(",
          "export async function runExperiment(",
        ),
    );
    rmSync(join(repository, "src/experiments/runtime-identity.ts"));
    writeFileSync(
      runFile,
      readFileSync(runFile, "utf8").replace(
        "return { directory, result, state };",
        'writeFileSync(join(directory, "pinned-marker"), "pinned runtime executed");\n  writeFileSync(join(directory, "pinned-environment.json"), JSON.stringify({ nodePath: process.env.NODE_PATH ?? null, status: git(process.cwd(), "status", "--porcelain", "--untracked-files=all", "--ignored") }));\n  return { directory, result, state };',
      ),
    );
    git(repository, "add", ".");
    git(repository, "commit", "-m", "Pinned fixture runtime");
    const pin = git(repository, "rev-parse", "HEAD");
    const preregistration = join(repository, "pilot.json");
    const pilot = {
      id: "fixture-pinned",
      class: "pilot",
      testcase: "fixture",
      condition: "T",
      stirpiCommit: pin,
      hiddenEvaluationDuringRun: false,
      limits: { maxSteps: 12 },
    };
    const contents = JSON.stringify(pilot);
    writeFileSync(preregistration, contents);
    writeFileSync(
      runFile,
      'throw new Error("NEWER RUNTIME MUST NEVER EXECUTE");',
    );
    git(repository, "add", ".");
    git(
      repository,
      "commit",
      "-m",
      "Later preregistration and incompatible runtime",
    );
    const containingCommit = git(repository, "rev-parse", "HEAD");
    const base: RunOptions = f.options("T");
    delete base.maxSteps;
    // Exercise the external compiled launcher, with no dependencies in its tree.
    const externalBuild = join(f.dir, "external-build");
    const require = createRequire(import.meta.url);
    execFileSync(process.execPath, [
      require.resolve("typescript/bin/tsc"),
      "--project",
      resolve("tsconfig.json"),
      "--outDir",
      externalBuild,
    ]);
    writeFileSync(join(externalBuild, "package.json"), '{"type":"module"}');
    const entry = join(f.dir, "launch.mjs");
    writeFileSync(
      entry,
      `
      import { runExperiment } from ${JSON.stringify(pathToFileURL(join(externalBuild, "experiments/run.js")).href)};
      console.log(JSON.stringify(await runExperiment(${JSON.stringify({ ...base, preregistration })})));
    `,
    );
    const run = JSON.parse(
      execFileSync(
        process.execPath,
        [resolve("tools/launch-pinned-runtime.mjs"), entry],
        { cwd: repository, env: { PATH: process.env.PATH }, encoding: "utf8" },
      ),
    );
    assert.equal(run.result.error, null);
    assert.ok(run.result.resources.executorInvocations > 0);
    assert.deepEqual(json(join(run.directory, "pinned-environment.json")), {
      nodePath: null,
      status: "",
    });
    assert.equal(existsSync(join(repository, "node_modules")), false);
    assert.equal(existsSync(join(externalBuild, "node_modules")), false);
    const returned = calls(run.directory).filter(
      (call) => call.type === "returned",
    );
    assert.ok(returned.length > 0);
    for (const call of returned)
      assert.equal(
        JSON.parse(call.response.text).envKeys.includes("NODE_PATH"),
        false,
      );
    assert.equal(
      readFileSync(join(run.directory, "pinned-marker"), "utf8"),
      "pinned runtime executed",
    );
    const evidence = json(join(run.directory, "preflight.json"));
    assert.equal(evidence.preregistration.sha256, sha256(contents));
    assert.equal(evidence.preregistration.contents, contents);
    assert.equal(evidence.preregistration.containingCommit, containingCommit);
    assert.equal(evidence.runtime.pinnedCommit, pin);
    assert.equal(evidence.runtime.actualCommit, pin);
    assert.notEqual(containingCommit, pin);
    assert.deepEqual(
      json(join(run.directory, "metadata.json")).preflight,
      evidence,
    );
    replayExperiment(run.directory);
    evidence.runtime.actualCommit = containingCommit;
    writeFileSync(
      join(run.directory, "preflight.json"),
      JSON.stringify(evidence),
    );
    assert.throws(() => replayExperiment(run.directory), /identity/);
    for (const badPin of ["0".repeat(40), "HEAD", 42]) {
      writeFileSync(
        preregistration,
        JSON.stringify({ ...pilot, stirpiCommit: badPin }),
      );
      git(repository, "add", "pilot.json");
      git(repository, "commit", "-m", "Invalid fixture pin");
      await assert.rejects(
        runExperiment({
          ...base,
          output: join(f.dir, "bad-runs"),
          preregistration,
        }),
        /Preflight/,
      );
      assert.equal(existsSync(join(f.dir, "bad-runs")), false);
    }
    writeFileSync(preregistration, contents);
    await assert.rejects(
      runExperiment({ ...base, preregistration }),
      /Preflight/,
    );
  } finally {
    f.close();
  }
});

test("runtime checkout verification rejects wrong identity and dirty files", () => {
  const dir = mkdtempSync(join(tmpdir(), "stirpi-runtime-check-"));
  try {
    initRepository(dir);
    writeFileSync(join(dir, "tracked"), "clean");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "fixture");
    const pin = git(dir, "rev-parse", "HEAD");
    assertRuntimeCheckout(dir, pin);
    assert.throws(
      () => assertRuntimeCheckout(dir, "0".repeat(40)),
      /Preflight/,
    );
    writeFileSync(join(dir, "untracked"), "dirty");
    assert.throws(() => assertRuntimeCheckout(dir, pin), /Preflight/);
    rmSync(join(dir, "untracked"));
    writeFileSync(join(dir, "tracked"), "dirty");
    assert.throws(() => assertRuntimeCheckout(dir, pin), /Preflight/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sanitized adapter failure survives process and experiment evidence", async () => {
  const f = fixture();
  try {
    const run = await runExperiment({
      ...f.options("S"),
      executor: {
        executable: process.execPath,
        args: [
          "-e",
          `process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write(JSON.stringify({ adapter: 'codex-m2-v1', failure: { code: 'AGENT_EXIT_FAILED', message: 'sensitive-stderr-sentinel' }, status: 7, diagnostics: { eventTypes: { error: 1 }, counts: { recognized: 1, unknown: 0, malformed: 0 }, lastNativeType: 'error', lifecycle: { turn: 'failed' } } })); process.exitCode = 7; });`,
        ],
      },
    });
    const bytes = readFileSync(
      join(run.directory, "invocations.jsonl"),
      "utf8",
    );
    const records = bytes
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const processRecord = records.find((r) => r.type === "process");
    assert.deepEqual(processRecord.adapterDiagnostics.failure, {
      code: "AGENT_EXIT_FAILED",
    });
    assert.equal(processRecord.adapterDiagnostics.lastNativeType, "error");
    assert.equal(processRecord.stateDirectory.exists, true);
    assert.equal(processRecord.stateDirectory.readable, true);
    assert.equal(processRecord.stateDirectory.writable, true);
    assert.equal(bytes.includes("sensitive-stderr-sentinel"), false);
    assert.equal(processRecord.stderr, undefined);
    assert.ok(json(join(run.directory, "metadata.json")).diagnosticEnvironment);
  } finally {
    f.close();
  }
});

test("executor identity pins gate experiment launch before output creation", async () => {
  const f = fixture();
  try {
    const preregistration = join(f.dir, "pilot.json");
    const base: RunOptions = f.options("T");
    delete base.maxSteps;
    const executor = {
      executableVersion: process.version,
      executableSha256: sha256(readFileSync(process.execPath)),
    };
    const pilot = {
      id: "fixture-executor-identity",
      class: "pilot",
      testcase: "fixture",
      condition: "T",
      hiddenEvaluationDuringRun: false,
      limits: { maxExecutorInvocations: 0 },
      executor,
    };
    for (const [pin, error] of [
      [{ ...executor, executableSha256: "0".repeat(64) }, /SHA256 mismatch/],
      [{ ...executor, executableVersion: "wrong-version" }, /version mismatch/],
    ] as const) {
      writeFileSync(
        preregistration,
        JSON.stringify({ ...pilot, executor: pin }),
      );
      await assert.rejects(runExperiment({ ...base, preregistration }), error);
      assert.equal(existsSync(base.output), false);
    }
    writeFileSync(preregistration, JSON.stringify(pilot));
    const run = await runExperiment({ ...base, preregistration });
    assert.equal(run.result.error, null);
    assert.deepEqual(json(join(run.directory, "preflight.json")).executor, {
      executablePath: process.execPath,
      ...executor,
    });
  } finally {
    f.close();
  }
});
