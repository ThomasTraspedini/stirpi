import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcessExecutor,
  OperationalChannel,
  hash,
  summarize,
  simulateAsync,
  replay,
  type OperationalEvent,
  type ExecutorContext,
  type ExecutorOperation,
  invokeAsync,
} from "../src/index.js";
import { JsonLines } from "../src/operational/jsonl.js";
import { CodexEvents } from "../adapters/codex/events.mjs";

function fixture(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "stirpi-telemetry-"));
  const path = join(directory, "actor.mjs");
  writeFileSync(path, script);
  const context = {
    work: { artifact: { worktree: directory, cleaned: false } },
  } as ExecutorContext;
  return {
    directory,
    context,
    config: { executable: process.execPath, args: [path] },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
const final = { version: 1, action: { type: "CONTINUE" }, effects: [] };

test("stdout is consumed incrementally; ordered observations precede completion and stderr cannot select an action", async () => {
  const f = fixture(`
    import {writeSync, writeFileSync, existsSync} from 'node:fs';
    const emit = e => writeSync(3, JSON.stringify(e)+'\\n');
    process.stdout.write('{"version":');
    while(!existsSync('stdout-release')) await new Promise(r=>setTimeout(r,5));
    process.stderr.write('{"version":1,"action":{"type":"COMPLETE","result":"wrong"},"effects":[]}');
    const scope = '${hash("command")}';
    emit({kind:'command',scope,status:'started',metadata:{commandHash:'${hash("echo")}',password:'DO-NOT-STORE'}});
    emit({kind:'command',scope,status:'started'});
    emit({kind:'usage',metadata:{inputTokens:999999999,outputTokens:12,secret:'DO-NOT-STORE'}});
    while(!existsSync('release')) await new Promise(r=>setTimeout(r,5));
    emit({kind:'command',scope,status:'completed',metadata:{exitCode:0}});
    process.stdout.write('1,"action":{"type":"CONTINUE"},"effects":[]}');
    writeFileSync('closed','yes');
  `);
  const events: OperationalEvent[] = [];
  let processCompleted = false;
  try {
    const executor = new ProcessExecutor(f.config, {
      timeoutMs: 5000,
      observe: () => {
        processCompleted = true;
      },
      observeEvent(event) {
        events.push(event);
        if (event.kind === "output" && event.scope === hash("stdout")) {
          assert.equal(processCompleted, false);
          writeFileSync(join(f.directory, "stdout-release"), "yes");
        }
        if (event.kind === "usage") {
          assert.equal(processCompleted, false);
          assert.equal(existsSync(join(f.directory, "closed")), false);
          writeFileSync(join(f.directory, "release"), "yes");
        }
      },
    });
    assert.deepEqual(await executor.execute(f.context), final);
    assert.ok(events.some((e) => e.kind === "output"));
    assert.deepEqual(
      events.map((e) => e.sequence),
      events.map((_, i) => i + 1),
    );
    const commands = events.filter((e) => e.kind === "command");
    assert.ok(commands[0]!.categories.includes("progress"));
    assert.deepEqual(commands[1]!.categories, ["activity"]);
    assert.ok(commands[2]!.categories.includes("progress"));
    assert.equal(summarize(events).commandCount, 1);
    assert.equal(summarize(events).latestUsage?.inputTokens, 999999999);
    assert.equal(JSON.stringify(events).includes("DO-NOT-STORE"), false);
  } finally {
    f.close();
  }
});

for (const [name, output, failure] of [
  ["legacy executor without events", JSON.stringify(final), null],
  ["missing final", "", "INVALID_EXECUTOR_JSON"],
  ["malformed final", "{", "INVALID_EXECUTOR_JSON"],
  [
    "multiple finals",
    JSON.stringify(final) + JSON.stringify(final),
    "INVALID_EXECUTOR_JSON",
  ],
  ["bounded output", "x".repeat(1024 * 1024 + 1), "PROCESS_OUTPUT_LIMIT"],
] as const)
  test(name, async () => {
    const f = fixture(`process.stdout.write(${JSON.stringify(output)});`);
    try {
      let size = 0;
      const executor = new ProcessExecutor(f.config, {
        observe(o) {
          size = Buffer.byteLength(o.stdout) + Buffer.byteLength(o.stderr);
        },
      });
      if (failure)
        await assert.rejects(
          executor.execute(f.context),
          (e: Error & { reason: { code: string } }) =>
            e.reason.code === failure,
        );
      else assert.deepEqual(await executor.execute(f.context), final);
      assert.ok(size <= 1024 * 1024);
    } finally {
      f.close();
    }
  });

test("explicit cancellation and wall-time exhaustion preserve observations and dirty files, with distinct reasons", async () => {
  for (const cancel of [true, false]) {
    const f = fixture(
      `import {writeFileSync,writeSync} from 'node:fs'; writeFileSync('dirty','inspect me'); writeSync(3,JSON.stringify({kind:'command',scope:'${hash("c")}',status:'started'})+'\\n'); setInterval(()=>{},100);`,
    );
    const controller = new AbortController();
    const events: OperationalEvent[] = [];
    try {
      const executor = new ProcessExecutor(f.config, {
        signal: controller.signal,
        ...(cancel ? {} : { timeoutMs: 300 }),
        observeEvent(e) {
          events.push(e);
          if (cancel && e.kind === "command") controller.abort();
        },
      });
      await assert.rejects(
        executor.execute(f.context),
        (e: Error & { reason: { code: string } }) =>
          e.reason.code ===
          (cancel ? "EXECUTOR_CANCELLED" : "EXECUTOR_WALL_TIME_EXHAUSTED"),
      );
      assert.equal(
        readFileSync(join(f.directory, "dirty"), "utf8"),
        "inspect me",
      );
      assert.ok(events.some((e) => e.kind === "command"));
      assert.equal(
        events.at(-1)!.status,
        cancel ? "cancelled" : "resource_exhausted",
      );
    } finally {
      f.close();
    }
  }
});

test("pre-cancelled invocation does not launch and still records operational termination", async () => {
  const f = fixture("throw new Error('must not launch')");
  const controller = new AbortController();
  controller.abort();
  const events: OperationalEvent[] = [];
  try {
    await assert.rejects(
      new ProcessExecutor(f.config, {
        signal: controller.signal,
        observeEvent: (e) => events.push(e),
      }).execute(f.context),
      /EXECUTOR_CANCELLED/,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.status, "cancelled");
  } finally {
    f.close();
  }
});

test("bounded JSONL framing handles split UTF-8, multiple lines and incomplete or oversized EOF", () => {
  const values: unknown[] = [];
  let invalid = 0;
  const parser = new JsonLines(
    (v) => values.push(v),
    () => invalid++,
    32,
  );
  const text = Buffer.from('{"text":"è"}\n{"n":1}\n');
  const split = text.indexOf(Buffer.from("è")) + 1;
  parser.write(text.subarray(0, split));
  parser.write(text.subarray(split));
  parser.write(Buffer.from("x".repeat(50) + '\n{"n":2}'));
  parser.end();
  assert.deepEqual(values, [{ text: "è" }, { n: 1 }, { n: 2 }]);
  assert.equal(invalid, 1);
  const partial = new JsonLines(
    (v) => values.push(v),
    () => invalid++,
  );
  partial.write(Buffer.from('{"n":'));
  partial.end();
  assert.equal(invalid, 2);
});

test("Codex incremental mapper uses selected fields; duplicates and reasoning updates are not new progress", () => {
  const events: OperationalEvent[] = [];
  const channel = new OperationalChannel("fixture", (e) => events.push(e));
  const parser = new CodexEvents(
    (e: Parameters<OperationalChannel["emit"]>[0]) => channel.emit(e),
  );
  const inputs = [
    { type: "thread.started", thread_id: "native-thread" },
    { type: "turn.started" },
    {
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "echo   secret",
        status: "in_progress",
      },
    },
    {
      type: "item.updated",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "echo secret",
        status: "in_progress",
        aggregated_output: "secret",
      },
    },
    {
      type: "item.completed",
      item: { id: "item_1", type: "command_execution", exit_code: 0 },
    },
    {
      type: "item.updated",
      item: { id: "item_2", type: "reasoning", text: "secret" },
    },
    {
      type: "item.completed",
      item: {
        id: "item_3",
        type: "file_change",
        changes: [{ path: "secret", kind: "update" }],
      },
    },
    {
      type: "item.started",
      item: {
        id: "item_4",
        type: "mcp_tool_call",
        server: "private",
        tool: "secret",
      },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        cached_input_tokens: 3,
        output_tokens: 2,
        reasoning_output_tokens: 0,
        total_tokens: 12,
        secret: "omit",
      },
    },
  ];
  const bytes = Buffer.from(inputs.map((e) => JSON.stringify(e)).join("\n"));
  parser.write(bytes.subarray(0, 12));
  assert.equal(events.length, 0);
  parser.write(bytes.subarray(12));
  assert.ok(events.length > 1);
  parser.end();
  assert.equal(events.filter((e) => e.kind === "command").length, 3);
  assert.equal(
    events
      .filter((e) => e.kind === "command")[1]!
      .categories.includes("progress"),
    false,
  );
  assert.deepEqual(
    events.find((e) => e.kind === "reasoning")!.categories.includes("progress"),
    false,
  );
  assert.equal(JSON.stringify(events).includes("secret"), false);
  assert.equal(events.find((e) => e.kind === "file")!.metadata!.files, 1);
  assert.equal(
    events.find((e) => e.kind === "tool")!.metadata!.toolHash,
    hash(JSON.stringify(["private", "secret"])),
  );
  assert.equal(summarize(events).latestUsage?.reasoningOutputTokens, 0);
  assert.equal(summarize(events).latestUsage?.totalTokens, undefined); // Not documented by this CLI interface.
  const before = events.length;
  parser.write(Buffer.from('{"type":'));
  parser.end();
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1)!.kind, "diagnostic");
});

