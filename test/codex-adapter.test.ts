import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  invocationFrom,
  responseFrom,
  responseContract,
} from "../adapters/codex/contract.mjs";
import { validateResponse } from "../src/executor/protocol.js";
import {
  ProcessExecutor,
  GitWorkspaceBackend,
  simulateAsync as simulate,
  replay,
} from "../src/index.js";

const adapter = resolve("adapters/codex/adapter.mjs");
const fake = resolve("test/fixtures/codex.mjs");
const codexArgs = (executable: string, ...extra: string[]) => [
  adapter,
  "--codex",
  executable,
  "--model",
  "gpt-6-astra",
  "--effort",
  "medium",
  ...extra,
];
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "stirpi-adapter-test-")));
  const repo = join(dir, "repo"),
    workspace = join(dir, "workspace");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Adapter test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-m", "Add base");
  git("worktree", "add", "-b", "assignment", workspace);
  const input = {
    version: 1,
    context: {
      work: {
        id: "w",
        name: "root",
        parentId: null,
        objective: "edit",
        cursor: 0,
        result: null,
        artifact: {
          worktree: workspace,
          ref: git("rev-parse", "HEAD"),
          cleaned: false,
        },
      },
      dna: ["own assumption"],
      publicEvaluation: { description: "Public", criteria: ["Return done"] },
      results: [],
      control: {
        version: 1,
        actions: ["CONTINUE", "SPAWN", "COMPLETE", "BLOCK"],
        semantics: {
          CONTINUE: "Continue",
          SPAWN: "Decompose",
          COMPLETE: "Evaluate",
          BLOCK: "Stop",
        },
        effects: "Request commits",
      },
    },
  };
  return {
    dir,
    repo,
    workspace,
    input,
    git,
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("input projection preserves exact task and own descendants, excluding unrelated fields at every boundary", async () => {
  const f = fixture();
  try {
    const c = f.input.context;
    const raw = JSON.stringify({
      ...f.input,
      secret: "omit",
      context: {
        ...c,
        task: "unchanged\r\n\uFEFFtask\n",
        siblings: "omit",
        hiddenEvaluation: "omit",
        work: {
          ...c.work,
          siblings: "omit",
          artifact: { ...c.work.artifact, privatePath: "omit" },
        },
        publicEvaluation: { ...c.publicEvaluation, privatePath: "omit" },
        results: [
          {
            name: "own child",
            status: "BLOCKED",
            result: null,
            reason: {
              code: "PAUSE",
              message: "Own reason",
              privatePath: "omit",
            },
            artifact: { ref: "own-ref", worktree: "omit" },
            artifacts: ["own-ref"],
            siblings: "omit",
          },
        ],
        verification: {
          available: ["unit"],
          latest: [
            {
              id: "unit",
              attempt: 1,
              passed: false,
              exitCode: 1,
              stdout: "public failure",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              durationMs: 12,
              argv: ["omit"],
            },
          ],
        },
        control: {
          version: 1,
          actions: ["CONTINUE", "BLOCK"],
          policy: "Public policy",
          privatePath: "omit",
          semantics: { CONTINUE: "Continue", BLOCK: "Stop", FORK: "omit" },
        },
      },
    });
    const projected = invocationFrom(raw);
    assert.equal(projected.task, "unchanged\r\n\uFEFFtask\n");
    assert.equal(JSON.stringify(projected).includes("omit"), false);
    assert.deepEqual(projected.context.dna, ["own assumption"]);
    assert.equal(projected.context.results[0].artifact.ref, "own-ref");
    assert.deepEqual(projected.context.verification.available, ["unit"]);
    assert.equal(projected.context.verification.latest[0].passed, false);
    assert.equal(
      JSON.stringify(projected.context.verification).includes("argv"),
      false,
    );
    assert.throws(
      () => invocationFrom(JSON.stringify({ ...f.input, version: 2 })),
      /UNSUPPORTED/,
    );
    assert.throws(
      () =>
        invocationFrom(
          JSON.stringify({
            version: 1,
            context: { ...c, work: { objective: "task" } },
          }),
        ),
      /WORKSPACE/,
    );
    assert.throws(
      () =>
        invocationFrom(
          JSON.stringify({
            ...f.input,
            context: {
              ...c,
              work: { ...c.work, objective: { secret: "not text" } },
            },
          }),
        ),
      /INVALID/,
    );
  } finally {
    f.close();
  }
});

test("all five structured actions round trip through native schema into core v1 validation", async () => {
  for (const action of [
    { type: "CONTINUE" },
    { type: "COMPLETE", result: "done" },
    { type: "BLOCK", reason: { code: "PAUSE", message: "Wait" } },
    {
      type: "SPAWN",
      work: [{ name: "child", objective: "task", priority: null }],
    },
    {
      type: "FORK",
      alternatives: ["A", "B"].map((name) => ({
        name,
        assumption: name,
        rationale: name,
        objective: null,
        priority: null,
      })),
    },
  ]) {
    const response = responseFrom(
      JSON.stringify({
        version: 1,
        action,
        effects: [{ type: "COMMIT", message: "Coherent edit" }],
        text: "COMPLETE BLOCK FORK is explanatory prose",
      }),
    );
    assert.deepEqual(validateResponse(response), response);
    assert.equal(response.action.type, action.type);
  }
  for (const raw of [
    "COMPLETE",
    "{}",
    '{"version":1,"action":{"type":"CONTINUE"},"effects":[],"text":"","__proto__":{}}',
    JSON.stringify({
      version: 2,
      action: { type: "CONTINUE" },
      effects: [],
      text: "",
    }),
    JSON.stringify({
      version: 1,
      action: { type: "WIN" },
      effects: [],
      text: "COMPLETE",
    }),
    JSON.stringify({
      version: 1,
      action: { type: "CONTINUE", extra: "COMPLETE" },
      effects: [],
      text: "",
    }),
  ])
    assert.throws(() => responseFrom(raw));
});

test("response contract exposes only assigned actions and allowlisted verification IDs", () => {
  const base = {
    control: {
      actions: ["CONTINUE", "SPAWN", "COMPLETE", "BLOCK"],
    },
  };
  const h = responseContract(base);
  const fork = JSON.stringify({
    version: 1,
    action: {
      type: "FORK",
      alternatives: ["a", "b"].map((name) => ({
        name,
        assumption: name,
        rationale: name,
        objective: null,
        priority: null,
      })),
    },
    effects: [],
    text: "",
  });
  assert.equal(h.instructions.includes("FORK"), false);
  assert.throws(() => responseFrom(fork, h), /INVALID_AGENT_RESPONSE/);
  assert.equal(
    responseFrom(
      fork,
      responseContract({
        control: { actions: [...base.control.actions, "FORK"] },
      }),
    ).action.type,
    "FORK",
  );

  const verification = responseContract({
    ...base,
    verification: { available: ["unit", "lint"] },
  });
  const envelope = (effects: unknown[], action = { type: "CONTINUE" }) =>
    JSON.stringify({ version: 1, action, effects, text: "" });
  assert.match(verification.instructions, /Available IDs: \["unit","lint"\]/);
  assert.deepEqual(
    responseFrom(envelope([{ type: "VERIFY", id: "unit" }]), verification)
      .effects,
    [{ type: "VERIFY", id: "unit" }],
  );
  for (const effects of [
    [{ type: "VERIFY", id: "foreign" }],
    [{ type: "VERIFY", id: "unit", argv: ["forged"] }],
    [
      { type: "VERIFY", id: "unit" },
      { type: "VERIFY", id: "lint" },
    ],
  ])
    assert.throws(
      () => responseFrom(envelope(effects), verification),
      /INVALID_AGENT_RESPONSE/,
    );
  assert.throws(
    () =>
      responseFrom(
        envelope([{ type: "VERIFY", id: "unit" }], {
          type: "COMPLETE",
          result: "done",
        }),
        verification,
      ),
    /INVALID_AGENT_RESPONSE/,
  );
  assert.equal(responseContract(base).instructions.includes("VERIFY"), false);
});

test("CLI uses assigned cwd, separate unchanged task, fresh homes, structured output and filtered diagnostics", async () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, codexArgs(fake), {
      cwd: f.workspace,
      input: JSON.stringify(f.input),
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: "wrong", PRIVATE_SENTINEL: "secret" },
    });
    assert.equal(result.status, 0, result.stderr);
    const response = validateResponse(JSON.parse(result.stdout));
    assert.equal(response.action.type, "COMPLETE");
    assert.deepEqual(response.effects, [
      { type: "COMMIT", message: "Add coherent change" },
    ]);
    const observed = JSON.parse(
      readFileSync(join(f.dir, "observed.json"), "utf8"),
    );
    assert.equal(realpathSync(observed.cwd), realpathSync(f.workspace));
    assert.equal(observed.task, "edit");
    assert.ok(observed.args.includes("--ephemeral"));
    assert.ok(observed.args.includes("--ignore-user-config"));
    assert.ok(observed.args.includes("--strict-config"));
    const modelIndex = observed.args.indexOf("--model");
    assert.deepEqual(observed.args.slice(modelIndex, modelIndex + 4), [
      "--model",
      "gpt-6-astra",
      "-c",
      'model_reasoning_effort="medium"',
    ]);
    assert.equal(observed.environment.includes("GIT_DIR"), false);
    assert.equal(observed.environment.includes("PRIVATE_SENTINEL"), false);
    assert.equal(observed.personalConfig, false);
    const projected = invocationFrom(JSON.stringify(f.input));
    const contract = responseContract(projected.context);
    assert.deepEqual(observed.schema, contract.schema);
    assert.equal(observed.args.at(-1).includes("FORK"), false);
    const evidence = JSON.parse(result.stderr);
    assert.equal(evidence.version, "codex-cli fixture");
    assert.equal(evidence.model, "gpt-6-astra");
    assert.equal(evidence.effort, "medium");
    assert.deepEqual(evidence.configuration.executor, {
      model: "gpt-6-astra",
      effort: "medium",
    });
    assert.equal(evidence.usage.input_tokens, 10);
    assert.equal(evidence.monetaryCost, null);
    assert.equal(result.stderr.includes("secret"), false);
    assert.equal(f.git("rev-list", "--all", "--count"), "1"); // Agent edits never commit.
  } finally {
    f.close();
  }
});

