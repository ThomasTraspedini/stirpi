import { isDeepStrictEqual } from "node:util";
import type { State } from "../domain/index.js";
import { simulate } from "../engine/index.js";
export function replay(original: State): State {
  const replayed = simulate(
    original.scenario,
    original.config,
    undefined,
    undefined,
    {
      taskId: original.taskId,
      runId: original.runId,
    },
  );
  if (!isDeepStrictEqual(original, replayed))
    throw new Error(
      "Replay mismatch: persisted state or event sequence differs",
    );
  return replayed;
}
