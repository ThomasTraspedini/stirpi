import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import {
  authorityObject,
  parseAuthorityJson,
} from "../../src/authority/json.js";
import {
  boundedPublicOutput,
  type CommandCheckProcess,
  type PublicCheck,
} from "../../src/evaluation/commands.js";
import {
  validatePublicEvaluator,
  type PublicEvaluatorConfig,
} from "../../src/experiments/evaluation.js";
import {
  frozenInput,
  gitAt,
  prepareSource,
  sha256,
} from "../../src/experiments/inputs.js";
import {
  TrustedPreparation,
  assertTrustedLocalCheck,
  trustedProcess,
  type TrustedProcess,
} from "../../src/experiments/preparation.js";
import { assertRuntimeCheckout } from "../../src/experiments/runtime-identity.js";
import { TrustedLocalAuthority } from "../../src/experiments/trusted-local-authority.js";
import { bindTrustedLocal } from "../../src/experiments/trusted-local-contract.js";
import {
  defaultLocalTools,
  verifyLocalTools,
  type LocalToolLocations,
} from "../../src/experiments/trusted-local-identity.js";

type FailureCategory = "operational" | "public-check";
type PhaseStatus = "passed" | "failed";
interface PhaseEvidence {
  id: string;
  status: PhaseStatus;
  detail?: string;
}
interface FailureEvidence {
  category: FailureCategory | "cleanup";
  phase: string;
  message: string;
}
interface PublicCheckEvidence {
  id: string;
  processStatus: "exited" | "signaled" | "operational_error";
  exitStatus: number | null;
  signal: string | null;
  passed: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  error: string | null;
}
export interface Schema3PreflightEvidence {
  kind: "p1-hst-schema-3-preflight-only";
  version: 1;
  status: "running" | "passed" | "failed";
  verificationMode: "trusted-local";
  runtime: { checkout: string; pinnedCommit: string | null };
  pilot: { path: string; sha256: string };
  source: string;
  output: string;
  contract: null | {
    id: string;
    version: number;
    status: "unfrozen" | "frozen";
    sha256: string;
  };
  publicInputs: null | Record<string, { path: string; sha256: string }>;
  tools: LocalToolLocations | null;
  transfer: null | {
    workspace: string;
    head: string;
    closureCommits: string[];
    fsck: string;
  };
  preparation: unknown[];
  publicChecks: PublicCheckEvidence[];
  phases: PhaseEvidence[];
  primaryFailure: FailureEvidence | null;
  cleanup: "not-required" | "passed" | "failed";
  cleanupFailure: FailureEvidence | null;
  executorInvocations: 0;
  modelInvocations: 0;
  lineagesCreated: 0;
}
export interface Schema3PreflightOptions {
  runtime: string;
  pilot: string;
  source: string;
  output: string;
  tools?: LocalToolLocations;
}
export interface Schema3PreflightDependencies {
  trustedProcess?: TrustedProcess;
  publicCheckProcess?: CommandCheckProcess;
}

class PublicCheckFailure extends Error {}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function prospectiveRealpath(path: string) {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    suffix.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...suffix);
}

function assertOutside(root: string, path: string, label: string) {
  const rel = relative(realpathSync(root), prospectiveRealpath(path));
  if (!rel || (!rel.startsWith("../") && !isAbsolute(rel)))
    throw new Error(`Schema-3 preflight output must be outside ${label}`);
}

function defaultPublicCheckProcess(
  check: PublicCheck,
  options: Parameters<CommandCheckProcess>[1],
) {
  return spawnSync(check.executable, check.args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    shell: false,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
  });
}

