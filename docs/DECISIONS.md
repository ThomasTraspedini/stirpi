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

## D043 — Global decisions exclude experiment-specific protocol

Status: accepted

`docs/DECISIONS.md` contains only durable human-owned decisions that constrain
Stirpi itself.

These may include decisions about:
- architecture;
- domain semantics;
- execution contracts;
- evaluation contracts;
- algorithms;
- persistence;
- artifact handling;
- scheduling;
- stack;
- governance and development rules.

Constraints that apply only to a specific experiment, benchmark, testcase, or
temporary development exercise must not be added to the global decision log.

Experiment-specific rules belong in that experiment's own documentation.

A temporary experiment may inform a later global Stirpi decision, but that
decision must be generalized before being added here.

## D044 — Runtime completion is governed only by the public evaluation contract

Status: accepted

A COMPLETE action requests evaluation against the evaluation contract available
to the running problem-solving process.

Only that runtime/public evaluator may authorize the transition to COMPLETED.

Hidden, retrospective, benchmark, research, or experimental evaluators do not
participate in the runtime completion transition.

They may later classify, compare, or criticize a completed artifact without
rewriting the historical Stirpi runtime status.

Therefore:

- COMPLETED means that the work satisfied its runtime evaluation contract;
- COMPLETED does not imply universal semantic correctness or optimality;
- hidden evaluation may subsequently discover failures not represented by the
  public contract;
- hidden evaluator results remain separate observations rather than retroactive
  lineage transitions.

The runtime evaluator must not receive information intentionally hidden from the
executor unless a future explicitly defined evaluation contract permits such a
boundary.

## D045 — Runtime evaluation may inspect public work evidence

Status: accepted

Runtime evaluation is not limited to executor-authored result text.

A runtime/public evaluator may inspect evidence that legitimately belongs to the
current work unit and is part of the solver-visible/public problem contract.

Such evidence may include:

- the executor's structured result;
- the current canonical artifact;
- lineage-local public state;
- declared or independently executed verification results;
- other public evidence explicitly defined by the runtime evaluation contract.

Runtime evaluation must not receive:

- private experimental oracle material;
- hidden benchmark outcomes not included in the runtime contract;
- sibling-lineage private state;
- future historical information unavailable to the running process.

For software tasks, runtime completion may require independently verifying the
produced artifact rather than trusting claims in executor-authored text.

The exact public evaluation contract is task-specific configuration and does not
change Stirpi's core completion semantics.

## D046 — Runtime evaluation receives authoritative artifact context

Status: accepted

When completion depends on produced artifacts, the runtime/public evaluator must
receive authoritative artifact context for the work unit being evaluated.

The evaluator must not infer the candidate artifact or workspace from
executor-authored result text.

The runtime evaluation context may include:

- canonical artifact reference;
- assigned artifact workspace when it still exists;
- lineage/work identity;
- public evaluation criteria;
- executor result;
- public verification evidence produced for that work.

For software tasks, independently executed checks must run against the exact
candidate artifact/workspace associated with the COMPLETE request.

Artifact context is evaluation evidence, not hidden benchmark information.

The evaluator must still not receive:

- private experimental oracle material;
- future historical information unavailable to the running process;
- sibling-lineage private state;
- unrelated host filesystem paths.

A task-specific evaluator may execute multiple independent checks and preserve
their individual outcomes.

Failure of an individual public check is a normal negative evaluation result,
not an operational evaluator-process failure.

## D047 — Operational supervision is progress- and resource-aware

Status: accepted

Stirpi must not use elapsed wall-clock time as a generic proxy for executor
failure or lack of progress when more specific observable information is
available.

Operational supervision distinguishes:

- activity: observable execution activity;
- progress: transition to a new operational state;
- resource consumption: measurable work/cost;
- budget exhaustion: reaching an explicitly configured resource limit.

Supervision should be applied to the smallest observable execution scope.

Examples of scopes may include:

- Run;
- ExecutorInvocation;
- executor turn;
- tool/item execution;
- command/subprocess.

Where structured progress is observable, stopping should prefer explicit
mechanisms such as:

- resource budgets;
- iteration limits;
- repeated-cycle detection;
- repeated-failure detection;
- scope-specific no-progress detection.

Time remains a valid measurable resource.

A wall-time limit may be configured explicitly as a resource budget, including
for experiments where total execution time is part of the comparison.

Reaching such a limit is resource exhaustion, not evidence that the executor is
incorrect or stalled.

Elapsed time may also be used as a local no-progress watchdog when an execution
scope is genuinely opaque and no stronger progress signal is available.

