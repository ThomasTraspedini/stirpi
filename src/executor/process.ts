import {
  adapterEvidence,
  environmentEvidence,
  pathEvidence,
} from "../operational/diagnostics.js";
import {
  InvocationSupervisor,
  type InvocationPolicy,
  type SupervisionObserver,
  type SupervisionObservation,
  type StopEvidence,
} from "../supervision/index.js";
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
  adapterDiagnostics?: ReturnType<typeof adapterEvidence>;
  environment?: ReturnType<typeof environmentEvidence>;
  stateDirectory?: ReturnType<typeof pathEvidence>;
  supervision?: SupervisionObservation;
  startedAt: string;
  completedAt: string;
  stdout: string;
  stderr: string;
  status: number | null;
  signal: string | null;
  error: string | null;
}
export interface ProcessOptions {
  supervision?: InvocationPolicy;
  observeSupervision?: SupervisionObserver;
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
    supervise?: SupervisionObserver,
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
    if (
      timeout !== undefined &&
      this.options.supervision?.budgets?.wallTimeMs !== undefined
    )
      throw new Error(
        "Use either timeoutMs or supervision wallTimeMs, not both",
      );
    const supervisor = new InvocationSupervisor(`invocation:${invocationId}`, {
      ...this.options.supervision,
      budgets: {
        ...this.options.supervision?.budgets,
        ...(timeout !== undefined ? { wallTimeMs: timeout } : {}),
      },
    });
    let refresh: (() => void) | undefined;
    let finished = false;
    let observerFailed = false;
    const record = () => {
      for (const callback of [supervise, this.options.observeSupervision]) {
        try {
          callback?.(supervisor.snapshot());
        } catch {
          observerFailed = true;
          stopObserver?.();
        }
      }
    };
    let stopObserver: (() => void) | undefined;
    const channel = new OperationalChannel(invocationId, (event) => {
      if (!finished) supervisor.observe(event);
      refresh?.();
      record();
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
    let providerStop: StopEvidence | undefined;
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0);
    let captured = 0;
    const limit = 1024 * 1024;
    let status: number | null = null,
      signal: string | null = null;
    record();
    if (this.options.signal?.aborted) {
      termination = "EXECUTOR_CANCELLED";
      supervisor.stop({
        kind: "CALLER_CANCELLED",
        scope: supervisor.scope,
        code: termination,
      });
    } else if (supervisor.check()) termination = "RESOURCE_EXHAUSTED";
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
          supervisor.stop({
            kind:
              code === "EXECUTOR_CANCELLED"
                ? "CALLER_CANCELLED"
                : "PROCESS_PROTOCOL_FAILURE",
            scope: supervisor.scope,
            code,
          });
          kill("SIGTERM");
          // Escalation only after explicit termination/output failure, never a watchdog.
          cleanup = setTimeout(() => kill("SIGKILL"), 1000);
        };
        stopObserver = () => stop("PROCESS_OBSERVER_FAILED");
        const cancel = () => stop("EXECUTOR_CANCELLED");
        this.options.signal?.addEventListener("abort", cancel, { once: true });
        if (this.options.signal?.aborted) cancel();
        refresh = () => {
          clearTimeout(timer);
          const reason = supervisor.check();
          if (reason) {
            stop(
              reason.kind === "NO_PROGRESS"
                ? "NO_PROGRESS"
                : reason.kind === "RESOURCE_EXHAUSTED"
                  ? timeout !== undefined && reason.resource === "wallTimeMs"
                    ? "EXECUTOR_WALL_TIME_EXHAUSTED"
                    : "RESOURCE_EXHAUSTED"
                  : reason.code,
            );
            return;
          }
          const delay = supervisor.delay();
          if (delay !== undefined)
            timer = setTimeout(() => {
              refresh?.();
              record();
            }, delay);
        };
        refresh();
        const lines = new JsonLines(
          (value) => {
            const event = channel.emit(
              value as Parameters<OperationalChannel["emit"]>[0],
            );
            if (
              event.kind === "termination" &&
              event.status === "resource_exhausted"
            ) {
              const budget = event.metadata?.budgetMs;
              const observed = event.metadata?.durationMs;
              if (typeof budget === "number" && typeof observed === "number") {
                providerTermination = "EXECUTOR_WALL_TIME_EXHAUSTED";
                providerStop = {
                  kind: "RESOURCE_EXHAUSTED",
                  scope: `${supervisor.scope}/provider`,
                  resource: "wallTimeMs",
                  budget,
                  observed,
                };
              } else providerTermination = "INVALID_RESOURCE_EVIDENCE";
            }
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
          refresh = undefined;
          clearTimeout(timer);
          clearTimeout(cleanup);
          if (termination) kill("SIGKILL");
          this.options.signal?.removeEventListener("abort", cancel);
          stopObserver = undefined;
          lines.end();
          status = code;
          signal = sig;
          if (code !== 0 && !termination) {
            termination = providerTermination;
            if (providerStop) supervisor.stop(providerStop);
          }
          stopObserver = undefined;
          resolve();
        });
        child.stdin!.end(JSON.stringify({ version: 1, context }) + "\n");
      });
    const pendingStop = supervisor.snapshot().stop;
    if (!termination && pendingStop)
      termination =
        pendingStop.kind === "NO_PROGRESS"
          ? "NO_PROGRESS"
          : pendingStop.kind === "RESOURCE_EXHAUSTED"
            ? "RESOURCE_EXHAUSTED"
            : pendingStop.code;
    finished = true;
    let response: unknown;
    if (!termination && status !== 0) termination = "PROCESS_EXIT_FAILED";
    if (!termination) {
      try {
        response = JSON.parse(stdout.toString("utf8"));
      } catch {
        termination = "INVALID_EXECUTOR_JSON";
      }
    }
    if (termination)
      supervisor.stop({
        kind:
          termination === "EXECUTOR_CANCELLED"
            ? "CALLER_CANCELLED"
            : "PROCESS_PROTOCOL_FAILURE",
        scope: supervisor.scope,
        code: termination,
      });
    channel.emit({
      kind: "process",
      scope,
      status:
        termination === "EXECUTOR_CANCELLED"
          ? "cancelled"
          : supervisor.snapshot().stop?.kind === "RESOURCE_EXHAUSTED"
            ? "resource_exhausted"
            : termination || status !== 0
              ? "failed"
              : "completed",
      metadata: {
        durationMs: Date.now() - Date.parse(startedAt),
        ...(status !== null ? { exitCode: status } : {}),
      },
    });
    if (observerFailed) {
      termination ??= "PROCESS_OBSERVER_FAILED";
      supervisor.stop({
        kind: "PROCESS_PROTOCOL_FAILURE",
        scope: supervisor.scope,
        code: termination,
      });
    }
    record();
    this.options.observe?.({
      adapterDiagnostics: adapterEvidence(stderr.toString("utf8")),
      environment: environmentEvidence(process.env, {
        ...Object.fromEntries(
          Object.entries(this.options.environment ?? process.env).filter(
            ([k]) => !k.startsWith("GIT_"),
          ),
        ),
        STIRPI_OPERATIONAL_FD: "3",
      }),
      stateDirectory: pathEvidence(this.options.environment?.TMPDIR),
      supervision: supervisor.snapshot(),
      startedAt,
      completedAt: new Date().toISOString(),
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      status,
      signal,
      error: termination,
    });
    if (termination)
      throw new OperationalFailure({
        code: termination,
        message: termination,
        stop: supervisor.snapshot().stop ?? {
          kind: "PROCESS_PROTOCOL_FAILURE",
          scope: supervisor.scope,
          code: termination,
        },
      });
    return response;
  }
}
