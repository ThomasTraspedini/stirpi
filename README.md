# Stirpi

Stirpi is a lineage-engine simulation with a Git artifact backend. The CLI is `strpi`. M0 explores conditional lineages with a deterministic fake executor; M1 adds isolated artifact work without LLM integration.

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

Crash recovery/checkpointing during a run, migrations between released schemas, true asynchronous workers, stronger token/cost/time budgets, unblocking/resurrection policies, alternative evaluator implementations, secrets/access controls, and artifact integration policies are deferred. There is no LLM integration, auto-merge, explicit JOIN, confidence scoring, GUI, semantic search or distributed execution.

Run status is limited to ACTIVE, BLOCKED and COMPLETED, preserving M0 aggregation. Lineage and work status types remain separate names for the existing lifecycle; main work records BRANCHED after FORK, while spawned work is forbidden from forking. DEAD remains representable but has no M0 transition.

## M1 Git artifacts

Requires system Git in addition to Node.js. The engine depends on `ArtifactBackend`, not Git commands or branch names. Pass a `GitArtifactBackend(repository, workCallback)` as the sixth argument to `simulate`. The optional trusted local callback receives a work request and a workspace with `path`, `base`, `branch`, and `commit(message)`. M1 invokes it once, at the work unit's first scheduled step, before its scripted action; the callback may make zero or more coherent commits. This is a small simulation adapter, not a coding-agent protocol. Work after parent resumption remains scripted in M1.

Initialization checks the target for tracked and untracked changes and resolves HEAD to a full commit SHA. Dirty targets produce a structured `DIRTY_REPOSITORY` blocked outcome before any work executes. Each scheduled work unit gets a separate worktree and branch from its saved base, including main work when it executes. FORK copies the current parent artifact to every child before any child executes. SPAWN captures the spawning parent's current artifact for every child, including nested SPAWN; completing a child never replaces the parent's artifact or merges its changes.

The callback's `commit` helper skips unchanged trees and uses ordinary descriptive commit messages. It adds changes within that isolated worktree, so callbacks should make only their intended edits. Canonical refs are full commit SHAs; branches and worktree paths are operational metadata. Clean temporary worktrees are removed after the callback. Dirty worktrees or failed cleanup are retained with structured failure information; branches and commits are preserved for audit. Callbacks are trusted local code and are responsible for coherent edits. M1 adds no sandbox or automatic history cleanup.

A small end-to-end demonstration against a **separate, clean repository with an initial commit**:

```sh
node dist/cli/index.js run git-reference --repo /path/to/target --db /tmp/stirpi-m1.sqlite --id m1
node dist/cli/index.js inspect m1 --db /tmp/stirpi-m1.sqlite
node dist/cli/index.js replay m1 --db /tmp/stirpi-m1.sqlite
```

Configure a Git author in the test target before running this example. `git-reference` uses the reference control scenario and makes X and Y write different contents to `artifact-example.txt` in their own worktrees. It prints the refs, base commits, branches, cleanup status, and worktree paths. Both results remain on separate branches; the target checkout is unchanged. The final run remains BLOCKED because reference branch B needs input. Ordinary `run reference --repo ...` demonstrates inheritance and no-change work without editing files. Keep the database and exports outside the target; the CLI checks output locations before opening its store.

Lineage/work JSON state stores artifact refs and operational metadata. An `artifact_operations` state table stores ordered structured requests and outcomes, also copied to the append-only event log for JSONL export. No Git blobs or diffs are stored in SQLite. Replay compares each generated artifact request with its recorded request and returns the recorded outcome without invoking the backend. It rejects missing, extra, or mismatched operations and compares the full resulting state/event sequence. Replay works even if the target repository is unavailable; it does not verify that commits still exist (D031).

The existing M0 path remains available without an artifact backend. Persisted custom decision executors are still outside replay support; the M1 callback's artifact outcomes are recorded, while decision actions use the saved scenario scripts. Crash recovery across external effects and SQLite persistence, artifact integrity verification, result integration, and real coding-agent execution remain deferred.
