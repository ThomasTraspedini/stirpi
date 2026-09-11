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
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  invocationFrom,
  responseFrom,
  responseSchema,
} from "../adapters/codex/contract.mjs";
import { validateResponse } from "../src/executor/protocol.js";
import {
  ProcessExecutor,
  GitWorkspaceBackend,
  simulate,
  replay,
} from "../src/index.js";

const adapter = resolve("adapters/codex/adapter.mjs");
const fake = resolve("test/fixtures/codex.mjs");
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

test("input projection preserves exact task and own descendants, excluding unrelated fields at every boundary", () => {
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

test("all five structured actions round trip through native schema into core v1 validation", () => {
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

test("CLI uses assigned cwd, separate unchanged task, fresh homes, structured output and filtered diagnostics", () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, [adapter, "--codex", fake], {
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
    assert.equal(observed.cwd, f.workspace);
    assert.equal(observed.task, "edit");
    assert.ok(observed.args.includes("--ephemeral"));
    assert.ok(observed.args.includes("--ignore-user-config"));
    assert.equal(observed.environment.includes("GIT_DIR"), false);
    assert.equal(observed.environment.includes("PRIVATE_SENTINEL"), false);
    assert.equal(observed.personalConfig, false);
    assert.deepEqual(observed.schema, responseSchema);
    const evidence = JSON.parse(result.stderr);
    assert.equal(evidence.version, "codex-cli fixture");
    assert.equal(evidence.usage.input_tokens, 10);
    assert.equal(evidence.monetaryCost, null);
    assert.equal(result.stderr.includes("secret"), false);
    assert.equal(f.git("rev-list", "--all", "--count"), "1"); // Agent edits never commit.
  } finally {
    f.close();
  }
});

for (const [task, code] of [
  ["exit", "AGENT_EXIT_FAILED"],
  ["prose", "INVALID_AGENT_RESPONSE"],
  ["invalid-action", "INVALID_AGENT_RESPONSE"],
  ["timeout", "AGENT_TIMEOUT"],
  ["overflow", "AGENT_OUTPUT_LIMIT"],
])
  test(`${task} is operational failure with no semantic stdout`, () => {
    const f = fixture();
    try {
      f.input.context.work.objective = task!;
      const r = spawnSync(
        process.execPath,
        [
          adapter,
          "--codex",
          fake,
          "--timeout-ms",
          task === "timeout" ? "200" : "5000",
        ],
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

test("unavailable executable, launch rejection, missing/mismatched workspace, and unsupported input fail closed", () => {
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
      const r = spawnSync(process.execPath, [adapter, "--codex", executable], {
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

test("existing process/engine boundary owns commits, evaluation, operational failure and replay", () => {
  const f = fixture();
  try {
    for (const objective of ["edit", "exit"]) {
      const executor = new ProcessExecutor({
        executable: process.execPath,
        args: [adapter, "--codex", fake],
        id: "fixture-adapter",
      });
      const state = simulate(
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
