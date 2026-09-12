import { environmentEvidence } from "../operational/diagnostics.js";
import {
  validatePolicy,
  type InvocationPolicy,
  type RunBudgets,
  type SupervisionObserver,
} from "../supervision/index.js";
import {
  hash,
  summarize,
  type OperationalEvent,
  type OperationalObserver,
} from "../operational/index.js";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  existsSync,
  cpSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { simulateAsync } from "../engine/index.js";
import { ProcessExecutor, type ProcessConfig } from "../executor/process.js";
import { OperationalFailure, validateResponse } from "../executor/protocol.js";
import type { ExecutorContext } from "../executor/index.js";
import type { State } from "../domain/index.js";
import { Store, jsonl } from "../persistence/index.js";
import { tree } from "../render/index.js";
import { assertExternalGitState } from "../artifacts/git.js";
import { frozenInput, git, prepareSource, sha256, transfer } from "./inputs.js";
import { ExperimentArtifacts } from "./artifacts.js";
import { control, type Condition } from "./protocol.js";
import {
  runtimeEvaluator,
  validatePublicEvaluator,
  type PublicEvaluatorConfig,
  type EvaluationRecord,
} from "./evaluation.js";

import { runPinnedRuntime } from "./runtime-identity.js";
import { preregisteredOptions } from "./preregistration.js";

export interface RunOptions {
  preregistration?: string;
  evaluatorWallTimeMs?: number;
  manifest: string;
  condition: Condition;
  source: string;
  output: string;
  executor: ProcessConfig;
  publicEvaluator: PublicEvaluatorConfig;
  metadata?: {
    executorVersion?: string;
    model?: string;
    modelVersion?: string;
    effort?: string;
    sampling?: string;
    baselinePolicy?: string;
  };
  budgets?: RunBudgets;
  supervision?: InvocationPolicy;
  maxSteps?: number;
  maxConcurrency?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  observeEvent?: OperationalObserver;
}
const save = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
export async function runExperiment(
  options: RunOptions,
): Promise<Awaited<ReturnType<typeof runExperimentLocally>>> {
  if (
    options.preregistration &&
    "stirpiCommit" in JSON.parse(readFileSync(options.preregistration, "utf8"))
  )
    return runPinnedRuntime(options);
  return runExperimentLocally(options);
}

