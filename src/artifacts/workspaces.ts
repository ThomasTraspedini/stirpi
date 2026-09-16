import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Artifact,
  ArtifactBackend,
  ArtifactOutcome,
  ArtifactRequest,
} from "./index.js";
import { GitArtifactBackend, assertExternalGitState } from "./git.js";

function git(executable: string, path: string, ...args: string[]): string {
  const identityArgs = executable === "git" ? [] : ["--no-replace-objects"];
  return execFileSync(executable, [...identityArgs, "-C", path, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    ),
  }).trim();
}
// Assignments are held by the artifact layer; requests never select a path.
export class GitWorkspaceBackend implements ArtifactBackend {
  private ready = false;
  private readonly assignments = new Map<string, Artifact>();
  constructor(
    private readonly repository: string,
    private readonly gitExecutable = "git",
  ) {}
  perform(request: ArtifactRequest): ArtifactOutcome {
    if (request.type === "INITIALIZE") {
      const result = new GitArtifactBackend(
        this.repository,
        undefined,
        this.gitExecutable,
      ).perform(request);
      this.ready = result.ok;
      return result;
    }
    let artifact: Artifact | undefined;
    try {
      if (!this.ready) throw new Error("Repository must be initialized");
      if (request.type === "EXECUTE")
        throw new Error("Persistent backend requires workspace operations");
      const key = JSON.stringify([
        request.taskId,
        request.runId,
        request.lineageId,
        request.workId,
      ]);
      artifact = this.assignments.get(key);
      if (request.type === "OPEN") {
        if (artifact) throw new Error("Workspace already assigned");
        if (
          !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.base) ||
          git(
            this.gitExecutable,
            this.repository,
            "rev-parse",
            "--verify",
            `${request.base}^{commit}`,
          ) !== request.base
        )
          throw new Error("Base must be an immutable commit SHA");
        const temp = realpathSync(tmpdir());
        assertExternalGitState(this.repository, [temp], this.gitExecutable);
        const container = mkdtempSync(join(temp, "stirpi-work-"));
        const worktree = join(container, "checkout");
        const branch = `stirpi/work-${randomUUID()}`;
        try {
          git(
            this.gitExecutable,
            this.repository,
            "worktree",
            "add",
            "-b",
            branch,
            worktree,
            request.base,
          );
        } catch (error) {
          try {
            rmdirSync(container);
          } catch {
            /* Preserve unexpected files. */
          }
          throw error;
        }
        artifact = {
          ref: request.base,
          base: request.base,
          branch,
          worktree,
          cleaned: false,
        };
        this.assignments.set(key, artifact);
      } else {
        if (!artifact?.worktree || artifact.cleaned)
          throw new Error("No active assigned workspace");
        const path = artifact.worktree;
        if (
          request.base !== artifact.ref ||
          git(this.gitExecutable, path, "rev-parse", "HEAD") !== artifact.ref ||
          git(this.gitExecutable, path, "symbolic-ref", "--short", "HEAD") !==
            artifact.branch
        )
          throw new Error("Executor changed managed Git identity");
        if (request.type === "COMMIT") {
          if (!request.message?.trim())
            throw new Error("Commit message must describe the change");
          git(this.gitExecutable, path, "add", "--all");
          if (
            git(this.gitExecutable, path, "write-tree") !==
            git(this.gitExecutable, path, "rev-parse", "HEAD^{tree}")
          )
            git(
              this.gitExecutable,
              path,
              "-c",
              "commit.gpgsign=false",
              "commit",
              "-m",
              request.message,
            );
          artifact.ref = git(
            this.gitExecutable,
            path,
            "rev-parse",
            "--verify",
            "HEAD^{commit}",
          );
        } else if (request.type === "CHECK") {
          if (
            git(
              this.gitExecutable,
              path,
              "status",
              "--porcelain",
              "--untracked-files=all",
            )
          )
            return {
              ok: false,
              reason: {
                code: "DIRTY_WORKSPACE",
                message:
                  "Commit workspace changes explicitly before FORK, SPAWN or COMPLETE",
              },
              artifact: structuredClone(artifact),
            };
        } else if (request.type === "RELEASE") {
          // No force: retain dirty and ignored files for diagnosis.
          if (
            git(
              this.gitExecutable,
              path,
              "status",
              "--porcelain",
              "--untracked-files=all",
              "--ignored",
            )
          )
            return { ok: true, artifact: structuredClone(artifact) };
          git(this.gitExecutable, this.repository, "worktree", "remove", path);
          artifact.cleaned = true;
          try {
            rmdirSync(join(path, ".."));
          } catch {
            /* Preserve unexpected files. */
          }
        }
      }
      return { ok: true, artifact: structuredClone(artifact!) };
    } catch (error) {
      return {
        ok: false,
        reason: {
          code: `ARTIFACT_${request.type}_FAILED`,
          message: error instanceof Error ? error.message : String(error),
        },
        ...(artifact ? { artifact: structuredClone(artifact) } : {}),
      };
    }
  }
}
