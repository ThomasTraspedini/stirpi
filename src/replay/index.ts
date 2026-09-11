import { isDeepStrictEqual } from "node:util";
import type { State } from "../domain/index.js";
import { simulate } from "../engine/index.js";
export function replay(original: State): State {
  let cursor = 0;
  const replayed = simulate(
    original.scenario,
    original.config,
    undefined,
    undefined,
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
    cursor !== (original.artifactOperations?.length ?? 0) ||
    !isDeepStrictEqual(original, replayed)
  )
    throw new Error(
      "Replay mismatch: persisted state or event sequence differs",
    );
  return replayed;
}