test("Codex model and effort are mandatory, singular and supported before launch", () => {
  const f = fixture();
  try {
    const configurations = [
      [adapter, "--codex", fake, "--effort", "medium"],
      [adapter, "--codex", fake, "--model", "gpt-6-astra"],
      [...codexArgs(fake), "--model", "gpt-contradictory"],
      [...codexArgs(fake), "--effort", "high"],
      [
        adapter,
        "--codex",
        fake,
        "--model",
        "gpt-6-astra",
        "--effort",
        "unsupported",
      ],
    ];
    for (const args of configurations) {
      const result = spawnSync(process.execPath, args, {
        cwd: f.workspace,
        input: JSON.stringify(f.input),
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(
        JSON.parse(result.stderr).failure.code,
        "INVALID_CONFIGURATION",
      );
    }
  } finally {
    f.close();
  }
});

test("workspace aliases are accepted, but a different linked worktree is rejected", async () => {
  const f = fixture();
  try {
    const alias = join(f.dir, "workspace-alias");
    const other = join(f.dir, "other-workspace");
    symlinkSync(f.workspace, alias, "junction");
    f.git("worktree", "add", "-b", "other-assignment", other);
    f.input.context.work.artifact.worktree = alias;
    for (const cwd of [f.workspace, alias, other]) {
      const result = spawnSync(process.execPath, codexArgs(fake), {
        cwd,
        input: JSON.stringify(f.input),
        encoding: "utf8",
      });
      if (cwd === other) {
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.equal(
          JSON.parse(result.stderr).failure.code,
          "INVALID_WORKSPACE",
        );
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          validateResponse(JSON.parse(result.stdout)).action.type,
          "COMPLETE",
        );
      }
    }
  } finally {
    f.close();
  }
});

for (const [task, code] of [
  ["exit", "AGENT_EXIT_FAILED"],
  ["prose", "INVALID_AGENT_RESPONSE"],
  ["invalid-action", "INVALID_AGENT_RESPONSE"],
  ["timeout", "AGENT_WALL_TIME_EXHAUSTED"],
  ["overflow", "AGENT_OUTPUT_LIMIT"],
])
  test(`${task} is operational failure with no semantic stdout`, async () => {
    const f = fixture();
    try {
      f.input.context.work.objective = task!;
      const r = spawnSync(
        process.execPath,
        codexArgs(fake, "--timeout-ms", task === "timeout" ? "200" : "5000"),
        { cwd: f.workspace, input: JSON.stringify(f.input), encoding: "utf8" },
      );
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "");
      assert.equal(JSON.parse(r.stderr).failure.code, code);
      assert.equal(r.stderr.includes("secret diagnostic"), false);
    } finally {
      f.close();
    }
  });

