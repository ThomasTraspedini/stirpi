import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  VerificationRegistry,
  VerificationRuntime,
  DockerVerifierAdapter,
  type DockerCommandResult,
  replay,
  simulate,
  snapshotWorkspace,
  type ArtifactBackend,
  type Scenario,
  type VerificationExecutor,
} from "../src/index.js";

const scenario: Scenario = {
  name: "verify",
  objective: "verify",
  scripts: {},
  publicEvaluation: { description: "done", criteria: ["done"] },
  hiddenEvaluation: { requiredText: "done" },
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stirpi-verify-test-"));
  writeFileSync(join(root, "tracked.txt"), "candidate\n");
  const backend: ArtifactBackend = {
    perform(request) {
      if (request.type === "INITIALIZE")
        return {
          ok: true,
          artifact: { ref: "a".repeat(40), base: "a".repeat(40) },
        };
      return {
        ok: true,
        artifact: {
          ref: "a".repeat(40),
          base: "a".repeat(40),
          worktree: root,
          cleaned: request.type === "RELEASE",
        },
      };
    },
  };
  return {
    root,
    backend,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
class FakeVerifier implements VerificationExecutor {
  calls = 0;
  available() {
    return ["unit"];
  }
  perform(id: string, workId: string) {
    this.calls++;
    return {
      request: { id, workId, workspaceDigest: "a".repeat(64) },
      outcome: {
        ok: true as const,
        evidence: {
          id,
          attempt: this.calls,
          passed: false,
          exitCode: 1,
          stdout: "bad\u001b[31m output",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 4,
        },
      },
    };
  }
}

test("CONTINUE + trusted VERIFY records normal negative evidence and delivers it once", () => {
  const f = fixture();
  try {
    const verifier = new FakeVerifier();
    const contexts: unknown[] = [];
    const state = simulate(
      scenario,
      undefined,
      {
        protocol: 1,
        execute(context) {
          contexts.push(structuredClone(context));
          return context.work.cursor === 0
            ? {
                version: 1,
                action: { type: "CONTINUE" },
                effects: [{ type: "VERIFY", id: "unit" }],
              }
            : {
                version: 1,
                action: { type: "COMPLETE", result: "done" },
                effects: [],
              };
        },
      },
      undefined,
      undefined,
      f.backend,
      undefined,
      verifier,
    );
    assert.equal(state.status, "COMPLETED");
    assert.equal(verifier.calls, 1);
    assert.equal(state.verificationOperations!.length, 1);
    assert.deepEqual(
      (contexts[0] as { verification: { latest: unknown[] } }).verification
        .latest,
      [],
    );
    assert.equal(
      (contexts[1] as { verification: { latest: { passed: boolean }[] } })
        .verification.latest[0]!.passed,
      false,
    );
    assert.equal(state.lineages[0]!.status, "COMPLETED");
    assert.deepEqual(replay(state), state);
  } finally {
    f.close();
  }
});

test("VERIFY protocol rejects incompatible action, duplicates, unknown fields, authority fields, and unknown IDs before execution", () => {
  const f = fixture();
  try {
    for (const effect of [
      [
        { type: "VERIFY", id: "unit" },
        { type: "VERIFY", id: "unit" },
      ],
      [{ type: "VERIFY", id: "unit", argv: ["forged"] }],
      [{ type: "VERIFY", id: "unit", environment: {} }],
      [{ type: "VERIFY", id: "unit", timeout: 1 }],
    ]) {
      const verifier = new FakeVerifier();
      const state = simulate(
        scenario,
        undefined,
        {
          protocol: 1,
          execute: () => ({
            version: 1,
            action: { type: "CONTINUE" },
            effects: effect,
          }),
        },
        undefined,
        undefined,
        f.backend,
        undefined,
        verifier,
      );
      assert.equal(state.work[0]!.reason!.code, "INVALID_EXECUTOR_RESPONSE");
      assert.equal(verifier.calls, 0);
    }
    const verifier = new FakeVerifier();
    const state = simulate(
      scenario,
      undefined,
      {
        protocol: 1,
        execute: () => ({
          version: 1,
          action: { type: "COMPLETE", result: "done" },
          effects: [{ type: "VERIFY", id: "unit" }],
        }),
      },
      undefined,
      undefined,
      f.backend,
      undefined,
      verifier,
    );
    assert.equal(state.work[0]!.reason!.code, "INVALID_EXECUTOR_RESPONSE");
    assert.equal(verifier.calls, 0);
    const unknown = simulate(
      scenario,
      undefined,
      {
        protocol: 1,
        execute: () => ({
          version: 1,
          action: { type: "CONTINUE" },
          effects: [{ type: "VERIFY", id: "not-registered" }],
        }),
      },
      undefined,
      undefined,
      f.backend,
      undefined,
      verifier,
    );
    assert.equal(unknown.work[0]!.reason!.code, "UNKNOWN_VERIFICATION_ID");
    assert.equal(verifier.calls, 0);
  } finally {
    f.close();
  }
});

test("snapshot includes dirty files but excludes repository and dependency state and rejects symlinks", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "untracked.txt"), "yes");
    mkdirSync(join(f.root, ".git"));
    writeFileSync(join(f.root, ".git", "config"), "private");
    mkdirSync(join(f.root, "node_modules"));
    writeFileSync(join(f.root, "node_modules", "bad.js"), "bad");
    const snapshot = snapshotWorkspace(f.root);
    assert.ok(snapshot.entries.some((e) => e.path === "untracked.txt"));
    assert.equal(
      snapshot.entries.some(
        (e) => e.path.startsWith(".git") || e.path.startsWith("node_modules"),
      ),
      false,
    );
    rmSync(snapshot.root, { recursive: true, force: true });
    symlinkSync("tracked.txt", join(f.root, "link"));
    assert.throws(() => snapshotWorkspace(f.root), /Unsafe symlink/);
  } finally {
    f.close();
  }
});