Activity alone must not necessarily reset a progress watchdog.

Operational stopping must not imply semantic falsification of a lineage.

## D048 — Operational events are separate from semantic executor actions

Status: accepted

An executor may emit incremental operational events while an invocation is in
progress.

Operational events may describe:

- lifecycle transitions;
- activity;
- tool/item execution;
- command execution;
- file changes;
- resource usage;
- other observable execution state.

Operational events are telemetry and supervision input.

They do not directly produce Stirpi semantic transitions such as:

- CONTINUE;
- FORK;
- SPAWN;
- COMPLETE;
- BLOCK.

Exactly one final structured executor response remains authoritative for the
semantic action of an invocation.

Operational events may be used for:

- progress detection;
- resource accounting;
- cycle detection;
- liveness supervision;
- audit evidence.

Executor implementations may expose different levels of telemetry.
Stirpi must not infer unobservable internal structure merely for uniformity.

## D049 — Executor cancellation is explicit and distinct from implicit timeout

Status: accepted

Executor invocations must not be terminated by hidden or implicit wall-clock
limits.

A wall-time limit may exist when it is explicitly configured as part of the
execution/resource policy.

An explicitly configured wall-time limit represents resource exhaustion, not
evidence that the executor is stalled or semantically incorrect.

The caller may explicitly request cancellation of an active executor invocation.

Caller-requested cancellation is an operational termination condition.

It must:

- terminate the owned execution scope as safely as the executor boundary allows;
- preserve operational events already observed;
- preserve partial run evidence;
- preserve dirty workspaces/artifacts when they may be useful for inspection;
- avoid silently converting cancellation into semantic falsification or
  completion.

Cancellation, no-progress detection, resource exhaustion, and semantic outcomes
are distinct concepts.

No-progress supervision is defined separately and must not be simulated through
an implicit invocation timeout.

Timeout/cancellation policies for evaluators are outside this decision unless
explicitly configured by their own execution contract.

## D050 — No-progress supervision is scope-local

Status: accepted

No-progress supervision applies to the smallest observable execution scope for
which meaningful progress can be measured.

Elapsed time without progress may be used to stop an opaque or stalled scope,
but must not be used as a generic proxy for total executor duration.

A progress watchdog is reset only by observations classified as progress for
that scope.

Activity alone does not necessarily reset a progress watchdog.

Examples of progress may include:

- a new structured execution item starting;
- an execution item reaching a new lifecycle state;
- a command completing;
- verified artifact state changing;
- another explicit operational transition defined for that scope.

Examples of activity that do not necessarily imply progress include:

- repeated output bytes;
- reasoning/message deltas;
- heartbeat-like notifications;
- process existence.

A no-progress stop is an operational condition and does not imply semantic
falsification.

## D051 — Resource budgets are explicit and independently measurable

Status: accepted

Execution limits are represented as explicit budgets over measurable resources.

Resources may include, where observable:

- Stirpi steps;
- executor invocations;
- lineages;
- executor items;
- command executions;
- tool calls;
- tokens;
- monetary cost;
- wall-clock time.

A budget is optional unless required by the execution or experiment policy.

Reaching a configured budget produces resource exhaustion for that resource.

Wall-clock time is therefore a valid optional resource budget, but it is not an
implicit indication of executor failure or lack of progress.

Budget configuration, consumption, and exhaustion reason must remain
inspectable.

## D052 — Repetition alone does not define an execution cycle

Status: accepted

Repeated operations are not considered pathological solely because their command
or tool identity repeats.

Cycle detection must consider relevant execution state and outcomes.

A future cycle signature may include information such as:

- operation identity;
- relevant state before execution;
- observed outcome;
- relevant state after execution.

For artifact-producing work, repeated execution after a materially changed
artifact state is not automatically the same cycle.

Cycle detection must prefer false negatives over terminating legitimate progress
based on superficial repetition.

## D053 — Operational stop causes remain distinct

Status: accepted

Stirpi must preserve the cause of operational termination rather than collapsing
different mechanisms into a generic timeout or failure.

At minimum, supervision must distinguish where applicable:

- explicit caller cancellation;
- no-progress stop;
- resource exhaustion;
- repeated-cycle stop;
- repeated-failure stop;
- process/protocol operational failure.

These operational outcomes do not imply that the lineage assumption is false.

Runtime and experiment evidence must retain the scope, configured policy,
observed measurements, and reason that caused the stop.

## D054 — Experiment preregistration identity is separate from runtime identity

Status: accepted

A committed experiment preregistration and the Stirpi runtime revision it pins
have distinct identities.