test("unavailable executable, launch rejection, missing/mismatched workspace, and unsupported input fail closed", async () => {
  const f = fixture();
  try {
    for (const [executable, cwd, input, code] of [
      [join(f.dir, "missing"), f.workspace, f.input, "AGENT_UNAVAILABLE"],
      [f.repo, f.workspace, f.input, "AGENT_LAUNCH_FAILED"],
      [fake, f.repo, f.input, "INVALID_WORKSPACE"],
      [
        fake,
        f.workspace,
        { ...f.input, version: 9 },
        "UNSUPPORTED_PROTOCOL_VERSION",
      ],
      [
        fake,
        f.workspace,
        {
          version: 1,
          context: { ...f.input.context, work: { objective: "task" } },
        },
        "WORKSPACE_REQUIRED",
      ],
    ] as const) {
      const r = spawnSync(process.execPath, codexArgs(executable), {
        cwd,
        input: JSON.stringify(input),
        encoding: "utf8",
      });
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "");
      assert.equal(JSON.parse(r.stderr).failure.code, code);
    }
  } finally {
    f.close();
  }
});

test("existing process/engine boundary owns commits, evaluation, operational failure and replay", async () => {
  const f = fixture();
  try {
    for (const objective of ["edit", "exit"]) {
      const executor = new ProcessExecutor({
        executable: process.execPath,
        args: codexArgs(fake),
        id: "fixture-adapter",
      });
      const state = await simulate(
        {
          name: "adapter",
          objective,
          publicEvaluation: { description: "done", criteria: ["done"] },
          hiddenEvaluation: { requiredText: "done" },
          scripts: {},
        },
        undefined,
        executor,
        undefined,
        undefined,
        new GitWorkspaceBackend(f.repo),
      );
      assert.equal(
        state.status,
        objective === "edit" ? "COMPLETED" : "BLOCKED",
      );
      assert.equal(
        state.work[0]!.reason?.code,
        objective === "exit" ? "PROCESS_EXIT_FAILED" : undefined,
      );
      assert.deepEqual(replay(state), state);
      if (objective === "edit")
        assert.equal(
          f.git("show", `${state.work[0]!.artifact!.ref}:change.txt`),
          "coherent change",
        );
      for (const w of state.work)
        if (w.artifact?.worktree)
          rmSync(join(w.artifact.worktree, ".."), {
            recursive: true,
            force: true,
          });
    }
  } finally {
    f.close();
  }
});