export async function runExperimentLocally(options: RunOptions) {
  const frozen = frozenInput(options.manifest);
  const preflight = preregisteredOptions(options, frozen.manifest.id);
  const { signal, observeEvent, ...configuration } = preflight.options;
  options = {
    ...structuredClone(configuration),
    ...(signal ? { signal } : {}),
    ...(observeEvent ? { observeEvent } : {}),
  };
  if (!["H", "S", "T"].includes(options.condition))
    throw new Error("Condition must be H, S or T");
  const evaluator = options.publicEvaluator;
  validatePublicEvaluator(evaluator);
  for (const command of [
    options.executor,
    ...(evaluator.checks ?? [evaluator.command]),
  ]) {
    if (
      !command ||
      Object.keys(command).some(
        (key) =>
          !(
            evaluator.checks?.some((check) => check === command)
              ? ["id", "executable", "args", "workingDirectory"]
              : ["id", "executable", "args"]
          ).includes(key),
      )
    )
      throw new Error("Command configuration contains unsupported fields");
    if (
      command.args?.some((arg) =>
        /^--?(?:api[-_]?key|token|password|secret|authorization|access[-_]?token)(?:=|$)/i.test(
          arg,
        ),
      )
    )
      throw new Error(
        "Credentials must not be supplied as recorded command arguments",
      );
  }
  if (
    options.metadata &&
    Object.entries(options.metadata).some(
      ([key, value]) =>
        ![
          "executorVersion",
          "model",
          "modelVersion",
          "effort",
          "sampling",
          "baselinePolicy",
        ].includes(key) || typeof value !== "string",
    )
  )
    throw new Error(
      "Metadata must contain only supported nonsensitive string fields",
    );
  // Validate the executor before creating a run.
  new ProcessExecutor(options.executor);

  validatePolicy(options.supervision ?? {});
  const config = {
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(options.budgets ? { budgets: options.budgets } : {}),
    maxConcurrency: options.maxConcurrency ?? 1,
  };
  const timeoutMs = options.timeoutMs;
  const evaluatorTimeoutMs = options.evaluatorWallTimeMs;
  if (
    evaluatorTimeoutMs !== undefined &&
    (!Number.isSafeInteger(evaluatorTimeoutMs) ||
      evaluatorTimeoutMs < 1 ||
      evaluatorTimeoutMs > 2147483647)
  )
    throw new Error("Invalid evaluator wall-time budget");
  if (
    (config.maxSteps !== undefined &&
      (!Number.isSafeInteger(config.maxSteps) || config.maxSteps < 0)) ||
    !Number.isSafeInteger(config.maxConcurrency) ||
    config.maxConcurrency < 1 ||
    (timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 2147483647))
  )
    throw new Error("Invalid resource limits");
  const output = resolve(options.output);
  if (existsSync(options.source))
    assertExternalGitState(options.source, [output]);
  mkdirSync(output, { recursive: true });
  const runId = randomUUID();
  const directory = join(output, runId);
  mkdirSync(directory, { mode: 0o700 });
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const identity = {
    testcase: frozen.manifest.id,
    condition: options.condition,
    runId,
    kind: "pilot",
    sourceRepository: frozen.manifest.sourceRepository,
    sourceCommit: frozen.manifest.sourceCommit,
    taskSha256: frozen.manifest.taskSha256,
    startedAt,
    executorConfigurationId: sha256(
      JSON.stringify({
        executor: options.executor,
        metadata: options.metadata ?? {},
        config,
        timeoutMs,
        supervision: options.supervision,
        evaluatorWallTimeMs: evaluatorTimeoutMs,
        control: control(options.condition),
      }),
    ),
  };
  const diagnosticEnvironment = environmentEvidence(process.env, {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    TZ: "UTC",
    HOME: "experiment-local",
    TMPDIR: "experiment-local",
  });
  if (preflight.evidence)
    Object.assign(preflight.evidence, { diagnosticEnvironment });
  if (preflight.evidence)
    save(join(directory, "preflight.json"), preflight.evidence);
  save(join(directory, "metadata.json"), {
    diagnosticEnvironment,
    statePlacement: "experiment_local",
    preflight: preflight.evidence,
    ...identity,
    executor: options.executor,
    executorVersion: options.metadata?.executorVersion ?? null,
    model: options.metadata?.model ?? null,
    modelVersion: options.metadata?.modelVersion ?? null,
    effort: options.metadata?.effort ?? null,
    sampling: options.metadata?.sampling ?? null,
    baselinePolicy: options.metadata?.baselinePolicy ?? null,
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    limits: {
      ...config,
      supervision: options.supervision ?? {},
      executorWallTimeMs: timeoutMs ?? null,
      evaluatorWallTimeMs: evaluatorTimeoutMs ?? null,
      processOutputBytes: 1048576,
    },
    publicEvaluator: evaluator,
    control: control(options.condition),
    environment:
      "PATH, LANG, TZ; empty per-work HOME and TMPDIR; no inherited credentials",
  });
  writeFileSync(join(directory, "task.txt"), frozen.bytes);
  writeFileSync(join(directory, "running"), "solver phase\n", { flag: "wx" });
  const evaluations: EvaluationRecord[] = [];
  const evaluationPath = join(directory, "runtime-evaluations.json");
  save(evaluationPath, evaluations);
  const invocationPath = join(directory, "invocations.jsonl");
  writeFileSync(invocationPath, "", { mode: 0o600 });
  const operationalEvents: OperationalEvent[] = [];
  const operationalPath = join(directory, "operational.jsonl");
  writeFileSync(operationalPath, "", { mode: 0o600 });
  let invocations = 0;
  let humanGate = false;
  let state: State | undefined;
  let error: string | null = null;
  let archive: string | undefined;
  try {
    archive = prepareSource(options.source, directory, frozen.manifest);
    const home = join(directory, "executor-home");
    mkdirSync(home);
    const environment = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      TZ: "UTC",
      HOME: home,
      TMPDIR: home,
    };
    const executor = {
      protocol: 1 as const,
      id: options.executor.id ?? options.executor.executable,
      async execute(
        context: ExecutorContext,
        observe?: OperationalObserver,
        supervise?: SupervisionObserver,
      ) {
        if (humanGate)
          throw new OperationalFailure({
            code: "HUMAN_GATE_CLOSED",
            message: "Run stopped pending human decision",
          });
        // Return only this work's own spawned artifact outcomes to its object database.
        for (const child of context.results)
          for (const ref of child.artifacts ?? []) {
            transfer(archive!, context.work.artifact!.worktree!, ref);
          }
        const localHome = join(home, context.work.id);
        mkdirSync(localHome, { recursive: true });
        const index = ++invocations;
        const local = {
          ...context,
          task: frozen.task,
          control: control(options.condition),
        };
        appendFileSync(
          invocationPath,
          JSON.stringify({
            type: "started",
            index,
            timestamp: new Date().toISOString(),
            lineageId: context.work.lineageId,
            workId: context.work.id,
            artifactBefore: context.work.artifact?.ref ?? null,
            input: local,
          }) + "\n",
        );
        const processExecutor = new ProcessExecutor(options.executor, {
          environment: { ...environment, HOME: localHome, TMPDIR: localHome },
          ...(options.supervision ? { supervision: options.supervision } : {}),
          observeSupervision(observation) {
            appendFileSync(
              invocationPath,
              JSON.stringify({ type: "supervision", index, observation }) +
                "\n",
            );
          },
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          observeEvent(event) {
            operationalEvents.push(structuredClone(event));
            appendFileSync(
              operationalPath,
              JSON.stringify({
                sequence: operationalEvents.length,
                index,
                event,
              }) + "\n",
            );
            options.observeEvent?.(structuredClone(event));
          },
          observe(observation) {
            appendFileSync(
              invocationPath,
              JSON.stringify({
                type: "process",
                index,
                ...observation,
                stdout: undefined,
                stderr: undefined,
                stdoutBytes: Buffer.byteLength(observation.stdout),
                stdoutHash: hash(observation.stdout),
                stderrBytes: Buffer.byteLength(observation.stderr),
                stderrHash: hash(observation.stderr),
              }) + "\n",
            );
          },
        });
        try {
          const response = await processExecutor.execute(
            local,
            observe,
            supervise,
          );
          const validated = validateResponse(response);
          if (options.condition !== "T" && validated.action.type === "FORK")
            throw new OperationalFailure({
              code: "ACTION_UNAVAILABLE",
              message: "FORK is unavailable in this condition",
            });
          if (
            options.condition === "H" &&
            validated.action.type === "BLOCK" &&
            validated.action.reason.code === "HUMAN_DECISION_REQUIRED"
          )
            humanGate = true;
          appendFileSync(
            invocationPath,
            JSON.stringify({
              type: "returned",
              index,
              timestamp: new Date().toISOString(),
              response,
            }) + "\n",
          );
          return response;
        } catch (failure) {
          appendFileSync(
            invocationPath,
            JSON.stringify({
              type: "failed",
              index,
              timestamp: new Date().toISOString(),
              error:
                failure instanceof Error ? failure.message : String(failure),
              reason:
                failure instanceof OperationalFailure ? failure.reason : null,
            }) + "\n",
          );
          throw failure;
        }
      },
    };
    const artifacts = new ExperimentArtifacts(
      archive,
      join(directory, "worlds"),
      frozen.manifest.sourceCommit,
    );
    state = await simulateAsync(
      {
        name: frozen.manifest.id,
        objective: frozen.task,
        publicEvaluation: evaluator.criteria,
        hiddenEvaluation: { requiredText: "" },
        scripts: {},
      },
      config,
      executor,
      runtimeEvaluator(
        evaluator,
        home,
        environment,
        evaluatorTimeoutMs,
        evaluations,
        () => save(evaluationPath, evaluations),
      ),
      { taskId: frozen.manifest.id, runId },
      {
        perform(request) {
          const startedAt = new Date().toISOString();
          const outcome = artifacts.perform(request);
          appendFileSync(
            invocationPath,
            JSON.stringify({
              type: "artifact",
              index: invocations || null,
              startedAt,
              completedAt: new Date().toISOString(),
              request,
              outcome,
            }) + "\n",
          );
          return outcome;
        },
      },
    );
    save(join(directory, "state.json"), state);
    writeFileSync(join(directory, "events.jsonl"), jsonl(state));
    writeFileSync(join(directory, "tree.txt"), tree(state) + "\n");
    const store = new Store(join(directory, "state.sqlite"));
    try {
      store.save(state);
    } finally {
      store.close();
    }
    for (const work of state.work) {
      if (!work.artifact) continue;
      writeFileSync(
        join(directory, `${work.id}.diff`),
        git(
          archive,
          "diff",
          "--binary",
          frozen.manifest.sourceCommit,
          work.artifact.ref,
        ) + "\n",
      );
      if (work.artifact.worktree && !work.artifact.cleaned) {
        cpSync(
          work.artifact.worktree,
          join(directory, "pending-workspaces", work.id),
          {
            recursive: true,
            dereference: false,
            filter: (path) => path !== join(work.artifact!.worktree!, ".git"),
          },
        );
        writeFileSync(
          join(directory, `${work.id}.uncommitted.diff`),
          git(work.artifact.worktree, "diff", "--binary", "HEAD") + "\n",
        );
        writeFileSync(
          join(directory, `${work.id}.status.txt`),
          git(
            work.artifact.worktree,
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignored",
          ) + "\n",
        );
      }
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const completedAt = new Date().toISOString();
  const humanRequests =
    state?.work.filter((w) => w.reason?.code === "HUMAN_DECISION_REQUIRED") ??
    [];
  const result = {
    ...identity,
    phase: "finished",
    completedAt,
    runtimeOutcome: state?.status ?? "OPERATIONAL_FAILURE",
    error,
    lineages: state?.lineages ?? [],
    artifacts:
      state?.work.map((w) => ({
        workId: w.id,
        lineageId: w.lineageId,
        status: w.status,
        reason: w.reason,
        result: w.result,
        artifact: w.artifact ?? null,
      })) ?? [],
    resources: {
      executorInvocations: invocations,
      engineSteps: state?.resources.steps ?? 0,
      wallTimeMs: performance.now() - start,
      logicalLineages: state?.lineages.length ?? 0,
      scheduledLineages: new Set(
        state?.work
          .filter((w) => w.resources.steps > 0)
          .map((w) => w.lineageId),
      ).size,
      artifactCommits: new Set(
        state?.artifactOperations
          ?.filter(
            (o) =>
              o.request.type === "COMMIT" &&
              o.outcome.artifact &&
              o.outcome.artifact.ref !== o.request.base,
          )
          .map((o) => o.outcome.artifact!.ref),
      ).size,
      humanInterventions: 0,
      tokens: null,
      operational: summarize(operationalEvents),
      monetaryCost: null,
    },
    humanIntervention: {
      required: humanRequests.length > 0,
      requests: humanRequests.map((w) => ({ workId: w.id, reason: w.reason })),
      supplied: 0,
    },
    evidence: {
      preflight: preflight.evidence ? "preflight.json" : null,
      invocations: "invocations.jsonl",
      operational: "operational.jsonl",
      runtimeEvaluations: "runtime-evaluations.json",
      events: state ? "events.jsonl" : null,
      state: state ? "state.json" : null,
      tree: state ? "tree.txt" : null,
      archive: archive ? "artifacts" : null,
    },
  };
  save(join(directory, "result.json"), result);
  rmSync(join(directory, "running"));
  return { directory, result, state };
}
