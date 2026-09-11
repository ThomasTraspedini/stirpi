import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { assertExternalGitState } from "../artifacts/git.js";

export const sha256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export interface Manifest {
  id: string;
  sourceRepository: string;
  sourceCommit: string;
  taskFile: string;
  taskSha256: string;
}
export function frozenInput(path: string) {
  const manifest: Manifest = JSON.parse(readFileSync(path, "utf8"));
  if (
    !manifest.id ||
    !/^[\w.-]+\/[\w.-]+$/.test(manifest.sourceRepository) ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
    !/^[a-f0-9]{64}$/.test(manifest.taskSha256) ||
    typeof manifest.taskFile !== "string"
  )
    throw new Error("Invalid frozen manifest");
  const taskPath = resolve(dirname(path), manifest.taskFile);
  const rel = relative(resolve(dirname(path)), taskPath);
  if (rel.startsWith("../") || isAbsolute(rel))
    throw new Error("Task must be inside public testcase directory");
  const bytes = readFileSync(taskPath);
  if (sha256(bytes) !== manifest.taskSha256)
    throw new Error("Task SHA-256 mismatch");
  const task = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  if (!Buffer.from(task).equals(bytes))
    throw new Error("Task must round-trip as UTF-8 unchanged");
  return { manifest, bytes, task };
}
export const gitEnvironment = () => ({
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
});
export function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["--no-replace-objects", "-C", repo, ...args], {
    encoding: "utf8",
    env: gitEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}
export function initRepository(repo: string) {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--template=", "-b", "main");
  git(repo, "config", "user.name", "Stirpi experiment");
  git(repo, "config", "user.email", "experiment@example.invalid");
  git(repo, "config", "core.hooksPath", "/dev/null");
}
// Transfer only the specified commit's reachable closure. No clone, refs, reflogs,
// alternates, hardlinks, source config, or unrelated/dangling objects are copied.
export function transfer(source: string, destination: string, commit: string) {
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    git(source, "rev-parse", "--verify", `${commit}^{commit}`) !== commit
  )
    throw new Error("Source commit mismatch or unavailable");
  if (git(source, "rev-parse", "--is-shallow-repository") !== "false")
    throw new Error("Source must contain complete ancestry of frozen commit");
  const pack = execFileSync(
    "git",
    [
      "--no-replace-objects",
      "-C",
      source,
      "pack-objects",
      "--revs",
      "--stdout",
      "--no-reuse-delta",
    ],
    {
      input: `${commit}\n`,
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  execFileSync("git", ["-C", destination, "index-pack", "--stdin"], {
    input: pack,
    env: gitEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}
function repositoryIdentity(url: string) {
  return url
    .replace(/^https:\/\/github.com\//, "")
    .replace(/^git@github.com:/, "")
    .replace(/^ssh:\/\/git@github.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}
export function prepareSource(
  source: string,
  output: string,
  manifest: Manifest,
) {
  let origin: string;
  let sourcePath: string;
  if (existsSync(source)) {
    sourcePath = resolve(source);
    assertExternalGitState(sourcePath, [output]);
    origin = git(sourcePath, "remote", "get-url", "origin");
  } else {
    origin = source;
    sourcePath = join(output, "acquisition");
  }
  if (repositoryIdentity(origin) !== manifest.sourceRepository)
    throw new Error("Source repository identity mismatch");
  if (!existsSync(source)) {
    initRepository(sourcePath);
    git(
      sourcePath,
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      origin,
      manifest.sourceCommit,
    );
  }
  const repo = join(output, "artifacts");
  initRepository(repo);
  transfer(sourcePath, repo, manifest.sourceCommit);
  git(repo, "checkout", "--detach", manifest.sourceCommit);
  verifyStart(repo, manifest.sourceCommit);
  return repo;
}
export function verifyStart(repo: string, commit: string) {
  if (git(repo, "rev-parse", "HEAD") !== commit)
    throw new Error("Source commit mismatch");
  if (git(repo, "status", "--porcelain", "--untracked-files=all"))
    throw new Error("Run workspace is dirty");
  if (
    git(repo, "remote") ||
    existsSync(join(repo, ".git", "objects", "info", "alternates"))
  )
    throw new Error("Workspace must not link to source history");
}
