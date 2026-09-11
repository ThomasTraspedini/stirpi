import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitArtifactBackend,
  assertExternalGitState,
  simulate,
  replay,
  Store,
  ScriptedExecutor,
  type ArtifactRequest,
} from "../src/index.js";
import { reference } from "../src/scenarios/index.js";

function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  }).trim();
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "stirpi-test-"));
  const repo = join(dir, "target");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Artifact Test");
  git(repo, "config", "user.email", "artifact@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "result.txt"), "base\n");
  git(repo, "add", "result.txt");
  git(repo, "commit", "-m", "Add base result");
  return {
    dir,
    repo,
    base: git(repo, "rev-parse", "HEAD"),
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const initialize: ArtifactRequest = {
  type: "INITIALIZE",
  taskId: "t",
  runId: "r",
};

test("clean targets accepted; tracked and untracked changes rejected locally", () => {
  const f = fixture();
  try {
    assert.deepEqual(new GitArtifactBackend(f.repo).perform(initialize), {
      ok: true,
      artifact: { ref: f.base, base: f.base },
    });
    for (const file of ["result.txt", "new.txt"]) {
      writeFileSync(join(f.repo, file), "dirty\n");
      let called = false;
      const state = simulate(
        reference,
        undefined,
        undefined,
        undefined,
        undefined,
        new GitArtifactBackend(f.repo, () => {
          called = true;
        }),
      );
      assert.equal(state.status, "BLOCKED");
      assert.equal(state.lineages[0]!.reason!.code, "DIRTY_REPOSITORY");
      assert.equal(state.resources.steps, 0);
      assert.equal(called, false);
      assert.equal(readFileSync(join(f.repo, file), "utf8"), "dirty\n");
      assert.deepEqual(replay(state), state);
      if (file === "result.txt") writeFileSync(join(f.repo, file), "base\n");
      else rmSync(join(f.repo, file));
    }
    assert.equal(git(f.repo, "branch", "--format=%(refname:short)"), "main");
    assert.equal(new GitArtifactBackend(f.dir).perform(initialize).ok, false);
  } finally {
    f.close();
  }
});

test("FORK inheritance, SPAWN isolation, commits, outcomes, persistence and effect-free replay", () => {
  const f = fixture();
  const store = new Store(join(f.dir, "state.sqlite"));
  try {
    let received = false;
    const scripted = new ScriptedExecutor(reference.scripts);
    const state = simulate(
      reference,
      undefined,
      {
        execute(ctx) {
          if (ctx.work.name === "A" && ctx.work.cursor === 1) {
            received = true;
            assert.equal(ctx.results.length, 2);
            for (const child of ctx.results) {
              assert.equal(child.status, "COMPLETED");
              assert.match(child.artifacts![0]!, /^[0-9a-f]{40}$/);
              assert.equal(child.artifact!.base, f.base);
              assert.equal(child.artifact!.cleaned, true);
            }
            assert.notEqual(
              ctx.results[0]!.artifacts![0],
              ctx.results[1]!.artifacts![0],
            );
          }
          return scripted.execute(ctx);
        },
      },
      undefined,
      undefined,
      new GitArtifactBackend(f.repo, ({ name }, workspace) => {
        assert.equal(workspace.base, f.base);
        assert.equal(git(workspace.path, "rev-parse", "HEAD"), f.base);
        if (name !== "X" && name !== "Y") return;
        writeFileSync(join(workspace.path, "result.txt"), `${name}\n`);
        workspace.commit(`Use result ${name}`);
        if (name === "X") {
          writeFileSync(join(workspace.path, "extra.txt"), "extra\n");
          workspace.commit("Add extra result detail");
        }
      }),
    );
    assert.ok(received);
    assert.equal(state.lineages.length, 3);
    for (const event of state.events.filter((e) => e.type === "FORK"))
      assert.equal(
        (event.data as { lineage: { artifact: { ref: string } } }).lineage
          .artifact.ref,
        f.base,
      );
    const children = state.work.filter((w) => w.parentId !== null);
    for (const w of children) {
      assert.equal(w.artifact!.base, f.base);
      assert.equal(
        git(f.repo, "rev-parse", w.artifact!.branch!),
        w.artifact!.ref,
      );
      assert.equal(git(f.repo, "cat-file", "-t", w.artifact!.ref), "commit");
      assert.equal(existsSync(w.artifact!.worktree!), false);
      assert.equal(w.artifact!.cleaned, true);
      assert.equal(
        git(f.repo, "show", `${w.artifact!.ref}:result.txt`),
        w.name,
      );
    }
    assert.equal(
      git(
        f.repo,
        "rev-list",
        "--count",
        `${f.base}..${children[0]!.artifact!.ref}`,
      ),
      "2",
    );
    assert.notEqual(
      children[0]!.artifact!.branch,
      children[1]!.artifact!.branch,
    );
    assert.equal(state.lineages[1]!.artifact!.ref, f.base);
    assert.equal(git(f.repo, "rev-parse", "HEAD"), f.base);
    assert.equal(git(f.repo, "status", "--porcelain"), "");
    assert.equal(git(f.repo, "rev-list", "--all", "--merges"), "");
    assert.deepEqual(readdirSync(f.repo).sort(), [".git", "result.txt"]);
    assert.equal(
      git(f.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)!
        .length,
      1,
    );
    store.save(state);
    assert.deepEqual(store.load(state.runId), state);
    const changed = structuredClone(state);
    changed.artifactOperations![1]!.request = { ...initialize };
    assert.throws(() => replay(changed), /Replay mismatch/);
    const missing = structuredClone(state);
    missing.artifactOperations!.pop();
    assert.throws(() => replay(missing), /Replay mismatch/);
    const extra = structuredClone(state);
    extra.artifactOperations!.push(
      structuredClone(extra.artifactOperations![0]!),
    );
    assert.throws(() => replay(extra), /Replay mismatch/);
    // Replay must succeed with neither the target nor its commits/worktrees present.
    rmSync(f.repo, { recursive: true });
    assert.deepEqual(replay(store.load(state.runId)), state);
    assert.equal(existsSync(f.repo), false);
  } finally {
    store.close();
    f.close();
  }
});

test("fork inherits the current parent commit and sibling lineages diverge independently", () => {
  const f = fixture();
  try {
    let parent = "";
    const scenario = structuredClone(reference);
    scenario.scripts.A = [{ type: "COMPLETE", result: "A done" }];
    scenario.scripts.B = [{ type: "COMPLETE", result: "B done" }];
    const state = simulate(
      scenario,
      undefined,
      undefined,
      undefined,
      undefined,
      new GitArtifactBackend(f.repo, ({ name }, ws) => {
        if (name !== "root") assert.equal(ws.base, parent);
        writeFileSync(join(ws.path, "result.txt"), `${name}\n`);
        const commit = ws.commit(`Use ${name} result`);
        if (name === "root") parent = commit;
      }),
    );
    for (const event of state.events.filter((e) => e.type === "FORK"))
      assert.equal(
        (event.data as { lineage: { artifact: { ref: string } } }).lineage
          .artifact.ref,
        parent,
      );
    assert.equal(state.lineages[0]!.status, "BRANCHED");
    assert.equal(state.lineages[1]!.status, "COMPLETED");
    assert.equal(state.lineages[2]!.status, "COMPLETED");
    assert.notEqual(
      state.lineages[1]!.artifact!.ref,
      state.lineages[2]!.artifact!.ref,
    );
    assert.equal(git(f.repo, "rev-parse", "HEAD"), f.base);
    assert.deepEqual(replay(state), state);
  } finally {
    f.close();
  }
});

test("zero-change work creates no empty commit and unsafe cleanup retains work", () => {
  const f = fixture();
  let retained: string | undefined;
  try {
    const backend = new GitArtifactBackend(f.repo, (_request, ws) => {
      assert.equal(ws.commit("No changes"), f.base);
    });
    backend.perform(initialize);
    const request: ArtifactRequest = {
      type: "EXECUTE",
      taskId: "t",
      runId: "r",
      lineageId: "l",
      workId: "w",
      name: "X",
      base: f.base,
    };
    const outcome = backend.perform(request);
    assert.ok(outcome.ok);
    assert.equal(outcome.artifact.ref, f.base);
    assert.equal(outcome.artifact.cleaned, true);
    assert.equal(git(f.repo, "rev-list", "--all", "--count"), "1");
    const failed = new GitArtifactBackend(f.repo, (_request, ws) => {
      writeFileSync(join(ws.path, "unfinished.txt"), "keep me\n");
      throw new Error("Local failure");
    });
    failed.perform(initialize);
    const result = failed.perform(request);
    assert.equal(result.ok, false);
    retained = result.artifact!.worktree;
    assert.equal(result.artifact!.cleaned, false);
    assert.equal(
      readFileSync(join(retained!, "unfinished.txt"), "utf8"),
      "keep me\n",
    );
    assert.equal(git(f.repo, "rev-parse", result.artifact!.branch!), f.base);
    // Test owns the abandoned edit and explicitly disposes of it.
    rmSync(join(retained!, "unfinished.txt"));
    git(f.repo, "worktree", "remove", retained!);
  } finally {
    if (retained)
      rmSync(join(retained, ".."), { recursive: true, force: true });
    f.close();
  }
});

test("artifact failures stay local and blocked SPAWN outcomes reach the parent", () => {
  const f = fixture();
  try {
    const state = simulate(
      reference,
      undefined,
      undefined,
      undefined,
      undefined,
      new GitArtifactBackend(f.repo, ({ name }) => {
        if (name === "X") throw new Error("Unavailable input");
      }),
    );
    assert.equal(
      state.work.find((w) => w.name === "X")!.reason!.code,
      "ARTIFACT_EXECUTION_FAILED",
    );
    assert.equal(state.lineages[1]!.status, "COMPLETED");
    assert.equal(state.work.find((w) => w.name === "Y")!.status, "COMPLETED");
    assert.deepEqual(replay(state), state);
    assert.equal(
      git(f.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)!
        .length,
      1,
    );
  } finally {
    f.close();
  }
});

test("database and export destinations must remain outside target", () => {
  const f = fixture();
  try {
    const alias = join(f.dir, "repo-alias");
    const externalAlias = join(f.dir, "external-alias");
    const external = join(f.dir, "external");
    mkdirSync(external);
    symlinkSync(f.repo, alias, "junction");
    symlinkSync(external, externalAlias, "junction");
    for (const repository of [f.repo, alias]) {
      for (const target of [f.repo, alias]) {
        assert.throws(
          () => assertExternalGitState(repository, [target]),
          /outside/,
        );
        assert.throws(
          () =>
            assertExternalGitState(repository, [
              join(target, "new", "state.sqlite"),
            ]),
          /outside/,
        );
      }
      assert.doesNotThrow(() =>
        assertExternalGitState(repository, [
          join(externalAlias, "new", "state.sqlite"),
        ]),
      );
    }

    assert.doesNotThrow(() =>
      assertExternalGitState(f.repo, [join(f.dir, "state.sqlite")]),
    );
    assert.throws(
      () => assertExternalGitState(f.repo, [join(f.repo, "state.sqlite")]),
      /outside/,
    );
    assert.throws(
      () =>
        assertExternalGitState(f.repo, [join(f.repo, "new", "events.jsonl")]),
      /outside/,
    );
  } finally {
    f.close();
  }
});
