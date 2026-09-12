import { spawnSync } from "node:child_process";
import type {
  CheckResult,
  Evaluation,
  EvaluationContext,
  Evaluator,
} from "./index.js";
import { OperationalFailure } from "../executor/protocol.js";

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
    private readonly environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
    },
    private readonly timeoutMs: number | undefined = undefined,
    private readonly observe: (result: CheckResult) => void = () => {},
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
        const output = spawnSync(check.executable, check.args, {
          cwd: context.workspacePath,
          env: Object.fromEntries(
            Object.entries(this.environment).filter(
              ([key]) => !key.startsWith("GIT_"),
            ),
          ),
          input: JSON.stringify(context) + "\n",
          encoding: "utf8",
          shell: false,
          timeout: this.timeoutMs,
          maxBuffer: limit,
        });
        record.exitStatus = output.status;
        record.signal = output.signal;
        record.stdout = Buffer.from(output.stdout ?? "")
          .subarray(0, limit)
          .toString("utf8");
        record.stderr = Buffer.from(output.stderr ?? "")
          .subarray(0, limit)
          .toString("utf8");
        record.outputTruncated =
          Buffer.byteLength(output.stdout ?? "") +
            Buffer.byteLength(output.stderr ?? "") >
          limit;
        record.error = output.error?.message ?? null;
        record.processStatus = output.error
          ? "operational_error"
          : output.signal
            ? "signaled"
            : "exited";
        record.passed = !output.error && output.status === 0;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
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
