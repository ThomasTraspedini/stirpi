import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvocationSupervisor,
  OperationalChannel,
  hash,
  ProcessExecutor,
  invokeAsync,
  simulate,
  simulateAsync,
  replay,
  OperationalFailure,
  type ExecutorContext,
  type Scenario,
  type SupervisionObservation,
} from "../src/index.js";

const scenario: Scenario = {
  name: "supervision",
  objective: "test",
  publicEvaluation: { description: "test", criteria: [] },
  hiddenEvaluation: { requiredText: "done" },
  scripts: {
    root: [{ type: "CONTINUE" }, { type: "COMPLETE", result: "done" }],
  },
};

test("progress resets the local watchdog; activity and duplicate transitions do not", () => {
  let now = 0;
  const supervisor = new InvocationSupervisor(
    "invocation:test",
    { noProgressMs: 10 },
    () => now,
  );
  const channel = new OperationalChannel("test", (e) => supervisor.observe(e));
  channel.emit({ kind: "command", scope: hash("c"), status: "started" });
  now = 9;
  channel.emit({ kind: "command", scope: hash("c"), status: "completed" });
  now = 18;
  channel.emit({ kind: "output", metadata: { bytes: 100 } });
  channel.emit({ kind: "command", scope: hash("c"), status: "completed" });
  assert.equal(supervisor.check(), null);
  now = 19;
  assert.deepEqual(supervisor.check(), {
    kind: "NO_PROGRESS",
    scope: "invocation:test",
    lastProgressSequence: 2,
    elapsedMs: 10,
    limitMs: 10,
  });
});

test("continued progress can exceed arbitrary total time; no implicit timer exists", () => {
  let now = 0;
  const supervisor = new InvocationSupervisor(
    "invocation:test",
    { noProgressMs: 10 },
    () => now,
  );
  const channel = new OperationalChannel("test", (e) => supervisor.observe(e));
  for (let i = 0; i < 10000; i++) {
    now += 9;
    channel.emit({ kind: "item", scope: hash(String(i)), status: "started" });
  }
  assert.equal(supervisor.check(), null);
  const unlimited = new InvocationSupervisor(
    "invocation:unlimited",
    {},
    () => now,
  );
  now += 1e12;
  assert.equal(unlimited.check(), null);
  assert.equal(unlimited.delay(), undefined);
});

test("explicit wall budget is resource exhaustion even with recent progress", () => {
  let now = 0;
  const supervisor = new InvocationSupervisor(
    "invocation:test",
    { budgets: { wallTimeMs: 100 }, noProgressMs: 20 },
    () => now,
  );
  const channel = new OperationalChannel("test", (e) => supervisor.observe(e));
  for (now = 10; now < 100; now += 10)
    channel.emit({ kind: "item", scope: hash(String(now)), status: "started" });
  assert.deepEqual(supervisor.check(), {
    kind: "RESOURCE_EXHAUSTED",
    scope: "invocation:test",
    resource: "wallTimeMs",
    budget: 100,
    observed: 100,
  });
  assert.equal(supervisor.snapshot().elapsedNoProgressMs, 10);
});

for (const resource of ["items", "commands"] as const)
  test(`${resource} exhaustion records exact values and differs from no-progress`, () => {
    const supervisor = new InvocationSupervisor(
      "invocation:test",
      { budgets: { [resource]: 1 }, noProgressMs: 100 },
      () => 0,
    );
    new OperationalChannel("test", (e) => supervisor.observe(e)).emit({
      kind: "command",
      scope: hash("c"),
      status: "started",
    });
    const record = supervisor.snapshot();
    assert.deepEqual(record.stop, {
      kind: "RESOURCE_EXHAUSTED",
      scope: "invocation:test",
      resource,
      budget: 1,
      observed: 1,
    });
    assert.equal(record.policy.budgets![resource], 1);
    assert.equal(record.consumption[resource], 1);
    assert.equal(record.lastProgressSequence, 1);
  });

test("run step/invocation budgets record admission stops and replay recorded outcomes", () => {
  for (const resource of ["steps", "invocations"] as const) {
    const state = simulate(scenario, {
      maxConcurrency: 1,
      budgets: { [resource]: 1 },
    });
    assert.equal(state.work[0]!.reason?.stop?.kind, "RESOURCE_EXHAUSTED");
    assert.equal(state.resources.steps, 1);
    assert.deepEqual(replay(state), state);
  }
});

