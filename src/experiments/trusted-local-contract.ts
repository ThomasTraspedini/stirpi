import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  closedAuthorityObject,
  parseAuthorityJson,
} from "../authority/json.js";
import { gitAt, gitEnvironment, sha256 } from "./inputs.js";
import type { RunOptions } from "./run.js";

export interface LocalFilePin {
  path: string;
  sha256: string;
}
export interface TrustedLocalContract {
  kind: "p1-hst-trusted-local";
  version: 1;
  id: string;
  status: "unfrozen" | "frozen";
  verificationMode: "trusted-local";
  testcase: string;
  source: { repository: string; commit: string };
  inputs: Record<
    "manifest" | "task" | "evaluator" | "governance",
    LocalFilePin
  >;
  baseline: {
    scope: "baseline-only";
    packageSha256: string;
    lockfileSha256: string;
  };
  toolchain: {
    platform: string;
    architecture: string;
    node: { version: string; sha256: string | null };
    npm: { version: string; treeSha256: string | null };
    compiler: { treeSha256: string | null };
    typeRoots: { treeSha256: string | null };
    git: { sha256: string | null };
    docker: { sha256: string | null };
  };
  preparation: {
    modules: string[];
    postgres: {
      kind: "local-image-id";
      imageId: string;
      platform: string | null;
      prerequisites: string[];
      pull: "never";
      transport: "loopback";
      state: "disposable";
    };
    npm: {
      registry: "https://registry.npmjs.org/";
      userConfig: "empty";
      globalConfig: "empty";
      candidateConfig: "unsupported-operationally";
      install: "ci";
      lifecycle: "baseline-authority";
    };
  };
  executor: {
    adapter: "codex";
    executableVersion: string;
    executableSha256: string;
    model: "gpt-6-astra";
    effort: "medium";
    adapterPath: "adapters/codex/adapter.mjs";
    timeoutMs: 900000;
  };
  limits: typeof p1Limits;
  maxConcurrency: 1;
  procedure: {
    order: ["H", "S", "T"];
    replacement: "at-most-one-operational-per-condition";
  };
}
export const p1Limits = {
  maxSteps: 20,
  maxExecutorInvocations: 20,
  maxLineages: 20,
  maxItemsPerInvocation: 200,
  maxCommandsPerInvocation: 100,
  noProgressMs: 180000,
  maxWallTimePerInvocationMs: 900000,
  maxEvaluatorWallTimeMs: 300000,
} as const;
const digest = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown) => typeof value === "string" && value.length > 0;
const equal = (actual: unknown, expected: unknown, label: string) => {
  if (!isDeepStrictEqual(actual, expected))
    throw new Error(`Preflight: trusted-local ${label} mismatch`);
};
export function localPath(root: string, path: unknown) {
  if (
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Preflight: trusted-local path escape");
  const target = resolve(root, path);
  // Ancestor symlinks cannot redirect authority outside R either.
  const rel = relative(realpathSync(root), realpathSync(target));
  if (rel.startsWith("../") || isAbsolute(rel) || !lstatSync(target).isFile())
    throw new Error(
      "Preflight: trusted-local file must be regular and inside root",
    );
  return target;
}
export function parseLocalFilePin(value: unknown): LocalFilePin {
  const pin = closedAuthorityObject(
    value,
    ["path", "sha256"],
    "Preflight: trusted-local file pin",
  );
  if (!text(pin.path) || !digest(pin.sha256))
    throw new Error("Preflight: invalid trusted-local file pin");
  // Path syntax checked without requiring a file to exist.
  if (
    isAbsolute(pin.path as string) ||
    (pin.path as string).includes("\\") ||
    (pin.path as string).split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Preflight: trusted-local path escape");
  return pin as unknown as LocalFilePin;
}
export function parseTrustedLocalContract(
  bytes: Buffer | string,
  allowUnfrozen = false,
): TrustedLocalContract {
  const c = closedAuthorityObject(
    parseAuthorityJson(bytes),
    [
      "kind",
      "version",
      "id",
      "status",
      "verificationMode",
      "testcase",
      "source",
      "inputs",
      "baseline",
      "toolchain",
      "preparation",
      "executor",
      "limits",
      "maxConcurrency",
      "procedure",
    ],
    "Preflight: trusted-local contract",
  );
  if (
    c.kind !== "p1-hst-trusted-local" ||
    c.version !== 1 ||
    !text(c.id) ||
    !text(c.testcase) ||
    c.verificationMode !== "trusted-local" ||
    !["unfrozen", "frozen"].includes(c.status as string)
  )
    throw new Error("Preflight: invalid trusted-local contract identity");
  const source = closedAuthorityObject(
    c.source,
    ["repository", "commit"],
    "source",
  );
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(source.repository as string) ||
    !/^[a-f0-9]{40}$/.test(source.commit as string)
  )
    throw new Error("Preflight: invalid source identity");
  const inputs = closedAuthorityObject(
    c.inputs,
    ["manifest", "task", "evaluator", "governance"],
    "inputs",
  );
  for (const value of Object.values(inputs)) parseLocalFilePin(value);
  equal(
    (inputs.governance as LocalFilePin).sha256,
    "3d772fc6c57042b73933523bf5583a05c5371a981f93cd8cd56e187db85f2f75",
    "approved governance",
  );
  const baseline = closedAuthorityObject(
    c.baseline,
    ["scope", "packageSha256", "lockfileSha256"],
    "baseline",
  );
  if (
    baseline.scope !== "baseline-only" ||
    !digest(baseline.packageSha256) ||
    !digest(baseline.lockfileSha256)
  )
    throw new Error("Preflight: invalid baseline identity");
  const tools = closedAuthorityObject(
    c.toolchain,
    [
      "platform",
      "architecture",
      "node",
      "npm",
      "compiler",
      "typeRoots",
      "git",
      "docker",
    ],
    "toolchain",
  );
  if (!text(tools.platform) || !text(tools.architecture))
    throw new Error("Preflight: missing toolchain platform");
  for (const name of [
    "node",
    "npm",
    "compiler",
    "typeRoots",
    "git",
    "docker",
  ]) {
    const field = ["npm", "compiler", "typeRoots"].includes(name)
      ? "treeSha256"
      : "sha256";
    const pin = closedAuthorityObject(
      tools[name],
      [...(["node", "npm"].includes(name) ? ["version"] : []), field],
      `toolchain ${name}`,
    );
    if (
      (["node", "npm"].includes(name) && !text(pin.version)) ||
      (pin[field] !== null && !digest(pin[field]))
    )
      throw new Error(`Preflight: invalid ${name} pin`);
    if (!allowUnfrozen && !digest(pin[field]))
      throw new Error(`Preflight: missing required ${name} pin`);
  }
  const prep = closedAuthorityObject(
    c.preparation,
    ["modules", "postgres", "npm"],
    "preparation",
  );
  equal(
    prep.modules,
    ["pg", "typescript", "@types/pg/package.json", "@types/node/package.json"],
    "modules",
  );
  const pg = closedAuthorityObject(
    prep.postgres,
    [
      "kind",
      "imageId",
      "platform",
      "prerequisites",
      "pull",
      "transport",
      "state",
    ],
    "postgres",
  );
  equal(
    { ...pg, imageId: null, platform: null },
    {
      kind: "local-image-id",
      imageId: null,
      platform: null,
      prerequisites: ["btree_gist"],
      pull: "never",
      transport: "loopback",
      state: "disposable",
    },
    "postgres policy",
  );
  if (
    !/^sha256:[a-f0-9]{64}$/.test(pg.imageId as string) ||
    (pg.platform !== null &&
      !/^linux\/(amd64|arm64)$/.test(pg.platform as string))
  )
    throw new Error("Preflight: invalid local image identity/platform");
  if (!allowUnfrozen && pg.platform === null)
    throw new Error("Preflight: missing required image platform");
  equal(
    prep.npm,
    {
      registry: "https://registry.npmjs.org/",
      userConfig: "empty",
      globalConfig: "empty",
      candidateConfig: "unsupported-operationally",
      install: "ci",
      lifecycle: "baseline-authority",
    },
    "npm policy",
  );
  const executor = closedAuthorityObject(
    c.executor,
    [
      "adapter",
      "executableVersion",
      "executableSha256",
      "model",
      "effort",
      "adapterPath",
      "timeoutMs",
    ],
    "executor",
  );
  if (!text(executor.executableVersion) || !digest(executor.executableSha256))
    throw new Error("Preflight: invalid CLI pin");
  equal(
    { ...executor, executableVersion: null, executableSha256: null },
    {
      adapter: "codex",
      executableVersion: null,
      executableSha256: null,
      model: "gpt-6-astra",
      effort: "medium",
      adapterPath: "adapters/codex/adapter.mjs",
      timeoutMs: 900000,
    },
    "executor configuration",
  );
  equal(c.limits, p1Limits, "limits");
  equal(c.maxConcurrency, 1, "concurrency");
  equal(
    c.procedure,
    {
      order: ["H", "S", "T"],
      replacement: "at-most-one-operational-per-condition",
    },
    "procedure",
  );
  if (!allowUnfrozen && c.status !== "frozen")
    throw new Error("Preflight: trusted-local contract is unfrozen");
  return c as unknown as TrustedLocalContract;
}

/** Reads R's committed blob and compares its checkout; never accepts P as authority. */
export function runtimeBlob(root: string, path: string, gitExecutable = "git") {
  const target = localPath(root, path);
  const mode = gitAt(gitExecutable, root, "ls-tree", "HEAD", "--", path).split(
    " ",
  )[0];
  if (mode !== "100644" && mode !== "100755")
    throw new Error("Preflight: authority is not a committed regular file");
  const bytes = execFileSync(
    gitExecutable,
    ["--no-replace-objects", "-C", root, "show", `HEAD:${path}`],
    { env: gitEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
  );
  if (!readFileSync(target).equals(bytes))
    throw new Error(
      "Preflight: runtime authority differs from committed bytes",
    );
  return bytes;
}
export function bindTrustedLocal(
  pilot: Record<string, unknown>,
  root: string,
  allowUnfrozen = false,
  gitExecutable = "git",
) {
  closedAuthorityObject(
    pilot,
    [
      "schemaVersion",
      "id",
      "class",
      "testcase",
      "condition",
      "stirpiCommit",
      "trustedLocalContract",
      "hiddenEvaluationDuringRun",
    ],
    "Preflight: trusted-local pilot",
  );
  if (
    pilot.schemaVersion !== 3 ||
    pilot.class !== "pilot" ||
    !text(pilot.id) ||
    !["H", "S", "T"].includes(pilot.condition as string) ||
    !/^[a-f0-9]{40}$/.test(pilot.stirpiCommit as string) ||
    pilot.hiddenEvaluationDuringRun !== false
  )
    throw new Error("Preflight: invalid dedicated trusted-local pilot");
  equal(
    gitAt(gitExecutable, root, "rev-parse", "HEAD"),
    pilot.stirpiCommit,
    "runtime commit",
  );
  const pin = closedAuthorityObject(
    pilot.trustedLocalContract,
    ["id", "version", "path", "sha256"],
    "Preflight: trusted-local contract pin",
  );
  const file = parseLocalFilePin({ path: pin.path, sha256: pin.sha256 });
  equal(
    file.path,
    "docs/experiments/p1-hst/trusted-local-contract.json",
    "contract path",
  );
  const bytes = runtimeBlob(root, file.path, gitExecutable);
  equal(sha256(bytes), file.sha256, "contract hash");
  const contract = parseTrustedLocalContract(bytes, allowUnfrozen);
  equal(pin.id, contract.id, "contract ID");
  equal(pin.version, contract.version, "contract version");
  equal(pilot.testcase, contract.testcase, "testcase");
  const inputs = Object.fromEntries(
    Object.entries(contract.inputs).map(([name, p]) => {
      const input = runtimeBlob(root, p.path, gitExecutable);
      equal(sha256(input), p.sha256, `${name} hash`);
      return [name, input];
    }),
  ) as Record<keyof TrustedLocalContract["inputs"], Buffer>;
  return { contract, bytes, inputs };
}
export function assertLocalOptions(
  options: RunOptions,
  contract: TrustedLocalContract,
  root: string,
  gitExecutable = "git",
) {
  const allowed = [
    "verificationMode",
    "trustedLocalTools",
    "preregistration",
    "evaluatorWallTimeMs",
    "manifest",
    "condition",
    "source",
    "output",
    "executor",
    "publicEvaluator",
    "metadata",
    "budgets",
    "supervision",
    "maxSteps",
    "maxConcurrency",
    "timeoutMs",
    "signal",
    "observeEvent",
  ];
  if (Object.keys(options).some((key) => !allowed.includes(key)))
    throw new Error("Preflight: unknown trusted-local option/override");
  equal(options.verificationMode, "trusted-local", "mode");
  for (const key of ["preparation", "maxSteps", "timeoutMs"] as const)
    if (options[key] !== undefined)
      throw new Error(`Preflight: trusted-local override forbidden: ${key}`);
  if (options.maxConcurrency !== undefined)
    equal(options.maxConcurrency, 1, "concurrency");
  const manifestBytes = readFileSync(options.manifest);
  equal(
    sha256(manifestBytes),
    contract.inputs.manifest.sha256,
    "external manifest",
  );
  const manifest = parseAuthorityJson(manifestBytes) as Record<string, unknown>;
  equal(manifest.id, contract.testcase, "manifest ID");
  equal(
    manifest.sourceRepository,
    contract.source.repository,
    "source repository",
  );
  equal(manifest.sourceCommit, contract.source.commit, "source commit");
  equal(
    options.publicEvaluator,
    parseAuthorityJson(
      runtimeBlob(root, contract.inputs.evaluator.path, gitExecutable),
    ),
    "evaluator config",
  );
  if (
    options.metadata &&
    Object.keys(options.metadata).some((k) => !["model", "effort"].includes(k))
  )
    throw new Error("Preflight: trusted-local metadata override");
  if (options.metadata?.model !== undefined)
    equal(options.metadata.model, contract.executor.model, "model");
  if (options.metadata?.effort !== undefined)
    equal(options.metadata.effort, contract.executor.effort, "effort");
}
