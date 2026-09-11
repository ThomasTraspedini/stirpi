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

## D031 — Replay does not repeat external artifact side effects

Status: accepted

Replay verifies Stirpi's semantic engine transitions using the artifact-operation
outcomes recorded during the original Run.

Replay must not recreate Git worktrees, commits, branches, or other external
artifact mutations.

Artifact backends are effect boundaries. During replay, previously recorded
artifact outcomes are supplied back to the engine as the observations that were
produced by those effects during the original execution.

This preserves the distinction between:
- deterministic replay of Stirpi's decision and transition logic;
- verification of external artifact availability or integrity.

Artifact availability/integrity verification is a separate operation and may
later verify properties such as whether a recorded Git commit still exists or
has the expected ancestry.

Replay must not require external side effects to be deterministic.

## D032 — Executors are not necessarily agents

Status: accepted

Stirpi manages problem-solving processes rather than a specific class of AI agents.

An executor is any actor capable of consuming an assigned lineage/work context
and returning structured actions and results.

Executors may later include:
- coding agents;
- human operators or teams;
- deterministic services;
- other software systems.

M2 may implement a coding-agent executor first, but core protocol semantics
must not require the executor to be an LLM.

---

## D033 — Executors operate only inside assigned artifact workspaces

Status: accepted

An executor that performs artifact work receives an isolated workspace assigned
by Stirpi.

The executor must not modify sibling lineage/work artifacts or the target
repository outside its assigned workspace.

Artifact isolation is enforced by the artifact layer, not by trusting executor
intent alone.

---

## D034 — Stirpi controls artifact commit operations

Status: accepted

Executors may modify files inside their assigned workspace.

Canonical Git commits are created through Stirpi-controlled artifact operations
rather than arbitrary unmanaged Git history manipulation by the executor.

Executors may request multiple coherent commits during a work unit.

Commit creation must remain compatible with D025 and D029.

---

## D035 — Executor communication uses a structured protocol

Status: accepted

Executor-to-Stirpi control flow uses structured actions rather than free-text
interpretation.

At minimum the protocol represents:
- CONTINUE
- FORK
- SPAWN
- COMPLETE
- BLOCK

Free text may accompany structured actions as rationale, explanation, or result,
but must not be the authoritative control signal.

---

## D036 — Executors see only their own lineage world

Status: accepted

An executor receives only the context necessary for its assigned lineage/work.

This includes:
- current task/objective;
- inherited assumption path;
- artifacts belonging to that lineage/work;
- public evaluation information;
- relevant outcomes of its own spawned descendants.

The executor must not receive sibling-lineage assumptions, artifacts, results,
or rationale by default.

Sibling lineages represent alternative conditional worlds and must remain
epistemically isolated unless an explicit future mechanism introduces
cross-lineage observation.

---

## D037 — Fork children do not see sibling alternatives

Status: accepted

A fork child receives its own newly inherited assumption and ancestral context.

It does not receive the assumptions, rationale, progress, or artifacts of
sibling fork children.

The existence of alternative siblings is not part of the child's default
problem-solving context.

---

## D038 — Executor output separates control actions from artifact effects

Status: accepted

Executor execution may produce both:
- artifact mutations/results;
- a structured Stirpi control action.

Artifact mutation alone does not define a lineage transition.

A control action must be explicitly returned and validated by Stirpi before the
corresponding semantic transition occurs.

---

## D039 — COMPLETE requires evaluation

Status: accepted

An executor cannot make a lineage/work successfully complete merely by
declaring COMPLETE.

A COMPLETE action is a request to evaluate the produced result/artifact against
the relevant evaluation contract.

Only evaluation success may transition the target to COMPLETED.

Evaluation failure must remain distinguishable from executor declaration of
completion.

---

## D040 — Human executors are first-class future participants

Status: accepted

The executor abstraction must remain capable of representing human or
human-team participation in the same process model used by automated executors.

M2 does not need to implement a human UI or collaborative workflow.

This decision exists to prevent the protocol and persistence model from
assuming that executor interactions are necessarily model/API calls.

## D041 — Executor identity is not lineage identity

Status: accepted

A lineage may be advanced by different executors over time.

Executor replacement does not create a new lineage by itself.

Lineage continuity is defined by task ancestry, assumptions, state, and
artifacts—not by continuity of the actor performing the work.

## D042 — A work unit retains its workspace across executor invocations

Status: accepted

An artifact-producing WorkUnit owns one assigned workspace for the duration of
its active execution.

Executor invocations are not workspace lifetimes.

When an executor returns CONTINUE, the same workspace is retained for the next
invocation, including any uncommitted changes.

Uncommitted workspace state is transient execution state. It is not a canonical
Stirpi artifact.

The canonical Git artifact remains the most recent committed artifact identity.

A Stirpi-controlled commit advances that canonical artifact while allowing the
same WorkUnit and workspace to continue.

Actions that create artifact inheritance or claim a completed artifact require
a canonical committed state.

Therefore:

- CONTINUE may leave the workspace dirty;
- FORK must not silently inherit uncommitted workspace state;
- SPAWN must not silently inherit uncommitted workspace state;
- COMPLETE must not silently treat uncommitted changes as a canonical final
  artifact.

Before FORK, SPAWN, or artifact-bearing COMPLETE, relevant changes must already
be committed through Stirpi-controlled artifact operations.

Stirpi must not silently auto-commit dirty state merely to satisfy this
requirement.

If a WorkUnit becomes BLOCKED or stops because of an operational failure, a
dirty workspace may be retained for inspection. Such uncommitted state does not
become the canonical artifact.

Cleanup must not destroy dirty workspace state that may be useful for diagnosis
unless an explicit future cleanup policy permits it.
