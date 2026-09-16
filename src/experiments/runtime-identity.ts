import {
  bindTrustedLocal,
  localPath,
  runtimeBlob,
} from "./trusted-local-contract.js";
import {
  defaultLocalTools,
  verifyLocalTools,
} from "./trusted-local-identity.js";
import { authorityObject, parseAuthorityJson } from "../authority/json.js";
import { validatePreregisteredProfile } from "./profile-authority.js";
import { execFileSync, fork } from "node:child_process";
import { createRequire } from "node:module";
import {
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  gitAt,
  gitEnvironment,
  initRepository,
  sha256,
  transfer,
} from "./inputs.js";
import type { RunOptions, runExperimentLocally } from "./run.js";

type Result = Awaited<ReturnType<typeof runExperimentLocally>>;
const require = createRequire(import.meta.url);

export function assertRuntimeCheckout(
  checkout: string,
  pin: string,
  gitExecutable = "git",
) {
  if (
    gitAt(gitExecutable, checkout, "rev-parse", "HEAD") !== pin ||
    gitAt(
      gitExecutable,
      checkout,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignored",
    )
  )
    throw new Error("Preflight: runtime checkout dirty or identity mismatch");
}

// This boundary transports input/results only. All experiment decisions execute
// in modules compiled exclusively from the pinned tree, in a fresh process.
export async function runPinnedRuntime(options: RunOptions): Promise<Result> {
  const path = realpathSync(options.preregistration!);
  const bytes = readFileSync(path);
  const pilot = authorityObject(
    parseAuthorityJson(bytes),
    "Preflight: preregistration",
  );
  const pin = pilot.stirpiCommit;
  if (typeof pin !== "string" || !/^[a-f0-9]{40}$/.test(pin))
    throw new Error("Preflight: invalid runtime pin");
  // Schema 3 supplies an operational locator whose bytes are authenticated
  // against R below. Use that same candidate for the bootstrap reads, then
  // retain those reads only if verification succeeds.
  const schema3Tools =
    pilot.schemaVersion === 3
      ? (options.trustedLocalTools ?? defaultLocalTools())
      : undefined;
  const gitExecutable = schema3Tools?.git ?? "git";
  if (
    schema3Tools &&
    (typeof gitExecutable !== "string" || !isAbsolute(gitExecutable))
  )
    throw new Error("Preflight: tool locations must be absolute locators");
  let repository: string;
  let containingCommit: string;
  try {
    repository = gitAt(
      gitExecutable,
      dirname(path),
      "rev-parse",
      "--show-toplevel",
    );
    containingCommit = gitAt(gitExecutable, repository, "rev-parse", "HEAD");
    const name = relative(repository, path);
    const committed = execFileSync(
      gitExecutable,
      [
        "--no-replace-objects",
        "-C",
        repository,
        "show",
        `${containingCommit}:${name}`,
      ],
      { env: gitEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
    );
    if (!committed.equals(bytes))
      throw new Error("uncommitted preregistration");
    if (
      typeof pin !== "string" ||
      !/^[a-f0-9]{40}$/.test(pin) ||
      gitAt(
        gitExecutable,
        repository,
        "rev-parse",
        "--verify",
        `${pin}^{commit}`,
      ) !== pin
    )
      throw new Error("invalid runtime pin");
  } catch (error) {
    throw new Error(
      "Preflight: preregistration identity or pinned runtime unavailable",
      { cause: error },
    );
  }
  const temporary = mkdtempSync(
    join(realpathSync(tmpdir()), "stirpi-runtime-"),
  );
  const checkout = join(temporary, "checkout");
  const build = join(temporary, "build");
  try {
    initRepository(checkout, gitExecutable);
    transfer(repository, checkout, pin, gitExecutable);
    gitAt(gitExecutable, checkout, "checkout", "--detach", pin);
    assertRuntimeCheckout(checkout, pin, gitExecutable);
    if (pilot.schemaVersion === 2)
      validatePreregisteredProfile(pilot, checkout);
    const binding =
      pilot.schemaVersion === 3
        ? bindTrustedLocal(pilot, checkout, false, gitExecutable)
        : undefined;
    if (binding) {
      for (const [name, filePin] of Object.entries(binding.contract.inputs)) {
        const committed = binding.inputs[name as keyof typeof binding.inputs];
        if (name !== "governance") {
          const fromP = runtimeBlob(repository, filePin.path, gitExecutable);
          if (!fromP.equals(committed))
            throw new Error(`Preflight: ${name} P/R input mismatch`);
        }
      }
      if (
        relative(repository, resolve(options.manifest)) !==
          binding.contract.inputs.manifest.path ||
        !readFileSync(options.manifest).equals(binding.inputs.manifest)
      )
        throw new Error("Preflight: external manifest mismatch");
      // Ensure the supplied manifest's task resolves to the exact snapshotted task.
      const manifest = authorityObject(
        parseAuthorityJson(binding.inputs.manifest),
        "manifest",
      );
      if (
        typeof manifest.taskFile !== "string" ||
        resolve(
          dirname(binding.contract.inputs.manifest.path),
          manifest.taskFile,
        ) !== resolve(binding.contract.inputs.task.path)
      )
        throw new Error("Preflight: task path does not match contract");
    }
    const tools = binding
      ? verifyLocalTools(binding.contract, schema3Tools!)
      : undefined;
    if (binding) {
      // Validate supplied argv before replacing its deployment path with R's adapter.
      if (
        sha256(readFileSync(options.executor.executable)) !==
          binding.contract.toolchain.node.sha256 ||
        Object.keys(options.executor).some(
          (key) => !["id", "executable", "args"].includes(key),
        )
      )
        throw new Error(
          "Preflight: executor executable/configuration override",
        );
      const args = options.executor.args ?? [];
      if (
        args[0] !== "R:" + binding.contract.executor.adapterPath &&
        args[0] !== resolve(repository, binding.contract.executor.adapterPath)
      )
        throw new Error("Preflight: executor adapter must designate R");
      const expected = [
        args[0],
        "--codex",
        args[2],
        "--model",
        binding.contract.executor.model,
        "--effort",
        binding.contract.executor.effort,
        "--timeout-ms",
        String(binding.contract.executor.timeoutMs),
      ];
      const auth =
        args.length === 11 &&
        args[9] === "--auth-file" &&
        args[10]?.startsWith("/")
          ? args.slice(9)
          : [];
      if (
        !args[2]?.startsWith("/") ||
        JSON.stringify(args) !== JSON.stringify([...expected, ...auth])
      )
        throw new Error("Preflight: executor configuration override");
    }
    // Never consume dist, loaders, package scripts, or runtime modules from HEAD.
    execFileSync(
      process.execPath,
      [
        tools
          ? join(tools.compilerRoot, "bin/tsc")
          : require.resolve("typescript/bin/tsc"),
        "--project",
        join(checkout, "tsconfig.json"),
        "--outDir",
        build,
        "--typeRoots",
        tools
          ? tools.typeRoots
          : dirname(dirname(require.resolve("@types/node/package.json"))),
      ],
      { cwd: checkout, env: { PATH: process.env.PATH }, stdio: "pipe" },
    );
    assertRuntimeCheckout(checkout, pin, gitExecutable);
    writeFileSync(join(build, "package.json"), '{"type":"module"}');
    const inputRoot = join(temporary, "input");
    const snapshot = join(inputRoot, relative(repository, path));
    mkdirSync(dirname(snapshot), { recursive: true });
    writeFileSync(snapshot, bytes);
    if (binding) {
      for (const [name, filePin] of Object.entries(binding.contract.inputs)) {
        const committed = binding.inputs[name as keyof typeof binding.inputs];
        const target = resolve(inputRoot, filePin.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, committed);
      }
      localPath(checkout, binding.contract.executor.adapterPath);
      localPath(checkout, "adapters/codex/contract.mjs");
    }
    if (pilot.publicEvaluator !== undefined) {
      const file = authorityObject(
        pilot.publicEvaluator,
        "Preflight: public evaluator pin",
      ).file;
      if (
        typeof file !== "string" ||
        !resolve(dirname(snapshot), file).startsWith(inputRoot + "/")
      )
        throw new Error(
          "Preflight: public evaluator pin must be inside input directory",
        );
      const target = resolve(dirname(snapshot), file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(resolve(dirname(path), file)));
    }
    const bridge = join(temporary, "bridge.mjs");
    writeFileSync(
      bridge,
      `
      import { execFileSync } from 'node:child_process';
      import { readFileSync } from 'node:fs';
      import { createHash } from 'node:crypto';
      const git = (...args) => execFileSync(${JSON.stringify(gitExecutable)}, ['--no-replace-objects', ...args], {
        encoding: 'utf8', env: ${JSON.stringify(gitEnvironment())}
      }).trim();
      const actualCommit = git('rev-parse', 'HEAD');
      if (actualCommit !== ${JSON.stringify(pin)} || git('status', '--porcelain', '--untracked-files=all', '--ignored'))
        throw new Error('Preflight: actual runtime checkout mismatch');
      if (createHash('sha256').update(readFileSync(${JSON.stringify(snapshot)})).digest('hex') !== ${JSON.stringify(sha256(bytes))})
        throw new Error('Preflight: preregistration hash mismatch');
      const runtime = await import(${JSON.stringify(pathToFileURL(join(build, "experiments/run.js")).href)});
      const controller = new AbortController();
      process.on('message', async message => {
        if (message.cancel) { controller.abort(); return; }
        try {
          const result = await (runtime.runExperimentLocally ?? runtime.runExperiment)({
            ...message.options, signal: controller.signal,
            observeEvent: event => process.send({event})
          });
          process.send({result, actualCommit}, () => process.disconnect());
        } catch (error) { process.send({error: String(error)}, () => process.disconnect()); }
      });
    `,
    );
    assertRuntimeCheckout(checkout, pin, gitExecutable);
    const actualCommit = gitAt(gitExecutable, checkout, "rev-parse", "HEAD");
    if (actualCommit !== pin)
      throw new Error("Preflight: actual runtime differs from pin");
    const { signal, observeEvent, ...input } = options;
    const result = await new Promise<Result>((accept, reject) => {
      const child = fork(bridge, [], {
        cwd: checkout,
        execArgv: [],
        env: { PATH: process.env.PATH },
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let errorOutput = "";
      child.stderr?.on("data", (chunk) => {
        errorOutput += chunk;
      });
      let result: Result | undefined;
      const cancel = () => {
        if (child.connected) child.send({ cancel: true });
      };
      signal?.addEventListener("abort", cancel, { once: true });
      child.on(
        "message",
        (message: {
          event?: Parameters<NonNullable<RunOptions["observeEvent"]>>[0];
          result?: Result;
          actualCommit?: string;
          error?: string;
        }) => {
          if (message.event) observeEvent?.(message.event);
          if (message.result) {
            if (message.actualCommit === pin) result = message.result;
            else
              errorOutput +=
                "Preflight: actual runtime identity differs from pin";
          }
          if (message.error) errorOutput += message.error;
        },
      );
      child.on("error", reject);
      child.on("exit", (code) => {
        signal?.removeEventListener("abort", cancel);
        if (code === 0 && result) accept(result);
        else reject(new Error(`Pinned runtime failed: ${errorOutput}`));
      });
      child.send({
        options: {
          ...input,
          preregistration: snapshot,
          manifest: binding
            ? resolve(inputRoot, binding.contract.inputs.manifest.path)
            : resolve(input.manifest),
          ...(binding && tools
            ? {
                trustedLocalTools: tools,
                executor: {
                  ...input.executor,
                  executable: tools.node,
                  args: [
                    resolve(checkout, binding.contract.executor.adapterPath),
                    ...(input.executor.args ?? []).slice(1),
                  ],
                },
              }
            : {}),
          output: resolve(input.output),
          source: /^(https?:|git@|ssh:)/.test(input.source)
            ? input.source
            : resolve(input.source),
        },
      });
      if (signal?.aborted) cancel();
    });
    const evidencePath = join(result.directory, "preflight.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    if (evidence.preregistration.sha256 !== sha256(bytes))
      throw new Error("Preflight: preregistration changed during execution");
    evidence.preregistration.path = path;
    evidence.preregistration.containingCommit = containingCommit;
    evidence.preregistration.contents = bytes.toString("utf8");
    evidence.runtime = {
      pinnedCommit: pin,
      actualCommit,
      isolation: "clean-checkout-compiled-outside-tree",
    };
    const metadataPath = join(result.directory, "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    metadata.preflight = evidence;
    for (const [file, value] of [
      [evidencePath, evidence],
      [metadataPath, metadata],
    ] as const)
      writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
    return result;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
