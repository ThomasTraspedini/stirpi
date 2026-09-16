import { verifyObservations } from "../operational/index.js";
import { isDeepStrictEqual } from "node:util";
import type { State } from "../domain/index.js";
import {
  OperationalFailure,
  type ExecutorOperation,
} from "../executor/protocol.js";
import { simulate } from "../engine/index.js";
import type { EvaluationOperation } from "../evaluation/index.js";
import type {
  VerificationExecutor,
  VerificationOperation,
} from "../verification/index.js";
export function replay(original: State): State {
  const supervision = original.events
    .filter((e) => e.type === "SUPERVISION")
    .map(
      (e) =>
        e.data as import("../supervision/run.js").RunSupervisionObservation,
    );
  let supervisionCursor = 0;
  let cursor = 0;
  let invocation = 0;
  let evaluationCursor = 0;
  let verificationCursor = 0;
  const operations = original.events
    .filter((e) => e.type === "EXECUTOR_OPERATION")
    .map((e) => e.data as ExecutorOperation);
  const verifications = original.events
    .filter((e) => e.type === "VERIFICATION_OPERATION")
    .map((e) => e.data as VerificationOperation);
  const advertised = operations
    .map((operation) => operation.context.verification?.available)
    .find((available) => available !== undefined);
  if (
    advertised &&
    operations.some(
      (operation) =>
        !isDeepStrictEqual(
          operation.context.verification?.available,
          advertised,
        ),
    )
  )
    throw new Error("Replay verification availability mismatch");
  const verifier: VerificationExecutor | undefined = advertised
    ? {
        available() {
          return structuredClone(advertised);
        },
        perform(id, workId) {
          const operation = verifications[verificationCursor++];
          if (
            !operation ||
            operation.request.id !== id ||
            operation.request.workId !== workId
          )
            throw new Error(
              "Replay mismatch: verification request differs or outcome missing",
            );
          if (!/^[a-f0-9]{64}$/.test(operation.request.workspaceDigest))
            throw new Error(
              "Replay mismatch: verification workspace digest is invalid",
            );
          return structuredClone(operation);
        },
      }
    : undefined;
  const evaluations = original.events
    .filter((e) => e.type === "EVALUATION_OPERATION")
    .map((e) => e.data as EvaluationOperation);
  const executor = (
    original.events[0]?.data as { executor?: { protocol: 1; id: string } }
  ).executor;
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
          execute(context, observe, supervise) {
            const operation = operations[invocation++];
            if (!operation || !isDeepStrictEqual(operation.context, context))
              throw new Error(
                "Replay mismatch: executor context or outcome missing",
              );
            for (const record of operation.supervision ?? [])
              supervise?.(structuredClone(record));
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
    (input) => {
      const recorded = supervision[supervisionCursor++];
      if (!recorded) throw new Error("Replay supervision outcome missing");
      if (!isDeepStrictEqual({ ...input, stop: recorded.stop }, recorded))
        throw new Error("Replay supervision context mismatch");
      return structuredClone(recorded);
    },
    verifier,
  );
  if (
    supervisionCursor !== supervision.length ||
    evaluationCursor !== evaluations.length ||
    invocation !== operations.length ||
    cursor !== (original.artifactOperations?.length ?? 0) ||
    verificationCursor !== verifications.length ||
    !isDeepStrictEqual(original, replayed)
  )
    throw new Error(
      "Replay mismatch: persisted state or event sequence differs",
    );
  return replayed;
}