test("lineage budget rejects an indivisible fork without branching or estimating consumption", () => {
  const state = simulate(
    {
      ...scenario,
      scripts: {
        root: [
          {
            type: "FORK",
            alternatives: [
              { name: "a", assumption: "a", rationale: "a" },
              { name: "b", assumption: "b", rationale: "b" },
            ],
          },
        ],
      },
    },
    { maxConcurrency: 1, budgets: { lineages: 2 } },
  );
  assert.equal(state.lineages.length, 1);
  assert.equal(state.lineages[0]!.status, "BLOCKED");
  assert.deepEqual(state.work[0]!.reason?.stop, {
    kind: "RESOURCE_EXHAUSTED",
    scope: "run:run",
    resource: "lineages",
    budget: 2,
    observed: 1,
  });
  assert.deepEqual(replay(state), state);
});

test("process command budget terminates owned invocation, preserving snapshots and caller cancellation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stirpi-supervision-"));
  try {
    const context = {
      work: { artifact: { worktree: directory } },
    } as ExecutorContext;
    const script = `import {writeSync} from 'node:fs'; writeSync(3, JSON.stringify({kind:'command',scope:'${hash("c")}',status:'started'})+'\\n'); setInterval(()=>{},1000);`;
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      if (cancel) controller.abort();
      const operation = await invokeAsync(
        new ProcessExecutor(
          {
            executable: process.execPath,
            args: ["--input-type=module", "-e", script],
          },
          {
            supervision: { budgets: { commands: 1 } },
            signal: controller.signal,
          },
        ),
        context,
      );
      assert.equal(operation.outcome.ok, false);
      if (operation.outcome.ok) throw new Error("Expected stop");
      assert.equal(
        operation.outcome.reason.stop?.kind,
        cancel ? "CALLER_CANCELLED" : "RESOURCE_EXHAUSTED",
      );
      assert.equal(
        operation.supervision!.at(-1)!.stop?.kind,
        operation.outcome.reason.stop?.kind,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("replay copies invocation supervision without clocks, budgets or executor execution", async () => {
  let calls = 0;
  let record: SupervisionObservation;
  const state = await simulateAsync(
    scenario,
    { maxConcurrency: 1 },
    {
      protocol: 1,
      execute(_context, _observe, supervise) {
        calls++;
        let now = 0;
        const supervisor = new InvocationSupervisor(
          "invocation:test",
          { noProgressMs: 10 },
          () => now,
        );
        now = 10;
        const stop = supervisor.check()!;
        record = supervisor.snapshot();
        supervise?.(record);
        throw new OperationalFailure({
          code: "NO_PROGRESS",
          message: "No progress",
          stop,
        });
      },
    },
  );
  assert.deepEqual(replay(state), state);
  assert.equal(calls, 1);
  assert.equal(record!.stop!.kind, "NO_PROGRESS");
  assert.equal(state.work[0]!.status, "BLOCKED");
});

test("process watchdog stops activity-only execution and retains its first reason through cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stirpi-watchdog-"));
  try {
    const operation = await invokeAsync(
      new ProcessExecutor(
        {
          executable: process.execPath,
          args: ["-e", "setInterval(() => process.stderr.write('.'), 5)"],
        },
        {
          supervision: { noProgressMs: 200 },
        },
      ),
      { work: { artifact: { worktree: directory } } } as ExecutorContext,
    );
    assert.equal(operation.outcome.ok, false);
    if (operation.outcome.ok) throw new Error("Expected stop");
    const stop = operation.outcome.reason.stop;
    assert.equal(stop?.kind, "NO_PROGRESS");
    assert.deepEqual(operation.supervision!.at(-1)!.stop, stop);
    assert.ok(operation.observations!.some((e) => e.kind === "output"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("zero wall budget prevents launch and preserves RESOURCE_EXHAUSTED values", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stirpi-zero-wall-"));
  try {
    const operation = await invokeAsync(
      new ProcessExecutor(
        { executable: "must-not-be-launched" },
        {
          supervision: { budgets: { wallTimeMs: 0 } },
        },
      ),
      { work: { artifact: { worktree: directory } } } as ExecutorContext,
    );
    assert.equal(operation.outcome.ok, false);
    if (operation.outcome.ok) throw new Error("Expected stop");
    const stop = operation.outcome.reason.stop;
    assert.equal(stop?.kind, "RESOURCE_EXHAUSTED");
    if (stop?.kind !== "RESOURCE_EXHAUSTED")
      throw new Error("Expected resource evidence");
    assert.equal(stop.resource, "wallTimeMs");
    assert.equal(stop.budget, 0);
    assert.ok(stop.observed >= 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
