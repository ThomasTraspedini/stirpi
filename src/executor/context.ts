import { dna, type State, type WorkUnit } from "../domain/index.js";
import type { ExecutorContext } from "./index.js";
import type { VerificationEvidence } from "../verification/index.js";

// Explicitly project local state; never serialize the full run or genealogy.
export function executorContext(
  state: State,
  work: WorkUnit,
  artifacts: boolean,
  protocol: boolean,
  verification?: { available: string[]; latest: VerificationEvidence[] },
): ExecutorContext {
  return structuredClone({
    ...(protocol
      ? { identity: { taskId: state.taskId, runId: state.runId } }
      : {}),
    work,
    dna: dna(state, work.lineageId),
    publicEvaluation: state.scenario.publicEvaluation,
    ...(protocol && verification
      ? { verification: structuredClone(verification) }
      : {}),
    results: state.work
      .filter((c) => c.parentId === work.id)
      .map((c) => ({
        name: c.name,
        status: c.status,
        result: c.result,
        reason: c.reason,
        ...(artifacts
          ? {
              artifacts: c.artifacts,
              ...(c.artifact
                ? {
                    artifact: protocol
                      ? { ref: c.artifact.ref, base: c.artifact.base }
                      : c.artifact,
                  }
                : {}),
            }
          : {}),
      })),
  });
}
