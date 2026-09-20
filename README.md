# Stirpi

Stirpi is a lineage runtime with a Git artifact backend. The CLI is `strpi`. M0 explores conditional lineages with a deterministic executor; M1 adds isolated artifact work; M2 adds a provider-neutral external process executor. M2 is provider-neutral; this repository also contains an experimental, preregistered Codex adapter for the documented H/S/T pilot. It is not a general provider-integration layer. The pilot's derived [results](docs/experiments/p1-hst/RESULTS.md) and [redacted offline replay package](docs/experiments/p1-hst/REPLAY.md) distinguish recorded runtime completion from semantic validity.

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

Normal tables are authoritative; this is not event sourcing. M0 persists final state and the complete transition log in one transaction. Replay reruns the saved scenario and configuration and compares the entire semantic state and ordered event sequence; it does not append another run. Replay retains the original Task and Run identities. IDs, queue counters and synthetic usage are deterministic. Legacy custom action executors remain outside replay support; structured protocol executors record their invocation outcomes for replay. CLI runs use the deterministic fake evaluator.

## Development

```sh
npm run format
npm run check
npm run build
```

Tests cover the reference scenario, branch preservation, DNA, scheduling, local failures, resource budgets, SQLite transactions and replay, including property checks over budgets, concurrency and fork widths.

## Deferred beyond M0

Crash recovery/checkpointing during a run, migrations between released schemas, true asynchronous workers, stronger token/cost/time budgets, unblocking/resurrection policies, alternative evaluator implementations, secrets/access controls, and artifact integration policies are deferred. There is no general LLM-provider integration, auto-merge, explicit JOIN, confidence scoring, GUI, semantic search or distributed execution.

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

The existing M0 path remains available without an artifact backend. Legacy custom decision executors remain outside replay support; the M1 callback's artifact outcomes are recorded, while decision actions use the saved scenario scripts. Crash recovery across external effects and SQLite persistence, artifact integrity verification, result integration, and provider-specific coding-agent integrations remain deferred.

## M2 external process protocol

Use `ProcessExecutor` with `GitWorkspaceBackend` in `await simulateAsync(...)`, or pass
`--executor process-config.json --repo /path/to/clean/target` to `run`.
The process config contains `executable`, optional `args` (an array of strings),
and an optional executor `id`. Use absolute paths for executable scripts and
arguments referring to files: every invocation runs in its assigned worktree.
The executor ID is operational metadata and does not define lineage identity.

The adapter starts one process per scheduled invocation, without a shell. It
writes one JSON object plus a newline to stdin, closes stdin, and reads one JSON
object from incrementally collected stdout after process exit. Diagnostics belong on stderr. Output is
bounded to 1 MiB. Version 1 input has this shape:

```json
{
  "version": 1,
  "context": {
    "identity": { "taskId": "task", "runId": "run" },
    "work": {},
    "dna": [],
    "publicEvaluation": {},
    "results": []
  }
}
```

`work` contains the assigned work's objective, status, iteration cursor, resource
usage and artifact metadata, including its `artifact.worktree`. `dna` contains
only that lineage's ancestry assumptions. `results` contains only this work's
own spawned child outcomes, with immutable artifact refs rather than child
workspace paths. The full typed shape is `ExecutorContext`. Hidden evaluator
material, sibling assumptions, sibling rationale, sibling results and sibling
workspace paths are absent. Contexts are copied; changing received JSON cannot
mutate engine state. FORK children see their own assumption path; SPAWN children
retain their parent's lineage/DNA and receive distinct workspaces.

A response explicitly separates the action, artifact requests and optional text:

```json
{
  "version": 1,
  "action": { "type": "CONTINUE" },
  "effects": [{ "type": "COMMIT", "message": "Fix empty input handling" }],
  "text": "Implemented the empty input case."
}
```

`effects` is required (use `[]` for no requests). Only `COMMIT` with a nonempty
message is supported; executors cannot select paths, branches or canonical refs
through effects. Actions are CONTINUE, FORK, SPAWN, COMPLETE and BLOCK, using the
existing action fields; COMPLETE contains a string `result` and cannot supply
`artifacts`. Text never controls transitions. Unsupported versions, malformed
responses and forbidden actions fail locally as structured BLOCKED outcomes.

Stirpi validates the envelope and action, including FORK eligibility and name
uniqueness, before applying requested commits in order. It then checks committed
state for FORK, SPAWN and artifact-bearing COMPLETE, and evaluates COMPLETE
before allowing successful completion. A failed commit prevents the transition;
previous successful commits remain canonical. File changes or exit status alone
never imply any action. Launch/exit/JSON failures also block only the assigned
work; a failed spawned child returns its outcome to its waiting parent.

