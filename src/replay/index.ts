import { verifyObservations } from "../operational/index.js";
import { isDeepStrictEqual } from "node:util";
import type { State } from "../domain/index.js";
import {
  OperationalFailure,
  type ExecutorOperation,
} from "../executor/protocol.js";
import { simulate } from "../engine/index.js";
import type { EvaluationOperation } from "../evaluation/index.js";
export function replay(original: State): State {
  let cursor = 0;
  let invocation = 0;
  let evaluationCursor = 0;
  const evaluations = original.events
    .filter((e) => e.type === "EVALUATION_OPERATION")
    .map((e) => e.data as EvaluationOperation);
  const executor = (
    original.events[0]?.data as { executor?: { protocol: 1; id: string } }
  ).executor;
  const operations = original.events
    .filter((e) => e.type === "EXECUTOR_OPERATION")
    .map((e) => e.data as ExecutorOperation);
  const replayed = simulate(
    original.scenario,
    original.config,
    executor
      ? {
          protocol: executor.protocol,
          get id() {
            return invocation === 0
              ? executor.id
              : (operations[invocation - 1]?.executorId ?? executor.id);
          },
          execute(context, observe) {
            const operation = operations[invocation++];
            if (!operation || !isDeepStrictEqual(operation.context, context))
              throw new Error(
                "Replay mismatch: executor context or outcome missing",
              );
            if (operation.observations) {
              if (
                !isDeepStrictEqual(
                  verifyObservations(operation.observations),
                  operation.observations,
                )
              )
                throw new Error("Replay operational sequence mismatch");
              for (const event of operation.observations)
                observe?.(structuredClone(event));
            }
            if (!operation.outcome.ok)
              throw new OperationalFailure(
                structuredClone(operation.outcome.reason),
              );
            return structuredClone(operation.outcome.response);
          },
        }
      : undefined,
    {
      evaluate(context) {
        const operation = evaluations[evaluationCursor++];
        if (!operation || !isDeepStrictEqual(operation.context, context))
          throw new Error("Replay evaluation context mismatch");
        if (!operation.outcome.ok)
          throw new OperationalFailure(
            structuredClone(operation.outcome.reason),
          );
        return structuredClone(operation.outcome.evaluation);
      },
    },
    {
      taskId: original.taskId,
      runId: original.runId,
    },
    original.artifactOperations
      ? {
          perform(request) {
            const operation = original.artifactOperations![cursor++];
            if (!operation || !isDeepStrictEqual(operation.request, request))
              throw new Error(
                "Replay mismatch: artifact request differs or outcome missing",
              );
            return structuredClone(operation.outcome);
          },
        }
      : undefined,
  );
  if (
    evaluationCursor !== evaluations.length ||
    invocation !== operations.length ||
    cursor !== (original.artifactOperations?.length ?? 0) ||
    !isDeepStrictEqual(original, replayed)
  )
    throw new Error(
      "Replay mismatch: persisted state or event sequence differs",
    );
  return replayed;
}