test("runtime sanitizes, bounds, redacts and treats ordinary nonzero exits as evidence", () => {
  const f = fixture();
  try {
    const registry = new VerificationRegistry([
      {
        id: "unit",
        executable: "/bin/check",
        argv: ["--fixed"],
        cwd: "/workspace",
        image: "example.invalid/verifier@sha256:" + "a".repeat(64),
        limits: {
          timeoutMs: 1000,
          memoryBytes: 64_000_000,
          pids: 16,
          fileDescriptors: 32,
          outputBytes: 32,
        },
      },
    ]);
    let seen: unknown;
    const runtime = new VerificationRuntime(registry, {
      execute(spec) {
        seen = spec;
        return {
          exitCode: 1,
          stdout:
            "DATABASE_URL=postgres://secret\n\u001b[31m" + "x".repeat(70_000),
          stderr: "",
          durationMs: 3,
        };
      },
    });
    const operation = runtime.perform("unit", "w1", f.root);
    assert.ok(operation.outcome.ok);
    if (!operation.outcome.ok) return;
    assert.equal(operation.outcome.evidence.passed, false);
    assert.equal(operation.outcome.evidence.stdout.includes("secret"), false);
    assert.equal(operation.outcome.evidence.stdout.includes("\u001b"), false);
    assert.equal(operation.outcome.evidence.stdoutTruncated, true);
    assert.equal(Buffer.byteLength(operation.outcome.evidence.stdout), 32);
    assert.deepEqual(seen, registry.get("unit"));
  } finally {
    f.close();
  }
});

function databaseSpec() {
  return {
    id: "database",
    executable: "/bin/check",
    argv: ["--fixed"],
    cwd: "/workspace" as const,
    image: "example.invalid/verifier@sha256:" + "b".repeat(64),
    database: "required" as const,
    limits: {
      timeoutMs: 1000,
      memoryBytes: 64_000_000,
      pids: 16,
      fileDescriptors: 32,
    },
  };
}

