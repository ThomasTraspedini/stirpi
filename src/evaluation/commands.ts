import { spawnSync } from "node:child_process";
import type {
  CheckResult,
  Evaluation,
  EvaluationContext,
  Evaluator,
} from "./index.js";
import { OperationalFailure } from "../executor/protocol.js";
import type { SpawnSyncReturns } from "node:child_process";

export interface PublicCheck {
  id: string;
  executable: string;
  args: string[];
  workingDirectory?: "candidate";
}
export interface CommandChecksConfig {
  checks: PublicCheck[];
  completionPolicy: "all_checks_pass";
}
export interface CommandCheckProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs?: number;
  maxBuffer: number;
}
export type CommandCheckProcess = (
  check: PublicCheck,
  options: CommandCheckProcessOptions,
) => Pick<
  SpawnSyncReturns<string>,
  "status" | "signal" | "stdout" | "stderr" | "error"
>;
export const commandCheckProcess: CommandCheckProcess = (check, options) =>
  spawnSync(check.executable, check.args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    shell: false,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
  });
export function boundedPublicOutput(value: string, limit: number) {
  const sanitized = value
    .replace(
      /(?:DATABASE_URL\s*[=:]\s*|postgres(?:ql)?:\/\/)[^\s'"`]+/gi,
      "[REDACTED_DATABASE_URL]",
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\x1b]/g, "");
  const bytes = Buffer.from(sanitized);
  let end = Math.min(bytes.length, limit);
  if (end < bytes.length)
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    value: bytes.subarray(0, end).toString("utf8"),
    truncated: bytes.length > limit,
  };
}
export function validateChecks(config: CommandChecksConfig): void {
  if (config.completionPolicy !== "all_checks_pass")
    throw new Error("completionPolicy must be all_checks_pass");
  if (!Array.isArray(config.checks) || !config.checks.length)
    throw new Error("At least one public check required");
  const ids = new Set<string>();
  for (const check of config.checks) {
    if (
      !check ||
      typeof check.id !== "string" ||
      !check.id.trim() ||
      ids.has(check.id)
    )
      throw new Error("Public checks require unique stable ids");
    ids.add(check.id);
    if (
      typeof check.executable !== "string" ||
      !check.executable.trim() ||
      !Array.isArray(check.args) ||
      !check.args.every((arg) => typeof arg === "string")
    )
      throw new Error(
        "Public checks require executable and string args; command strings are unsupported",
      );
    if (
      Object.keys(check).some(
        (key) =>
          !["id", "executable", "args", "workingDirectory"].includes(key),
      ) ||
      (check.workingDirectory !== undefined &&
        check.workingDirectory !== "candidate")
    )
      throw new Error(
        "Public checks support only the candidate working directory",
      );
  }
}
const limit = 1024 * 1024;
// Trusted public programs, not a host filesystem sandbox. No shell parsing or
// fallback directory: missing candidate context is an infrastructure failure.
export class CommandChecksEvaluator implements Evaluator {
  private readonly config: CommandChecksConfig;
  constructor(
    config: CommandChecksConfig,
    private readonly environment:
      | NodeJS.ProcessEnv
      | ((workspace: string, check: PublicCheck) => NodeJS.ProcessEnv) = {
      PATH: process.env.PATH,
    },
    private readonly timeoutMs: number | undefined = undefined,
    private readonly observe: (result: CheckResult) => void = () => {},
    private readonly run: CommandCheckProcess = commandCheckProcess,
  ) {
    validateChecks(config);
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    )
      throw new Error("Invalid check timeout");
    this.config = structuredClone(config);
  }
  evaluate(context: EvaluationContext): Evaluation {
    if (!context.artifactRef || !context.workspacePath)
      throw new OperationalFailure({
        code: "PUBLIC_EVALUATOR_FAILED",
        message:
          "Public checks require a canonical artifact and active candidate workspace",
      });
    const checks: CheckResult[] = [];
    for (const check of this.config.checks) {
      const record: CheckResult = {
        id: check.id,
        startedAt: new Date().toISOString(),
        completedAt: "",
        processStatus: "operational_error",
        exitStatus: null,
        signal: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        passed: false,
        error: null,
      };
      try {
        const output = this.run(structuredClone(check), {
          cwd: context.workspacePath,
          env: Object.fromEntries(
            Object.entries(
              typeof this.environment === "function"
                ? this.environment(
                    context.workspacePath,
                    structuredClone(check),
                  )
                : this.environment,
            ).filter(([key]) => !key.startsWith("GIT_")),
          ),
          input: JSON.stringify(context) + "\n",
          ...(this.timeoutMs !== undefined
            ? { timeoutMs: this.timeoutMs }
            : {}),
          maxBuffer: limit,
        });
        record.exitStatus = output.status;
        record.signal = output.signal;
        const stdout = boundedPublicOutput(output.stdout ?? "", limit);
        const stderr = boundedPublicOutput(output.stderr ?? "", limit);
        record.stdout = stdout.value;
        record.stderr = stderr.value;
        record.outputTruncated =
          stdout.truncated ||
          stderr.truncated ||
          Buffer.byteLength(output.stdout ?? "") +
            Buffer.byteLength(output.stderr ?? "") >
            limit;
        record.error = output.error
          ? boundedPublicOutput(output.error.message, 1024).value
          : null;
        record.processStatus = output.error
          ? "operational_error"
          : output.signal
            ? "signaled"
            : "exited";
        record.passed = !output.error && output.status === 0;
      } catch (error) {
        record.error = boundedPublicOutput(
          error instanceof Error ? error.message : String(error),
          1024,
        ).value;
      }
      record.completedAt = new Date().toISOString();
      checks.push(record);
      this.observe(structuredClone(record));
    }
    const failed = checks.find((check) => check.error !== null);
    if (failed)
      throw new OperationalFailure({
        code: "PUBLIC_EVALUATOR_FAILED",
        message: `Public check ${failed.id}: ${failed.error}`,
      });
    return {
      passed: checks.every((check) => check.passed),
      reason: checks.every((check) => check.passed)
        ? "All public checks passed"
        : "Public checks failed",
      completionPolicy: this.config.completionPolicy,
      checks,
    };
  }
}