test("recorded observations replay without executor calls; corrupt chronology and final transition are rejected", async () => {
  let calls = 0;
  const state = await simulateAsync(
    {
      name: "telemetry",
      objective: "fixture",
      publicEvaluation: { description: "fixture", criteria: [] },
      hiddenEvaluation: { requiredText: "done" },
      scripts: {},
    },
    undefined,
    {
      protocol: 1,
      async execute(_context, observe) {
        calls++;
        const channel = new OperationalChannel("fixture", (e) => observe?.(e));
        channel.emit(
          { kind: "command", scope: hash("scope"), status: "started" },
          "2026-01-01T00:00:00.000Z",
        );
        channel.emit(
          { kind: "command", scope: hash("scope"), status: "completed" },
          "2026-01-01T00:00:00.000Z",
        );
        return {
          version: 1,
          action: { type: "COMPLETE", result: "done" },
          effects: [],
        };
      },
    },
  );
  assert.deepEqual(replay(state), state);
  assert.equal(calls, 1);
  for (const corrupt of ["sequence", "action"]) {
    const copy = structuredClone(state);
    const op = copy.events.find((e) => e.type === "EXECUTOR_OPERATION")!
      .data as ExecutorOperation;
    if (corrupt === "sequence") op.observations!.reverse();
    else if (op.outcome.ok)
      (op.outcome.response as typeof final).action.type = "CONTINUE";
    assert.throws(() => replay(copy), /Replay/);
  }
});

