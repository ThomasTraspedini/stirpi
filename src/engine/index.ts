import type { ArtifactBackend } from "../artifacts/index.js";
import {
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
import {
  invoke,
  invokeAsync,
  type ExecutorOperation,
  validateResponse,
  OperationalFailure,
} from "../executor/protocol.js";
import { artifactEffects } from "./artifact-effects.js";
import { executorContext } from "../executor/context.js";
import { select } from "../scheduler/index.js";
function* simulation(
  scenario: Scenario,
  config: Config = { maxConcurrency: 1, maxSteps: 100 },
  executor: Executor = new ScriptedExecutor(scenario.scripts),
  evaluator: Evaluator = new FakeEvaluator(scenario.hiddenEvaluation),
  identity: RunIdentity = { taskId: `task:${scenario.name}`, runId: "run" },
  artifactBackend?: ArtifactBackend,
): Generator<
  import("../executor/index.js").ExecutorContext,
  State,
  ExecutorOperation
> {
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
    ...(executor.protocol
      ? {
          executor: {
            protocol: executor.protocol,
            id: executor.id ?? "external",
          },
        }
      : {}),
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
  const { effect, workspaceEffect } = artifactEffects(
    state,
    artifactBackend,
    emit,
  );
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
      if (
        !executor.protocol &&
        artifactBackend &&
        w.artifact &&
        !artifactAttempted.has(w.id)
      ) {
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
        if (
          executor.protocol &&
          artifactBackend &&
          w.artifact &&
          !artifactAttempted.has(w.id)
        ) {
          artifactAttempted.add(w.id);
          workspaceEffect(w, "OPEN");
        }
        const context = executorContext(
          state,
          w,
          !!artifactBackend,
          !!executor.protocol,
        );
        const operation = executor.protocol ? yield context : undefined;
        if (operation) emit("EXECUTOR_OPERATION", w.id, operation);
        if (operation && !operation.outcome.ok)
          throw new OperationalFailure(operation.outcome.reason);
        const response = operation?.outcome.ok
          ? validateResponse(operation.outcome.response)
          : undefined;
        const action =
          response?.action ?? validateAction(executor.execute(context));
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
        if (response) {
          for (const request of response.effects)
            workspaceEffect(w, "COMMIT", request.message);
          if (w.artifact && ["FORK", "SPAWN", "COMPLETE"].includes(action.type))
            workspaceEffect(w, "CHECK");
        }
        let evaluation = null;
        if (action.type === "COMPLETE") {
          const evaluationContext = {
            result: action.result,
            criteria: structuredClone(scenario.publicEvaluation),
            workId: w.id,
            lineageId: w.lineageId,
            ...(w.artifact ? { artifactRef: w.artifact.ref } : {}),
            ...(w.artifact?.worktree && !w.artifact.cleaned
              ? { workspacePath: w.artifact.worktree }
              : {}),
          };
          try {
            evaluation = evaluator.evaluate(structuredClone(evaluationContext));
            emit("EVALUATION_OPERATION", w.id, {
              context: evaluationContext,
              outcome: { ok: true, evaluation },
            });
          } catch (error) {
            const reason =
              error instanceof OperationalFailure
                ? error.reason
                : {
                    code: "PUBLIC_EVALUATOR_FAILED",
                    message:
                      error instanceof Error ? error.message : String(error),
                  };
            emit("EVALUATION_OPERATION", w.id, {
              context: evaluationContext,
              outcome: { ok: false, reason },
            });
            throw new OperationalFailure(reason);
          }
        }
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
          error instanceof OperationalFailure
            ? error.reason.code
            : "INVALID_EXECUTOR_ACTION",
          error instanceof Error ? error.message : String(error),
        );
      }
      emit("RESOURCES", w.id, w.resources);
    }
  }
  if (executor.protocol && artifactBackend) {
    for (const w of state.work)
      if (w.artifact?.worktree && !w.artifact.cleaned) {
        try {
          workspaceEffect(w, "RELEASE");
        } catch (error) {
          emit(
            "ARTIFACT_RELEASE_FAILURE",
            w.id,
            error instanceof OperationalFailure
              ? error.reason
              : { code: "ARTIFACT_RELEASE_FAILED", message: String(error) },
          );
        }
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

// Both drivers execute the same transition machine in the same scheduling order.
export function simulate(...args: Parameters<typeof simulation>): State {
  if (args[2]?.asynchronous)
    throw new Error("Async executor requires simulateAsync");
  const machine = simulation(...args);
  let next = machine.next();
  while (!next.done) next = machine.next(invoke(args[2]!, next.value));
  return next.value;
}
export async function simulateAsync(
  ...args: Parameters<typeof simulation>
): Promise<State> {
  const machine = simulation(...args);
  let next = machine.next();
  while (!next.done)
    next = machine.next(await invokeAsync(args[2]!, next.value));
  return next.value;
}
