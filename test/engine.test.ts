import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  simulate,
  ScriptedExecutor,
  dna,
  sumResources,
  Store,
  replay,
  jsonl,
  tree,
  inspect,
} from "../src/index.js";
import { reference } from "../src/scenarios/index.js";
import { select } from "../src/scheduler/index.js";

test("reference distinguishes fork and spawn, waits, resumes, and preserves DNA", () => {
  const s = simulate(reference);
  assert.equal(s.lineages.length, 3);
  assert.equal(s.work.length, 5);
  assert.deepEqual(
    s.lineages.map((l) => l.status),
    ["BRANCHED", "COMPLETED", "BLOCKED"],
  );
  assert.equal(select(s.work, 10).length, 0);
  for (const l of s.lineages.slice(1)) assert.equal(dna(s, l.id).length, 1);
  const a = s.lineages[1]!;
  for (const w of s.work.filter((w) => ["X", "Y"].includes(w.name)))
    assert.deepEqual(dna(s, w.lineageId), dna(s, a.id));
  const resumed = s.events.findIndex((e) => e.type === "RESUMED");
  assert.ok(
    resumed >
      s.events.findIndex((e) => e.type === "COMPLETED" && e.subject === "w5"),
  );
  assert.match(tree(s), /FORK A/);
  assert.match(tree(s), /SPAWN X/);
  assert.deepEqual(s.resources, sumResources(s.work));
  assert.equal(s.resources.steps, 7);
  assert.ok(!JSON.stringify(inspect(s)).includes("hiddenEvaluation"));
});
test("completed siblings are legal and invalid actions stay local", () => {
  const scenario = structuredClone(reference);
  scenario.scripts.B = [{ type: "COMPLETE", result: "B done" }];
  assert.equal(
    simulate(scenario).lineages.filter((l) => l.status === "COMPLETED").length,
    2,
  );
  scenario.scripts.A = [
    {
      type: "FORK",
      alternatives: [{ name: "bad", assumption: ["two", "assumptions"] }],
    },
  ];
  const s = simulate(scenario);
  assert.equal(s.lineages[1]!.reason!.code, "INVALID_EXECUTOR_ACTION");
  assert.equal(s.lineages[2]!.status, "COMPLETED");
  assert.equal(s.lineages.length, 3);
});
test("SQLite reload, append-only log, JSONL and replay", () => {
  const store = new Store(":memory:");
  try {
    const s = simulate(reference, undefined, undefined, undefined, {
      taskId: "task-test",
      runId: "test",
    });
    store.save(s);
    assert.deepEqual(store.load("test"), s);
    assert.deepEqual(replay(store.load("test")), s);
    assert.equal(jsonl(s).trim().split("\n").length, s.events.length);
    assert.throws(() => store.db.exec("DELETE FROM events"), /append-only/);
    assert.throws(
      () => store.db.exec("UPDATE events SET type='oops'"),
      /append-only/,
    );
    assert.throws(() => store.save(s));
    assert.deepEqual(store.load("test"), s);
    const modified = structuredClone(s);
    modified.events.pop();
    assert.throws(() => replay(modified), /mismatch/);
  } finally {
    store.close();
  }
});
test("priority and FIFO", () => {
  const s = simulate(reference);
  const ws = s.work.map((w, i) => ({
    ...w,
    status: "ACTIVE" as const,
    priority: i === 2 ? 4 : 0,
    queue: i,
  }));
  assert.deepEqual(
    select(ws, 3).map((w) => w.id),
    ["w3", "w1", "w2"],
  );
});
test("blocked child releases parent without blocking its lineage", () => {
  const scenario = structuredClone(reference);
  scenario.scripts.X = [
    { type: "BLOCK", reason: { code: "INPUT", message: "Missing" } },
  ];
  const s = simulate(scenario);
  assert.equal(s.lineages[1]!.status, "COMPLETED");
  assert.equal(s.work.find((w) => w.name === "X")!.status, "BLOCKED");
});
test("executor receives public criteria, results, and isolated state only", () => {
  let count = 0;
  simulate(reference, undefined, {
    execute(ctx) {
      assert.ok(!("hiddenEvaluation" in ctx));
      count++;
      ctx.work.resources.steps = 999;
      return { type: "COMPLETE", result: "done" };
    },
  });
  assert.equal(count, 1);
});
test("budget enforcement and deterministic replay across configurations (property)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 30 }),
      fc.integer({ min: 1, max: 6 }),
      (maxSteps, maxConcurrency) => {
        const s = simulate(reference, { maxSteps, maxConcurrency });
        assert.ok(s.resources.steps <= maxSteps);
        assert.deepEqual(s.resources, sumResources(s.work));
        assert.deepEqual(replay(s), s);
        assert.ok(
          !s.work.some((w) => w.status === "ACTIVE" || w.status === "WAITING"),
        );
        if (maxSteps >= 7) assert.equal(s.lineages.length, 3);
      },
    ),
  );
});
test("each child extends ancestry by exactly one assumption (property)", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 12 }), (n) => {
      const scenario = structuredClone(reference);
      scenario.scripts = {
        root: [
          {
            type: "FORK",
            alternatives: Array.from({ length: n }, (_, i) => ({
              name: `child${i}`,
              assumption: `assumption${i}`,
              rationale: "Explore",
            })),
          },
        ],
      };
      for (let i = 0; i < n; i++)
        scenario.scripts[`child${i}`] = [{ type: "COMPLETE", result: "done" }];
      const s = simulate(scenario);
      assert.equal(s.lineages.length, n + 1);
      assert.equal(
        s.lineages.filter((l) => l.status === "COMPLETED").length,
        n,
      );
      for (const l of s.lineages.slice(1))
        assert.deepEqual(dna(s, l.id), [l.assumption]);
    }),
  );
});

