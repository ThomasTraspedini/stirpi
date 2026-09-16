import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  frozenInput,
  git,
  prepareSource,
  sha256,
} from "../../src/experiments/inputs.js";
import {
  TrustedPreparation,
  bookingPreparation,
} from "../../src/experiments/preparation.js";
import {
  validatePublicEvaluator,
  type PublicEvaluatorConfig,
} from "../../src/experiments/evaluation.js";

const root = "/private/tmp/stirpi-p3-c01/";
const expectedSourceCommit = "bd9ae09ac74374199c48d22ec36c739600cfee59";
const expectedEvaluatorSha256 =
  "9215c50aa69af9218b3530f22959552cbd41e75c43eb71260b9a732cad950bc1";
const argumentsByName = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || !value || argumentsByName.has(name))
    throw new Error(
      "Usage: node --import tsx scripts/p3/booking-preflight.mts --source /absolute/booking-invariants --output /private/tmp/stirpi-p3-c01/new-output",
    );
  argumentsByName.set(name, value);
}
if (argumentsByName.size !== 2)
  throw new Error("Only --source and --output are accepted");
const source = argumentsByName.get("--source");
const outputArgument = argumentsByName.get("--output");
if (!source || !outputArgument || source !== resolve(source))
  throw new Error("Source must be an absolute path");
const output = resolve(outputArgument);
if (!output.startsWith(root) || output === root.slice(0, -1))
  throw new Error(`Output must be a new directory below ${root}`);
if (existsSync(output))
  throw new Error("Preflight output directory already exists");

const manifestPath = resolve("docs/experiments/d032/manifest.json");
const evaluatorPath = resolve("docs/experiments/d032/public-evaluator-v2.json");
const frozen = frozenInput(manifestPath);
if (frozen.manifest.sourceCommit !== expectedSourceCommit)
  throw new Error("Frozen manifest source commit does not match P3 authority");
const evaluatorBytes = readFileSync(evaluatorPath);
const evaluatorSha256 = sha256(evaluatorBytes);
if (evaluatorSha256 !== expectedEvaluatorSha256)
  throw new Error("Frozen evaluator SHA-256 does not match P3 authority");
const evaluator = JSON.parse(
  evaluatorBytes.toString("utf8"),
) as PublicEvaluatorConfig;
validatePublicEvaluator(evaluator);
if (!evaluator.checks || evaluator.completionPolicy !== "all_checks_pass")
  throw new Error(
    "Frozen evaluator must be an all_checks_pass check evaluator",
  );

mkdirSync(root, { recursive: true, mode: 0o700 });
mkdirSync(output, { recursive: false, mode: 0o700 });
const reportPath = `${output}/preflight-report.json`;
const report: Record<string, unknown> = {
  kind: "P3 trusted-local target preflight",
  status: "running",
  source: resolve(source),
  output,
  verificationMode: "trusted-local",
  manifest: {
    id: frozen.manifest.id,
    sourceRepository: frozen.manifest.sourceRepository,
    sourceCommit: frozen.manifest.sourceCommit,
    taskSha256: frozen.manifest.taskSha256,
  },
  evaluator: {
    id: evaluator.id,
    sha256: evaluatorSha256,
    checks: evaluator.checks.map((check) => ({
      id: check.id,
      executable: check.executable,
      args: check.args,
    })),
    completionPolicy: evaluator.completionPolicy,
  },
  preparation: {
    postgresImage: bookingPreparation.postgres.image,
    prerequisites: bookingPreparation.postgres.prerequisites,
    requiredModules: bookingPreparation.modules,
  },
  node: process.version,
  npm: null,
  transfer: null,
  checks: [],
  cleanup: "not-started",
};
const save = () =>
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });

let preparation: TrustedPreparation | undefined;
let cleanupFailure: Error | undefined;
try {
  report.npm = execFileSync("npm", ["--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  }).trim();
  const workspace = prepareSource(
    source,
    `${output}/transfer`,
    frozen.manifest,
  );
  const closure = git(workspace, "rev-list", "--all")
    .split("\n")
    .filter(Boolean);
  const ancestry = git(workspace, "rev-list", frozen.manifest.sourceCommit)
    .split("\n")
    .filter(Boolean);
  if (JSON.stringify(closure) !== JSON.stringify(ancestry))
    throw new Error(
      "Transferred repository contains objects outside frozen ancestry",
    );
  report.transfer = {
    workspace,
    head: git(workspace, "rev-parse", "HEAD"),
    closureCommits: closure,
    fsck: git(workspace, "fsck", "--no-dangling"),
  };
  save();

  preparation = new TrustedPreparation(bookingPreparation, save);
  preparation.prepare(workspace);
  report.preparationEvidence = preparation.records;
  report.resolvedModules = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createRequire } from 'node:module'; const require = createRequire(process.cwd() + '/package.json'); console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(bookingPreparation.modules)}.map(name => [name, require.resolve(name)]))))`,
      ],
      {
        cwd: workspace,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    ),
  );
  for (const check of evaluator.checks) {
    const environment = preparation.verificationEnvironment(workspace, check, {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    });
    const result = spawnSync(check.executable, check.args, {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
      shell: false,
      timeout: 300000,
      maxBuffer: 1024 * 1024,
    });
    const status = {
      id: check.id,
      exitStatus: result.status,
      signal: result.signal,
      passed: !result.error && result.status === 0,
      error: result.error?.message ?? null,
    };
    (report.checks as unknown[]).push(status);
    save();
    if (!status.passed) throw new Error(`Public check failed: ${check.id}`);
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (preparation) {
    try {
      preparation.cleanup();
      report.cleanup = "passed";
    } catch (error) {
      report.cleanup = "failed";
      report.cleanupError =
        error instanceof Error ? error.message : String(error);
      if (report.status === "passed") {
        report.status = "failed";
        cleanupFailure =
          error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  report.preparationEvidence = preparation?.records ?? [];
  save();
}

console.log(reportPath);
if (cleanupFailure) throw cleanupFailure;
