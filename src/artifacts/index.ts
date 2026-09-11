import type { Reason, RunIdentity } from "../domain/index.js";

// Canonical identity is opaque to the engine; location is operational metadata.
export interface Artifact {
  ref: string;
  base: string;
  branch?: string;
  worktree?: string;
  cleaned?: boolean;
}
export type WorkspaceRequest = {
  type: "OPEN" | "CHECK" | "RELEASE" | "COMMIT";
  taskId: string;
  runId: string;
  lineageId: string;
  workId: string;
  base: string;
  message?: string;
};
export type ArtifactRequest =
  | WorkspaceRequest
  | ({ type: "INITIALIZE" } & RunIdentity)
  | ({
      type: "EXECUTE";
      lineageId: string;
      workId: string;
      name: string;
      base: string;
    } & RunIdentity);
export type ArtifactOutcome =
  | { ok: true; artifact: Artifact }
  | { ok: false; reason: Reason; artifact?: Artifact };
export interface ArtifactOperation {
  request: ArtifactRequest;
  outcome: ArtifactOutcome;
}
export interface ArtifactBackend {
  perform(request: ArtifactRequest): ArtifactOutcome;
}
