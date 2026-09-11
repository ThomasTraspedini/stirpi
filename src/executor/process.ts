import { spawnSync } from "node:child_process";
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
  observe?: (observation: ProcessObservation) => void;
}
// Trusted local programs. cwd is assignment, not a filesystem sandbox.
export class ProcessExecutor implements Executor {
  readonly protocol = 1;
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
  execute(context: ExecutorContext): unknown {
    const workspace = context.work.artifact;
    if (!workspace?.worktree || workspace.cleaned)
      throw new OperationalFailure({
        code: "WORKSPACE_REQUIRED",
        message: "Process executor requires an assigned active workspace",
      });
    const startedAt = new Date().toISOString();
    const result = spawnSync(this.config.executable, this.config.args ?? [], {
      cwd: workspace.worktree,
      input: JSON.stringify({ version: 1, context }) + "\n",
      encoding: "utf8",
      shell: false,
      maxBuffer: 1024 * 1024,
      ...(this.options.timeoutMs === undefined
        ? {}
        : { timeout: this.options.timeoutMs }),
      // Do not pass inherited Git overrides that could redirect artifact work.
      env: Object.fromEntries(
        Object.entries(this.options.environment ?? process.env).filter(
          ([key]) => !key.startsWith("GIT_"),
        ),
      ),
    });
    this.options.observe?.({
      startedAt,
      completedAt: new Date().toISOString(),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
    });
    if (result.error)
      throw new OperationalFailure({
        code: "PROCESS_LAUNCH_FAILED",
        message: result.error.message,
      });
    if (result.status !== 0)
      throw new OperationalFailure({
        code: "PROCESS_EXIT_FAILED",
        message: `Process exited with status ${result.status}, signal ${result.signal}: ${result.stderr}`,
      });
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new OperationalFailure({
        code: "INVALID_EXECUTOR_JSON",
        message: "Process stdout must contain one JSON response",
      });
    }
  }
}
