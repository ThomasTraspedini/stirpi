import { experimentCli } from "../src/experiments/cli.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  rmSync,
  existsSync,
  chmodSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import {
  bindTrustedLocal,
  parseTrustedLocalContract,
} from "../src/experiments/trusted-local-contract.js";
import { TrustedLocalAuthority } from "../src/experiments/trusted-local-authority.js";
import {
  defaultLocalTools,
  verifyLocalTools,
} from "../src/experiments/trusted-local-identity.js";
import {
  TrustedPreparation,
  type TrustedProcess,
} from "../src/experiments/preparation.js";
import { runExperimentLocally } from "../src/experiments/run.js";
import { runPinnedRuntime } from "../src/experiments/runtime-identity.js";
import { replayExperiment } from "../src/experiments/evaluation.js";
import { git, sha256 } from "../src/experiments/inputs.js";
import { bindingFixture } from "./fixtures/p3/binding-fixture.js";

function edit(object: object, path: string[], value: unknown) {
  let target = object as Record<string, unknown>;
  for (const key of path.slice(0, -1))
    target = target[key] as Record<string, unknown>;
  if (value === undefined) delete target[path.at(-1)!];
  else target[path.at(-1)!] = value;
}
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const lines = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
function fakePreparation(
  f: ReturnType<typeof bindingFixture>,
  calls: { args: string[]; env: NodeJS.ProcessEnv }[],
): TrustedProcess {
  return (_exe, args, _cwd, env) => {
    calls.push({ args, env });
    if (args.includes("--version"))
      return args.length === 1
        ? f.contract.toolchain.node.version
        : f.contract.toolchain.npm.version;
    if (args[0] === "image")
      return JSON.stringify([
        {
          Id: f.contract.preparation.postgres.imageId,
          Os: "linux",
          Architecture: "arm64",
        },
      ]);
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Image: f.contract.preparation.postgres.imageId,
          NetworkSettings: {
            Ports: { "5432/tcp": [{ HostPort: "32123", HostIp: "127.0.0.1" }] },
          },
        },
      ]);
    return "fixture";
  };
}

test("closed dedicated contract rejects missing/extra/duplicates, escapes, placeholders and contradictory modes", () => {
  const f = bindingFixture();
  try {
    assert.deepEqual(parseTrustedLocalContract(f.contractBytes), f.contract);
    for (const [path, value] of [
      [["source", "commit"], undefined],
      [["toolchain", "npm", "extra"], true],
      [["inputs", "task", "path"], "../escape"],
      [["inputs", "task", "path"], "/absolute"],
      [["inputs", "task", "path"], "input/../task.txt"],
      [["verificationMode"], "isolated"],
      [["toolchain", "compiler", "treeSha256"], null],
      [["status"], "unfrozen"],
      [["preparation", "postgres", "kind"], "registry-manifest"],
      [["preparation", "postgres", "platform"], null],
      [["maxConcurrency"], 2],
      [["executor", "effort"], "high"],
    ] as [string[], unknown][]) {
      const c = structuredClone(f.contract);
      edit(c, path, value);
      assert.throws(() => parseTrustedLocalContract(JSON.stringify(c)));
    }
    assert.throws(
      () =>
        parseTrustedLocalContract(
          f.contractBytes.replace('"version":1', '"version":1,"version":1'),
        ),
      /duplicate/,
    );
    assert.throws(
      () =>
        parseTrustedLocalContract(
          readFileSync("docs/experiments/p1-hst/trusted-local-contract.json"),
        ),
      /contract is unfrozen/,
    );
    for (const [path, value] of [
      [["executor"], {}],
      [["hiddenEvaluationDuringRun"], undefined],
      [["trustedLocalContract", "extra"], true],
      [["trustedLocalContract", "sha256"], "0".repeat(64)],
      [["trustedLocalContract", "path"], "../contract"],
    ] as [string[], unknown][]) {
      const p = structuredClone(f.pilot);
      edit(p, path, value);
      assert.throws(() => bindTrustedLocal(p, f.runtime));
    }
    writeFileSync(
      join(f.runtime, f.pilot.trustedLocalContract.path),
      f.contractBytes + "\n",
    );
    assert.throws(
      () => bindTrustedLocal(f.pilot, f.runtime),
      /differs from committed/,
    );
  } finally {
    f.close();
  }
});

