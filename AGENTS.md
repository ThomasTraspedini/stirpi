# AGENTS.md

## Project

Stirpi is a lineage-based runtime for agentic problem solving.

The persistent conceptual unit is the lineage, not the model or executor.

## Ownership

Human-owned:
- semantics
- invariants
- architecture boundaries
- scope
- evaluation meaning
- unresolved trade-offs
- acceptance criteria

Agent-owned within those boundaries:
- implementation details
- focused tests
- local refactors
- code organization

If implementation pressure exposes a contradiction or requires changing
FORK, SPAWN, lineage lifecycle, inheritance, evaluation semantics, or another
human-owned invariant, stop and report it. Do not silently resolve it.

## Scope discipline

- Do not implement future milestones unless explicitly requested.
- Do not add unrelated features or speculative abstractions.
- Do not add dependencies merely for convenience.
- Report useful out-of-scope ideas instead of implementing them.
- Do not perform unrelated refactors while completing a task.

## FORK and SPAWN

FORK and SPAWN are different primitives.

FORK represents epistemic divergence:
- it creates descendant lineages;
- each child introduces exactly one path-defining assumption;
- the parent becomes BRANCHED and is no longer schedulable;
- siblings need not converge or produce one winner.

SPAWN represents work decomposition inside one lineage:
- it does not create a lineage;
- it does not change lineage DNA;
- the parent waits for spawned work;
- spawned outcomes return to the same lineage.

Do not collapse these concepts for implementation convenience.

## Failure semantics

Do not silently collapse distinctions among:
- WAITING
- BLOCKED
- DEAD
- COMPLETED
- BRANCHED

A resource-limited or blocked lineage is not therefore falsified or invalid.

Executor failures should remain local where the architecture permits.

## Evaluation

Solver-visible evaluation criteria and hidden evaluator material are separate
concepts.

Do not expose hidden evaluator payloads to executors in order to simplify an
implementation or test.

Passing examples are not proof of exhaustive correctness.

## Target repositories

Stirpi state belongs outside repositories it operates on.

Do not require Stirpi-specific state files or metadata to be written into a
target codebase unless explicitly designed and approved later.

## Code organization

Prefer cohesive, inspectable modules.

File size is a review signal, not a hard correctness threshold.

Split a file when it accumulates multiple responsibilities or becomes
materially harder to inspect. Do not split cohesive code merely to satisfy a
line-count target.

Avoid generic catch-all modules and unrelated components in the same file.

## Verification

During implementation prefer focused checks appropriate to the change.

Run broader/full verification at milestone boundaries or when the change can
affect broad behavior.

Do not repeatedly run expensive checks without a concrete reason.

## Git and task boundaries

Keep commits small enough to describe one coherent change.

Do not begin another milestone after completing the requested task.

If commit/push is requested:
1. implement the requested scope;
2. run appropriate verification;
3. commit/push;
4. report the result;
5. stop.

Never rewrite published history unless explicitly instructed.

## Decisions

`docs/DECISIONS.md` contains human-owned semantic and architectural decisions.

Agents must:
- read relevant decisions before implementation;
- preserve them;
- not silently reinterpret them;
- stop when two accepted decisions conflict;
- stop when implementation requires a new semantic decision;
- report the smallest concrete contradiction or missing decision.

Agents may suggest candidate decisions, but they may not mark them accepted or
change accepted decisions unless explicitly instructed.
