import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DockerVerifierAdapter,
  POSTGRES_17_IMAGE,
  snapshotWorkspace,
} from "../dist/verification/index.js";

const observationMs = 5_000;
const root = mkdtempSync(join(tmpdir(), "stirpi-lease-reproducer-"));
const startedAt = new Date();
const trace = [];
let containerName;
let containerId;
let cleanupStarted = false;
let postgresLogsBeforeCleanup = "";

function now() {
  return new Date().toISOString();
}
function safeArgs(args) {
  return args.map((arg) =>
    arg.startsWith("PGPASSWORD=") ? "PGPASSWORD=[REDACTED]" : arg,
  );
}
function command(args, input, timeoutMs) {
  const beganAt = now();
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    input,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "" },
  });
  const event = {
    beganAt,
    endedAt: now(),
    args: safeArgs(args),
    status: result.status,
    signal: result.signal ?? null,
    error: result.error?.message,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  trace.push(event);
  if (
    args[0] === "run" &&
    args.includes("-d") &&
    args.includes("--name") &&
    args[args.indexOf("--name") + 1]?.endsWith("-postgres")
  ) {
    containerName = args[args.indexOf("--name") + 1];
    containerId = (result.stdout ?? "").trim();
    event.lifecycle = "postgres-container-create-and-start";
  }
  if (containerName && args[0] === "rm" && args.includes(containerName)) {
    cleanupStarted = true;
    postgresLogsBeforeCleanup = direct(["logs", containerName]).stdout ?? "";
    event.lifecycle = "trusted-cleanup-entry/database-container-removal";
  } else if (containerName) event.stateAfter = inspectState();
  return result;
}
function direct(args, input) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    input,
    maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "" },
  });
}
function inspectState() {
  const result = direct([
    "inspect",
    "--format",
    "{{json .State}}",
    containerName,
  ]);
  if (result.status !== 0)
    return { inspectError: (result.stderr ?? "").trim() };
  try {
    const state = JSON.parse(result.stdout);
    return {
      Status: state.Status,
      Running: state.Running,
      Paused: state.Paused,
      Restarting: state.Restarting,
      OOMKilled: state.OOMKilled,
      Dead: state.Dead,
      Pid: state.Pid,
      ExitCode: state.ExitCode,
      Error: state.Error,
      StartedAt: state.StartedAt,
      FinishedAt: state.FinishedAt,
    };
  } catch {
    return { inspectError: "unparseable inspect state" };
  }
}
function sql(lease, statement) {
  const result = direct([
    "exec",
    "-i",
    "-e",
    `PGPASSWORD=${lease.password}`,
    lease.containerName,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    lease.role,
    "-d",
    lease.database,
    "-h",
    lease.socketDirectory,
    "-c",
    statement,
  ]);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
function inventory() {
  return {
    containers: (direct(["container", "ls", "-aq", "--filter", "name=stirpi-verify-"])
      .stdout ?? "").trim().split("\n").filter(Boolean),
    volumes: (direct(["volume", "ls", "-q", "--filter", "name=stirpi-verify-"])
      .stdout ?? "").trim().split("\n").filter(Boolean),
  };
}

let result;
let observation;
try {
  writeFileSync(join(root, "fixture.txt"), "lease-only\n");
  const adapter = new DockerVerifierAdapter(command, {
    afterDatabaseBootstrap(lease) {
      const reachedAt = now();
      const btreeGist = sql(
        lease,
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') AS installed;",
      );
      const initialSelect = sql(lease, "SELECT 1;");
      const stateAtReady = inspectState();
      const deadline = Date.now() + observationMs;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, deadline - Date.now());
      const stateAfterWindow = inspectState();
      const finalSelect = sql(lease, "SELECT 1;");
      observation = {
        reachedAt,
        observationMs,
        btreeGist,
        initialSelect,
        stateAtReady,
        stateAfterWindow,
        finalSelect,
        cleanupStartedBeforeReturn: cleanupStarted,
        postgresLogsBeforeExplicitCleanup: direct(["logs", lease.containerName]).stdout ?? "",
      };
      return "stop";
    },
  });
  result = adapter.execute(
    {
      id: "lease-only",
      executable: "/bin/false",
      argv: [],
      cwd: "/workspace",
      image: POSTGRES_17_IMAGE,
      database: "required",
      limits: {
        timeoutMs: 60_000,
        memoryBytes: 256 * 1024 * 1024,
        pids: 64,
        fileDescriptors: 128,
      },
    },
    snapshotWorkspace(root),
  );
} finally {
  const endedAt = new Date();
  const events = direct([
    "events",
    "--since",
    startedAt.toISOString(),
    "--until",
    endedAt.toISOString(),
    "--format",
    "{{.TimeNano}} {{.Type}} {{.Action}} {{json .Actor.Attributes}}",
  ]);
  process.stdout.write(
    JSON.stringify({
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      containerId,
      containerName,
      result,
      observation,
      cleanupStarted,
      postgresLogsBeforeCleanup,
      dockerEvents: (events.stdout ?? "").split("\n").filter(Boolean),
      trace,
      finalInventory: inventory(),
    }) + "\n",
  );
  rmSync(root, { recursive: true, force: true });
}
