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
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import {
  invocationFrom,
  instructions,
  responseSchema,
  responseFrom,
} from "./contract.mjs";

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
    kill();
  });

function run(executable, args, options) {
  return new Promise((resolve) => {
    child = spawn(executable, args, {
      ...options,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      error = null,
      size = 0;
    const timer = setTimeout(() => {
      error = "AGENT_TIMEOUT";
      kill();
    }, options.timeout);
    const collect = (which, chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        error = "AGENT_OUTPUT_LIMIT";
        kill();
        return;
      }
      if (which === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", (s) => collect("stdout", s));
    child.stderr.setEncoding("utf8").on("data", (s) => collect("stderr", s));
    child.on("error", (e) => {
      error = e.code === "ENOENT" ? "AGENT_UNAVAILABLE" : "AGENT_LAUNCH_FAILED";
    });
    child.stdin.on("error", () => {
      /* A failed process may close stdin early. */
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      child = undefined;
      resolve({ stdout, stderr, status, signal, error });
    });
    child.stdin.end(options.input);
  });
}

try {
  const { values } = parseArgs({
    options: {
      codex: { type: "string" },
      "auth-file": { type: "string" },
      model: { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  if (
    !values.codex ||
    !isAbsolute(values.codex) ||
    (values["auth-file"] && !isAbsolute(values["auth-file"]))
  )
    throw new Error("INVALID_CONFIGURATION");
  const timeout = Number(values["timeout-ms"] ?? 180000);
  if (!Number.isSafeInteger(timeout) || timeout < 1)
    throw new Error("INVALID_CONFIGURATION");
  record.tool = values.codex;
  record.model = values.model ?? null;
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
  const schemaFile = join(temporary, "response-schema.json"),
    responseFile = join(temporary, "response.json");
  writeFileSync(schemaFile, JSON.stringify(responseSchema), { mode: 0o600 });
  // CLI treats an explicit prompt and stdin as separate instruction/context parts.
  // Task text is an unmodified suffix: no quoting, trimming, or reconstruction.
  const prompt =
    instructions +
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
  ];
  if (values.model) args.push("--model", values.model);
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
    stderrBytes: Buffer.byteLength(result.stderr),
    stderrSha256: hash(result.stderr),
    eventTypes: {},
  };
  for (const line of result.stdout.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (
        [
          "thread.started",
          "turn.started",
          "turn.completed",
          "turn.failed",
          "item.started",
          "item.completed",
          "error",
        ].includes(event.type)
      )
        record.diagnostics.eventTypes[event.type] =
          (record.diagnostics.eventTypes[event.type] ?? 0) + 1;
      if (event.type === "turn.completed" && event.usage) {
        record.usage = Object.fromEntries(
          [
            "input_tokens",
            "cached_input_tokens",
            "output_tokens",
            "reasoning_output_tokens",
          ].map((k) => [
            k,
            Number.isSafeInteger(event.usage[k]) && event.usage[k] >= 0
              ? event.usage[k]
              : null,
          ]),
        );
      }
    } catch {
      /* Diagnostic JSONL is never used to infer a control action. */
    }
  }
  if (result.error) throw new Error(result.error);
  if (result.status !== 0) throw new Error("AGENT_EXIT_FAILED");
  if (
    git("rev-parse", "HEAD") !== head ||
    git("symbolic-ref", "HEAD") !== branch
  )
    throw new Error("GIT_IDENTITY_CHANGED");
  let response;
  try {
    response = responseFrom(readFileSync(responseFile, "utf8"));
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
    "AGENT_TIMEOUT",
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
}