test("database verification leases an isolated socket PostgreSQL sidecar without exposing credentials", () => {
  const f = fixture();
  const calls: Array<{ args: string[]; input?: string }> = [];
  try {
    const adapter = new DockerVerifierAdapter(
      (args, input): DockerCommandResult => {
        calls.push({ args, input });
        if (args.some((arg) => arg.includes("stirpi-final-postmaster")))
          return { status: 0, stdout: "stirpi-final-postmaster\n", stderr: "" };
        return { status: 0, stdout: "ok", stderr: "" };
      },
    );
    const result = adapter.execute(databaseSpec(), snapshotWorkspace(f.root));
    assert.equal(result.exitCode, 0);
    const postgres = calls.find((call) =>
      call.args.includes("unix_socket_directories=/var/run/postgresql"),
    );
    assert.ok(postgres);
    assert.ok(postgres!.args.includes("none"));
    assert.ok(postgres!.args.includes("listen_addresses=*"));
    assert.ok(
      postgres!.args.some(
        (x) => x.includes("pgsocket") && x.includes("/var/run/postgresql"),
      ),
    );
    const verifier = calls.filter(
      (call) => call.args[0] === "run" && call.args.includes("--env-file"),
    );
    assert.equal(verifier.length, 1);
    for (const call of verifier) {
      assert.ok(call.args.includes("none"));
      assert.ok(
        call.args.some((x) => x.includes("pgsocket") && x.includes("readonly")),
      );
      assert.equal(
        call.args.some((x) => x.includes("postgresql://")),
        false,
      );
    }
    const setup = calls.find((call) => call.input?.includes("CREATE ROLE"));
    assert.match(setup!.input!, /NOSUPERUSER NOCREATEDB NOCREATEROLE/);
    assert.match(setup!.input!, /CREATE EXTENSION btree_gist/);
    const readiness = calls.filter(
      (call) =>
        call.args[0] === "exec" &&
        call.args.some((arg) => arg.includes("stirpi-final-postmaster")),
    );
    assert.equal(readiness.length, 1);
    assert.ok(readiness[0]!.args.includes("psql"));
    assert.ok(readiness[0]!.args.includes("-tAc"));
    assert.ok(readiness[0]!.args.includes("-U"));
    assert.ok(readiness[0]!.args.includes("postgres"));
    assert.ok(readiness[0]!.args.includes("-h"));
    assert.ok(readiness[0]!.args.includes("/var/run/postgresql"));
    const hba = calls.find((call) =>
      call.input?.includes("verifier HBA validation failed"),
    );
    assert.ok(hba);
    assert.match(hba!.input!, /pg_hba_file_rules/);
    assert.match(hba!.input!, /auth_method = 'reject'/);
    const disposableProbe = calls.find(
      (call) =>
        call.args[0] === "exec" &&
        call.args.includes("psql") &&
        call.args.includes("SELECT 1;"),
    );
    assert.ok(disposableProbe);
    assert.ok(disposableProbe!.args.includes("/var/run/postgresql"));
    const candidate = verifier[0]!;
    assert.deepEqual(candidate.args.slice(-2), ["/bin/check", "--fixed"]);
    const cleanup = calls.find((call) =>
      call.input?.includes("pg_terminate_backend"),
    );
    assert.match(cleanup!.input!, /pg_terminate_backend/);
    const databaseDrop = calls.find((call) =>
      call.input?.includes("DROP DATABASE"),
    );
    const roleDrop = calls.find((call) => call.input?.includes("DROP ROLE"));
    assert.ok(databaseDrop);
    assert.ok(roleDrop);
    assert.ok(
      calls.some(
        (call) =>
          call.args.join(" ").includes("volume rm -f") &&
          call.args.join(" ").includes("pgdata"),
      ),
    );
    assert.ok(
      calls.some(
        (call) =>
          call.args.join(" ").includes("volume rm -f") &&
          call.args.join(" ").includes("pgsocket"),
      ),
    );
  } finally {
    f.close();
  }
});

test("database lease waits through temporary PostgreSQL lifecycle before final trusted readiness", () => {
  const f = fixture();
  const calls: Array<{ args: string[]; input?: string }> = [];
  let readinessAttempt = 0;
  try {
    const adapter = new DockerVerifierAdapter(
      (args, input): DockerCommandResult => {
        calls.push({ args, input });
        if (args.some((arg) => arg.includes("stirpi-final-postmaster"))) {
          readinessAttempt++;
          if (readinessAttempt === 1)
            return { status: 0, stdout: "stirpi-temporary-postmaster\n" };
          if (readinessAttempt === 2)
            return {
              status: 1,
              stderr: "FATAL: the database system is shutting down",
            };
          return { status: 0, stdout: "stirpi-final-postmaster\n" };
        }
        return { status: 0, stdout: "ok", stderr: "" };
      },
    );
    const result = adapter.execute(databaseSpec(), snapshotWorkspace(f.root));
    assert.equal(result.exitCode, 0);
    assert.equal(readinessAttempt, 3);
    const finalReady = calls.findLastIndex((call) =>
      call.args.some((arg) => arg.includes("stirpi-final-postmaster")),
    );
    const setup = calls.findIndex((call) =>
      call.input?.includes("CREATE ROLE"),
    );
    const candidate = calls.findIndex(
      (call) => call.args.slice(-2).join(" ") === "/bin/check --fixed",
    );
    assert.ok(finalReady < setup);
    assert.ok(setup < candidate);
    assert.equal(
      calls.some((call) => call.args.includes("pg_isready")),
      false,
    );
  } finally {
    f.close();
  }
});