test("baseline-only authority covers harmless metadata but rejects new operations on first descendant prepare and stale leases", () => {
  const f = bindingFixture(),
    calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  try {
    const run = fakePreparation(f, calls),
      state = join(f.directory, "state");
    mkdirSync(state);
    const authority = new TrustedLocalAuthority(
      f.contract,
      f.tools,
      state,
      run,
    );
    authority.assertBaseline(f.source);
    const prep = new TrustedPreparation(
      {
        modules: f.contract.preparation.modules,
        postgres: {
          image: f.contract.preparation.postgres.imageId,
          prerequisites: ["btree_gist"],
        },
      },
      () => {},
      run,
      authority,
    );
    const descendant = join(f.directory, "descendant");
    mkdirSync(descendant);
    for (const name of ["package.json", "package-lock.json"])
      cpSync(join(f.source, name), join(descendant, name));
    const original = json(join(descendant, "package.json"));
    for (const modify of [
      (p: {
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
      }) => {
        p.scripts.preinstall = "new-script";
      },
      (p: {
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
      }) => {
        p.scripts.test = "new-test";
      },
      (p: {
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
      }) => {
        p.dependencies.new = "new-dependency";
      },
    ]) {
      const pkg = structuredClone(original);
      modify(pkg);
      writeFileSync(join(descendant, "package.json"), JSON.stringify(pkg));
      const n = calls.filter(
        (c) => c.args[0] === "ci" || c.args[0] === "run",
      ).length;
      assert.throws(() => prep.prepare(descendant), /not covered/);
      assert.equal(
        calls.filter((c) => c.args[0] === "ci" || c.args[0] === "run").length,
        n,
      );
    }
    writeFileSync(
      join(descendant, "package.json"),
      JSON.stringify({ ...original, description: "Informational change" }),
    );
    prep.prepare(descendant);
    assert.equal(prep.records.length, 1);
    const dependencies = calls.find((c) => c.args[0] === "ci")!;
    assert.equal(
      dependencies.env.NPM_CONFIG_REGISTRY,
      "https://registry.npmjs.org/",
    );
    assert.equal(
      dependencies.env.NPM_CONFIG_USERCONFIG,
      dependencies.env.NPM_CONFIG_GLOBALCONFIG,
    );
    assert.equal(dependencies.env.OPENAI_API_KEY, undefined);
    assert.ok(
      calls.some(
        (c) => c.args.includes("--pull=never") && c.args.includes("--platform"),
      ),
    );
    writeFileSync(
      join(descendant, "package.json"),
      JSON.stringify({
        ...original,
        description: "Another informational change",
      }),
    );
    prep.prepare(descendant);
    assert.equal(prep.records.length, 2);
    assert.ok(
      prep.records[0]!.steps.some((s) => s.id === "cleanup" && s.passed),
    );
    writeFileSync(join(descendant, ".npmrc"), "registry=https://new.invalid\n");
    assert.throws(() => prep.prepare(descendant), /not covered/);
    rmSync(join(descendant, ".npmrc"));
    writeFileSync(
      join(descendant, "package-lock.json"),
      JSON.stringify({ resolved: "https://new.invalid" }),
    );
    assert.throws(() => prep.prepare(descendant), /not covered/);
    assert.throws(
      () =>
        prep.verificationEnvironment(
          descendant,
          { id: "test", executable: "npm", args: ["test"] },
          { HOME: state },
        ),
      /not covered/,
    );
    prep.cleanup();
    assert.equal(prep.records[1]!.steps.at(-1)!.id, "cleanup");
    writeFileSync(join(f.source, "package.json"), "{}");
    assert.throws(() => authority.assertBaseline(f.source), /baseline package/);
  } finally {
    f.close();
  }
});

