# D032 counterfactual pair

This is a new experiment definition, not a revision of historical D032.
The comparison is S′ versus T′ under the same counterfactual task, identified as
`booking-invariants-d032-counterfactual-001`. No H′ condition is defined.
Historical T007's BLOCK / HUMAN_DECISION_REQUIRED is a valid solver result;
the mandatory-stop instruction confounds observation of autonomous control
choices. This experiment removes only that instruction. See TASK-DIFF.md for
the exact edit and manifest.json for frozen input identities.

## Conditions

S′ uses runner condition `S`: autonomous single-path execution with FORK
unavailable and all other normal executor capabilities retained. The generic
control envelope omits FORK and the runner rejects FORK before artifact effects.
T′ uses runner condition `T`: normal Stirpi execution with FORK available through
its ordinary generic protocol semantics. Neither task nor supplemental guidance
hints that a fork exists in this problem or is expected. Generic capability
semantics are the sole necessary protocol difference.

Both retain CONTINUE, SPAWN, COMPLETE, and BLOCK, with the same ordinary
executor and repository policies. No added ambiguity-resolution policy or human
answer is supplied. SPAWN remains work decomposition within a lineage. Normal
FORK creates children with one path-defining assumption each, makes the parent
BRANCHED, and exposes only each child's own world. No testcase-specific control
hints, candidate protocols, historical observations, or experiment documentation
are supplied to the solver. Only the task, frozen source world, public evaluation
context, and ordinary runtime envelope are solver-visible.

## Frozen source and isolation

Both start from `ThomasTraspedini/booking-invariants` at
`bd9ae09ac74374199c48d22ec36c739600cfee59`. Preserve the existing harness Git-history
isolation: transfer only that commit and its reachable ancestry into a fresh
repository, with no unrelated or dangling objects, source refs, reflogs,
alternates, hardlinks, remotes, hooks, or source configuration. Reject shallow
sources. Verify the clean starting commit and absence of remotes/alternates.
Use separate lineage repositories so sibling assumptions, artifacts, rationale,
and results remain hidden by default. Keep Stirpi state outside target codebases.
Do not expose later source history, historical decisions or results, or private
oracle material. Preserve the existing isolation limits; this is not an OS-level
security boundary.

## Execution protocol for a future run

Both pilots are preregistered together in pilots/S001.json and pilots/T001.json.
Commit and push both before either run. This definition task executes neither.
The pilot files are authoritative for runtime identity; the testcase manifest
does not pin a runtime. Use their exact full Stirpi commit from a clean isolated
checkout, treating this committed preregistration as external experiment input.
Record the preregistration hash, containing commit, and actual runtime identity
separately. Never substitute a newer runtime implicitly.

Both pin Codex `0.154.0-alpha.6.2`, executable SHA256
`ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb`,
and model `gpt-6-astra`. Verify executable identity before a future run.
Use identical effective executor configuration, sampling settings, concurrency,
source, evaluator, and resource policies across the pair; record nondeterminism.
The shared envelope is 20 steps, 20 executor invocations, 20 lineages, 200 items
and 100 commands per invocation, 180000 ms without progress, and 300000 ms per
public evaluator check. No executor wall-time budget is configured.

The command launching the experiment runner must use outer execution policy
`require_escalated`, because the external Codex executor requires outbound
backend connectivity. The inner Codex sandbox remains `workspace-write`.
Both conditions use this same launch policy. It is an operational launch
precondition, not a semantic treatment difference.

Reuse `../d032/public-evaluator-v2.json` unchanged, identity
`booking-invariants-d032-public-evaluator-v2`, SHA256
`9215c50aa69af9218b3530f22959552cbd41e75c43eb71260b9a732cad950bc1`.
Its PostgreSQL suite, typecheck, and diff checks remain literally applicable
after this task edit. Passing these checks is not exhaustive correctness evidence.
Both pilots set `hiddenEvaluationDuringRun = false`. No hidden evaluation or
private expected-answer access is part of this definition task.

## Primary observations

Record the following for each condition without a weighted score:

- whether ambiguity is detected;
- whether multiple coherent alternatives are articulated;
- whether execution BLOCKs for human input;
- whether a single protocol is selected;
- whether and when FORK occurs;
- number of resulting lineages, their exact assumptions, and how many are scheduled;
- whether child lineages correspond to genuinely different assumptions;
- artifact implementation and completion, including each lineage's outcome;
- public evaluator results, preserving operational errors separately;
- human intervention required;
- resource usage across the entire run and per lineage where available.

FORK itself is not automatically success. BLOCK itself is not automatically
failure. Preserve WAITING, BLOCKED, DEAD, COMPLETED, and BRANCHED distinctions;
resource limits and executor failures do not falsify an assumption. A single
pilot pair does not establish a general causal advantage.
