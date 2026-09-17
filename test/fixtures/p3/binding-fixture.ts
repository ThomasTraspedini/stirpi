import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import {
  git,
  initRepository,
  sha256,
} from "../../../src/experiments/inputs.js";
import { executablePath } from "../../../src/experiments/executor-identity.js";
import { localTreeSha256 } from "../../../src/experiments/trusted-local-identity.js";
import type { TrustedLocalContract } from "../../../src/experiments/trusted-local-contract.js";
import type { RunOptions } from "../../../src/experiments/run.js";

export function bindingFixture(build = false) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "stirpi-p3-binding-")),
  );
  const runtime = join(directory, "runtime"),
    source = join(directory, "source"),
    toolRoot = join(directory, "tools");
  initRepository(runtime);
  initRepository(source);
  mkdirSync(toolRoot);
  const pkg = JSON.stringify({
    name: "fixture",
    version: "1",
    scripts: { test: "node --test", typecheck: "tsc --noEmit" },
    dependencies: { pg: "fixture" },
  });
  const lock = JSON.stringify({
    name: "fixture",
    lockfileVersion: 3,
    packages: {},
  });
  writeFileSync(join(source, ".gitignore"), "node_modules/\n");
  writeFileSync(join(source, "package.json"), pkg);
  writeFileSync(join(source, "package-lock.json"), lock);
  git(source, "remote", "add", "origin", "https://github.com/fixture/p3.git");
  git(source, "add", ".");
  git(source, "commit", "-m", "Fixture baseline");
  const baseline = git(source, "rev-parse", "HEAD");
  for (const path of ["adapters/codex"])
    cpSync(resolve(path), join(runtime, path), { recursive: true });
  if (build) {
    cpSync(resolve("src"), join(runtime, "src"), { recursive: true });
    for (const file of ["tsconfig.json", "package.json"])
      cpSync(resolve(file), join(runtime, file));
  }
  const require = createRequire(import.meta.url);
  const tools = {
    node: realpathSync(process.execPath),
    npmRoot: join(toolRoot, "npm"),
    compilerRoot: build
      ? dirname(require.resolve("typescript/package.json"))
      : join(toolRoot, "compiler"),
    typeRoots: build
      ? dirname(dirname(require.resolve("@types/node/package.json")))
      : join(toolRoot, "types"),
    git: realpathSync(executablePath("git")),
    docker: join(toolRoot, "docker"),
    shell: "/bin/sh",
  };
  mkdirSync(join(tools.npmRoot, "bin"), { recursive: true });
  cpSync(
    resolve("test/fixtures/p3/preparation-npm.mjs"),
    join(tools.npmRoot, "bin/npm-cli.js"),
  );
  cpSync(resolve("test/fixtures/p3/preparation-docker.mjs"), tools.docker);
  chmodSync(tools.docker, 0o755);
  chmodSync(join(tools.npmRoot, "bin/npm-cli.js"), 0o755);
  if (!build)
    for (const path of [tools.compilerRoot, tools.typeRoots]) {
      mkdirSync(path);
      writeFileSync(join(path, "fixture"), "fixture");
    }
  const codex = join(toolRoot, "codex");
  cpSync(resolve("test/fixtures/p3/governance-codex.mjs"), codex);
  chmodSync(codex, 0o755);
  const contract: TrustedLocalContract = JSON.parse(
    readFileSync(
      resolve("docs/experiments/p1-hst/trusted-local-contract.json"),
      "utf8",
    ),
  );
  contract.status = "frozen";
  contract.testcase = "fixture";
  contract.source = { repository: "fixture/p3", commit: baseline };
  contract.baseline = {
    scope: "baseline-only",
    packageSha256: sha256(pkg),
    lockfileSha256: sha256(lock),
  };
  contract.toolchain = {
    platform: process.platform,
    architecture: process.arch,
    node: {
      version: process.version,
      sha256: sha256(readFileSync(tools.node)),
    },
    npm: { version: "fixture-npm", treeSha256: localTreeSha256(tools.npmRoot) },
    compiler: { treeSha256: localTreeSha256(tools.compilerRoot) },
    typeRoots: { treeSha256: localTreeSha256(tools.typeRoots) },
    git: { sha256: sha256(readFileSync(tools.git)) },
    docker: { sha256: sha256(readFileSync(tools.docker)) },
    shell: {
      locator: "/bin/sh",
      sha256: sha256(readFileSync(tools.shell)),
    },
  };
  contract.preparation.postgres.imageId = "sha256:" + "1".repeat(64);
  contract.preparation.postgres.platform = "linux/arm64";
  contract.executor.executableVersion = "fixture";
  contract.executor.executableSha256 = sha256(readFileSync(codex));
  const evaluator = JSON.parse(
    readFileSync(
      resolve("docs/experiments/d032/public-evaluator-v2.json"),
      "utf8",
    ),
  );
  const inputRoot = join(runtime, "input");
  mkdirSync(inputRoot);
  const task = "unchanged task\r\nfixture\n";
  const manifest = {
    id: "fixture",
    sourceRepository: contract.source.repository,
    sourceCommit: baseline,
    taskFile: "task.txt",
    taskSha256: sha256(task),
  };
  const inputData = {
    manifest: JSON.stringify(manifest),
    task,
    evaluator: JSON.stringify(evaluator),
    governance: readFileSync(
      resolve("docs/experiments/p1-hst/solver-governance.txt"),
      "utf8",
    ),
  };
  for (const [name, bytes] of Object.entries(inputData)) {
    const path = `input/${name === "manifest" || name === "evaluator" ? name + ".json" : name + ".txt"}`;
    writeFileSync(join(runtime, path), bytes);
    contract.inputs[name as keyof typeof contract.inputs] = {
      path,
      sha256: sha256(bytes),
    };
  }
  const contractPath = "docs/experiments/p1-hst/trusted-local-contract.json";
  mkdirSync(dirname(join(runtime, contractPath)), { recursive: true });
  const contractBytes = JSON.stringify(contract);
  writeFileSync(join(runtime, contractPath), contractBytes);
  git(runtime, "add", ".");
  git(runtime, "commit", "-m", "Fixture authority R");
  const pin = git(runtime, "rev-parse", "HEAD");
  const pilot = {
    schemaVersion: 3,
    id: "fixture-pilot",
    class: "pilot",
    testcase: "fixture",
    condition: "T",
    stirpiCommit: pin,
    trustedLocalContract: {
      id: contract.id,
      version: 1,
      path: contractPath,
      sha256: sha256(contractBytes),
    },
    hiddenEvaluationDuringRun: false,
  };
  const preregistration = join(directory, "pilot.json");
  writeFileSync(preregistration, JSON.stringify(pilot));
  const options = (condition: "H" | "S" | "T" = "T"): RunOptions => {
    writeFileSync(preregistration, JSON.stringify({ ...pilot, condition }));
    return {
      verificationMode: "trusted-local",
      preregistration,
      manifest: join(runtime, contract.inputs.manifest.path),
      condition,
      source,
      output: join(directory, "output"),
      executor: {
        executable: tools.node,
        args: [
          join(runtime, contract.executor.adapterPath),
          "--codex",
          codex,
          "--model",
          "gpt-6-astra",
          "--effort",
          "medium",
          "--timeout-ms",
          "900000",
        ],
      },
      publicEvaluator: structuredClone(evaluator),
      trustedLocalTools: structuredClone(tools),
    };
  };
  return {
    directory,
    runtime,
    source,
    tools,
    contract,
    contractBytes,
    pilot,
    preregistration,
    pin,
    task,
    options,
    close() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
