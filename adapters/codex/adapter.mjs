#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  lstatSync,
  symlinkSync,
  rmSync,
  createWriteStream,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { invocationFrom, responseContract, responseFrom } from "./contract.mjs";

import {
  environmentEvidence,
  permissions,
  statePlacement,
} from "./diagnostics.mjs";
import { CodexEvents } from "./events.mjs";

const operationalOutput =
  process.env.STIRPI_OPERATIONAL_FD === "3"
    ? createWriteStream("", { fd: 3, autoClose: false })
    : null;
operationalOutput?.on("error", () => {
  /* Parent channel closed. */
});
const emit = (event) => operationalOutput?.write(JSON.stringify(event) + "\n");
const events = new CodexEvents(emit);
let cancelled = false;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const record = {
  adapter: "codex-m2-v1",
  startedAt: new Date().toISOString(),
  tool: null,
  version: null,
  status: null,
  signal: null,
  response: null,
  usage: null,
  monetaryCost: null,
};
let temporary;
let child;
const kill = () => {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  }
};
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    cancelled = true;
    kill();
  });

function run(executable, args, options) {
  return new Promise((resolve) => {
    const started = performance.now();
    let exhaustedAt;
    child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrHash = createHash("sha256");
    let stderrBytes = 0,
      error = null,
      size = 0;
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(() => {
            error = "AGENT_WALL_TIME_EXHAUSTED";
            exhaustedAt = Math.floor(performance.now() - started);
            kill();
          }, options.timeout);
    const collect = (which, chunk) => {
      size += chunk.length;
      emit({
        kind: "output",
        scope: hash(`codex.${which}`),
        metadata: { bytes: chunk.length, outputHash: hash(chunk) },
      });
      if (which === "stderr") {
        stderrBytes += chunk.length;
        stderrHash.update(chunk);
      }
      if (size > 1024 * 1024) {
        error = "AGENT_OUTPUT_LIMIT";
        kill();
        return;
      }
      if (which === "stdout") events.write(chunk);
    };
    child.stdout.on("data", (s) => collect("stdout", s));
    child.stderr.on("data", (s) => collect("stderr", s));
    child.on("error", (e) => {
      error = e.code === "ENOENT" ? "AGENT_UNAVAILABLE" : "AGENT_LAUNCH_FAILED";
    });
    child.stdin.on("error", () => {
      /* A failed process may close stdin early. */
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      child = undefined;
      events.end();
      if (cancelled) error = "AGENT_CANCELLED";
      if (error === "AGENT_CANCELLED" || error === "AGENT_WALL_TIME_EXHAUSTED")
        emit({
          kind: "termination",
          ...(error === "AGENT_WALL_TIME_EXHAUSTED"
            ? {
                metadata: {
                  budgetMs: options.timeout,
                  durationMs: exhaustedAt,
                },
              }
            : {}),
          status:
            error === "AGENT_CANCELLED" ? "cancelled" : "resource_exhausted",
        });
      resolve({
        stderrBytes,
        stderrSha256: stderrHash.digest("hex"),
        status,
        signal,
        error,
      });
    });
    child.stdin.end(options.input);
  });
}

