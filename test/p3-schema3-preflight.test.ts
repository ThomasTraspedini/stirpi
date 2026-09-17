import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { CommandCheckProcess } from "../src/evaluation/commands.js";
import { git, sha256 } from "../src/experiments/inputs.js";
import type { TrustedProcess } from "../src/experiments/preparation.js";
import type { TrustedLocalContract } from "../src/experiments/trusted-local-contract.js";
import {
  runSchema3Preflight,
  schema3PreflightCliOptions,
  type Schema3PreflightEvidence,
} from "../scripts/p3/schema3-preflight.mts";
import { localTreeSha256 } from "../src/experiments/trusted-local-identity.js";
import { bindingFixture } from "./fixtures/p3/binding-fixture.js";

type Fixture = ReturnType<typeof bindingFixture>;

function installContract(f: Fixture, contract: TrustedLocalContract) {
  const bytes = JSON.stringify(contract);
  writeFileSync(join(f.runtime, f.pilot.trustedLocalContract.path), bytes);
  git(f.runtime, "add", f.pilot.trustedLocalContract.path);
  if (git(f.runtime, "status", "--porcelain"))
    git(f.runtime, "commit", "-m", "Fixture preflight authority");
  const pilot = {
    ...f.pilot,
    stirpiCommit: git(f.runtime, "rev-parse", "HEAD"),
    trustedLocalContract: {
      ...f.pilot.trustedLocalContract,
      sha256: sha256(bytes),
    },
  };
  writeFileSync(f.preregistration, JSON.stringify(pilot));
  return contract;
}

function processFake(
  contract: TrustedLocalContract,
  calls: { executable: string; args: string[] }[],
  options: { wrongImage?: boolean; cleanupFailure?: boolean } = {},
): TrustedProcess {
  return (executable, args) => {
    calls.push({ executable, args: [...args] });
    assert.equal(
      [executable, ...args].some((value) =>
        /codex|gpt-6-astra|adapter\.mjs|experiment run/i.test(value),
      ),
      false,
      `solver boundary reached: ${executable} ${args.join(" ")}`,
    );
    if (args[0] === "--version") return contract.toolchain.node.version;
    if (args.at(-1) === "--version") return contract.toolchain.npm.version;
    if (args[0] === "image")
      return JSON.stringify([
        options.wrongImage
          ? {
              Id: "sha256:" + "0".repeat(64),
              Os: "linux",
              Architecture: "amd64",
            }
          : {
              Id: contract.preparation.postgres.imageId,
              Os: "linux",
              Architecture: "arm64",
            },
      ]);
    if (args[0] === "run") return "fixture-container";
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Image: contract.preparation.postgres.imageId,
          NetworkSettings: {
            Ports: {
              "5432/tcp": [{ HostPort: "32123", HostIp: "127.0.0.1" }],
            },
          },
        },
      ]);
    if (args[0] === "rm" && options.cleanupFailure)
      throw new Error("fixture cleanup unavailable");
    return "fixture";
  };
}

function checkFake(calls: string[], failedId?: string): CommandCheckProcess {
  return (check) => {
    calls.push(check.id);
    return {
      status: check.id === failedId ? 1 : 0,
      signal: null,
      stdout: check.id,
      stderr: "",
      error: undefined,
    };
  };
}

function execute(
  f: Fixture,
  suffix: string,
  contract: TrustedLocalContract,
  processOptions: { wrongImage?: boolean; cleanupFailure?: boolean } = {},
  failedCheck?: string,
) {
  const processCalls: { executable: string; args: string[] }[] = [];
  const checkCalls: string[] = [];
  const report = runSchema3Preflight(
    {
      runtime: f.runtime,
      pilot: f.preregistration,
      source: f.source,
      output: join(f.directory, `schema3-${suffix}`),
      tools: f.tools,
    },
    {
      trustedProcess: processFake(contract, processCalls, processOptions),
      publicCheckProcess: checkFake(checkCalls, failedCheck),
    },
  );
  return { report, processCalls, checkCalls };
}

