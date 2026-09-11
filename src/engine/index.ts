import type { ArtifactBackend, ArtifactRequest } from "../artifacts/index.js";
import {
  dna,
  sumResources,
  zero,
  type Config,
  type RunIdentity,
  type Lineage,
  type Scenario,
  type State,
  type WorkUnit,
} from "../domain/index.js";
import {
  ScriptedExecutor,
  validateAction,
  type Executor,
} from "../executor/index.js";
import { FakeEvaluator, type Evaluator } from "../evaluation/index.js";
import { select } from "../scheduler/index.js";
export function simulate(
  scenario: Scenario,
  config: Config = { maxConcurrency: 1, maxSteps: 100 },
  executor: Executor = new ScriptedExecutor(scenario.scripts),
  evaluator: Evaluator = new FakeEvaluator(scenario.hiddenEvaluation),
  identity: RunIdentity = { taskId: `task:${scenario.name}`, runId: "run" },
  artifactBackend?: ArtifactBackend,
): State {
  if (
    !Number.isSafeInteger(config.maxConcurrency) ||
    config.maxConcurrency < 1 ||
    !Number.isSafeInteger(config.maxSteps) ||
    config.maxSteps < 0
  )
    throw new Error(
      "Concurrency must be positive and steps nonnegative safe integers",
    );
  const state: State = {
    ...identity,
    status: "ACTIVE",
    reason: null,
    scenario: structuredClone(scenario),
    config: { ...config },
    lineages: [],
    work: [],
    events: [],
    resources: zero(),
    nextQueue: 0,
  };
  const emit = (type: string, subject: string, data: unknown = {}) =>
    state.events.push({
      seq: state.events.length + 1,
      type,
      subject,
      data: structuredClone(data),
    });
  const addWork = (
    lineage: Lineage,
    name: string,
    objective: string,
    parentId: string | null,
    priority: number,
  ) => {
    const w: WorkUnit = {
      ...(lineage.artifact
        ? {
            artifact: { ref: lineage.artifact.ref, base: lineage.artifact.ref },
          }
        : {}),
      id: `w${state.work.length + 1}`,
      lineageId: lineage.id,
      parentId,
      name,
      objective,
      priority,
      status: "ACTIVE",
      queue: state.nextQueue++,
      cursor: 0,
      result: null,
      artifacts: [],
      reason: null,
      resources: zero(),
    };
    state.work.push(w);
    return w;
  };
  const addLineage = (
    name: string,
    objective: string,
    parentId: string | null,
    assumption: string | null,
    rationale: string | null,
    priority: number,
  ) => {
    const inherited = state.lineages.find((l) => l.id === parentId)?.artifact;
    const l: Lineage = {
      ...(inherited
        ? { artifact: { ref: inherited.ref, base: inherited.ref } }
        : {}),
      id: `l${state.lineages.length + 1}`,
      name,
      objective,
      parentId,
      assumption,
      rationale,
      priority,
      status: "ACTIVE",
      reason: null,
    };
    state.lineages.push(l);
    addWork(l, name, objective, null, priority);
    return l;
  };
  const root = addLineage("root", scenario.objective, null, null, null, 0);
  emit("RUN_STARTED", state.runId, {
    taskId: state.taskId,
    config,
    root: root.id,
    objective: scenario.objective,
    publicEvaluation: scenario.publicEvaluation,
  });
  const sync = (w: WorkUnit) => {
    if (w.parentId === null) {
      const l = state.lineages.find((l) => l.id === w.lineageId)!;
      l.status = w.status;
      l.reason = w.reason;
    }
  };
  const block = (w: WorkUnit, code: string, message: string) => {
    w.status = "BLOCKED";
    w.reason = { code, message };
    sync(w);
    emit("BLOCKED", w.id, w.reason);
  };
  const effect = (request: ArtifactRequest) => {
    const outcome = artifactBackend!.perform(structuredClone(request));
    const operation = structuredClone({ request, outcome });
    (state.artifactOperations ??= []).push(operation);
    emit(
      "ARTIFACT_OPERATION",
      request.type === "INITIALIZE" ? state.runId : request.workId,
      operation,
    );
    return outcome;
  };
  if (artifactBackend) {
    const outcome = effect({ type: "INITIALIZE", ...identity });
    if (outcome.ok) {
      root.artifact = structuredClone(outcome.artifact);
      state.work[0]!.artifact = structuredClone(outcome.artifact);
    } else block(state.work[0]!, outcome.reason.code, outcome.reason.message);
  }
  const artifactAttempted = new Set<string>();
  const resume = () => {
    for (const w of state.work)
      if (
        w.status === "WAITING" &&
        state.work
          .filter((c) => c.parentId === w.id)
          .every((c) =>
            ["BLOCKED", "DEAD", "COMPLETED", "BRANCHED"].includes(c.status),
          )
      ) {
        w.status = "ACTIVE";
        w.queue = state.nextQueue++;
        sync(w);
        emit("RESUMED", w.id, {
          results: state.work
            .filter((c) => c.parentId === w.id)
            .map((c) => ({ id: c.id, status: c.status, result: c.result })),
        });
      }
  };
  while (true) {
    resume();
    const batch = select(state.work, config.maxConcurrency);
    if (!batch.length) break;
    if (state.resources.steps >= config.maxSteps) {
      for (const w of state.work)
        if (w.status === "ACTIVE" || w.status === "WAITING")
          block(w, "STEP_BUDGET", "Run step budget exhausted");
      break;
    }
    emit("SCHEDULED", state.runId, {
      work: batch
        .slice(0, config.maxSteps - state.resources.steps)
        .map((w) => w.id),
    });
    for (const w of batch) {
      if (state.resources.steps >= config.maxSteps) break;
      w.resources.steps++;
      w.resources.tokens += 10;
      w.resources.cost += 1;
      w.resources.wallTimeMs += 1;
      state.resources = sumResources(state.work);
      if (artifactBackend && w.artifact && !artifactAttempted.has(w.id)) {
        artifactAttempted.add(w.id);
        const outcome = effect({
          type: "EXECUTE",
          ...identity,
          lineageId: w.lineageId,
          workId: w.id,
          name: w.name,
          base: w.artifact.ref,
        });
        if (outcome.artifact) {
          w.artifact = structuredClone(outcome.artifact);
          w.artifacts = [w.artifact.ref];
          if (w.parentId === null)
            state.lineages.find((l) => l.id === w.lineageId)!.artifact =
              structuredClone(w.artifact);
        }
        if (!outcome.ok) {
          block(w, outcome.reason.code, outcome.reason.message);
          emit("RESOURCES", w.id, w.resources);
          continue;
        }
      }
      try {
        const action = validateAction(
          executor.execute(
            structuredClone({
              work: w,
              dna: dna(state, w.lineageId),
              publicEvaluation: scenario.publicEvaluation,
              results: state.work
                .filter((c) => c.parentId === w.id)
                .map((c) => ({
                  name: c.name,
                  status: c.status,
                  result: c.result,
                  reason: c.reason,
                  ...(artifactBackend
                    ? {
                        artifacts: c.artifacts,
                        ...(c.artifact ? { artifact: c.artifact } : {}),
                      }
                    : {}),
                })),
            }),
          ),
        );
        if (action.type === "FORK" && w.parentId !== null)
          throw new Error("Only lineage main work may FORK");
        const names =
          action.type === "FORK"
            ? action.alternatives.map((a) => a.name)
            : action.type === "SPAWN"
              ? action.work.map((a) => a.name)
              : [];
        if (
          new Set(names).size !== names.length ||
          names.some((name) => state.work.some((w) => w.name === name))
        )
          throw new Error("Work names must be unique within a run");
        const evaluation =
          action.type === "COMPLETE"
            ? evaluator.evaluate(
                action.result,
                structuredClone(scenario.publicEvaluation),
              )
            : null;
        w.cursor++;
        emit("ACTION", w.id, action);
        switch (action.type) {
          case "CONTINUE":
            w.queue = state.nextQueue++;
            break;
          case "BLOCK":
            block(w, action.reason.code, action.reason.message);
            break;
          case "COMPLETE":
            w.result = action.result;
            w.artifacts = w.artifact
              ? [w.artifact.ref]
              : (action.artifacts ?? []);
            if (!evaluation!.passed)
              block(w, "EVALUATION_FAILED", evaluation!.reason);
            else {
              w.status = "COMPLETED";
              emit("COMPLETED", w.id, { result: w.result, evaluation });
            }
            break;
          case "FORK":
            w.status = "BRANCHED";
            for (const a of action.alternatives) {
              const child = addLineage(
                a.name,
                a.objective ?? w.objective,
                w.lineageId,
                a.assumption,
                a.rationale,
                a.priority ?? w.priority,
              );
              emit("FORK", w.id, { lineage: child });
            }
            break;
          case "SPAWN":
            w.status = "WAITING";
            for (const child of action.work) {
              const spawned = addWork(
                state.lineages.find((l) => l.id === w.lineageId)!,
                child.name,
                child.objective,
                w.id,
                child.priority ?? w.priority,
              );
              if (w.artifact)
                spawned.artifact = {
                  ref: w.artifact.ref,
                  base: w.artifact.ref,
                };
              emit("SPAWN", w.id, { work: spawned });
            }
            break;
        }
        sync(w);
      } catch (error) {
        w.cursor++;
        block(
          w,
          "INVALID_EXECUTOR_ACTION",
          error instanceof Error ? error.message : String(error),
        );
      }
      emit("RESOURCES", w.id, w.resources);
    }
  }
  state.resources = sumResources(state.work);
  state.status = state.work.some((w) => w.status === "BLOCKED")
    ? "BLOCKED"
    : "COMPLETED";
  state.reason =
    state.status === "BLOCKED"
      ? { code: "UNRESOLVED_WORK", message: "Run quiescent with blocked work" }
      : null;
  emit("RUN_FINISHED", state.runId, {
    status: state.status,
    reason: state.reason,
    resources: state.resources,
  });
  return state;
}
