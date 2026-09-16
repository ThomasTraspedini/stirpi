import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type {
  ArtifactBackend,
  ArtifactRequest,
  ArtifactOutcome,
} from "../artifacts/index.js";
import { GitWorkspaceBackend } from "../artifacts/workspaces.js";
import { gitAt, initRepository, transfer, verifyStart } from "./inputs.js";

// A separate object database per assignment prevents ordinary Git inspection of
// sibling refs/objects. Existing M2 owns workspace/commit/lifecycle operations.
export class ExperimentArtifacts implements ArtifactBackend {
  private readonly assignments = new Map<
    string,
    { repo: string; backend: GitWorkspaceBackend }
  >();
  constructor(
    private readonly archive: string,
    private readonly worlds: string,
    private readonly sourceCommit: string,
    private readonly gitExecutable = "git",
  ) {
    mkdirSync(worlds);
  }
  perform(request: ArtifactRequest): ArtifactOutcome {
    let performed: ArtifactOutcome | undefined;
    try {
      if (request.type === "INITIALIZE") {
        verifyStart(this.archive, this.sourceCommit, this.gitExecutable);
        return {
          ok: true,
          artifact: { ref: this.sourceCommit, base: this.sourceCommit },
        };
      }
      if (request.type === "EXECUTE")
        throw new Error("Experiment requires M2 executor");
      const key = request.workId;
      let assignment = this.assignments.get(key);
      if (request.type === "OPEN") {
        if (assignment) throw new Error("Workspace already assigned");
        const repo = join(this.worlds, randomUUID());
        initRepository(repo, this.gitExecutable);
        transfer(this.archive, repo, request.base, this.gitExecutable);
        gitAt(this.gitExecutable, repo, "checkout", "--detach", request.base);
        verifyStart(repo, request.base, this.gitExecutable);
        const backend = new GitWorkspaceBackend(repo, this.gitExecutable);
        const initialized = backend.perform({
          type: "INITIALIZE",
          taskId: request.taskId,
          runId: request.runId,
        });
        if (!initialized.ok) return initialized;
        assignment = { repo, backend };
        this.assignments.set(key, assignment);
      }
      if (!assignment) throw new Error("No assigned workspace");
      const outcome = assignment.backend.perform(request);
      performed = outcome;
      if (
        outcome.ok &&
        (request.type === "COMMIT" || request.type === "RELEASE")
      ) {
        transfer(
          assignment.repo,
          this.archive,
          outcome.artifact.ref,
          this.gitExecutable,
        );
        gitAt(
          this.gitExecutable,
          this.archive,
          "update-ref",
          `refs/heads/artifact-${key}`,
          outcome.artifact.ref,
        );
      }
      return outcome;
    } catch (error) {
      return {
        ...(performed?.artifact ? { artifact: performed.artifact } : {}),
        ok: false,
        reason: {
          code: `ARTIFACT_${request.type}_FAILED`,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
