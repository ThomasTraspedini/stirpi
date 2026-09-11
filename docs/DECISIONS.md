# Decisions

This document contains human-owned decisions that constrain Stirpi's semantics
and implementation.

Agents may implement these decisions but must not reinterpret, weaken, or
silently replace them.

If implementation exposes a contradiction or missing decision, stop and report
it instead of inventing a new semantic rule.

---

## D001 — Persistent unit is the lineage

Status: accepted

The persistent conceptual unit of Stirpi is the lineage, not the model,
executor, chat, or process instance.

A model may be replaced while the lineage continues.

---

## D002 — FORK and SPAWN are distinct

Status: accepted

FORK represents epistemic divergence.

SPAWN represents work decomposition inside one lineage.

FORK creates descendant lineages and changes lineage DNA.
SPAWN does not create a lineage and does not change DNA.

---

## D003 — One fork child adds one assumption

Status: accepted

Each child created by a FORK introduces exactly one new path-defining
assumption relative to its parent.

Composite consequences may follow from that assumption, but the genealogical
edge represents one explicit new commitment.

---

## D004 — Fork parent becomes BRANCHED

Status: accepted

After a successful FORK, the parent lineage no longer progresses.

It becomes BRANCHED and persists only as genealogy shared by its descendants.

---

## D005 — Multiple completed lineages may coexist

Status: accepted

Completion does not imply global victory.

Multiple descendant lineages may remain valid simultaneously under different
assumptions or environments.

Stirpi must not require a single canonical winner.

---

## D006 — BLOCKED is not DEAD

Status: accepted

BLOCKED means progress cannot continue under current conditions without an
external or higher-level change.

DEAD means the lineage should not continue in the current world.

Resource exhaustion or missing information must not be silently interpreted as
falsification.

---

## D007 — SPAWN parent waits and later resumes

Status: accepted

SPAWN creates work inside the same lineage.

The parent pauses while required spawned work is unresolved.

When spawned work reaches a terminal condition, its outcomes become available
to the parent, which may resume and decide how to proceed.

A blocked spawned child may therefore return a blocked outcome to its parent;
blocking does not automatically propagate to the lineage.

---

## D008 — No optional SPAWN in M0

Status: accepted

M0 models SPAWNed work as required work.

Background/fire-and-forget/optional work is outside M0 and must not be
introduced until a concrete use case requires it.

---

## D009 — Task and Run are distinct

Status: accepted

A Task defines a problem/evaluation target.

A Run is one execution of that task under a particular configuration, budget,
model/executor, or experimental condition.

One Task may have many Runs.

---

## D010 — Public and hidden evaluation are separate

Status: accepted

Executors may receive solver-visible evaluation requirements.

Hidden evaluator material must remain outside executor context.

The implementation must not weaken this boundary for convenience.

---

## D011 — Genealogical DNA is reconstructed from ancestry

Status: accepted

For V1, lineage DNA is reconstructed by walking parent lineage relationships
and collecting the path-defining assumption introduced by each fork edge.

Do not duplicate full DNA unless later measurements justify materialization.

Do not encode authoritative genealogy into Git branch names.

---

## D012 — Git is an artifact backend, not the semantic core

Status: accepted

Stirpi's core semantics must not depend on Git.

Git may later represent concrete artifact inheritance and work branches, but
lineage identity, assumptions, evaluation, and lifecycle remain Stirpi domain
concepts.

---

## D013 — Stirpi state stays outside target repositories

Status: accepted

Stirpi must not require project-specific state files to be written into target
repositories merely to operate on them.

Operational state belongs to Stirpi's own storage.

---

## D014 — M0 uses ordinary state + append-only events

Status: accepted

M0 uses normal state tables as authoritative state plus an append-only event
log for observability and replay.

M0 is not a full event-sourced system.

---

## D015 — M0 uses TypeScript, Node.js and SQLite

Status: accepted

Core implementation:
- TypeScript
- Node.js
- SQLite

This is an implementation decision for the current milestone, not a universal
requirement for future integrations.

---

## D016 — No confidence ranking in FORK alternatives in M0

Status: accepted

Fork alternatives do not carry confidence scores in M0.

