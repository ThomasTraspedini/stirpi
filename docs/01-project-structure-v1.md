# Stirpi — Project Structure V1

Status: consolidated after architecture decision pass.

## Core idea
Stirpi is a lineage-based runtime for agentic problem solving.

When progress requires commitment to an unresolved assumption, the system may create multiple conditional descendants and preserve why each exists.

A Stirpi project does not require one canonical winner. Multiple completed lineages may remain valid under different assumptions or environments.

## Core ontology
- Task
- Lineage
- Assumption
- Fork
- Spawn
- WorkUnit
- EvaluationContract
- ArtifactRef
- Run
- Outcome
- ResourceUsage
- Scheduler

The model/LLM is an executor, not the persistent entity.

## FORK vs SPAWN
`FORK` changes the assumed world:
- creates new lineages;
- one new path-defining assumption per child;
- parent becomes `BRANCHED`;
- children do not auto-merge.

`SPAWN` changes work distribution inside the same world:
- does not create a lineage;
- does not change DNA;
- creates work units;
- parent waits;
- when required spawned work is terminal, parent may resume;
- no explicit JOIN in M0.

## Lifecycle
- ACTIVE
- WAITING
- BLOCKED
- BRANCHED
- DEAD
- COMPLETED

`BLOCKED` != `DEAD`.

Reasons remain structured data rather than exploding the enum prematurely.

## DNA
Initially reconstruct DNA by walking `parent_lineage_id` plus each child's `fork_assumption`.
Do not encode authoritative genealogy in Git branch names.

## Stack
- Node.js
- TypeScript
- SQLite
- normal state tables + append-only event log
- JSONL event export
- JSON/TS configuration

## Scheduling
- integer priority
- FIFO within equal priority
- configurable maxConcurrency
- maxConcurrency=1 must preserve all logical branches

## Resources
Track steps, tokens, cost, wall time.
Only steps need strong enforcement in M0.

Do not include confidence in fork alternatives in M0.

## Evaluation
Separate solver-visible/public evaluation information from hidden evaluator material from day one.
Use an evaluator interface even while M0 uses a deterministic fake.

## Artifact layer
M0: opaque artifact refs only.
M1: Git artifact backend.
Stirpi state stays outside target repositories.

## Observability
Errors should remain local when possible.
Future principle: no hidden operational crumbs. Human decisions, blocked lineages, budget problems, errors and resurrection opportunities must eventually be centrally queryable.

## Public-ready development
Keep repository history clean and modular from first commit.
No employer/application-specific references.
No arbitrary LOC limits.
Avoid monoliths.

## Initial testcase
Booking Invariants D032.

Research question:
Can explicit lineage branching turn a real stop-for-human architectural decision into useful autonomous exploration without hiding uncertainty?
