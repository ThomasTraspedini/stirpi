# Stirpi

Stirpi is a deterministic lineage-engine simulation. The CLI is `strpi`. M0 explores conditional lineages and delegates work within them without LLMs or Git.

## Quick start

Requires Node.js 24 or newer (uses built-in SQLite).

```sh
npm ci
npm run build
node dist/cli/index.js run reference --id demo --db demo.sqlite --concurrency 1 --export events.jsonl
node dist/cli/index.js tree demo --db demo.sqlite
node dist/cli/index.js inspect demo:l2 --db demo.sqlite
node dist/cli/index.js replay demo --db demo.sqlite
# Optional: install the strpi command locally
npm link
strpi --help
```

Use a fresh run ID for each run. `--id` identifies the Run; `--task` identifies its Task and defaults to `task:<scenario.name>`. Reuse the Task ID with a new Run ID to persist another execution; its objective and public criteria must match the stored Task. For example, run reference again with `--id demo-2 --task task:reference --db demo.sqlite`. `run` also accepts a JSON scenario matching the exported `Scenario` interface. Script keys are unique work names; each action consumes one script entry. `inspect` accepts a run ID or `run:lineage`, because lineage IDs are scoped to runs. `--export` writes ordered JSONL events.

## Control model

FORK is available to main lineage work. It creates at least two children, each with one nonempty assumption and rationale. DNA is reconstructed by walking lineage parents. The parent becomes BRANCHED; children never merge and multiple siblings may complete. Work names must be unique within a run so scripts are unambiguous.

SPAWN creates work in the same lineage, with unchanged DNA. Work units may themselves spawn. The parent waits until every direct child is terminal, then resumes automatically with child results and reasons in its executor context. BLOCKED, DEAD, COMPLETED and BRANCHED are terminal for this dependency check. A blocked child therefore releases its parent; the parent can decide how to use that result. BLOCKED remains distinct from DEAD; M0 has no action producing DEAD.

Scheduling uses higher integer priority first, FIFO for ties, and requeues CONTINUE and resumed work at the end of their priority group. `maxConcurrency` controls deterministic batches, simulated sequentially. Serial execution preserves all logical branches. Every executor attempt, including invalid actions, consumes one step. A run-wide step limit blocks all remaining active or waiting work. Tokens (10), cost (1 synthetic unit), and wall time (1 simulated millisecond) are fixed per attempt; totals sum work-unit usage, including delegated work exactly once. No real elapsed time or currency is claimed.

The run becomes COMPLETED when quiescent with no blocked work, otherwise BLOCKED. Completed lineages remain completed even when other work blocks. Executors receive copies of work state, DNA, public evaluation criteria, and child outcomes; they cannot mutate engine state. Validation failures and executor/evaluator exceptions block only the current work with a structured reason. Storage failures remain fatal.

## Modules and persistence

- `domain`: lifecycle, actions, entities, ancestry and resources.
- `engine`, `scheduler`: deterministic transitions and priority/FIFO batches.
- `executor`, `evaluation`: structured-action and evaluator interfaces, scripted executor and deterministic fake evaluator.
- `persistence`: SQLite state tables and an append-only event table, committed atomically per finished simulation.
- `replay`, `render`, `cli`, `scenarios`: deterministic verification, observability and reference scenario.

SQLite stores tasks, runs, lineages with parent ancestry, one assumption per child, work units with spawn parents, evaluator payloads, and ordered events. Status, priority, reasons and resources are queryable alongside JSON entity records. Evaluation payloads live in a separate table and never enter executor contexts or ordinary inspection. This is an interface boundary, not access control against readers of the database. Artifact references are opaque strings.

Normal tables are authoritative; this is not event sourcing. M0 persists final state and the complete transition log in one transaction. Replay reruns the saved scenario and configuration and compares the entire semantic state and ordered event sequence; it does not append another run. Replay retains the original Task and Run identities. IDs, queue counters and synthetic usage are deterministic. Persisted custom executors are outside replay support: reproducible CLI runs use scenario scripts and the fake evaluator.

## Development

```sh
npm run format
npm run check
npm run build
```

Tests cover the reference scenario, branch preservation, DNA, scheduling, local failures, resource budgets, SQLite transactions and replay, including property checks over budgets, concurrency and fork widths.

## Deferred beyond M0

Crash recovery/checkpointing during a run, migrations between released schemas, true asynchronous workers, stronger token/cost/time budgets, unblocking/resurrection policies, alternative evaluator implementations, secrets/access controls, and real artifact backends are deferred. There is no LLM integration, auto-merge, explicit JOIN, confidence scoring, GUI, semantic search or distributed execution.

Run status is limited to ACTIVE, BLOCKED and COMPLETED, preserving M0 aggregation. Lineage and work status types remain separate names for the existing lifecycle; main work records BRANCHED after FORK, while spawned work is forbidden from forking. DEAD remains representable but has no M0 transition.