test("outer cancellation reaches the adapter's detached Codex scope and retains telemetry", async () => {
  const f = fixture();
  const controller = new AbortController();
  const events: import("../src/operational/index.js").OperationalEvent[] = [];
  try {
    const child = join(f.dir, "streaming-codex.mjs");
    writeFileSync(
      child,
      `#!/usr/bin/env node
      import {writeFileSync} from 'node:fs';
      if (process.argv.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
      writeFileSync('pending.txt','inspect');
      writeFileSync('../child.pid',String(process.pid));
      console.log(JSON.stringify({type:'item.started',item:{id:'item_1',type:'command_execution',command:'fixture',status:'in_progress'}}));
      setInterval(()=>{},100);
    `,
      { mode: 0o755 },
    );
    const executor = new ProcessExecutor(
      { executable: process.execPath, args: codexArgs(child) },
      {
        signal: controller.signal,
        observeEvent(event) {
          events.push(event);
          if (event.kind === "command") controller.abort();
        },
      },
    );
    await assert.rejects(
      executor.execute(
        f.input
          .context as unknown as import("../src/executor/index.js").ExecutorContext,
      ),
      /EXECUTOR_CANCELLED/,
    );
    assert.ok(events.some((e) => e.kind === "command"));
    assert.equal(
      readFileSync(join(f.workspace, "pending.txt"), "utf8"),
      "inspect",
    );
    const pid = Number(readFileSync(join(f.dir, "child.pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    f.close();
  }
});

test("message-classified errors cross the process boundary without ending semantic execution", async () => {
  const f = fixture();
  try {
    const child = join(f.dir, "diagnostic-codex.mjs");
    writeFileSync(
      child,
      `#!/usr/bin/env node
      import {writeFileSync} from 'node:fs';
      if (process.argv.includes('--version')) { console.log('codex-cli 0.154.0-alpha.6.2'); process.exit(0); }
      console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
      console.log(JSON.stringify({type:'turn.started'}));
      for (const event of [
        {type:'error',message:'unexpected status 429 Too Many Requests: raw-credential-sentinel'},
        {type:'turn.failed',error:{message:'Connection failed: raw-credential-sentinel'}}
      ]) console.log(JSON.stringify(event));
      console.log(JSON.stringify({type:'turn.started'}));
      console.log(JSON.stringify({type:'turn.completed'}));
      writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1], JSON.stringify({version:1,action:{type:'COMPLETE',result:'done'},effects:[],text:''}));
    `,
      { mode: 0o755 },
    );
    const observations: import("../src/executor/process.js").ProcessObservation[] =
      [];
    const events: import("../src/operational/index.js").OperationalEvent[] = [];
    const executor = new ProcessExecutor(
      { executable: process.execPath, args: codexArgs(child) },
      {
        observe: (o) => observations.push(o),
        observeEvent: (e) => events.push(e),
      },
    );
    const state = await simulate(
      {
        name: "error-diagnostics",
        objective: "Return done without edits",
        publicEvaluation: { description: "done", criteria: ["done"] },
        hiddenEvaluation: { requiredText: "done" },
        scripts: {},
      },
      undefined,
      executor,
      undefined,
      undefined,
      new GitWorkspaceBackend(f.repo),
    );
    assert.equal(state.status, "COMPLETED");
    assert.deepEqual(replay(state), state);
    const errors = events.filter((e) => e.metadata?.diagnosticCategory);
    assert.deepEqual(
      errors.map((e) => e.metadata?.diagnosticCategory),
      ["RATE_OR_USAGE_LIMIT", "NETWORK_CONNECTION"],
    );
    assert.deepEqual(errors[0]?.categories, ["activity"]);
    const persisted = join(f.dir, "persisted.json");
    writeFileSync(persisted, JSON.stringify({ state, observations, events }));
    assert.equal(
      readFileSync(persisted, "utf8").includes("raw-credential-sentinel"),
      false,
    );
    assert.equal(
      observations[0]?.adapterDiagnostics?.errors instanceof Array,
      true,
    );
    for (const w of state.work)
      if (w.artifact?.worktree)
        rmSync(join(w.artifact.worktree, ".."), {
          recursive: true,
          force: true,
        });
  } finally {
    f.close();
  }
});