function evidence(report: Schema3PreflightEvidence) {
  return JSON.parse(
    readFileSync(
      join(report.output, "schema3-preflight-evidence.json"),
      "utf8",
    ),
  ) as Schema3PreflightEvidence;
}

function externalToolchain(f: Fixture) {
  const root = join(f.directory, "external-toolchain");
  const compilerRoot = join(root, "node_modules", "typescript");
  const typeRoots = join(root, "node_modules", "@types");
  mkdirSync(compilerRoot, { recursive: true });
  mkdirSync(join(typeRoots, "node"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"toolchain"}\n');
  writeFileSync(join(compilerRoot, "package.json"), '{"name":"typescript"}\n');
  writeFileSync(join(compilerRoot, "compiler.js"), "fixture compiler\n");
  writeFileSync(
    join(typeRoots, "node", "package.json"),
    '{"name":"@types/node"}\n',
  );
  writeFileSync(join(typeRoots, "node", "index.d.ts"), "// fixture types\n");
  const npmLocator = join(f.tools.npmRoot, "bin", "npm");
  writeFileSync(npmLocator, "#!/bin/sh\nexit 0\n");
  chmodSync(npmLocator, 0o755);
  return { root, compilerRoot, typeRoots };
}

function checkoutSymlinks(root: string) {
  const found: string[] = [];
  const walk = (directory: string, prefix = "") => {
    for (const name of readdirSync(directory)) {
      if (!prefix && name === ".git") continue;
      const path = join(directory, name);
      const relativePath = join(prefix, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) found.push(relativePath);
      else if (stat.isDirectory()) walk(path, relativePath);
    }
  };
  walk(root);
  return found.sort();
}

test("explicit dependency root resolves from a clean, distinct R checkout without writing into R", async () => {
  const f = bindingFixture(true);
  const previousPath = process.env.PATH;
  try {
    const launcher = join(f.runtime, "scripts", "p3", "schema3-preflight.mts");
    mkdirSync(dirname(launcher), { recursive: true });
    cpSync("scripts/p3/schema3-preflight.mts", launcher);
    git(f.runtime, "add", "scripts/p3/schema3-preflight.mts");
    git(f.runtime, "commit", "-m", "Fixture schema-3 launcher");
    const toolchain = externalToolchain(f);
    process.env.PATH = [
      join(f.tools.npmRoot, "bin"),
      dirname(f.tools.docker),
      previousPath ?? "",
    ].join(delimiter);

    const runtimeIdentityUrl = pathToFileURL(
      join(f.runtime, "src", "experiments", "trusted-local-identity.ts"),
    ).href;
    const runtimeIdentity = (await import(runtimeIdentityUrl)) as {
      defaultLocalTools(root?: string): typeof f.tools;
    };
    const discovered = runtimeIdentity.defaultLocalTools(toolchain.root);
    assert.equal(discovered.compilerRoot, toolchain.compilerRoot);
    assert.equal(discovered.typeRoots, toolchain.typeRoots);
    assert.equal(existsSync(join(f.runtime, "node_modules")), false);
    assert.deepEqual(checkoutSymlinks(f.runtime), []);

    const contract = structuredClone(f.contract);
    contract.toolchain.npm.treeSha256 = localTreeSha256(discovered.npmRoot);
    contract.toolchain.compiler.treeSha256 = localTreeSha256(
      discovered.compilerRoot,
    );
    contract.toolchain.typeRoots.treeSha256 = localTreeSha256(
      discovered.typeRoots,
    );
    installContract(f, contract);
    const cleanBefore = git(f.runtime, "status", "--porcelain");
    const processCalls: { executable: string; args: string[] }[] = [];
    const checkCalls: string[] = [];
    const report = runSchema3Preflight(
      {
        runtime: f.runtime,
        pilot: f.preregistration,
        source: f.source,
        output: join(f.directory, "schema3-explicit-root"),
        toolchainRoot: toolchain.root,
      },
      {
        trustedProcess: processFake(contract, processCalls),
        publicCheckProcess: checkFake(checkCalls),
      },
    );
    assert.equal(report.status, "passed");
    assert.deepEqual(report.tools, discovered);
    assert.equal(report.executorInvocations, 0);
    assert.equal(report.modelInvocations, 0);
    assert.equal(report.lineagesCreated, 0);
    assert.equal(existsSync(join(f.runtime, "node_modules")), false);
    assert.deepEqual(checkoutSymlinks(f.runtime), []);
    assert.equal(git(f.runtime, "status", "--porcelain"), cleanBefore);
    assert.equal(cleanBefore, "");

    writeFileSync(join(toolchain.compilerRoot, "compiler.js"), "drift\n");
    const drift = runSchema3Preflight(
      {
        runtime: f.runtime,
        pilot: f.preregistration,
        source: f.source,
        output: join(f.directory, "schema3-explicit-root-drift"),
        toolchainRoot: toolchain.root,
      },
      {
        trustedProcess: processFake(contract, []),
        publicCheckProcess: checkFake([]),
      },
    );
    assert.equal(drift.status, "failed");
    assert.equal(drift.primaryFailure?.category, "operational");
    assert.equal(drift.primaryFailure?.phase, "toolchain");
    assert.match(drift.primaryFailure!.message, /compiler closure mismatch/);
    assert.equal(drift.transfer, null);
    assert.equal(existsSync(join(f.runtime, "node_modules")), false);
    assert.deepEqual(checkoutSymlinks(f.runtime), []);
    assert.equal(git(f.runtime, "status", "--porcelain"), "");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    f.close();
  }
});

test("toolchain-root CLI and bootstrap discovery failures fail closed", () => {
  assert.throws(
    () =>
      schema3PreflightCliOptions([
        "--runtime",
        "/R",
        "--pilot",
        "/pilot",
        "--source",
        "/source",
        "--output",
        "/output",
      ]),
    /paths are required/,
  );

  const relative = bindingFixture();
  try {
    installContract(relative, structuredClone(relative.contract));
    const output = join(relative.directory, "schema3-relative-root");
    assert.throws(
      () =>
        runSchema3Preflight({
          runtime: relative.runtime,
          pilot: relative.preregistration,
          source: relative.source,
          output,
          toolchainRoot: "relative-toolchain",
        }),
      /toolchain root path must be absolute/,
    );
    assert.equal(existsSync(output), false);
  } finally {
    relative.close();
  }

  for (const scenario of ["missing", "without-dependencies"] as const) {
    const f = bindingFixture();
    try {
      const contract = installContract(f, structuredClone(f.contract));
      const root = join(f.directory, `toolchain-${scenario}`);
      if (scenario === "without-dependencies") {
        mkdirSync(root);
        writeFileSync(join(root, "package.json"), "{}\n");
      }
      const report = runSchema3Preflight(
        {
          runtime: f.runtime,
          pilot: f.preregistration,
          source: f.source,
          output: join(f.directory, `schema3-${scenario}-root`),
          toolchainRoot: root,
        },
        { trustedProcess: processFake(contract, []) },
      );
      assert.equal(report.status, "failed");
      assert.equal(report.primaryFailure?.category, "operational");
      assert.equal(report.primaryFailure?.phase, "bootstrap");
      assert.equal(report.tools, null);
      assert.equal(report.transfer, null);
      assert.equal(report.executorInvocations, 0);
      assert.equal(report.modelInvocations, 0);
      assert.equal(report.lineagesCreated, 0);
      assert.deepEqual(evidence(report), report);
    } finally {
      f.close();
    }
  }
});

test("schema-3 preflight-only verifies R, target transfer, pinned preparation, public checks and zero solver", () => {
  const f = bindingFixture();
  try {
    const contract = installContract(f, {
      ...structuredClone(f.contract),
      status: "unfrozen",
    });
    const { report, processCalls, checkCalls } = execute(f, "passed", contract);
    assert.equal(report.status, "passed");
    assert.equal(report.contract?.status, "unfrozen");
    assert.equal(
      report.runtime.pinnedCommit,
      git(f.runtime, "rev-parse", "HEAD"),
    );
    assert.equal(report.transfer?.head, contract.source.commit);
    assert.deepEqual(checkCalls, [
      "full-postgres-suite",
      "typecheck",
      "diff-check",
    ]);
    assert.equal(report.cleanup, "passed");
    assert.equal(report.executorInvocations, 0);
    assert.equal(report.modelInvocations, 0);
    assert.equal(report.lineagesCreated, 0);
    assert.ok(
      processCalls.some(
        ({ args }) =>
          args[0] === "run" &&
          args.includes("--pull=never") &&
          args.includes("--platform") &&
          args.includes("linux/arm64") &&
          args.includes("127.0.0.1::5432"),
      ),
    );
    assert.ok(processCalls.some(({ args }) => args[0] === "ci"));
    assert.ok(
      processCalls.some(
        ({ args }) => args[0] === "run" && args[1] === "typecheck",
      ),
    );
    assert.ok(
      processCalls.some(({ args }) =>
        args.some((arg) => arg.includes("require.resolve")),
      ),
    );
    assert.ok(
      processCalls.some(({ args }) =>
        args.some((arg) => arg.includes("CREATE EXTENSION IF NOT EXISTS")),
      ),
    );
    assert.deepEqual(evidence(report), report);
  } finally {
    f.close();
  }
});

test("schema-3 preflight-only fails closed on missing or drifting pins before target preparation", () => {
  for (const [name, mutate, pattern] of [
    [
      "missing-node",
      (contract: TrustedLocalContract) => {
        contract.toolchain.node.sha256 = null;
      },
      /node bytes mismatch\/missing/,
    ],
    [
      "npm-drift",
      (contract: TrustedLocalContract) => {
        contract.toolchain.npm.treeSha256 = "0".repeat(64);
      },
      /npm closure mismatch\/missing/,
    ],
    [
      "shell-drift",
      (contract: TrustedLocalContract) => {
        contract.toolchain.shell.sha256 = "0".repeat(64);
      },
      /shell bytes mismatch\/missing/,
    ],
  ] as const) {
    const f = bindingFixture();
    try {
      const contract = structuredClone(f.contract);
      mutate(contract);
      installContract(f, contract);
      const { report, processCalls, checkCalls } = execute(f, name, contract);
      assert.equal(report.status, "failed");
      assert.equal(report.primaryFailure?.category, "operational");
      assert.match(report.primaryFailure!.message, pattern);
      assert.equal(report.transfer, null);
      assert.equal(processCalls.length, 0);
      assert.equal(checkCalls.length, 0);
      assert.equal(report.executorInvocations, 0);
      assert.deepEqual(evidence(report), report);
    } finally {
      f.close();
    }
  }
});

test("schema-3 preflight-only distinguishes wrong image, failed public check and cleanup failure", () => {
  for (const scenario of ["image", "check", "cleanup"] as const) {
    const f = bindingFixture();
    try {
      const contract = installContract(f, structuredClone(f.contract));
      const { report, processCalls, checkCalls } = execute(
        f,
        scenario,
        contract,
        {
          wrongImage: scenario === "image",
          cleanupFailure: scenario === "cleanup",
        },
        scenario === "check" ? "typecheck" : undefined,
      );
      assert.equal(report.status, "failed");
      assert.equal(report.executorInvocations, 0);
      if (scenario === "image") {
        assert.equal(report.primaryFailure?.category, "operational");
        assert.match(report.primaryFailure!.message, /image ID\/platform/);
        assert.equal(checkCalls.length, 0);
        assert.equal(
          processCalls.some(({ args }) => args[0] === "run"),
          false,
        );
        assert.equal(report.cleanup, "passed");
      } else if (scenario === "check") {
        assert.equal(report.primaryFailure?.category, "public-check");
        assert.deepEqual(checkCalls, [
          "full-postgres-suite",
          "typecheck",
          "diff-check",
        ]);
        assert.equal(report.cleanup, "passed");
        assert.equal(report.cleanupFailure, null);
      } else {
        assert.equal(report.primaryFailure, null);
        assert.equal(report.cleanup, "failed");
        assert.equal(report.cleanupFailure?.category, "cleanup");
      }
      assert.deepEqual(evidence(report), report);
    } finally {
      f.close();
    }
  }
});
