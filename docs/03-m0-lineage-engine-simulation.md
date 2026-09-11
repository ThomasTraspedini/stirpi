# Stirpi M0 — Lineage Engine Simulation

Status: ready for implementation.

## Objective
Implement the smallest deterministic Stirpi core that proves the control model independently from LLM behavior.

Reference scenario:
```text
root
 -> CONTINUE
 -> FORK(A, B)
 -> A -> SPAWN(X, Y)
 -> X COMPLETE
 -> Y COMPLETE
 -> A resumes
 -> A COMPLETE
 -> B BLOCKED
```

## Required actions
- CONTINUE
- FORK
- SPAWN
- COMPLETE
- BLOCK

## Lifecycle states
- ACTIVE
- WAITING
- BLOCKED
- BRANCHED
- DEAD
- COMPLETED

## Core invariants
1. FORK creates distinct child lineages.
2. Each fork child adds exactly one new assumption.
3. Fork parent becomes BRANCHED and unschedulable.
4. SPAWN never creates a lineage.
5. Spawned work inherits unchanged lineage DNA.
6. Parent waits while required spawned work is incomplete.
7. Parent may resume automatically when required spawned work becomes terminal.
8. BLOCKED is not DEAD.
9. Multiple completed sibling lineages are legal.
10. maxConcurrency=1 preserves all logical branches.
11. Priority is integer + FIFO.
12. Resource usage is available per work unit, lineage, and run.
13. Invalid executor actions fail locally.
14. Deterministic replay reproduces the same semantic tree/event sequence.
15. DNA is reconstructable from ancestry without Git naming conventions.

## Suggested modules
```text
src/
  domain/
  persistence/
  engine/
  scheduler/
  replay/
  render/
  cli/
  scenarios/
```

Keep components modular; structure may change if a cleaner decomposition emerges.

## Persistence
SQLite state tables + append-only event log.
No full event sourcing.
Support JSONL export.

## Fake executor
Structured actions only; no direct mutation of engine state.
FORK alternatives contain:
- assumption
- rationale
- optional next objective

No confidence.

## Evaluator
Create interface now; use deterministic fake evaluator in M0.
Keep public specification separate from hidden evaluator payload.

## CLI
Minimum:
```text
strpi run <scenario>
strpi tree <run>
strpi inspect <run-or-lineage>
strpi replay <run>
```

Tree output must visually distinguish FORK from SPAWN.

## Testing
Unit tests + a few useful property-based tests.

## Explicit non-goals
No real LLM, Git backend, D032 code, semantic search, MCP, GUI, merge/recombination, real distributed workers, Memory3D, scaffold self-evolution.

## Exit criteria
Reference scenario runs end-to-end, persists/reloads, renders expected genealogy, distinguishes FORK/SPAWN, demonstrates serial scheduling with multiple live branches, exports readable deterministic events, accounts resources, and passes invariants.
