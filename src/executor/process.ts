import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  OperationalChannel,
  hash,
  type OperationalObserver,
} from "../operational/index.js";
import { JsonLines } from "../operational/jsonl.js";
import type { Executor, ExecutorContext } from "./index.js";
import { OperationalFailure } from "./protocol.js";

export interface ProcessConfig {
  executable: string;
  args?: string[];
  id?: string;
}
export interface ProcessObservation {
  startedAt: string;
  completedAt: string;
  stdout: string;
  stderr: string;
  status: number | null;
  signal: string | null;
  error: string | null;
}
export interface ProcessOptions {
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  observeEvent?: OperationalObserver;
  observe?: (observation: ProcessObservation) => void;
}
// Trusted local programs. cwd is assignment, not a filesystem sandbox.
export class ProcessExecutor implements Executor {
  readonly protocol = 1;
  readonly asynchronous = true;
  readonly id: string;
  private readonly config: ProcessConfig;
  constructor(
    config: ProcessConfig,
    private readonly options: ProcessOptions = {},
  ) {
    if (
      !config ||
      typeof config.executable !== "string" ||
      !config.executable.trim() ||
      (config.args !== undefined &&
        (!Array.isArray(config.args) ||
          !config.args.every((arg) => typeof arg === "string"))) ||
      (config.id !== undefined &&
        (typeof config.id !== "string" || !config.id.trim()))
    )
      throw new Error(
        "Process config requires an executable, optional string args and optional executor id",
      );
    this.config = structuredClone(config);
    this.id = config.id ?? config.executable;
  }
  async execute(
    context: ExecutorContext,
    observe?: OperationalObserver,
  ): Promise<unknown> {
    const workspace = context.work.artifact;
    if (!workspace?.worktree || workspace.cleaned)
      throw new OperationalFailure({
        code: "WORKSPACE_REQUIRED",
        message: "Process executor requires an assigned active workspace",
      });
    const timeout = this.options.timeoutMs;
    if (
      timeout !== undefined &&
      (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647)
    )
      throw new Error(
        "Explicit invocation wall-time limit must be a positive timer integer",
      );
    const startedAt = new Date().toISOString();
    const invocationId = randomUUID();
    const scope = hash(invocationId);
    let observerFailed = false;
    let stopObserver: (() => void) | undefined;
    const channel = new OperationalChannel(invocationId, (event) => {
      for (const callback of [observe, this.options.observeEvent]) {
        try {
          callback?.(structuredClone(event));
        } catch {
          observerFailed = true;
          stopObserver?.();
        }
      }
    });
    let termination: string | null = null;
    let providerTermination: string | null = null;
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0);
    let captured = 0;
    const limit = 1024 * 1024;
    let status: number | null = null,
      signal: string | null = null;
    if (this.options.signal?.aborted) termination = "EXECUTOR_CANCELLED";
    else
      await new Promise<void>((resolve) => {
        const child = spawn(this.config.executable, this.config.args ?? [], {
          cwd: workspace.worktree!,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe", "pipe"],
          env: {
            ...Object.fromEntries(
              Object.entries(this.options.environment ?? process.env).filter(
                ([key]) => !key.startsWith("GIT_"),
              ),
            ),
            STIRPI_OPERATIONAL_FD: "3",
          },
        });
        let timer: NodeJS.Timeout | undefined,
          cleanup: NodeJS.Timeout | undefined;
        const kill = (sig: NodeJS.Signals) => {
          try {
            if (child.pid) {
              if (process.platform === "win32") child.kill(sig);
              else process.kill(-child.pid, sig);
            }
          } catch {
            /* Scope already exited. */
          }
        };
        const stop = (code: string) => {
          if (termination) return;
          termination = code;
          kill("SIGTERM");
          // Escalation only after explicit termination/output failure, never a watchdog.
          cleanup = setTimeout(() => kill("SIGKILL"), 1000);
        };
        stopObserver = () => stop("PROCESS_OBSERVER_FAILED");
        const cancel = () => stop("EXECUTOR_CANCELLED");
        this.options.signal?.addEventListener("abort", cancel, { once: true });
        if (this.options.signal?.aborted) cancel();
        if (timeout !== undefined)
          timer = setTimeout(
            () => stop("EXECUTOR_WALL_TIME_EXHAUSTED"),
            timeout,
          );
        const lines = new JsonLines(
          (value) => {
            const event = channel.emit(
              value as Parameters<OperationalChannel["emit"]>[0],
            );
            if (
              event.kind === "termination" &&
              event.status === "resource_exhausted"
            )
              providerTermination = "EXECUTOR_WALL_TIME_EXHAUSTED";
            if (event.kind === "termination" && event.status === "cancelled")
              providerTermination = "EXECUTOR_CANCELLED";
          },
          () => channel.emit({ kind: "diagnostic" }),
        );
        (child.stdio[3] as Readable).on("data", (chunk: Buffer) =>
          lines.write(chunk),
        );
        const collect = (which: "stdout" | "stderr", chunk: Buffer) => {
          const part = chunk.subarray(0, Math.max(0, limit - captured));
          captured += chunk.length;
          if (which === "stdout") stdout = Buffer.concat([stdout, part]);
          else stderr = Buffer.concat([stderr, part]);
          channel.emit({
            kind: "output",
            scope: hash(which),
            metadata: { bytes: chunk.length, outputHash: hash(chunk) },
          });
          if (captured > limit) stop("PROCESS_OUTPUT_LIMIT");
        };
        child.stdout!.on("data", (chunk: Buffer) => collect("stdout", chunk));
        child.stderr!.on("data", (chunk: Buffer) => collect("stderr", chunk));
        child.on("spawn", () =>
          channel.emit({ kind: "process", scope, status: "started" }),
        );
        child.on("error", () => {
          termination ??= "PROCESS_LAUNCH_FAILED";
        });
        child.stdin!.on("error", () => {
          /* Failed child may close stdin early. */
        });
        child.on("close", (code, sig) => {
          clearTimeout(timer);
          clearTimeout(cleanup);
          if (termination) kill("SIGKILL");
          this.options.signal?.removeEventListener("abort", cancel);
          stopObserver = undefined;
          lines.end();
          status = code;
          signal = sig;
          if (code !== 0) termination ??= providerTermination;
          stopObserver = undefined;
          resolve();
        });
        child.stdin!.end(JSON.stringify({ version: 1, context }) + "\n");
      });
    channel.emit({
      kind: "process",
      scope,
      status:
        termination === "EXECUTOR_CANCELLED"
          ? "cancelled"
          : termination === "EXECUTOR_WALL_TIME_EXHAUSTED"
            ? "resource_exhausted"
            : termination || status !== 0
              ? "failed"
              : "completed",
      metadata: {
        durationMs: Date.now() - Date.parse(startedAt),
        ...(status !== null ? { exitCode: status } : {}),
      },
    });
    if (observerFailed) termination ??= "PROCESS_OBSERVER_FAILED";
    this.options.observe?.({
      startedAt,
      completedAt: new Date().toISOString(),
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      status,
      signal,
      error: termination,
    });
    if (termination)
      throw new OperationalFailure({ code: termination, message: termination });
    if (status !== 0)
      throw new OperationalFailure({
        code: "PROCESS_EXIT_FAILED",
        message: `Process exited with status ${status}, signal ${signal}`,
      });
    try {
      return JSON.parse(stdout.toString("utf8"));
    } catch {
      throw new OperationalFailure({
        code: "INVALID_EXECUTOR_JSON",
        message: "Process stdout must contain one JSON response",
      });
    }
  }
}
