import type { ArtifactBackend, ArtifactRequest } from "../artifacts/index.js";
import type { State, WorkUnit } from "../domain/index.js";
import { OperationalFailure } from "../executor/protocol.js";

export function artifactEffects(
  state: State,
  artifactBackend: ArtifactBackend | undefined,
  emit: (type: string, subject: string, data: unknown) => void,
) {
  const effect = (request: ArtifactRequest) => {
    const outcome = artifactBackend!.perform(structuredClone(request));
    const operation = structuredClone({ request, outcome });
    (state.artifactOperations ??= []).push(operation);
    emit(
      "ARTIFACT_OPERATION",
      request.type === "INITIALIZE" ? state.runId : request.workId,
      operation,
    );
    return outcome;
  };
  const updateArtifact = (
    w: WorkUnit,
    outcome: import("../artifacts/index.js").ArtifactOutcome,
  ) => {
    if (outcome.artifact) {
      w.artifact = structuredClone(outcome.artifact);
      w.artifacts = [w.artifact.ref];
      if (w.parentId === null)
        state.lineages.find((l) => l.id === w.lineageId)!.artifact =
          structuredClone(w.artifact);
    }
    if (!outcome.ok) throw new OperationalFailure(outcome.reason);
  };
  const workspaceEffect = (
    w: WorkUnit,
    type: "OPEN" | "COMMIT" | "CHECK" | "RELEASE",
    message?: string,
  ) => {
    if (!artifactBackend || !w.artifact)
      throw new OperationalFailure({
        code: "WORKSPACE_REQUIRED",
        message: "Artifact effect requires an assigned workspace",
      });
    updateArtifact(
      w,
      effect({
        type,
        taskId: state.taskId,
        runId: state.runId,
        lineageId: w.lineageId,
        workId: w.id,
        base: w.artifact.ref,
        ...(message === undefined ? {} : { message }),
      }),
    );
  };
  return { effect, workspaceEffect };
}
