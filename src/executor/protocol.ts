import {
  validateAction,
  type ExecutorContext,
  type Executor,
} from "./index.js";
import type { Action, Reason } from "../domain/index.js";

export class OperationalFailure extends Error {
  constructor(readonly reason: Reason) {
    super(reason.message);
  }
}
export interface ExecutorResponse {
  version: 1;
  action: Action;
  effects: { type: "COMMIT"; message: string }[];
  text?: string;
}
export interface ExecutorOperation {
  executorId: string;
  context: ExecutorContext;
  outcome: { ok: true; response: unknown } | { ok: false; reason: Reason };
}
export function invoke(
  executor: Executor,
  context: ExecutorContext,
): ExecutorOperation {
  let outcome: ExecutorOperation["outcome"];
  try {
    outcome = {
      ok: true,
      response: executor.execute(structuredClone(context)),
    };
  } catch (error) {
    outcome = {
      ok: false,
      reason:
        error instanceof OperationalFailure
          ? error.reason
          : {
              code: "EXECUTOR_FAILED",
              message: error instanceof Error ? error.message : String(error),
            },
    };
  }
  return structuredClone({
    executorId: executor.id ?? "external",
    context,
    outcome,
  });
}
export function validateResponse(value: unknown): ExecutorResponse {
  const fail = (message: string): never => {
    throw new OperationalFailure({
      code: "INVALID_EXECUTOR_RESPONSE",
      message,
    });
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("Response must be an object");
  const v = value as Record<string, unknown>;
  if (v.version !== 1)
    throw new OperationalFailure({
      code: "UNSUPPORTED_PROTOCOL_VERSION",
      message: "Expected protocol version 1",
    });
  if (
    Object.keys(v).some(
      (k) => !["version", "action", "effects", "text"].includes(k),
    )
  )
    return fail("Unknown response field");
  const action = validateAction(v.action);
  const fields: Record<Action["type"], string[]> = {
    CONTINUE: ["type"],
    FORK: ["type", "alternatives"],
    SPAWN: ["type", "work"],
    COMPLETE: ["type", "result"],
    BLOCK: ["type", "reason"],
  };
  if (Object.keys(action).some((k) => !fields[action.type].includes(k)))
    return fail("Unknown or executor-owned artifact field in action");
  if (action.type === "COMPLETE" && action.artifacts !== undefined)
    return fail("Canonical artifacts are assigned by Stirpi");
  if (
    !Array.isArray(v.effects) ||
    !v.effects.every(
      (e) =>
        e &&
        typeof e === "object" &&
        !Array.isArray(e) &&
        e.type === "COMMIT" &&
        typeof e.message === "string" &&
        e.message.trim() &&
        Object.keys(e).every((k) => ["type", "message"].includes(k)),
    )
  )
    return fail("effects must contain only COMMIT requests with messages");
  if (v.text !== undefined && typeof v.text !== "string")
    return fail("text must be a string");
  return structuredClone(value) as ExecutorResponse;
}
