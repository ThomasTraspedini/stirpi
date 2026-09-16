import { performance } from "node:perf_hooks";
import { rmSync } from "node:fs";
import {
  boundedPublicOutput,
  commandCheckProcess,
  validateChecks,
  type CommandCheckProcess,
  type PublicCheck,
} from "../evaluation/commands.js";
import {
  snapshotWorkspace,
  type VerificationExecutor,
  type VerificationOperation,
} from "../verification/index.js";
import { assertTrustedLocalCheck } from "./preparation.js";

export type VerificationMode = "none" | "trusted-local";

export interface TrustedLocalPreparation {
  prepare(workspace: string): void;
  verificationEnvironment(
    workspace: string,
    check: PublicCheck,
    base: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv;
}

const OUTPUT_BYTES = 64 * 1024;
const PROCESS_BYTES = 1024 * 1024;

function failureMessage(value: string) {
  return (
    boundedPublicOutput(value, 1024).value || "Trusted-local verifier failed"
  );
}

function safeDurationMs(started: number, completed: number) {
  const elapsed = completed - started;
  if (!Number.isFinite(elapsed))
    return elapsed === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : 0;
  if (elapsed <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(elapsed));
}

export class TrustedLocalVerification implements VerificationExecutor {
  private readonly checks = new Map<string, PublicCheck>();
  private readonly attempts = new Map<string, number>();

  constructor(
    checks: readonly PublicCheck[],
    private readonly preparation: TrustedLocalPreparation,
    private readonly baseEnvironment: NodeJS.ProcessEnv,
    private readonly timeoutMs?: number,
    private readonly run: CommandCheckProcess = commandCheckProcess,
    private readonly clock: () => number = () => performance.now(),
  ) {
    validateChecks({
      checks: checks.map((check) => structuredClone(check)),
      completionPolicy: "all_checks_pass",
    });
    for (const check of checks) {
      assertTrustedLocalCheck(check);
      this.checks.set(check.id, structuredClone(check));
    }
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    )
      throw new Error("Invalid trusted-local verification timeout");
  }

  available(): string[] {
    return [...this.checks.keys()];
  }

  perform(
    id: string,
    workId: string,
    workspace: string,
  ): VerificationOperation {
    const check = this.checks.get(id);
    if (!check)
      return {
        request: { id, workId, workspaceDigest: "" },
        outcome: {
          ok: false,
          reason: {
            code: "UNKNOWN_VERIFICATION_ID",
            message: `Unknown verification ID: ${id}`,
          },
        },
      };

    let workspaceDigest = "";
    let snapshotRoot: string | undefined;
    try {
      this.preparation.prepare(workspace);
      const snapshot = snapshotWorkspace(workspace);
      workspaceDigest = snapshot.digest;
      snapshotRoot = snapshot.root;
      const environment = this.preparation.verificationEnvironment(
        workspace,
        structuredClone(check),
        this.baseEnvironment,
      );
      const started = this.clock();
      const output = this.run(structuredClone(check), {
        cwd: workspace,
        env: environment,
        input: "",
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
        maxBuffer: PROCESS_BYTES,
      });
      const durationMs = safeDurationMs(started, this.clock());
      const request = { id, workId, workspaceDigest };
      if (output.error || output.signal || output.status === null)
        return {
          request,
          outcome: {
            ok: false,
            reason: {
              code: "TRUSTED_LOCAL_VERIFICATION_FAILED",
              message: failureMessage(
                output.error?.message ??
                  `${output.signal ?? "missing exit status"}\n${output.stderr ?? ""}`,
              ),
            },
          },
        };
      const stdout = boundedPublicOutput(output.stdout ?? "", OUTPUT_BYTES);
      const stderr = boundedPublicOutput(output.stderr ?? "", OUTPUT_BYTES);
      const key = `${workId}:${id}`;
      const attempt = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, attempt);
      return {
        request,
        outcome: {
          ok: true,
          evidence: {
            id,
            attempt,
            passed: output.status === 0,
            exitCode: output.status,
            stdout: stdout.value,
            stderr: stderr.value,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            durationMs,
          },
        },
      };
    } catch (error) {
      return {
        request: { id, workId, workspaceDigest },
        outcome: {
          ok: false,
          reason: {
            code: "TRUSTED_LOCAL_VERIFICATION_FAILED",
            message: failureMessage(
              error instanceof Error ? error.message : String(error),
            ),
          },
        },
      };
    } finally {
      if (snapshotRoot) rmSync(snapshotRoot, { recursive: true, force: true });
    }
  }
}