Confidence would introduce ranking/probability semantics that have not yet been
designed and could bias branch allocation prematurely.

---

## D017 — File size is a review signal, not a hard limit

Status: accepted

Prefer one primary responsibility per module.

Split files when they accumulate unrelated responsibilities or become hard to
inspect.

Do not split cohesive code merely to satisfy an arbitrary line-count ceiling.

---

## D018 — Stirpi development remains human-governed for now

Status: accepted

Stirpi itself is not yet governed by Stirpi.

For development of Stirpi:
1. humans define semantics and architectural decisions;
2. agents implement within those constraints;
3. agents stop when implementation exposes contradictions or missing decisions;
4. humans make or revise the decision;
5. agents integrate the new decision.

This avoids circularly using an immature system to define its own semantics.

## D019 — FORK children inherit the same parent artifact

Status: accepted

When a lineage FORKs, every child lineage starts from the same artifact state
owned by the parent at the fork point.

The children diverge semantically through their distinct assumptions, not
because they receive different starting artifacts.

---

## D020 — SPAWN creates isolated artifact descendants

Status: accepted

Each SPAWNed work unit operates on an isolated descendant of the current
lineage artifact.

For the Git backend, each work unit receives its own worktree/branch derived
from the same parent artifact state.

SPAWN isolation must not create new lineage identity or alter lineage DNA.

---

## D021 — M1 does not automatically merge SPAWN results

Status: accepted

M1 does not automatically merge artifact changes produced by SPAWNed work.

SPAWN completion returns artifact references and outcomes to the parent lineage.

How those artifacts are later integrated is a separate concern and must not be
silently defined by the Git backend.

---

## D022 — Artifact conflicts are not lineage conflicts

Status: accepted

A Git merge conflict or other artifact-level integration conflict is not an
epistemic FORK by itself.

Artifact incompatibility and lineage incompatibility are distinct concepts.

A later integration step may expose a semantic contradiction that requires a
FORK, but the artifact conflict alone does not imply one.

---

## D023 — Git identity is not lineage identity

Status: accepted

Git branches, commits, and worktrees are artifact representations.

They are not authoritative identities for Stirpi lineages or work units.

Lineage/work identity remains in Stirpi's own state.

---

## D024 — M1 uses Git worktrees for isolated work

Status: accepted

The first Git artifact backend uses Git worktrees to isolate concurrent or
serial SPAWN work without repeatedly mutating the target repository checkout.

This is an M1 implementation decision, not a universal requirement for future
artifact backends.

---

## D025 — Work units may create commits

Status: accepted

A work unit may create zero or more coherent commits in its isolated artifact
branch.

Commits should represent understandable implementation progress.

A work unit that makes no artifact change must not create an empty commit
merely to prove that it ran.

---

## D026 — Target repository must start clean

Status: accepted

For M1, Stirpi refuses to start artifact execution against a target repository
with uncommitted tracked or untracked changes.

Supporting intentionally dirty starting states is deferred.

---

## D027 — Branch names are readable references, not genealogy

Status: accepted

Git branch names may include readable Stirpi run, lineage, or work references.

Branch naming must not become the authoritative storage of lineage ancestry,
assumptions, or semantic state.

The database remains authoritative.

---

## D028 — Temporary worktrees are cleaned up; branches and commits may remain

Status: accepted

Temporary Git worktrees created by Stirpi should be removed when they are no
longer needed.

Branches and commits produced by execution may remain available for inspection
and audit unless an explicit cleanup policy says otherwise.

M1 must not silently delete potentially useful execution history.

---

## D029 — Git history remains useful without Stirpi metadata

Status: accepted

Commit history should remain understandable to humans and ordinary Git tooling
without Stirpi.

Do not require proprietary Stirpi trailers, assumption blobs, or internal IDs
inside commit messages.

Stirpi enriches commits externally by storing mappings from artifact references
to lineage/work state in its own database.

Commit messages should describe the code change itself rather than duplicate
the lineage assumption.

## D030 — Git artifact references are immutable commit identities

Status: accepted

For the Git backend, the canonical artifact reference returned to Stirpi is an
immutable commit identity, not a mutable branch name or worktree path.

Branches/worktrees may be used operationally, but persisted artifact identity
must remain stable over time.
