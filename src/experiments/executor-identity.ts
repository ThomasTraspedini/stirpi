import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import type { ProcessConfig } from "../executor/process.js";
import { sha256 } from "./inputs.js";

export interface ExecutorPin {
  adapter?: string;
  executableVersion?: string;
  executableSha256?: string;
}

// Resolve once and launch using this absolute path, independent of worktree cwd.
function executablePath(executable: string) {
  if (typeof executable !== "string" || !executable.trim())
    throw new Error("Preflight: invalid executor executable");
  const candidates = executable.includes("/")
    ? [resolve(executable)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .map((directory) => resolve(directory, executable));
  for (const path of candidates) {
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.R_OK | constants.X_OK);
      return path;
    } catch {
      // Continue PATH lookup past missing or inaccessible entries.
    }
  }
  throw new Error("Preflight: executor executable unavailable");
}

export function verifyExecutor(config: ProcessConfig, pin: ExecutorPin = {}) {
  if (
    !pin ||
    typeof pin !== "object" ||
    Array.isArray(pin) ||
    (pin.executableVersion !== undefined &&
      (typeof pin.executableVersion !== "string" ||
        !pin.executableVersion.trim())) ||
    (pin.executableSha256 !== undefined &&
      (typeof pin.executableSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(pin.executableSha256)))
  )
    throw new Error("Preflight: invalid executor identity pin");
  const command = { ...config, executable: executablePath(config.executable) };
  let path = command.executable;
  if (pin.adapter === "codex") {
    const args = [...(config.args ?? [])];
    const indices = args.flatMap((arg, index) =>
      arg === "--codex" || arg.startsWith("--codex=") ? [index] : [],
    );
    if (indices.length !== 1)
      throw new Error(
        "Preflight: Codex adapter requires one --codex executable",
      );
    const index = indices[0]!;
    const inline = args[index]!.startsWith("--codex=");
    path = executablePath(inline ? args[index]!.slice(8) : args[index + 1]!);
    args[inline ? index : index + 1] = inline ? `--codex=${path}` : path;
    command.args = args;
  }
  const executableSha256 = sha256(readFileSync(path));
  let executableVersion: string;
  try {
    executableVersion = execFileSync(path, ["--version"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1048576,
    }).trim();
    if (!executableVersion) throw new Error("empty version");
  } catch {
    throw new Error("Preflight: executor version probe failed");
  }
  // Codex reports a product prefix; existing preregistrations pin its version.
  const version =
    pin.adapter === "codex"
      ? executableVersion.replace(/^codex-cli /, "")
      : executableVersion;
  if (pin.executableVersion !== undefined && pin.executableVersion !== version)
    throw new Error("Preflight: executor version mismatch");
  if (
    pin.executableSha256 !== undefined &&
    pin.executableSha256 !== executableSha256
  )
    throw new Error("Preflight: executor executable SHA256 mismatch");
  return {
    command,
    evidence: { executablePath: path, executableVersion, executableSha256 },
  };
}
