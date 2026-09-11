import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  join,
  relative,
  isAbsolute,
  resolve,
  dirname,
  basename,
} from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Artifact,
  ArtifactBackend,
  ArtifactOutcome,
  ArtifactRequest,
} from "./index.js";

function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    ),
  }).trim();
}
export interface GitWorkspace {
  path: string;
  base: string;
  branch: string;
  // Commit only when the staged tree differs; never manufacture empty commits.
  commit(message: string): string;
}
export type GitWork = (
  request: Extract<ArtifactRequest, { type: "EXECUTE" }>,
  workspace: GitWorkspace,
) => void;

// Callbacks are trusted local implementation code, not commands from an executor.
export class GitArtifactBackend implements ArtifactBackend {
  private ready = false;
  constructor(
    private readonly repository: string,
    private readonly work: GitWork = () => {},
  ) {}

  perform(request: ArtifactRequest): ArtifactOutcome {
    if (request.type === "INITIALIZE") {
      this.ready = false;
      try {
        if (
          git(this.repository, "rev-parse", "--is-inside-work-tree") !== "true"
        )
          throw new Error("Target must be a Git working repository");
        if (
          git(this.repository, "status", "--porcelain", "--untracked-files=all")
        )
          return {
            ok: false,
            reason: {
              code: "DIRTY_REPOSITORY",
              message: "Target has tracked or untracked changes",
            },
          };
        const ref = git(
          this.repository,
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        );
        this.ready = true;
        return { ok: true, artifact: { ref, base: ref } };
      } catch (error) {
        return this.failure("INVALID_REPOSITORY", error);
      }
    }
    if (!this.ready)
      return this.failure(
        "ARTIFACT_NOT_INITIALIZED",
        new Error("Repository must be validated before execution"),
      );
    if (request.type !== "EXECUTE")
      return this.failure(
        "UNSUPPORTED_ARTIFACT_OPERATION",
        new Error("Use GitWorkspaceBackend for persistent workspaces"),
      );
    let container: string | undefined;
    let artifact: Artifact | undefined;
    let created = false;
    let outcome: ArtifactOutcome;
    try {
      // Accept only a full immutable commit identity at the effect boundary.
      if (
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.base) ||
        git(
          this.repository,
          "rev-parse",
          "--verify",
          `${request.base}^{commit}`,
        ) !== request.base
      )
        throw new Error("Base must be a full commit identity");
      const root = realpathSync(
        git(this.repository, "rev-parse", "--show-toplevel"),
      );
      const tempRoot = realpathSync(tmpdir());
      const rel = relative(root, tempRoot);
      if (!rel || (!rel.startsWith("..") && !isAbsolute(rel)))
        throw new Error(
          "Temporary worktrees must be outside the target repository",
        );
      container = mkdtempSync(join(tempRoot, "stirpi-work-"));
      const path = join(container, "checkout");
      const branch = `stirpi/work-${randomUUID()}`;
      artifact = {
        ref: request.base,
        base: request.base,
        branch,
        worktree: path,
        cleaned: false,
      };
      git(this.repository, "worktree", "add", "-b", branch, path, request.base);
      created = true;
      this.work(request, {
        path,
        base: request.base,
        branch,
        commit(message) {
          if (!message.trim())
            throw new Error("Commit message must describe the change");
          git(path, "add", "--all");
          const tree = git(path, "write-tree");
          if (tree !== git(path, "rev-parse", "HEAD^{tree}"))
            git(path, "-c", "commit.gpgsign=false", "commit", "-m", message);
          return git(path, "rev-parse", "HEAD");
        },
      });
      artifact.ref = git(path, "rev-parse", "--verify", "HEAD^{commit}");
      if (git(path, "status", "--porcelain", "--untracked-files=all"))
        throw new Error(
          "Work left uncommitted changes; worktree retained for inspection",
        );
      outcome = { ok: true, artifact };
    } catch (error) {
      outcome = {
        ...this.failure("ARTIFACT_EXECUTION_FAILED", error),
        ...(artifact ? { artifact } : {}),
      };
    }
    if (created && artifact) {
      try {
        artifact.ref = git(
          artifact.worktree!,
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        );
        // No force: Git refuses removal if work would be lost (including ignored files).
        git(this.repository, "worktree", "remove", artifact.worktree!);
        artifact.cleaned = true;
      } catch (error) {
        if (outcome.ok)
          outcome = {
            ...this.failure("ARTIFACT_CLEANUP_FAILED", error),
            artifact,
          };
      }
    }
    if (container && (!created || artifact?.cleaned)) {
      try {
        rmdirSync(container);
      } catch {
        /* An unexpected file is retained, never recursively deleted. */
      }
    }
    return outcome;
  }
  private failure(
    code: string,
    error: unknown,
  ): { ok: false; reason: { code: string; message: string } } {
    return {
      ok: false,
      reason: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// Resolve existing symlink ancestors before checking state/output locations.
export function assertExternalGitState(
  repository: string,
  paths: string[],
): void {
  const root = realpathSync(git(repository, "rev-parse", "--show-toplevel"));
  for (const path of paths) {
    let ancestor = resolve(path);
    const suffix: string[] = [];
    while (!existsSync(ancestor)) {
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
    const target = join(realpathSync(ancestor), ...suffix);
    const rel = relative(root, target);
    if (!rel || (!rel.startsWith("../") && !isAbsolute(rel)))
      throw new Error(
        "Stirpi database and exports must be outside the target repository",
      );
  }
}