test("nested fork reconstructs cumulative DNA and work-unit fork fails locally", () => {
  const scenario = structuredClone(reference);
  scenario.scripts.A = [
    {
      type: "FORK",
      alternatives: [
        { name: "AA", assumption: "Further A", rationale: "Refine" },
        { name: "AB", assumption: "Further B", rationale: "Refine" },
      ],
    },
  ];
  scenario.scripts.AA = [{ type: "COMPLETE", result: "done" }];
  scenario.scripts.AB = [{ type: "COMPLETE", result: "done" }];
  const nested = simulate(scenario);
  assert.deepEqual(
    dna(nested, nested.lineages.find((l) => l.name === "AA")!.id),
    ["Use strategy A", "Further A"],
  );
  const invalid = structuredClone(reference);
  invalid.scripts.X = scenario.scripts.A;
  const s = simulate(invalid);
  assert.equal(s.lineages.length, 3);
  assert.equal(
    s.work.find((w) => w.name === "X")!.reason!.code,
    "INVALID_EXECUTOR_ACTION",
  );
  assert.equal(s.lineages[1]!.status, "COMPLETED");
});
test("all spawned work gates resumption and evaluator failures stay local", () => {
  const scenario = structuredClone(reference);
  scenario.scripts.A = [
    {
      type: "SPAWN",
      work: [{ name: "X", objective: "Check", priority: -1 }],
    },
    { type: "COMPLETE", result: "done" },
  ];
  scenario.scripts.X = [{ type: "COMPLETE", result: "failed" }];
  const s = simulate(scenario);
  assert.ok(
    s.events.findIndex((e) => e.type === "RESUMED") >
      s.events.findIndex((e) => e.type === "ACTION" && e.subject === "w4"),
  );
  assert.equal(s.lineages[1]!.status, "COMPLETED");
  assert.equal(
    s.work.find((w) => w.name === "X")!.reason!.code,
    "EVALUATION_FAILED",
  );
});

test("two runs share one task and preserve identities through replay", () => {
  const store = new Store(":memory:");
  try {
    for (const [runId, maxConcurrency] of [
      ["first", 1],
      ["second", 2],
    ] as const) {
      const state = simulate(
        reference,
        { maxConcurrency, maxSteps: 100 },
        undefined,
        undefined,
        { taskId: "shared", runId },
      );
      store.save(state);
      assert.deepEqual(store.load(runId), state);
      assert.deepEqual(replay(store.load(runId)), state);
    }
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM tasks").get()!.n,
      1,
    );
    assert.equal(
      store.db
        .prepare("SELECT count(*) AS n FROM runs WHERE task_id='shared'")
        .get()!.n,
      2,
    );
    const changed = structuredClone(reference);
    changed.objective = "Different problem";
    assert.throws(
      () =>
        store.save(
          simulate(changed, undefined, undefined, undefined, {
            taskId: "shared",
            runId: "third",
          }),
        ),
      /Task definition mismatch/,
    );
    assert.throws(() => store.load("third"), /Unknown run/);
  } finally {
    store.close();
  }
});

test("SPAWN rejects the removed required field locally", () => {
  for (const required of [false, true]) {
    const scenario = structuredClone(reference);
    scenario.scripts.A = [
      { type: "SPAWN", work: [{ name: "X", objective: "Check", required }] },
    ];
    const state = simulate(scenario);
    assert.equal(state.lineages[1]!.reason!.code, "INVALID_EXECUTOR_ACTION");
    assert.equal(state.work.length, 3);
  }
});

test("parent receives blocked child status and reason after all children finish", () => {
  const scenario = structuredClone(reference);
  scenario.scripts.X = [
    { type: "BLOCK", reason: { code: "INPUT", message: "Missing" } },
  ];
  const scripted = new ScriptedExecutor(scenario.scripts);
  let resumed = false;
  simulate(scenario, undefined, {
    execute(ctx) {
      if (ctx.work.name === "A" && ctx.work.cursor === 1) {
        resumed = true;
        assert.deepEqual(
          ctx.results.find((c) => c.name === "X"),
          {
            name: "X",
            status: "BLOCKED",
            result: null,
            reason: { code: "INPUT", message: "Missing" },
          },
        );
        assert.equal(
          ctx.results.find((c) => c.name === "Y")!.status,
          "COMPLETED",
        );
      }
      return scripted.execute(ctx);
    },
  });
  assert.ok(resumed);
});