The preregistration's `stirpiCommit` identifies the exact Stirpi implementation
revision under which the experiment must execute.

It does not identify the repository HEAD that contains the preregistration
itself.

A preregistration may therefore be committed after its pinned runtime revision
without changing the runtime identity.

Experiment evidence must independently preserve:

- the preregistration contents and cryptographic hash;
- the repository commit containing that preregistration;
- the pinned Stirpi runtime commit actually used for execution.

Execution must use the pinned runtime implementation rather than silently using
newer runtime code from the preregistration-containing HEAD.

A descendant relationship alone is insufficient proof of runtime identity.

If necessary, the harness should execute the pinned runtime from an isolated
clean checkout/worktree while treating the committed preregistration as external
experiment input.

A failed preflight caused by identity/configuration mismatch must remain
provenance and must not be rewritten as an experimental result.

## D055 — External executor identity includes executable byte identity

Status: accepted

For reproducible experiments, an external executor is not identified solely by
its reported version string.

Where an executor is a local executable, experiment evidence should identify at
least:

- reported executable version;
- executable SHA256;
- executable path used for that execution.

The preregistered experiment should pin the executable SHA256 when exact local
executor identity matters.

The executable path is deployment metadata, not semantic identity.

A version match with a hash mismatch must fail preflight for experiments that
pin executable identity.

A hash match at a different local path may be accepted, provided the executable
version and other preregistered executor constraints also match.

Historical runs that recorded only the version remain valid provenance, but
their exact executable bytes cannot be reconstructed unless independently
preserved.

## D056 — VERIFY is an operational effect

Status: accepted

VERIFY is an executor-requested operational effect, not a semantic lineage
transition.

A VERIFY request:

- is identified only by a trusted stable verification ID;
- is valid only with CONTINUE;
- cannot carry executor-controlled command, argv, cwd, environment, timeout,
  network, or resource policy;
- produces normal positive or negative verification evidence when the verifier
  executes successfully;
- produces an operational failure when the verifier infrastructure cannot
  operate;
- delivers bounded evidence to a subsequent invocation of the same work unit;
- does not itself authorize COMPLETE;
- is replayed from recorded evidence without repeating external verification.

## D057 — Protocol versions permit backward-compatible additive capabilities

Status: accepted

Within a protocol major version, optional capabilities may be added when:

- existing valid messages retain their meaning;
- existing executors remain valid without using the new capability;
- strict runtimes that do not implement the added capability may reject it
  explicitly rather than reinterpret it.

Breaking changes to existing fields, meanings, required behavior, or authority
boundaries require a new protocol version.

Under this rule, VERIFY may be added to executor protocol version 1.

## D058 — Candidate-executing verification requires isolation

Status: accepted

Any requested or public verification that executes candidate-controlled code
must run inside an approved isolated verifier boundary.

Candidate code must not execute directly in the trusted Stirpi host process.

The verifier operates on a disposable snapshot/copy of the assigned workspace
and must not receive:

- Docker daemon/socket access;
- arbitrary host filesystem access;
- Stirpi private state;
- private experiment/oracle material;
- inherited trusted-host environment;
- unrestricted network access.

The persistent executor workspace remains authoritative and is not modified by
verifier cleanup.

## D059 — Database access for isolated verification is disposable and scoped

When candidate verification requires a database:

- verification receives a per-request disposable non-superuser database lease;
- credentials and database identity are created for that verification request
  and destroyed afterward;
- verifier access is restricted to the experiment-owned database endpoint;
- general network access is not granted merely to enable database verification;
- database administrator credentials are never exposed to candidate code;
- credentials are not persisted in Stirpi evidence;
- verification infrastructure cleanup terminates sessions and destroys the
  disposable database identity.

For the current Docker verifier implementation, the preferred transport is a
Docker-managed Unix socket shared only between the verifier and its PostgreSQL
sidecar, with both containers otherwise using no network.

## D060 — Trusted verification profiles own candidate execution policy

Status: accepted

Candidate-executing verification is authorized only by a trusted, versioned
verification profile committed in the pinned Stirpi runtime revision.

The profile owns verifier and supporting image identities, platform, toolchain
expectations, dependency policy, stable operation IDs, fixed executable and argv,
database prerequisites, isolation, and resource/output limits.

Executors may request only a stable operation ID. Evaluators may select only an
operation already authorized by the profile. Neither may supply or override
command, argv, cwd, environment, network, database setup, images, or limits.

Profiles and their operational state remain outside target repositories.

## D061 — Candidate dependencies come only from isolated immutable bundles