test("toolchain and image drift fail before dependency preparation", () => {
  const f = bindingFixture(),
    calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  try {
    const run = fakePreparation(f, calls);
    const bad = structuredClone(f.contract);
    bad.toolchain.npm.treeSha256 = "0".repeat(64);
    assert.throws(() => verifyLocalTools(bad, f.tools, run), /npm closure/);
    assert.equal(calls.length, 0);
    const state = join(f.directory, "state");
    mkdirSync(state);
    const authority = new TrustedLocalAuthority(
      f.contract,
      f.tools,
      state,
      run,
    );
    authority.assertBaseline(f.source);
    const wrongImage: TrustedProcess = (exe, args, cwd, env) =>
      args[0] === "image"
        ? JSON.stringify([{ Id: "wrong", Os: "linux", Architecture: "amd64" }])
        : run(exe, args, cwd, env);
    const imageAuthority = new TrustedLocalAuthority(
      f.contract,
      f.tools,
      join(f.directory, "image-state"),
      wrongImage,
    );
    imageAuthority.assertBaseline(f.source);
    const prep = new TrustedPreparation(
      {
        modules: f.contract.preparation.modules,
        postgres: {
          image: f.contract.preparation.postgres.imageId,
          prerequisites: ["btree_gist"],
        },
      },
      () => {},
      wrongImage,
      imageAuthority,
    );
    assert.throws(() => prep.prepare(f.source), /image ID\/platform/);
    assert.equal(
      calls.some((c) => c.args[0] === "ci"),
      false,
    );
    assert.equal(prep.records.length, 0);
    writeFileSync(join(f.tools.compilerRoot, "fixture"), "drift");
    assert.throws(() => prep.prepare(f.source), /compiler closure/);
    assert.equal(
      calls.some((c) => c.args[0] === "ci"),
      false,
    );
  } finally {
    f.close();
  }
});