export function runSchema3Preflight(
  options: Schema3PreflightOptions,
  dependencies: Schema3PreflightDependencies = {},
): Schema3PreflightEvidence {
  for (const [name, path] of Object.entries({
    runtime: options.runtime,
    pilot: options.pilot,
    source: options.source,
    output: options.output,
  }))
    if (!isAbsolute(path) || path !== resolve(path))
      throw new Error(`Schema-3 preflight ${name} path must be absolute`);
  if (
    !existsSync(options.runtime) ||
    !existsSync(options.pilot) ||
    !existsSync(options.source)
  )
    throw new Error("Schema-3 preflight input path is unavailable");
  if (existsSync(options.output))
    throw new Error("Schema-3 preflight output must not already exist");
  assertOutside(options.runtime, options.output, "runtime R");
  assertOutside(options.source, options.output, "the target");

  const runtime = realpathSync(options.runtime);
  const pilotPath = realpathSync(options.pilot);
  const source = realpathSync(options.source);
  const output = prospectiveRealpath(options.output);
  const pilotBytes = readFileSync(pilotPath);
  const pilot = authorityObject(
    parseAuthorityJson(pilotBytes),
    "Schema-3 preflight pilot",
  );
  const tools = structuredClone(options.tools ?? defaultLocalTools());
  const run = dependencies.trustedProcess ?? trustedProcess;
  const runCheck = dependencies.publicCheckProcess ?? defaultPublicCheckProcess;

  mkdirSync(output, { recursive: false, mode: 0o700 });
  const reportPath = join(output, "schema3-preflight-evidence.json");
  const report: Schema3PreflightEvidence = {
    kind: "p1-hst-schema-3-preflight-only",
    version: 1,
    status: "running",
    verificationMode: "trusted-local",
    runtime: { checkout: runtime, pinnedCommit: null },
    pilot: { path: pilotPath, sha256: sha256(pilotBytes) },
    source,
    output,
    contract: null,
    publicInputs: null,
    tools: null,
    transfer: null,
    preparation: [],
    publicChecks: [],
    phases: [],
    primaryFailure: null,
    cleanup: "not-required",
    cleanupFailure: null,
    executorInvocations: 0,
    modelInvocations: 0,
    lineagesCreated: 0,
  };
  const save = () =>
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  const phase = (id: string, action: () => void) => {
    try {
      action();
      report.phases.push({ id, status: "passed" });
      save();
    } catch (error) {
      report.phases.push({ id, status: "failed", detail: message(error) });
      save();
      throw error;
    }
  };

  let preparation: TrustedPreparation | undefined;
  let workspace: string | undefined;
  let evaluator: PublicEvaluatorConfig | undefined;
  try {
    let binding: ReturnType<typeof bindTrustedLocal> | undefined;
    phase("runtime-authority", () => {
      if (
        typeof pilot.stirpiCommit !== "string" ||
        !/^[a-f0-9]{40}$/.test(pilot.stirpiCommit)
      )
        throw new Error("Preflight: invalid runtime pin");
      report.runtime.pinnedCommit = pilot.stirpiCommit;
      assertRuntimeCheckout(runtime, pilot.stirpiCommit, tools.git);
      binding = bindTrustedLocal(pilot, runtime, true, tools.git);
      report.contract = {
        id: binding.contract.id,
        version: binding.contract.version,
        status: binding.contract.status,
        sha256: sha256(binding.bytes),
      };
      report.publicInputs = Object.fromEntries(
        Object.entries(binding.contract.inputs).map(([name, pin]) => [
          name,
          { path: pin.path, sha256: pin.sha256 },
        ]),
      );
    });
    phase("toolchain", () => {
      report.tools = verifyLocalTools(binding!.contract, tools, run);
    });
    phase("public-inputs", () => {
      const frozen = frozenInput(
        join(runtime, binding!.contract.inputs.manifest.path),
      );
      if (
        frozen.manifest.id !== binding!.contract.testcase ||
        frozen.manifest.sourceRepository !==
          binding!.contract.source.repository ||
        frozen.manifest.sourceCommit !== binding!.contract.source.commit ||
        sha256(frozen.bytes) !== binding!.contract.inputs.task.sha256
      )
        throw new Error("Preflight: contract/public manifest mismatch");
      evaluator = parseAuthorityJson(
        binding!.inputs.evaluator,
      ) as PublicEvaluatorConfig;
      validatePublicEvaluator(evaluator);
      if (!evaluator.checks || evaluator.completionPolicy !== "all_checks_pass")
        throw new Error(
          "Preflight: public evaluator must use all_checks_pass checks",
        );
      for (const check of evaluator.checks) assertTrustedLocalCheck(check);
    });
    phase("target-transfer", () => {
      const manifest = frozenInput(
        join(runtime, binding!.contract.inputs.manifest.path),
      ).manifest;
      workspace = prepareSource(
        source,
        join(output, "transfer"),
        manifest,
        tools.git,
      );
      const closure = gitAt(tools.git, workspace, "rev-list", "--all")
        .split("\n")
        .filter(Boolean);
      const ancestry = gitAt(
        tools.git,
        workspace,
        "rev-list",
        binding!.contract.source.commit,
      )
        .split("\n")
        .filter(Boolean);
      if (JSON.stringify(closure) !== JSON.stringify(ancestry))
        throw new Error("Preflight: transferred target closure mismatch");
      report.transfer = {
        workspace,
        head: gitAt(tools.git, workspace, "rev-parse", "HEAD"),
        closureCommits: closure,
        fsck: gitAt(tools.git, workspace, "fsck", "--no-dangling"),
      };
    });
    const authority = new TrustedLocalAuthority(
      binding!.contract,
      tools,
      join(output, "trusted-state"),
      run,
    );
    phase("baseline", () => authority.assertBaseline(workspace!));
    preparation = new TrustedPreparation(
      {
        modules: binding!.contract.preparation.modules,
        postgres: {
          image: binding!.contract.preparation.postgres.imageId,
          prerequisites: binding!.contract.preparation.postgres.prerequisites,
        },
      },
      () => {
        report.preparation = structuredClone(preparation?.records ?? []);
        save();
      },
      run,
      authority,
    );
    phase("preparation", () => {
      preparation!.prepare(workspace!);
      report.preparation = structuredClone(preparation!.records);
    });
    phase("public-checks", () => {
      for (const check of evaluator!.checks!) {
        const env = preparation!.verificationEnvironment(workspace!, check, {
          HOME: join(output, "trusted-state", "preparation-home"),
        });
        const result = runCheck(check, {
          cwd: workspace!,
          env,
          input: "",
          timeoutMs: binding!.contract.limits.maxEvaluatorWallTimeMs,
          maxBuffer: 1024 * 1024,
        });
        const stdout = boundedPublicOutput(result.stdout ?? "", 1024 * 1024);
        const stderr = boundedPublicOutput(result.stderr ?? "", 1024 * 1024);
        const operational = Boolean(
          result.error || result.signal || result.status === null,
        );
        report.publicChecks.push({
          id: check.id,
          processStatus: result.error
            ? "operational_error"
            : result.signal
              ? "signaled"
              : "exited",
          exitStatus: result.status,
          signal: result.signal,
          passed: !operational && result.status === 0,
          stdout: stdout.value,
          stderr: stderr.value,
          outputTruncated: stdout.truncated || stderr.truncated,
          error: result.error
            ? boundedPublicOutput(result.error.message, 1024).value
            : null,
        });
        save();
        if (operational)
          throw new Error(`Public check ${check.id} failed operationally`);
      }
      const failed = report.publicChecks.filter((check) => !check.passed);
      if (failed.length)
        throw new PublicCheckFailure(
          `Public checks failed: ${failed.map((check) => check.id).join(", ")}`,
        );
    });
  } catch (error) {
    report.primaryFailure = {
      category:
        error instanceof PublicCheckFailure ? "public-check" : "operational",
      phase: report.phases.at(-1)?.id ?? "bootstrap",
      message: message(error),
    };
  } finally {
    if (preparation) {
      try {
        preparation.cleanup();
        report.cleanup = "passed";
      } catch (error) {
        report.cleanup = "failed";
        report.cleanupFailure = {
          category: "cleanup",
          phase: "cleanup",
          message: message(error),
        };
      }
      report.preparation = structuredClone(preparation.records);
    }
    report.status =
      report.primaryFailure === null && report.cleanupFailure === null
        ? "passed"
        : "failed";
    save();
  }
  return report;
}

function cliOptions(argv: string[]): Schema3PreflightOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !name ||
      !["--runtime", "--pilot", "--source", "--output"].includes(name) ||
      !value ||
      values.has(name)
    )
      throw new Error(
        "Usage: schema3-preflight.mts --runtime /absolute/R --pilot /absolute/pilot.json --source /absolute/target --output /absolute/new-evidence-directory",
      );
    values.set(name, value);
  }
  if (values.size !== 4)
    throw new Error("All schema-3 preflight paths are required");
  return {
    runtime: values.get("--runtime")!,
    pilot: values.get("--pilot")!,
    source: values.get("--source")!,
    output: values.get("--output")!,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const options = cliOptions(process.argv.slice(2));
  const evidence = runSchema3Preflight(options);
  console.log(join(evidence.output, "schema3-preflight-evidence.json"));
  if (evidence.status !== "passed") process.exitCode = 1;
}