try {
  const optionCount = (name) =>
    process.argv
      .slice(2)
      .filter((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
      .length;
  const { values } = parseArgs({
    options: {
      codex: { type: "string" },
      "auth-file": { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const supportedEfforts = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ];
  if (
    !values.codex ||
    optionCount("codex") !== 1 ||
    !isAbsolute(values.codex) ||
    optionCount("model") !== 1 ||
    typeof values.model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(values.model) ||
    optionCount("effort") !== 1 ||
    !supportedEfforts.includes(values.effort) ||
    (values["auth-file"] && !isAbsolute(values["auth-file"]))
  )
    throw new Error("INVALID_CONFIGURATION");
  const timeout =
    values["timeout-ms"] === undefined
      ? undefined
      : Number(values["timeout-ms"]);
  if (
    timeout !== undefined &&
    (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647)
  )
    throw new Error("INVALID_CONFIGURATION");
  record.tool = values.codex;
  record.model = values.model;
  record.effort = values.effort;
  record.configuration = {
    executor: { model: values.model, effort: values.effort },
    auth: {
      kind: values["auth-file"] ? "explicit_file" : "none",
      ...permissions(values["auth-file"]),
    },
    config: {
      present: permissions(
        join(
          process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex"),
          "config.toml",
        ),
      ).exists,
      policy: "ignored",
    },
  };
  let invocation;
  try {
    invocation = invocationFrom(readFileSync(0, "utf8"));
  } catch (e) {
    throw new Error(
      ["WORKSPACE_REQUIRED", "UNSUPPORTED_PROTOCOL_VERSION"].includes(e.message)
        ? e.message
        : "INVALID_INPUT",
    );
  }
  const { task, context, workspace } = invocation;
  // M2 assigns linked worktrees. Refuse ordinary source checkouts and cwd drift.
  if (!isAbsolute(workspace)) throw new Error("WORKSPACE_REQUIRED");
  let cwd;
  try {
    cwd = realpathSync(workspace);
    if (
      realpathSync(process.cwd()) !== cwd ||
      !lstatSync(join(cwd, ".git")).isFile()
    )
      throw new Error();
  } catch {
    throw new Error("INVALID_WORKSPACE");
  }
  const tempRoot = realpathSync(tmpdir());
  const rel = relative(cwd, tempRoot);
  if (!rel || (!rel.startsWith("../") && !isAbsolute(rel)))
    throw new Error("STATE_INSIDE_WORKSPACE");
  temporary = mkdtempSync(join(tempRoot, "stirpi-codex-"));
  const home = join(temporary, "home"),
    codexHome = join(temporary, "codex");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(codexHome, { mode: 0o700 });
  // Reuse explicitly selected login without copying credentials or personal state.
  if (values["auth-file"]) {
    if (!lstatSync(values["auth-file"]).isFile())
      throw new Error("INVALID_AUTH_FILE");
    symlinkSync(values["auth-file"], join(codexHome, "auth.json"));
  }
  const env = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    TZ: "UTC",
    HOME: home,
    TMPDIR: temporary,
    CODEX_HOME: codexHome,
  };
  record.configuration.environment = environmentEvidence(process.env, env);
  record.configuration.state = {
    ...permissions(temporary),
    placement: statePlacement(tempRoot),
  };
  record.configuration.placements = {
    HOME: "adapter_state",
    CODEX_HOME: "adapter_state",
    TMPDIR: "adapter_state",
  };
  const git = (...args) => {
    const result = spawnSync(
      "git",
      ["--no-replace-objects", "-C", cwd, ...args],
      {
        env,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 4096,
      },
    );
    if (result.error || result.status !== 0)
      throw new Error("INVALID_WORKSPACE");
    return result.stdout.trim();
  };
  const head = git("rev-parse", "HEAD");
  const branch = git("symbolic-ref", "HEAD");
  if (
    head !== context.artifact.ref ||
    realpathSync(git("rev-parse", "--show-toplevel")) !== cwd
  )
    throw new Error("INVALID_WORKSPACE");
  const version = spawnSync(values.codex, ["--version"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 4096,
  });
  if (version.error)
    throw new Error(
      version.error.code === "ENOENT"
        ? "AGENT_UNAVAILABLE"
        : "AGENT_LAUNCH_FAILED",
    );
  record.version = /^codex-cli [\w.+-]+\s*$/.test(version.stdout)
    ? version.stdout.trim()
    : null;
  events.version = record.version;
  const contract = responseContract(context);
  const schemaFile = join(temporary, "response-schema.json"),
    responseFile = join(temporary, "response.json");
  writeFileSync(schemaFile, JSON.stringify(contract.schema), { mode: 0o600 });
  // CLI treats an explicit prompt and stdin as separate instruction/context parts.
  // Task text is an unmodified suffix: no quoting, trimming, or reconstruction.
  const prompt =
    contract.instructions +
    "\n\nLineage-local context (JSON):\n" +
    JSON.stringify(context);
  record.taskSha256 = hash(task);
  record.contextSha256 = hash(JSON.stringify(context));
  record.promptSha256 = hash(prompt);
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--sandbox",
    "workspace-write",
    "--cd",
    cwd,
    "--json",
    "--strict-config",
    "--color",
    "never",
    "--output-schema",
    schemaFile,
    "--output-last-message",
    responseFile,
    "-c",
    'shell_environment_policy.inherit="none"',
    "-c",
    `shell_environment_policy.set={${Object.entries({
      PATH: env.PATH ?? "",
      HOME: home,
      TMPDIR: temporary,
      LANG: env.LANG,
      TZ: env.TZ,
    })
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(",")}}`,
    "-c",
    'web_search="disabled"',
    "--model",
    values.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(values.effort)}`,
  ];
  args.push(prompt);
  const result = await run(values.codex, args, {
    cwd,
    env,
    input: task,
    timeout,
  });
  record.status = result.status;
  record.signal = result.signal;
  // Arbitrary tool output may include secrets. Keep only native usage and safe
  // diagnostics, never raw command output, stderr, environment, or auth contents.
  record.diagnostics = {
    stderrBytes: result.stderrBytes,
    stderrSha256: result.stderrSha256,
    eventTypes: events.eventTypes,
    counts: events.counts,
    errors: events.errors,
    lastNativeType: events.lastNativeType,
    lifecycle: events.lifecycle,
  };
  record.usage = events.usage;
  if (result.error) throw new Error(result.error);
  if (result.status !== 0) throw new Error("AGENT_EXIT_FAILED");
  if (
    git("rev-parse", "HEAD") !== head ||
    git("symbolic-ref", "HEAD") !== branch
  )
    throw new Error("GIT_IDENTITY_CHANGED");
  let response;
  try {
    response = responseFrom(readFileSync(responseFile, "utf8"), contract);
  } catch {
    throw new Error("INVALID_AGENT_RESPONSE");
  }
  if (
    context.control &&
    !context.control.actions.includes(response.action.type)
  )
    throw new Error("ACTION_UNAVAILABLE");
  record.response = response;
  process.stdout.write(JSON.stringify(response) + "\n");
} catch (error) {
  const codes = [
    "INVALID_CONFIGURATION",
    "INVALID_INPUT",
    "UNSUPPORTED_PROTOCOL_VERSION",
    "WORKSPACE_REQUIRED",
    "INVALID_WORKSPACE",
    "GIT_IDENTITY_CHANGED",
    "STATE_INSIDE_WORKSPACE",
    "INVALID_AUTH_FILE",
    "AGENT_UNAVAILABLE",
    "AGENT_LAUNCH_FAILED",
    "AGENT_WALL_TIME_EXHAUSTED",
    "AGENT_CANCELLED",
    "AGENT_OUTPUT_LIMIT",
    "AGENT_EXIT_FAILED",
    "INVALID_AGENT_RESPONSE",
    "ACTION_UNAVAILABLE",
  ];
  record.failure = {
    code: codes.includes(error.message) ? error.message : "ADAPTER_FAILED",
    message:
      "Coding-agent invocation failed operationally; no semantic action returned",
  };
  process.exitCode = 1;
} finally {
  kill();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  record.completedAt = new Date().toISOString();
  record.wallTimeMs =
    Date.parse(record.completedAt) - Date.parse(record.startedAt);
  process.stderr.write(JSON.stringify(record) + "\n");
  operationalOutput?.end();
}
