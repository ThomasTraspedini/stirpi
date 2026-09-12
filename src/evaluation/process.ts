import { spawnSync } from "node:child_process";
import type { Evaluation, EvaluationContext, Evaluator } from "./index.js";
import type { ProcessConfig, ProcessObservation } from "../executor/process.js";
import { OperationalFailure } from "../executor/protocol.js";

// Existing JSON-in/JSON-out evaluator protocol, now with authoritative context.
export class ProcessEvaluator implements Evaluator {
  constructor(
    private readonly command: ProcessConfig,
    private readonly cwd: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly timeoutMs: number | undefined,
    private readonly observe: (result: ProcessObservation) => void = () => {},
  ) {}
  evaluate(context: EvaluationContext): Evaluation {
    const startedAt = new Date().toISOString();
    const output = spawnSync(this.command.executable, this.command.args ?? [], {
      cwd: context.workspacePath ?? this.cwd,
      env: Object.fromEntries(
        Object.entries(this.environment).filter(
          ([key]) => !key.startsWith("GIT_"),
        ),
      ),
      input: JSON.stringify(context) + "\n",
      encoding: "utf8",
      shell: false,
      timeout: this.timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    this.observe({
      startedAt,
      completedAt: new Date().toISOString(),
      status: output.status,
      signal: output.signal,
      stdout: (output.stdout ?? "").slice(0, 1024 * 1024),
      stderr: (output.stderr ?? "").slice(0, 1024 * 1024),
      error: output.error?.message ?? null,
    });
    try {
      if (output.error || output.status !== 0)
        throw new Error("Public evaluator process failed");
      const evaluation: Evaluation = JSON.parse(output.stdout);
      if (
        typeof evaluation?.passed !== "boolean" ||
        typeof evaluation.reason !== "string"
      )
        throw new Error("Invalid public evaluator response");
      return { passed: evaluation.passed, reason: evaluation.reason };
    } catch (error) {
      throw new OperationalFailure({
        code: "PUBLIC_EVALUATOR_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