test("Docker retains an argv0-sensitive operational locator while hashing target bytes", () => {
  const f = bindingFixture();
  const dockerDirectory = join(f.directory, "argv0-sensitive-docker");
  const target = join(dockerDirectory, "docker-tools");
  const locator = join(dockerDirectory, "docker");
  const previousPath = process.env.PATH;
  try {
    mkdirSync(dockerDirectory);
    writeFileSync(
      target,
      `#!/bin/sh
if [ "${"${0##*/}"}" != docker ]; then
  echo "docker argv0 required" >&2
  exit 64
fi
case "$1:$2" in
  image:inspect)
    printf '%s\\n' '[{"Id":"sha256:${"1".repeat(64)}","Os":"linux","Architecture":"arm64"}]'
    ;;
  inspect:*)
    printf '%s\\n' '[{"Image":"sha256:${"1".repeat(64)}","NetworkSettings":{"Ports":{"5432/tcp":[{"HostPort":"32123","HostIp":"127.0.0.1"}]}}}]'
    ;;
  *)
    echo "unexpected docker invocation: $*" >&2
    exit 65
    ;;
esac
`,
    );
    chmodSync(target, 0o755);
    symlinkSync(target, locator);
    process.env.PATH = [dockerDirectory, previousPath ?? ""].join(delimiter);

    const discovered = defaultLocalTools();
    assert.equal(discovered.docker, locator);
    assert.equal(discovered.docker.endsWith("/docker"), true);
    assert.equal(readlinkSync(discovered.docker), target);

    const contract = structuredClone(f.contract);
    contract.toolchain.docker.sha256 = sha256(readFileSync(discovered.docker));
    const run: TrustedProcess = (executable, args, cwd, env) => {
      const result = spawnSync(executable, args, {
        cwd,
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const authority = new TrustedLocalAuthority(
      contract,
      { ...f.tools, docker: discovered.docker },
      join(f.directory, "state"),
      run,
    );
    authority.assertImage(f.source);
    authority.assertContainer(f.source, "postgres-fixture", 32123);

    writeFileSync(target, "#!/bin/sh\nexit 0\n");
    assert.throws(
      () =>
        verifyLocalTools(
          contract,
          { ...f.tools, docker: discovered.docker },
          fakePreparation(f, []),
        ),
      /docker bytes mismatch/,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    f.close();
  }
});

test("governance reaches real adapter prompt and unchanged stdin across H/S/T, SPAWN/FORK; VERIFY and COMPLETE remain independent; replay has no effects", async () => {
  const f = bindingFixture(),
    previous = process.cwd();
  try {
    process.chdir(f.runtime);
    for (const condition of ["H", "S", "T"] as const) {
      const prepCalls: { args: string[]; env: NodeJS.ProcessEnv }[] = [],
        checks: { id: string; input: string }[] = [];
      const run = await runExperimentLocally(
        f.options(condition),
        fakePreparation(f, prepCalls),
        (check, options) => {
          checks.push({ id: check.id, input: options.input });
          return {
            status: options.input ? 0 : 1,
            signal: null,
            stdout: "fixture",
            stderr: "",
            error: undefined,
          };
        },
      );
      assert.equal(run.result.error, null);
      assert.equal(
        run.result.runtimeOutcome,
        "COMPLETED",
        JSON.stringify(run.state?.work),
      );
      assert.equal(checks.filter((c) => !c.input).length, 1);
      assert.ok(checks.filter((c) => c.input).length >= 3);
      const invocations = lines(join(run.directory, "invocations.jsonl"));
      const started = invocations.filter((r) => r.type === "started");
      assert.ok(started.some((r) => r.input.work.name === "child"));
      assert.equal(
        started.some((r) => r.input.work.name === "alpha"),
        condition === "T",
      );
      for (const record of started) {
        assert.equal(record.input.task, f.task);
        assert.deepEqual(record.input.governance, {
          text: readFileSync(
            join(f.runtime, f.contract.inputs.governance.path),
            "utf8",
          ),
          sha256: f.contract.inputs.governance.sha256,
        });
        assert.equal(record.promptSha256, sha256(record.prompt));
        assert.ok(record.prompt.includes(record.input.governance.text));
        const actual = invocations.find(
          (r) => r.type === "process" && r.index === record.index,
        ).effectivePromptIdentity;
        assert.deepEqual(actual, {
          taskSha256: sha256(f.task),
          promptSha256: record.promptSha256,
          governanceSha256: record.governanceSha256,
        });
        const returned = invocations.find(
          (r) => r.type === "returned" && r.index === record.index,
        );
        assert.equal(
          JSON.parse(returned.response.text).taskSha256,
          sha256(f.task),
        );
      }
      const count = prepCalls.length + checks.length;
      rmSync(join(run.directory, "artifacts"), {
        recursive: true,
        force: true,
      });
      rmSync(join(run.directory, "worlds"), { recursive: true, force: true });
      assert.deepEqual(replayExperiment(run.directory), run.state);
      assert.equal(prepCalls.length + checks.length, count);
      started[0].input.governance.text = "drift";
      writeFileSync(
        join(run.directory, "invocations.jsonl"),
        invocations.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
      assert.throws(
        () => replayExperiment(run.directory),
        /governance\/prompt/,
      );
    }
  } finally {
    process.chdir(previous);
    f.close();
  }
});

test("pinned runtime uses R contract, adapter and public input snapshots when P differs, and rejects P input drift", async () => {
  const f = bindingFixture(true);
  const ambientPath = process.env.PATH;
  try {
    const preregistration = join(f.runtime, "pilot.json");
    writeFileSync(preregistration, JSON.stringify(f.pilot));
    writeFileSync(
      join(f.runtime, "adapters/codex/adapter.mjs"),
      'throw new Error("P ADAPTER MUST NOT EXECUTE");',
    );
    writeFileSync(
      join(f.runtime, f.pilot.trustedLocalContract.path),
      "P CONTRACT MUST NOT BE READ",
    );
    writeFileSync(
      join(f.runtime, "src/experiments/run.ts"),
      'throw new Error("P RUNTIME MUST NOT EXECUTE");',
    );
    git(f.runtime, "add", ".");
    git(f.runtime, "commit", "-m", "Fixture preregistration P distinct from R");
    const p = git(f.runtime, "rev-parse", "HEAD");
    assert.notEqual(p, f.pin);
    const ambientBin = join(f.directory, "ambient-bin");
    const ambientGit = join(ambientBin, "git");
    const ambientMarker = join(ambientBin, "invoked");
    mkdirSync(ambientBin);
    writeFileSync(
      ambientGit,
      '#!/bin/sh\nprintf "ambient Git invoked\\n" > "${0%/*}/invoked"\nexit 97\n',
    );
    chmodSync(ambientGit, 0o755);
    assert.notEqual(f.tools.git, ambientGit);
    process.env.PATH = `${ambientBin}:${ambientPath ?? ""}`;
    const options = { ...f.options(), preregistration };
    const run = await runPinnedRuntime(options);
    assert.equal(existsSync(ambientMarker), false);
    assert.equal(run.result.error, null);
    assert.equal(
      run.result.runtimeOutcome,
      "COMPLETED",
      JSON.stringify(run.state?.work),
    );
    const evidence = json(join(run.directory, "preflight.json"));
    assert.equal(evidence.runtime.actualCommit, f.pin);
    assert.equal(evidence.preregistration.containingCommit, p);
    assert.equal(evidence.trustedLocal.contents, f.contractBytes);
    assert.deepEqual(replayExperiment(run.directory), run.state);
    writeFileSync(
      join(f.runtime, f.contract.inputs.task.path),
      f.task + "drift",
    );
    await assert.rejects(
      runPinnedRuntime({
        ...options,
        output: join(f.directory, "must-not-exist"),
      }),
      /differs from committed/,
    );
    assert.equal(existsSync(ambientMarker), false);
    assert.equal(existsSync(join(f.directory, "must-not-exist")), false);
  } finally {
    process.env.PATH = ambientPath;
    f.close();
  }
});

test("dedicated pilot rejects API/executor/evaluator overrides before preparation and solver", async () => {
  const f = bindingFixture(),
    previous = process.cwd(),
    calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  try {
    process.chdir(f.runtime);
    for (const [path, value] of [
      [["verificationMode"], "none"],
      [["preparation"], {}],
      [["maxConcurrency"], 2],
      [["maxSteps"], 1],
      [["budgets"], { steps: 1 }],
      [["supervision"], { noProgressMs: 1 }],
      [["evaluatorWallTimeMs"], 1],
      [["metadata"], { model: "gpt-other" }],
      [["metadata"], { sampling: "new" }],
      [["governance"], { text: "override" }],
      [["publicEvaluator", "criteria", "description"], "different"],
      [["trustedLocalTools", "extra"], "different"],
    ] as [string[], unknown][]) {
      const options = f.options();
      edit(options, path, value);
      await assert.rejects(
        runExperimentLocally(options, fakePreparation(f, calls)),
      );
      assert.equal(calls.length, 0);
      assert.equal(existsSync(join(f.directory, "output")), false);
    }
    for (const args of [
      [...f.options().executor.args!, "--model", "duplicate"],
      [
        join(f.directory, "untrusted-adapter.mjs"),
        ...f.options().executor.args!.slice(1),
      ],
    ]) {
      const options = f.options();
      options.executor.args = args;
      await assert.rejects(
        runExperimentLocally(options, fakePreparation(f, calls)),
        /override\/adapter/,
      );
      assert.equal(calls.length, 0);
      assert.equal(existsSync(join(f.directory, "output")), false);
    }
  } finally {
    process.chdir(previous);
    f.close();
  }
});

test("baseline mismatch and container mismatch produce operational evidence, zero solver processes and cleanup", async () => {
  for (const failure of ["baseline", "container"] as const) {
    const f = bindingFixture(),
      previous = process.cwd(),
      calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    try {
      if (failure === "baseline") {
        f.contract.baseline.packageSha256 = "0".repeat(64);
        const bytes = JSON.stringify(f.contract),
          path = join(f.runtime, f.pilot.trustedLocalContract.path);
        writeFileSync(path, bytes);
        git(f.runtime, "add", f.pilot.trustedLocalContract.path);
        git(f.runtime, "commit", "-m", "Synthetic mismatch authority");
        f.pilot.stirpiCommit = git(f.runtime, "rev-parse", "HEAD");
        f.pilot.trustedLocalContract.sha256 = sha256(bytes);
      }
      process.chdir(f.runtime);
      const fake = fakePreparation(f, calls);
      const prepareProcess: TrustedProcess = (exe, args, cwd, env) =>
        args[0] === "inspect"
          ? JSON.stringify([
              {
                Image: "wrong",
                NetworkSettings: {
                  Ports: {
                    "5432/tcp": [{ HostPort: "32123", HostIp: "127.0.0.1" }],
                  },
                },
              },
            ])
          : fake(exe, args, cwd, env);
      let checks = 0;
      const run = await runExperimentLocally(
        f.options(),
        prepareProcess,
        () => {
          checks++;
          throw new Error("Must not reach public checks");
        },
      );
      assert.equal(checks, 0);
      assert.equal(
        lines(join(run.directory, "invocations.jsonl")).some(
          (row) => row.type === "process",
        ),
        false,
      );
      if (failure === "baseline") {
        assert.equal(run.result.resources.executorInvocations, 0);
        assert.match(run.result.error!, /baseline package/);
        assert.equal(calls.length, 0);
      } else {
        assert.equal(run.result.runtimeOutcome, "BLOCKED");
        assert.match(run.state!.work[0]!.reason!.message, /container image/);
        assert.ok(calls.some((c) => c.args[0] === "rm"));
        assert.ok(
          json(join(run.directory, "preparation.json"))[0].steps.some(
            (s: { id: string; passed: boolean }) =>
              s.id === "cleanup" && s.passed,
          ),
        );
        assert.deepEqual(replayExperiment(run.directory), run.state);
      }
    } finally {
      process.chdir(previous);
      f.close();
    }
  }
});

test("adapter projection rejects malformed governance while preserving historical input without it", async () => {
  const modulePath = join(process.cwd(), "adapters/codex/contract.mjs");
  const { invocationFrom, promptFrom } = await import(modulePath);
  const text = readFileSync(
    "docs/experiments/p1-hst/solver-governance.txt",
    "utf8",
  );
  const context = {
    work: { objective: "task", artifact: { worktree: "/fixture/workspace" } },
    dna: [],
    results: [],
    publicEvaluation: { description: "fixture", criteria: [] },
    task: "unchanged\r\nstdin",
  };
  const historical = invocationFrom(JSON.stringify({ version: 1, context }));
  assert.equal(historical.context.governance, undefined);
  assert.equal(
    promptFrom(historical).prompt.includes("Common solver governance"),
    false,
  );
  for (const governance of [
    null,
    { text, sha256: "0".repeat(64) },
    { text },
    { text, sha256: sha256(text), extra: "new-authority" },
    { text: { secret: "hidden" }, sha256: sha256(text) },
  ])
    assert.throws(
      () =>
        invocationFrom(
          JSON.stringify({ version: 1, context: { ...context, governance } }),
        ),
      /INVALID_INPUT/,
    );
  const invocation = invocationFrom(
    JSON.stringify({
      version: 1,
      context: { ...context, governance: { text, sha256: sha256(text) } },
    }),
  );
  assert.equal(promptFrom(invocation).task, context.task);
  assert.ok(
    promptFrom(invocation).prompt.includes(
      "Common solver governance:\n" + text,
    ),
  );
});

test("CLI rejects duplicate flags and duplicate executor JSON keys before any run effects", async () => {
  const f = bindingFixture();
  try {
    const options = f.options(),
      executor = join(f.directory, "executor.json");
    writeFileSync(executor, JSON.stringify(options.executor));
    const argv = [
      "run",
      options.manifest,
      "--condition",
      "T",
      "--verification-mode",
      "trusted-local",
      "--source",
      f.source,
      "--executor",
      executor,
      "--public-evaluator",
      join(f.runtime, f.contract.inputs.evaluator.path),
      "--output",
      options.output,
      "--preregistration",
      f.preregistration,
    ];
    for (const duplicate of [
      ["--condition", "T"],
      ["--preregistration", f.preregistration],
      ["--concurrency", "1", "--concurrency=1"],
    ]) {
      await assert.rejects(
        experimentCli([...argv, ...duplicate]),
        /Duplicate run option/,
      );
      assert.equal(existsSync(options.output), false);
    }
    writeFileSync(
      executor,
      JSON.stringify(options.executor).replace(
        '"executable":',
        '"executable":null,"executable":',
      ),
    );
    await assert.rejects(experimentCli(argv), /duplicate key/);
    assert.equal(existsSync(options.output), false);
  } finally {
    f.close();
  }
});
