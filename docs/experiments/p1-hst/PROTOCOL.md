# H*/S*/T* trusted-local pilot protocol

Status: approved protocol; not preregistered and not authorization to run.

This document defines a new H*/S*/T* experiment. It is distinct from the
historical D032 experiment and from the S′/T′ counterfactual; neither historic
document, manifest, task, pilot, nor result is amended or renamed.

## Common basis and governance

All three conditions target `ThomasTraspedini/booking-invariants`, start from
the common initial commit `bd9ae09ac74374199c48d22ec36c739600cfee59`, and use
the common counterfactual task `booking-invariants-d032-counterfactual-001`.
They share the same public evaluator meaning and the same approved governance.
P3 will freeze and verify these already approved identities in the manifests and
preregistrations; it does not leave the target, initial commit, or task open
for later selection. No new hash, manifest, preregistration, or run is created
by this protocol.

The executor is `gpt-6-astra` with effort **medium**, identically configured in
H*, S*, and T*. The approved trusted-local mode in D073 is selected explicitly
and identically for the three conditions. It is limited to controlled
repositories and inputs, makes no safety claim against hostile code, and is
never an automatic fallback from isolated verification.

An assumption may be explored only as an explicit conditional world. It does
not alter accepted target decisions, invent external capabilities, or authorize
a parent change. A branch that requires a parent change is recorded as such and
is not a valid result under the original contract.

`Do not commit` prohibits autonomous Git operations by the solver. Canonical
checkpoints requested through Stirpi are authorized equally for H*, S*, and T*;
they are runtime operations, not solver operations.

## Treatments

| Condition | Treatment |
|---|---|
| H* | A human gate is present at the decision point; no human response is supplied during the run. |
| S* | The ordinary common policy applies; FORK is unavailable. |
| T* | The ordinary common policy applies; FORK is available with its general semantics. |

SPAWN has its unchanged semantics in every condition. Nothing in the task or
solver-visible material suggests seeking a FORK.

## Order, budgets, and retries

The approved order is H* → S* → T*. The approved technical budgets are 20
steps per run, 20 executor invocations per run, 20 lineages per run, 200 items and 100
commands per invocation, a no-progress limit of 180000 ms, a wall time of
900000 ms per invocation, a public-control wall time of 300000 ms, and
concurrency 1. There is one run per condition, with at most one replacement per
condition only for a purely operational failure, and at most six attempts in
total. No retry is justified by absence of FORK or by a failed lineage. A change
to common runtime, task, executor, or environment requires a new freeze and
human decision. Operational freeze, verification of these values, and all
execution responsibilities belong to P3, not to this document.

F1 remains open: a separately approved financial ceiling and its operational
control are mandatory before any run. This protocol authorizes neither it nor
any execution.

## Evaluation threshold

The private ex-ante rubric governs evaluative terms and remains outside solver
contexts; it is not reproduced here. The minimum threshold requires in T* a
justified FORK, at least two descendants actually scheduled from that FORK, and
at least one verified implementation produced by an actually scheduled
descendant of that same FORK. Two valid implementations remain desirable, not
the minimum threshold.

The rubric, freeze identity, evidence checks, and closure mechanics are private
and are completed before execution. This public protocol contains no hidden
material and no testcase-specific hint.