test("database final-server readiness timeout retains logs and cleans up without provisioning", () => {
  const f = fixture();
  const calls: Array<{ args: string[]; input?: string }> = [];
  let readinessAttempt = 0;
  try {
    const adapter = new DockerVerifierAdapter(
      (args, input): DockerCommandResult => {
        calls.push({ args, input });
        if (args.some((arg) => arg.includes("stirpi-final-postmaster"))) {
          readinessAttempt++;
          return { status: 0, stdout: "stirpi-temporary-postmaster\n" };
        }
        if (args[0] === "logs")
          return { status: 0, stdout: "temporary server stopped\n" };
        return { status: 0, stdout: "ok", stderr: "" };
      },
    );
    const result = adapter.execute(databaseSpec(), snapshotWorkspace(f.root));
    assert.equal(result.failure, "VERIFIER_DB_BOOTSTRAP_FAILED");
    assert.equal(readinessAttempt, 30);
    assert.match(result.stdout, /PostgreSQL logs:\ntemporary server stopped/);
    assert.equal(
      calls.some((call) => call.input?.includes("CREATE ROLE")),
      false,
    );
    const logs = calls.findIndex((call) => call.args[0] === "logs");
    const remove = calls.findIndex(
      (call) =>
        call.args[0] === "rm" && call.args.some((x) => x.endsWith("-postgres")),
    );
    assert.ok(logs < remove);
    assert.ok(
      calls.some(
        (call) =>
          call.args[0] === "volume" &&
          call.args[1] === "rm" &&
          call.args.some((x) => x.includes("pgdata")),
      ),
    );
  } finally {
    f.close();
  }
});

test("database lease fails closed when PostgreSQL reports an invalid HBA rule", () => {
  const f = fixture();
  const calls: Array<{ args: string[]; input?: string }> = [];
  try {
    const adapter = new DockerVerifierAdapter(
      (args, input): DockerCommandResult => {
        calls.push({ args, input });
        if (args.some((arg) => arg.includes("stirpi-final-postmaster")))
          return { status: 0, stdout: "stirpi-final-postmaster" };
        if (input?.includes("verifier HBA validation failed"))
          return { status: 1, stderr: "ERROR: verifier HBA validation failed" };
        return { status: 0 };
      },
    );
    const result = adapter.execute(databaseSpec(), snapshotWorkspace(f.root));
    assert.equal(result.failure, "VERIFIER_DB_BOOTSTRAP_FAILED");
    assert.ok(calls.some((call) => call.input?.includes("pg_hba_file_rules")));
    assert.equal(
      calls.some(
        (call) => call.args.slice(-2).join(" ") === "/bin/check --fixed",
      ),
      false,
    );
    assert.ok(
      calls.some((call) => call.input?.includes("pg_terminate_backend")),
    );
  } finally {
    f.close();
  }
});

test("database lease cleanup covers ordinary failures, bootstrap failures, and cleanup failures", () => {
  const f = fixture();
  try {
    for (const mode of ["exit-1", "bootstrap", "cleanup"] as const) {
      const calls: string[][] = [];
      const adapter = new DockerVerifierAdapter((args): DockerCommandResult => {
        calls.push(args);
        if (
          mode === "bootstrap" &&
          args.some((arg) => arg.includes("stirpi-final-postmaster"))
        )
          return { status: 1 };
        if (args.some((arg) => arg.includes("stirpi-final-postmaster")))
          return { status: 0, stdout: "stirpi-final-postmaster" };
        if (
          mode === "exit-1" &&
          args.slice(-2).join(" ") === "/bin/check --fixed"
        )
          return { status: 1, stdout: "failed" };
        if (mode === "cleanup" && args[0] === "volume" && args[1] === "rm")
          return { status: 1, stderr: "cleanup" };
        return { status: 0 };
      });
      const result = adapter.execute(databaseSpec(), snapshotWorkspace(f.root));
      if (mode === "exit-1") assert.equal(result.exitCode, 1);
      else
        assert.equal(
          result.failure,
          mode === "cleanup"
            ? "VERIFIER_CLEANUP_FAILED"
            : "VERIFIER_DB_BOOTSTRAP_FAILED",
        );
      assert.ok(
        calls.some(
          (args) =>
            args[0] === "rm" && args.some((x) => x.endsWith("-postgres")),
        ),
      );
      assert.ok(
        calls.some(
          (args) =>
            args[0] === "volume" &&
            args[1] === "rm" &&
            args.some((x) => x.includes("pgdata")),
        ),
      );
      assert.ok(
        calls.some(
          (args) =>
            args[0] === "volume" &&
            args[1] === "rm" &&
            args.some((x) => x.includes("pgsocket")),
        ),
      );
    }
  } finally {
    f.close();
  }
});

