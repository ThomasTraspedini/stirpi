import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DockerVerifierAdapter,
  VerificationRegistry,
  VerificationRuntime,
} from "../dist/verification/index.js";

const bootstrapOnly = process.argv.includes("--bootstrap-only");
const fixtureRoot = mkdtempSync(
  join(tmpdir(), "stirpi-hostile-verify-fixture-"),
);
const sentinelRoot = mkdtempSync(
  join(tmpdir(), "stirpi-hostile-verify-sentinel-"),
);
const sentinel = join(sentinelRoot, "trusted-host-sentinel");
const smokeId = `hostile-smoke-${randomUUID()}`;
const imageTag = "node:24-bookworm";
const outputLimit = 4096;

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0 || result.error)
    throw new Error(
      `${executable} ${args.join(" ")} failed: ${result.stderr || result.error?.message || "unknown failure"}`,
    );
  return result.stdout.trim();
}

function treeDigest(root) {
  const hash = createHash("sha256");
  const visit = (path, relative) => {
    const info = statSync(path);
    hash.update(`${relative}\0${info.mode}\0${info.size}\0`);
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort())
        visit(join(path, name), `${relative}/${name}`);
    } else hash.update(readFileSync(path));
  };
  visit(root, "");
  return hash.digest("hex");
}

function safeDiagnostic(value) {
  return value
    .replace(
      /(?:DATABASE_URL\s*[=:]\s*|postgres(?:ql)?:\/\/)[^\s'"`]+/gi,
      "[REDACTED_DATABASE_URL]",
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\x1b]/g, "")
    .slice(0, 4096);
}

class CapturingAdapter extends DockerVerifierAdapter {
  last;
  execute(spec, snapshot) {
    this.last = super.execute(spec, snapshot);
    return this.last;
  }
}

function fixtureCandidate() {
  return `
import pg from "./.smoke-pg/node_modules/pg/lib/index.js";
import { accessSync, constants, existsSync, writeFileSync } from "node:fs";

const fail = (message) => { throw new Error(message); };
const mustFail = async (label, operation) => {
  try { await operation(); fail(label + " unexpectedly succeeded"); }
  catch (error) { if (error?.message?.includes("unexpectedly succeeded")) throw error; }
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const select = await client.query("SELECT 1 AS value");
  if (select.rows[0]?.value !== 1) fail("SELECT 1 failed");
  const extension = await client.query("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') AS installed");
  if (extension.rows[0]?.installed !== true) fail("btree_gist is not installed");
} finally { await client.end().catch(() => {}); }

writeFileSync("/workspace/disposable-candidate-marker", "candidate-only\\n");
if (!existsSync("/workspace/disposable-candidate-marker")) fail("workspace write failed");
await mustFail("docker socket", () => accessSync("/var/run/docker.sock", constants.R_OK));
if (existsSync(${JSON.stringify(sentinel)})) fail("trusted host sentinel is visible");
await mustFail("external networking", async () => {
  await fetch("http://example.com", { signal: AbortSignal.timeout(1500) });
});
console.log("DATABASE_URL=" + process.env.DATABASE_URL);
console.log("stdout-flood:" + "x".repeat(9000));
console.error("DATABASE_URL=" + process.env.DATABASE_URL);
console.error("stderr-flood:" + "y".repeat(9000));
`;
}

let report;
try {
  writeFileSync(sentinel, "trusted host only\n", { mode: 0o600 });
  if (!bootstrapOnly)
    command("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      join(fixtureRoot, ".smoke-pg"),
      "pg@8.16.3",
    ]);
  writeFileSync(join(fixtureRoot, "candidate.mjs"), fixtureCandidate(), {
    mode: 0o644,
  });
  writeFileSync(join(fixtureRoot, "fixture.txt"), "authoritative source\n", {
    mode: 0o644,
  });
  const before = treeDigest(fixtureRoot);
  if (bootstrapOnly) {
    report = {
      passed: true,
      bootstrapOnly: true,
      implementation: "dist/verification/index.js",
      reachedBeforeDockerLifecycleStartup: true,
    };
  } else {
    command("docker", ["pull", imageTag]);
    const image = command("docker", [
      "image",
      "inspect",
      imageTag,
      "--format",
      "{{index .RepoDigests 0}}",
    ]);
    if (!/^.+@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error(`image is not digest pinned: ${image}`);
    const registry = new VerificationRegistry([
      {
        id: smokeId,
        executable: "/usr/local/bin/node",
        argv: ["candidate.mjs"],
        cwd: "/workspace",
        image,
        database: "required",
        limits: {
          timeoutMs: 60_000,
          memoryBytes: 256 * 1024 * 1024,
          pids: 64,
          fileDescriptors: 128,
          outputBytes: outputLimit,
        },
      },
    ]);
    const adapter = new CapturingAdapter();
    const operation = new VerificationRuntime(registry, adapter).perform(
      smokeId,
      "hostile-smoke",
      fixtureRoot,
    );
    const after = treeDigest(fixtureRoot);
    const evidence = operation.outcome.ok
      ? operation.outcome.evidence
      : undefined;
    const raw = adapter.last;
    const inventory = {
      containers: command("docker", [
        "container",
        "ls",
        "-aq",
        "--filter",
        "name=stirpi-verify-",
      ])
        .split("\n")
        .filter(Boolean),
      volumes: command("docker", [
        "volume",
        "ls",
        "-q",
        "--filter",
        "name=stirpi-verify-",
      ])
        .split("\n")
        .filter(Boolean),
    };
    report = {
      smokeId,
      passed: operation.outcome.ok && evidence?.passed === true,
      lifecycleFailure:
        raw?.failure ??
        (!operation.outcome.ok ? operation.outcome.reason.code : undefined),
      cleanupFailures: raw?.cleanupFailures ?? [],
      diagnostics: raw
        ? {
            stdout: safeDiagnostic(raw.stdout),
            stderr: safeDiagnostic(raw.stderr),
          }
        : undefined,
      assertions: {
        workspaceByteEquivalent: before === after,
        disposableMarkerAbsentFromSource: !existsSync(
          join(fixtureRoot, "disposable-candidate-marker"),
        ),
        stdoutBounded: evidence
          ? Buffer.byteLength(evidence.stdout) <= outputLimit &&
            evidence.stdoutTruncated
          : false,
        stderrBounded: evidence
          ? Buffer.byteLength(evidence.stderr) <= outputLimit &&
            evidence.stderrTruncated
          : false,
        credentialsRedacted: evidence
          ? !/postgres(?:ql)?:\/\//i.test(evidence.stdout + evidence.stderr) &&
            !evidence.stdout.includes("DATABASE_URL=") &&
            !evidence.stderr.includes("DATABASE_URL=")
          : false,
        noSmokeContainers: inventory.containers.length === 0,
        noSmokeVolumes: inventory.volumes.length === 0,
      },
      finalDockerInventory: inventory,
    };
    if (
      !report.passed ||
      Object.values(report.assertions).some((value) => !value)
    )
      process.exitCode = 1;
  }
} catch (error) {
  report = {
    passed: false,
    lifecycleFailure: "SMOKE_RUNNER_FAILED",
    cleanupFailures: [],
    diagnostics: {
      stderr: safeDiagnostic(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      ),
    },
  };
  process.exitCode = 1;
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(sentinelRoot, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
