# Experiment 001 — Booking Invariants D032

This experiment replays a historical software-engineering task that previously
reached an unresolved architectural decision during coding-agent execution.

Its purpose is to compare different problem-solving control structures while
holding the solver-visible engineering problem constant.

## Frozen input

Source repository:

`ThomasTraspedini/booking-invariants`

Solver starting commit:

`bd9ae09ac74374199c48d22ec36c739600cfee59`

Task:

`task.txt`

The source commit already contains the repository state, documentation,
constraints, and human-owned decisions that existed when the historical task
was issued.

The task text is preserved as historical experimental input rather than rewritten
for Stirpi.

## Provenance

The immediately preceding implementation state was:

`67907a09d9294e2c524c2a67dedeb65db3d418a8`

The solver input for this experiment is nevertheless the complete repository
state at the frozen source commit above, not a synthetic reconstruction from
multiple commits.

## Experimental isolation

Solver-visible input must not be supplemented with later knowledge about the
historical outcome.

In particular, experiment execution must not receive:

- later human decisions;
- later implementations or tests;
- descriptions of what the historical solver discovered;
- expected solution branches;
- hints that a particular control action should be used.

Hidden evaluation material is maintained separately from the public testcase
input.

## Principle

Conditions compared using this testcase should receive equivalent
solver-visible engineering information.

The intended experimental variable is the problem-solving/control scaffold,
not privileged knowledge about the historical outcome.

A single execution is treated as a pilot or demonstration until a repeated-run
protocol is frozen.
