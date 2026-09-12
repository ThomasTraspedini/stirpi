import type { OperationalObserver } from "../operational/index.js";
import type { Artifact } from "../artifacts/index.js";
import type {
  Action,
  PublicCriteria,
  Reason,
  WorkUnit,
  WorkUnitStatus,
} from "../domain/index.js";
export interface ExecutorContext {
  identity?: { taskId: string; runId: string };
  work: Readonly<WorkUnit>;
  dna: readonly string[];
  publicEvaluation: PublicCriteria;
  results: {
    artifacts?: string[];
    artifact?: Artifact;
    name: string;
    status: WorkUnitStatus;
    result: string | null;
    reason: Reason | null;
  }[];
}
export interface Executor {
  readonly protocol?: 1;
  readonly asynchronous?: boolean;
  readonly id?: string;
  execute(context: ExecutorContext, observe?: OperationalObserver): unknown;
}
export class ScriptedExecutor implements Executor {
  constructor(private readonly scripts: Record<string, unknown[]>) {}
  execute({ work }: ExecutorContext): unknown {
    return this.scripts[work.name]?.[work.cursor];
  }
}
const object = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const text = (x: unknown): x is string =>
  typeof x === "string" && x.trim().length > 0;
const priority = (x: unknown) => x === undefined || Number.isSafeInteger(x);
export function validateAction(value: unknown): Action {
  if (!object(value)) throw new Error("Action must be an object");
  switch (value.type) {
    case "CONTINUE":
      break;
    case "BLOCK":
      if (
        !object(value.reason) ||
        !text(value.reason.code) ||
        !text(value.reason.message)
      )
        throw new Error("BLOCK requires a structured reason");
      break;
    case "COMPLETE":
      if (
        typeof value.result !== "string" ||
        (value.artifacts !== undefined &&
          (!Array.isArray(value.artifacts) || !value.artifacts.every(text)))
      )
        throw new Error("Invalid completion");
      break;
    case "FORK":
      if (
        !Array.isArray(value.alternatives) ||
        value.alternatives.length < 2 ||
        !value.alternatives.every(
          (a) =>
            object(a) &&
            text(a.name) &&
            text(a.assumption) &&
            text(a.rationale) &&
            priority(a.priority) &&
            (a.objective === undefined || text(a.objective)) &&
            !("confidence" in a),
        )
      )
        throw new Error(
          "FORK requires at least two alternatives with one assumption each",
        );
      break;
    case "SPAWN":
      if (
        !Array.isArray(value.work) ||
        value.work.length === 0 ||
        !value.work.every(
          (w) =>
            object(w) &&
            text(w.name) &&
            text(w.objective) &&
            priority(w.priority) &&
            !("required" in w),
        )
      )
        throw new Error("Invalid spawned work");
      break;
    default:
      throw new Error("Unknown executor action");
  }
  return value as unknown as Action;
}