Under D042, each work unit keeps the same workspace across invocations, including
uncommitted changes on CONTINUE and while waiting for spawned children. Commits
stage the assigned workspace's tracked and untracked changes, skip unchanged
trees, and advance the canonical full commit SHA without ending the work unit.
Dirty state is transient, not an artifact. Dirty FORK, SPAWN or COMPLETE is
blocked without an implicit commit. At run end, clean worktrees are removed;
dirty or ignored files are retained for inspection. Branches and commits remain.
Git's normal ignore rules apply; ignored files are not included in commit requests.

This is **trusted local executor infrastructure**. Worktree isolation is artifact
and work isolation, **not security sandboxing**. Stirpi assigns separate paths,
uses those paths as process cwd, and routes commit operations through its artifact
layer. An arbitrary local process still has the operating system permissions of
the invoking user and must obey the workspace boundary. It must not perform
unmanaged Git history operations. M2 adds no containers or filesystem access
controls. The database, exports and invocation logs belong outside the target.

Process execution is asynchronous; scheduler selection and serial invocation order
remain unchanged. `simulate` remains synchronous for deterministic executors and
replay; use `simulateAsync` for process executors and async wrappers. Optional
operational JSONL on descriptor 3 is independent of the final stdout response.
`ProcessOptions.observeEvent` receives bounded, sanitized observations during
execution; `signal` supports caller cancellation. There is no implicit executor
timeout. Explicit `timeoutMs` means wall-time resource exhaustion (D049).
Legacy engine resource counters remain synthetic; actual telemetry is separate.
Crash recovery and live checkpoint resumption remain deferred. COMPLETE currently uses the existing required-text
fake evaluator, so demo success is not a claim of code correctness.

Executor identity, local input context, ordered operational observations and response/failure are recorded as
`EXECUTOR_OPERATION` events; workspace requests/outcomes use the existing artifact
operation table and event log. Replay supplies those observations, verifies
requests and contexts, and compares final state/events without relaunching
processes or repeating Git mutations. It does not verify artifact integrity.

### Small process demonstration

With the repository built, run this from the Stirpi checkout (requires Git author
configuration for the temporary target):

```sh
demo=$(mktemp -d)
git init -b main "$demo/target"
git -C "$demo/target" config user.name "Stirpi Demo"
git -C "$demo/target" config user.email "demo@example.invalid"
printf 'base\n' > "$demo/target/base.txt"
git -C "$demo/target" add base.txt
git -C "$demo/target" -c commit.gpgsign=false commit -m "Add base file"
node --input-type=module - "$demo" "$PWD/test/fixtures/executor.mjs" <<'JS'
import { writeFileSync } from 'node:fs';
const [dir, fixture] = process.argv.slice(2);
writeFileSync(`${dir}/executor.json`, JSON.stringify({
  executable: process.execPath, args: [fixture, 'progress', `${dir}/calls.jsonl`]
}));
writeFileSync(`${dir}/scenario.json`, JSON.stringify({
  name: 'process-demo', objective: 'Produce coherent progress', scripts: {},
  publicEvaluation: { description: 'Return done', criteria: ['Include done'] },
  hiddenEvaluation: { requiredText: 'done' }
}));
JS
node dist/cli/index.js run "$demo/scenario.json" --executor "$demo/executor.json" --repo "$demo/target" --db "$demo/state.sqlite" --id m2
node dist/cli/index.js inspect m2 --db "$demo/state.sqlite"
node dist/cli/index.js replay m2 --db "$demo/state.sqlite"
```

The tiny fixture makes four invocations in one workspace: an uncommitted edit,
a commit of accumulated progress, another commit, and a no-change commit request
with COMPLETE. The result has two new commits and one unchanged lineage. The
external invocation log records the assigned cwd and local context. Changing the
fixture mode from `progress` to `fork` demonstrates two isolated alternative
worlds, one of which spawns same-lineage work. Use a fresh run ID and log path.

## Experimental pilot harness

`strpi experiment` prepares isolated frozen-input H/S/T pilot runs through M2,
records auditable evidence, and separates public runtime completion from optional
post-run private evaluation. See [harness usage](src/experiments/README.md).
The documented H/S/T pilot was executed on its frozen inputs; its concise public
outcome and limits are in [the results report](docs/experiments/p1-hst/RESULTS.md).
The harness remains useful beyond that single pilot, but the adapter and pilot
results do not establish general provider support or semantic correctness.

See [operational events](docs/operational-events.md) for transport, classification,
evidence, cancellation and replay details.

## O2-FS design checkpoint

The [O2-FS source and holdout protocol](docs/experiments/o2-fs/PROTOCOL.md) and
[manual review checklist](docs/experiments/o2-fs/REVIEW-CHECKLIST.md) are a
design checkpoint for a prospective evaluation surface. They are separate from
the observed H/S/T pilot and its recorded replay, and do not constitute a new
benchmark, frozen study, or run.
