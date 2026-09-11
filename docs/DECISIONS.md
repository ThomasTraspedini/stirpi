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
