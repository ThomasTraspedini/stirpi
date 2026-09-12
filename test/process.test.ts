import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  simulateAsync as simulate,
  replay,
  Store,
  ProcessExecutor,
  GitWorkspaceBackend,
  type Scenario,
  type State,
  type ExecutorOperation,
  type ArtifactBackend,
} from "../src/index.js";

const actor = resolve("test/fixtures/executor.mjs");
const scenario: Scenario = {
  name: "process-demo",
  objective: "Produce coherent progress",
  publicEvaluation: {
    description: "Return done",
    criteria: ["Include done in result"],
  },
  hiddenEvaluation: { requiredText: "done" },
  scripts: {},
};
function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "stirpi-process-test-"));
  const repo = join(dir, "target");
  const log = join(dir, "invocations.jsonl");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Process Test");
  git(repo, "config", "user.email", "process@example.invalid");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "--all");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "Add base file");
  const base = git(repo, "rev-parse", "HEAD");
  return {
    dir,
    repo,
    log,
    base,
    executor(mode = "progress") {
      return new ProcessExecutor({
        executable: process.execPath,
        args: [actor, mode, log],
        id: "fixture",
      });
    },
    async run(
      mode = "progress",
      definition = scenario,
      backend: ArtifactBackend = new GitWorkspaceBackend(repo),
    ) {
      return await simulate(
        definition,
        undefined,
        this.executor(mode),
        undefined,
        undefined,
        backend,
      );
    },
    close(state?: State) {
      for (const w of state?.work ?? [])
        if (w.artifact?.worktree)
          rmSync(join(w.artifact.worktree, ".."), {
            recursive: true,
            force: true,
          });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function operations(state: State) {
  return state.events
    .filter((e) => e.type === "EXECUTOR_OPERATION")
    .map((e) => e.data as ExecutorOperation);
}

test("external round trip: dirty CONTINUE, same workspace, two commits, no empty commit, evaluation and effect-free persisted replay", async () => {
  const f = fixture();
  let state: State | undefined;
  const store = new Store(join(f.dir, "state.sqlite"));
  try {
    assert.equal(git(f.repo, "status", "--porcelain"), "");
    state = await f.run();
    assert.equal(state.status, "COMPLETED");
    assert.equal(state.lineages.length, 1);
    assert.equal(state.work.length, 1);
    const calls = operations(state);
    assert.equal(calls.length, 4);
    assert.equal(
      new Set(calls.map((o) => o.context.work.artifact!.worktree)).size,
      1,
    );
    assert.equal(new Set(calls.map((o) => o.context.work.id)).size, 1);
    assert.equal(calls[1]!.context.work.artifact!.ref, f.base); // Dirty first invocation is transient.
    assert.notEqual(calls[2]!.context.work.artifact!.ref, f.base);
    const artifact = state.work[0]!.artifact!;
    assert.match(artifact.ref, /^[0-9a-f]{40}$/);
    assert.equal(git(f.repo, "cat-file", "-t", artifact.ref), "commit");
    assert.equal(
      git(f.repo, "show", `${artifact.ref}:progress.txt`),
      "first\nsecond\nthird",
    );
    assert.equal(
      git(f.repo, "rev-list", "--count", `${f.base}..${artifact.ref}`),
      "2",
    );
    assert.equal(artifact.cleaned, true);
    assert.equal(existsSync(artifact.worktree!), false);
    assert.equal(git(f.repo, "rev-parse", "HEAD"), f.base);
    assert.equal(git(f.repo, "status", "--porcelain"), "");
    const logs = readFileSync(f.log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    for (const log of logs) {
      assert.equal(log.cwd, artifact.worktree);
      assert.notEqual(log.cwd, f.repo);
      assert.equal(JSON.stringify(log).includes("hiddenEvaluation"), false);
      assert.equal(log.context.work.status, "ACTIVE");
    }
    assert.deepEqual(
      calls.map((c) => c.context.dna),
      [[], [], [], []],
    );
    assert.ok(state.events.some((e) => e.type === "COMPLETED"));
    store.save(state);
    assert.deepEqual(store.load(state.runId), state);
    const before = readFileSync(f.log, "utf8");
    // Remove repository: replay cannot possibly repeat Git effects.
    rmSync(f.repo, { recursive: true });
    assert.deepEqual(replay(store.load(state.runId)), state);
    assert.equal(readFileSync(f.log, "utf8"), before);
    const tampered = structuredClone(state);
    (
      tampered.events.find((e) => e.type === "EXECUTOR_OPERATION")!
        .data as ExecutorOperation
    ).context.dna.push("tampered");
    assert.throws(() => replay(tampered), /Replay mismatch/);
  } finally {
    store.close();
    f.close(state);
  }
});

test("FORK worlds and SPAWN contexts stay local; hidden evaluator material never crosses process boundary", async () => {
  const f = fixture();
  let state: State | undefined;
  try {
    state = await f.run("fork", {
      ...scenario,
      hiddenEvaluation: { requiredText: "secret-evaluator-sentinel" },
    });
    const calls = operations(state);
    for (const call of calls) {
      const encoded = JSON.stringify(call.context);
      assert.equal(encoded.includes("secret-evaluator-sentinel"), false);
      assert.equal(encoded.includes("rationale"), false);
      if (call.context.work.name === "root") continue;
      const alpha = call.context.work.name !== "B";
      assert.deepEqual(call.context.dna, [
        alpha ? "world alpha" : "world beta",
      ]);
      assert.equal(
        encoded.includes(alpha ? "world beta" : "world alpha"),
        false,
      );
      for (const other of state.work.filter(
        (w) => w.lineageId !== call.context.work.lineageId,
      )) {
        if (other.artifact?.worktree)
          assert.equal(encoded.includes(other.artifact.worktree), false);
        if (other.result) assert.equal(encoded.includes(other.result), false);
      }
    }
    const parent = state.work.find((w) => w.name === "A")!;
    const child = state.work.find((w) => w.name === "child")!;
    assert.equal(child.lineageId, parent.lineageId);
    assert.notEqual(child.artifact!.worktree, parent.artifact!.worktree);
    const resumed = calls.find(
      (c) => c.context.work.name === "A" && c.context.work.cursor === 1,
    )!;
    assert.equal(resumed.context.results.length, 1);
    assert.equal(resumed.context.results[0]!.status, "BLOCKED");
    assert.equal(resumed.context.results[0]!.artifact!.worktree, undefined);
    assert.equal(state.lineages[0]!.status, "BRANCHED");
    assert.equal(parent.reason!.code, "EVALUATION_FAILED");
    assert.deepEqual(replay(state), state);
  } finally {
    f.close(state);
  }
});

for (const [mode, code] of [
  ["invalid-json", "INVALID_EXECUTOR_JSON"],
  ["invalid-action", "INVALID_EXECUTOR_ACTION"],
  ["invalid-envelope", "INVALID_EXECUTOR_RESPONSE"],
  ["version", "UNSUPPORTED_PROTOCOL_VERSION"],
  ["exit", "PROCESS_EXIT_FAILED"],
])
  test(`${mode} produces a recorded local operational failure`, async () => {
    const f = fixture();
    let state: State | undefined;
    try {
      state = await f.run(mode);
      assert.equal(state.work[0]!.status, "BLOCKED");
      assert.equal(state.work[0]!.reason!.code, code);
      assert.equal(state.lineages[0]!.status, "BLOCKED");
      assert.equal(state.work[0]!.artifact!.ref, f.base);
      assert.deepEqual(replay(state), state);
    } finally {
      f.close(state);
    }
  });

for (const type of ["FORK", "SPAWN", "COMPLETE", "BLOCK"])
  test(`dirty ${type} retains edits without publishing them`, async () => {
    const f = fixture();
    let state: State | undefined;
    try {
      state = await f.run(`dirty-${type}`);
      assert.equal(state.work.length, 1);
      assert.equal(state.work[0]!.status, "BLOCKED");
      assert.equal(
        state.work[0]!.reason!.code,
        type === "BLOCK" ? "PAUSED" : "DIRTY_WORKSPACE",
      );
      assert.equal(state.work[0]!.artifact!.ref, f.base);
      assert.equal(state.work[0]!.artifact!.cleaned, false);
      assert.equal(
        readFileSync(
          join(state.work[0]!.artifact!.worktree!, "pending.txt"),
          "utf8",
        ),
        "preserve me",
      );
      assert.equal(git(f.repo, "rev-list", "--all", "--count"), "1");
      assert.deepEqual(replay(state), state);
    } finally {
      f.close(state);
    }
  });

test("launch failure and missing workspace are local; commit failure prevents transition", async () => {
  const f = fixture();
  let state: State | undefined;
  try {
    state = await simulate(
      scenario,
      undefined,
      new ProcessExecutor({ executable: join(f.dir, "missing") }),
      undefined,
      undefined,
      new GitWorkspaceBackend(f.repo),
    );
    assert.equal(state.work[0]!.reason!.code, "PROCESS_LAUNCH_FAILED");
    assert.deepEqual(replay(state), state);
    const missing = await simulate(scenario, undefined, f.executor());
    assert.equal(missing.work[0]!.reason!.code, "WORKSPACE_REQUIRED");
    assert.deepEqual(replay(missing), missing);
    const backend = new GitWorkspaceBackend(f.repo);
    state = await f.run("progress", scenario, {
      perform(request) {
        if (request.type === "COMMIT")
          return {
            ok: false,
            reason: {
              code: "ARTIFACT_COMMIT_FAILED",
              message: "Commit unavailable",
            },
          };
        return backend.perform(request);
      },
    });
    assert.equal(state.work[0]!.reason!.code, "ARTIFACT_COMMIT_FAILED");
    assert.equal(state.work[0]!.artifact!.ref, f.base);
    assert.equal(state.work[0]!.artifact!.cleaned, false);
    assert.deepEqual(replay(state), state);
  } finally {
    f.close(state);
  }
});

test("invalid action is validated before requested commit; step budget retains dirty workspace", async () => {
  const f = fixture();
  let state: State | undefined;
  try {
    const processExecutor = f.executor();
    state = await simulate(
      scenario,
      undefined,
      {
        protocol: 1,
        async execute(ctx) {
          await processExecutor.execute(ctx);
          return {
            version: 1,
            action: { type: "FORK", alternatives: [] },
            effects: [
              { type: "COMMIT", message: "Do not commit invalid response" },
            ],
          };
        },
      },
      undefined,
      undefined,
      new GitWorkspaceBackend(f.repo),
    );
    assert.equal(state.work[0]!.reason!.code, "INVALID_EXECUTOR_ACTION");
    assert.equal(
      state.artifactOperations!.some((o) => o.request.type === "COMMIT"),
      false,
    );
    assert.deepEqual(replay(state), state);
  } finally {
    f.close(state);
  }
  const g = fixture();
  let limited: State | undefined;
  try {
    limited = await simulate(
      scenario,
      { maxConcurrency: 1, maxSteps: 1 },
      g.executor(),
      undefined,
      undefined,
      new GitWorkspaceBackend(g.repo),
    );
    assert.equal(limited.work[0]!.reason!.code, "STEP_BUDGET");
    assert.equal(limited.work[0]!.artifact!.cleaned, false);
    assert.deepEqual(replay(limited), limited);
  } finally {
    g.close(limited);
  }
});

test("a failed spawned process returns a blocked outcome and independent lineages continue", async () => {
  const f = fixture();
  let state: State | undefined;
  try {
    state = await f.run("child-failure");
    assert.equal(
      state.work.find((w) => w.name === "child")!.reason!.code,
      "PROCESS_EXIT_FAILED",
    );
    assert.equal(state.work.find((w) => w.name === "A")!.status, "COMPLETED");
    assert.equal(state.work.find((w) => w.name === "B")!.status, "COMPLETED");
    assert.deepEqual(replay(state), state);
  } finally {
    f.close(state);
  }
});

test("actual Git commit rejection preserves the previous canonical SHA and dirty files", async () => {
  const f = fixture();
  let state: State | undefined;
  try {
    const hooks = join(f.dir, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    git(f.repo, "config", "core.hooksPath", hooks);
    state = await f.run();
    assert.equal(state.work[0]!.reason!.code, "ARTIFACT_COMMIT_FAILED");
    assert.equal(state.work[0]!.artifact!.ref, f.base);
    assert.equal(state.work[0]!.artifact!.cleaned, false);
    assert.equal(
      readFileSync(
        join(state.work[0]!.artifact!.worktree!, "progress.txt"),
        "utf8",
      ),
      "first\nsecond\n",
    );
    assert.deepEqual(replay(state), state);
  } finally {
    f.close(state);
  }
});

test("protocol rejects unstructured completion, canonical refs, duplicate names and FORK from spawned work", async () => {
  for (const response of [
    null,
    { version: 1, text: "COMPLETE", effects: [] },
    {
      version: 1,
      action: { type: "COMPLETE", result: "done", artifacts: ["forged"] },
      effects: [],
    },
    {
      version: 1,
      action: {
        type: "SPAWN",
        work: [{ name: "root", objective: "duplicate" }],
      },
      effects: [],
    },
  ]) {
    const state = await simulate(scenario, undefined, {
      protocol: 1,
      execute() {
        return response;
      },
    });
    assert.equal(state.work[0]!.status, "BLOCKED");
    assert.deepEqual(replay(state), state);
  }
  const state = await simulate(scenario, undefined, {
    protocol: 1,
    execute(ctx) {
      return {
        version: 1,
        effects: [],
        action:
          ctx.work.parentId === null
            ? ctx.work.cursor === 0
              ? { type: "SPAWN", work: [{ name: "child", objective: "child" }] }
              : { type: "COMPLETE", result: "done" }
            : {
                type: "FORK",
                alternatives: [
                  { name: "X", assumption: "X", rationale: "X" },
                  { name: "Y", assumption: "Y", rationale: "Y" },
                ],
              },
      };
    },
  });
  assert.equal(state.lineages.length, 1);
  assert.equal(state.work[1]!.reason!.code, "INVALID_EXECUTOR_ACTION");
  assert.equal(state.work[0]!.status, "COMPLETED");
  assert.deepEqual(replay(state), state);
});

test("executor identity is recorded independently from lineage identity; Git assignment rejects unknown work", async () => {
  const f = fixture();
  let state: State | undefined;
  try {
    const backend = new GitWorkspaceBackend(f.repo);
    backend.perform({ type: "INITIALIZE", taskId: "t", runId: "r" });
    const invalid = backend.perform({
      type: "COMMIT",
      taskId: "t",
      runId: "r",
      lineageId: "l",
      workId: "unknown",
      base: f.base,
      message: "No assignment",
    });
    assert.equal(invalid.ok, false);
    state = await f.run();
    assert.ok(operations(state).every((o) => o.executorId === "fixture"));
    assert.ok(state.work.every((w) => w.lineageId !== "fixture"));
  } finally {
    f.close(state);
  }
});

test("replacing the actor across invocations preserves lineage, workspace and replay", async () => {
  const f = fixture();
  let state: State | undefined;
  try {
    const actors = ["first-actor", "replacement-actor"].map(
      (id) =>
        new ProcessExecutor({
          executable: process.execPath,
          args: [actor, "progress", f.log],
          id,
        }),
    );
    let activeId = "dispatcher";
    state = await simulate(
      scenario,
      undefined,
      {
        protocol: 1,
        get id() {
          return activeId;
        },
        execute(context) {
          const selected = actors[context.work.cursor === 0 ? 0 : 1]!;
          activeId = selected.id;
          return selected.execute(context);
        },
      },
      undefined,
      undefined,
      new GitWorkspaceBackend(f.repo),
    );
    assert.equal(state.status, "COMPLETED");
    assert.deepEqual(
      operations(state).map((o) => o.executorId),
      [
        "first-actor",
        "replacement-actor",
        "replacement-actor",
        "replacement-actor",
      ],
    );
    assert.equal(state.lineages.length, 1);
    assert.equal(
      new Set(operations(state).map((o) => o.context.work.artifact!.worktree))
        .size,
      1,
    );
    assert.deepEqual(replay(state), state);
  } finally {
    f.close(state);
  }
});