test("an observer failure is local and cleans up the process without losing previously collected events", async () => {
  const f = fixture(
    "process.stdout.write('activity'); setInterval(()=>{},100)",
  );
  const observed: OperationalEvent[] = [];
  try {
    const executor = new ProcessExecutor(f.config, {
      observeEvent(event) {
        if (event.kind === "output") throw new Error("sink unavailable");
      },
    });
    await assert.rejects(
      executor.execute(f.context, (e) => observed.push(e)),
      /PROCESS_OBSERVER_FAILED/,
    );
    assert.ok(observed.some((e) => e.kind === "output"));
    assert.equal(observed.at(-1)!.status, "failed");
  } finally {
    f.close();
  }
});

test("in-process callbacks receive the same bounded persistence projection", async () => {
  const operation = await invokeAsync(
    {
      protocol: 1,
      execute(_context, observe) {
        observe?.({
          invocationId: "sensitive-identity",
          sequence: 500,
          timestamp: "2026-01-01T00:00:00.000Z",
          kind: "usage",
          categories: ["progress"],
          metadata: { inputTokens: 100, secret: "private".repeat(10000) },
        });
        return final;
      },
    },
    {} as ExecutorContext,
  );
  const event = operation.observations![0]!;
  assert.equal(event.sequence, 1);
  assert.equal(event.invocationId, hash("sensitive-identity"));
  assert.deepEqual(event.categories, ["activity", "resource"]);
  assert.deepEqual(event.metadata, { inputTokens: 100 });
  assert.ok(JSON.stringify(event).length < 2048);
});