test("trusted database teardown follows completed verifier execution and accepts its expected session termination", () => {
  const f = fixture();
  const calls: Array<{ args: string[]; input?: string }> = [];
  try {
    const adapter = new DockerVerifierAdapter(
      (args, input): DockerCommandResult => {
        calls.push({ args, input });
        if (args.some((arg) => arg.includes("stirpi-final-postmaster")))
          return { status: 0, stdout: "stirpi-final-postmaster" };
        if (input?.includes("pg_terminate_backend"))
          return {
            status: 0,
            stdout: " pg_terminate_backend \\n----------------------\\n t\\n",
          };
        return { status: 0 };
      },
    );
    const result = adapter.execute(databaseSpec(), snapshotWorkspace(f.root));
    assert.equal(result.exitCode, 0);
    assert.equal(result.failure, undefined);
    assert.equal(result.cleanupFailures, undefined);
    const candidate = calls.findIndex(
      (call) => call.args.slice(-2).join(" ") === "/bin/check --fixed",
    );
    const terminate = calls.findIndex((call) =>
      call.input?.includes("pg_terminate_backend"),
    );
    const dropDatabase = calls.findIndex((call) =>
      call.input?.includes("DROP DATABASE"),
    );
    const dropRole = calls.findIndex((call) =>
      call.input?.includes("DROP ROLE"),
    );
    const removeDatabase = calls.findIndex(
      (call) =>
        call.args[0] === "rm" && call.args.some((x) => x.endsWith("-postgres")),
    );
    const removeData = calls.findLastIndex(
      (call) =>
        call.args[0] === "volume" &&
        call.args[1] === "rm" &&
        call.args.some((x) => x.includes("pgdata")),
    );
    const removeSocket = calls.findLastIndex(
      (call) =>
        call.args[0] === "volume" &&
        call.args[1] === "rm" &&
        call.args.some((x) => x.includes("pgsocket")),
    );
    assert.ok(candidate < terminate);
    assert.ok(terminate < dropDatabase);
    assert.ok(dropDatabase < dropRole);
    assert.ok(dropRole < removeDatabase);
    assert.ok(removeDatabase < removeData);
    assert.ok(removeData < removeSocket);
    assert.ok(
      calls.some((call) => call.args.join(" ").includes("container ls -aq")),
    );
    assert.ok(
      calls.some((call) => call.args.join(" ").includes("volume ls -q")),
    );
  } finally {
    f.close();
  }
});

test("database cleanup failures retain their stage and do not prevent later cleanup", () => {
  const f = fixture();
  const calls: Array<{ args: string[]; input?: string }> = [];
  try {
    const adapter = new DockerVerifierAdapter(
      (args, input): DockerCommandResult => {
        calls.push({ args, input });
        if (args.some((arg) => arg.includes("stirpi-final-postmaster")))
          return { status: 0, stdout: "stirpi-final-postmaster" };
        if (input?.includes("DROP DATABASE"))
          return { status: 1, stderr: "drop failed" };
        if (args[0] === "rm" && args.some((x) => x.endsWith("-postgres")))
          return { status: 1, stderr: "container removal failed" };
        return { status: 0 };
      },
    );
    const result = adapter.execute(databaseSpec(), snapshotWorkspace(f.root));
    assert.equal(result.failure, "VERIFIER_CLEANUP_FAILED");
    assert.deepEqual(result.cleanupFailures, [
      "database-drop",
      "database-container-removal",
    ]);
    assert.ok(calls.some((call) => call.input?.includes("DROP ROLE")));
    assert.ok(
      calls.some((call) => call.args.some((x) => x.includes("pgdata"))),
    );
    assert.ok(
      calls.some((call) => call.args.some((x) => x.includes("pgsocket"))),
    );
    assert.ok(
      calls.some((call) => call.args.join(" ").includes("container ls -aq")),
    );
    assert.ok(
      calls.some((call) => call.args.join(" ").includes("volume ls -q")),
    );
  } finally {
    f.close();
  }
});