Status: accepted

Candidate verification must not trust dependency directories from an executor
workspace or execute candidate-controlled package-manager operations on the
trusted host.

Dependencies are prepared in a dedicated isolated, digest-pinned preparation
environment under an exact trusted install and registry-access policy. The
preparer receives no candidate runtime secrets and exports a bounded immutable
bundle identified by its dependency inputs, preparation image, platform,
architecture, install policy, and canonical content digest.

The verifier receives only a disposable copy or read-only source of a
hash-verified bundle. Bundle provenance and identity are retained as verification
evidence.

## D062 — Verification image and platform identities are explicit

Status: accepted

Every container image used for candidate verification, dependency preparation,
or verification database service must be configured by immutable OCI digest
together with an explicit platform and architecture.

Mutable tags, implicit local images, implicit registries, and host-default
platform selection are not verification authority.

Evidence preserves both the configured digest identity and the actual resolved
platform manifest and image identities used by the container runtime.

## D063 — Database prerequisites are trusted profile authority

Status: accepted

Database image, extensions, bootstrap policy, transport, and candidate-role
properties used by verification are authorized by the trusted verification
profile, not by candidate code.

Trusted infrastructure installs and validates authorized prerequisites before
exposing a disposable non-superuser lease. Candidate code receives neither
administrator credentials nor authority to broaden those prerequisites.

This decision refines the authority source for the disposable and scoped access
required by D059 without changing D059's lease or cleanup semantics.

## D064 — Evaluator meaning is separate from verification environment

Status: accepted

A public evaluator defines solver-visible criteria, required checks, and the
policy that determines whether they pass. A trusted verification profile defines
the environment and fixed operations in which candidate-executing checks run.

Resolving an evaluator check through a profile must not add task-specific hints,
hidden material, expected outcomes, or change the evaluator's completion policy.

All command-style public checks are treated as candidate-executing and use the
isolated verifier. The trusted host may perform only separately typed operations
whose contract cannot execute candidate-controlled code; there is no fallback
from isolated verification to host command execution.

## D065 — Future preregistrations pin exact verification profiles

Status: accepted

A preregistration that uses trusted verification records the profile's stable ID,
version, repository-relative path in the pinned Stirpi runtime commit, and SHA-256
of its exact bytes.

The pinned runtime commit and path locate the profile; the profile SHA-256 is its
explicit experimental identity. Image identities referenced by the profile are
immutable, and actual resolved image identities are retained in run evidence.

Historical preregistrations are not retroactively amended. A failed historical
preflight remains historical provenance.

## D066 — Verification replay consumes identity-bound recorded outcomes

Status: accepted

Replay preserves and validates verification profile identity, dependency-bundle
identity and provenance, configured and resolved image identities, candidate
workspace identity, and verification outcomes.

Replay supplies those recorded outcomes at the verification effect boundary. It
must not rebuild dependencies, consult a live bundle cache or registry, resolve
or launch images, create database leases, or execute candidate verification.

## D067 — Dependency preparation uses an attestable registry-only egress boundary

Status: accepted

Dependency preparation that retrieves packages must have no direct route to
general external networks. The trusted runtime creates and owns a disposable
per-preparation internal network and a digest-pinned egress-proxy container. The
preparation container is attached only to the internal network; only the proxy
is attached to an outbound network.

The trusted verification profile owns the proxy image identity, exact allowed
HTTPS registry origins and destination ports, and versioned proxy and DNS
resolution policies. Candidate/package data, executors, evaluators, host
environment, and machine-local defaults cannot add or override that authority.

The proxy permits only CONNECT tunnels to exact declared origin host-and-port
pairs, preserves end-to-end TLS, resolves allowed names itself, rejects
non-public destination addresses, and denies every undeclared destination.
Dependency-preparation containers receive no external DNS path, Docker socket,
trusted-host filesystem, secrets, or authority to modify proxy policy or network
topology.

Before installation, the runtime must attest the configured and resolved proxy
image identity, effective proxy and resolver policy, exact container/network
attachments, absence of a direct preparation-container egress path, and
deny-by-default behavior. Failure to create or attest the boundary is an
operational failure and must not fall back to ordinary Docker networking, host
package installation, or widened origins.

The runtime owns teardown of the preparation container, proxy, networks,
volumes, and policy material. Evidence preserves profile, proxy, egress-policy,
dependency-bundle, preparation, and cleanup identities and outcomes. Replay
validates the recorded identities and outcomes without creating or contacting
any live network, proxy, container, image, registry, resolver, or bundle-store
resource.
