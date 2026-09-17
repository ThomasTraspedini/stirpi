# Pilot harness

The `strpi experiment` command runs one pilot at a time. It uses the M2 process
boundary, the existing engine and Git workspace lifecycle. It contains no D032
answer, semantic evaluator, provider integration, or repeated-run scheduler.
The actual D032 public evaluator configuration must be frozen separately before
running a real pilot. Fixture runs validate infrastructure only.

```sh
strpi experiment run docs/experiments/d032/manifest.json \
  --condition T --verification-mode trusted-local \
  --source /absolute/path/to/source-repository \
  --executor /absolute/path/to/executor.json \
  --public-evaluator /absolute/path/to/public-evaluator.json \
  --output /absolute/path/outside-source/pilot-evidence
strpi experiment replay /absolute/path/to/pilot-evidence/RUN_UUID
strpi experiment evaluate /absolute/path/to/pilot-evidence/RUN_UUID \
  --private-data /absolute/path/to/private-data --hook /absolute/path/to/hook.json
```

`run` rejects private evaluation flags. The separate `evaluate` command refuses
active or unfinished runs, writes a new `post-evaluation.json`, and never rewrites
runtime results. Hook stdin is `{runDirectory, privatePath}`; stdout/stderr and
exit status belong only to the post-run report. Treat that report as private.
The hook is a trusted local program. No semantic scoring is supplied.

## Configuration and control

Every run selects `--verification-mode none|trusted-local` explicitly. Omission
or an unknown value fails before solver execution; an error never changes modes.
`none` exposes no VERIFY operations and exists for paths that do not request
solver-visible verification. The approved H*/S*/T* pilot uses `trusted-local`
symmetrically for all conditions.

Executor and hook command files use M2 `{id, executable, args}` configuration.
Use absolute executable/script paths. Configuration files and optional metadata
must contain only nonsensitive values: no credentials, tokens, or secret command
arguments. Commands and diagnostic outputs are audit evidence. Adapters must not
print credentials. Credentials are not inherited into solver processes.

The public evaluator file is required and has this shape:

```json
{
  "id": "your-frozen-public-contract-version",
  "criteria": {
    "description": "Public contract",
    "criteria": ["Public criterion"]
  },
  "command": { "executable": "/absolute/path/to/public-evaluator", "args": [] }
}
```

The external JSON evaluator receives
`{result, criteria, workId, lineageId, artifactRef?, workspacePath?}` on stdin and
returns `{passed: boolean, reason: string}`. Result and criteria retain their
existing names. The TypeScript evaluator interface takes this structured context
as one argument. Artifact identity comes from engine state after the COMPLETE
workspace check, never from result text. Only the current candidate's canonical
ref and active workspace are included; branch metadata, sibling state, hidden
material and unrelated host paths are excluded. Evaluation precedes workspace
release. External evaluator processes run in the candidate workspace when present.

Alternatively, configure independent public checks:

```json
{
  "id": "software-public-v1",
  "criteria": {
    "description": "Public software verification",
    "criteria": ["Tests and type checking pass"]
  },
  "checks": [
    { "id": "tests", "executable": "npm", "args": ["test"] },
    { "id": "types", "executable": "npm", "args": ["run", "typecheck"] }
  ],
  "completionPolicy": "all_checks_pass"
}
```

Checks require unique stable IDs, executable and argument arrays. The optional
`workingDirectory` accepts only `"candidate"`, which is also the default. Checks
require an active candidate workspace and canonical artifact; they never fall
back to the harness directory or parse paths from result text. Commands run
sequentially with `shell: false`, and every check runs even after another fails.
A nonzero command exit is a normal negative evaluation. Launch errors, timeouts
and output-limit errors are operational failures. External JSON evaluator
process failures retain their existing operational meaning.

In `trusted-local` mode, VERIFY IDs are derived exactly from these public checks.
That mode requires a check evaluator with `all_checks_pass`, authoritative trusted
workspace preparation, and one of the fixed prepared operations (`npm test`,
`npm run typecheck`, or `git diff --check`). The solver selects only an ID; it
cannot provide command, arguments, directory, environment, timeout, database or
policy. A request runs one selected check on that work's active workspace after
trusted preparation, with the same per-work PostgreSQL lease and environment used
by completion. Output is bounded, control characters are removed, and database
URLs are redacted. A nonzero exit is normal negative evidence; preparation,
launch, timeout and infrastructure errors are operational failures.

VERIFY does not create lineage or authorize completion. COMPLETE independently
runs the full public `all_checks_pass` policy even after a positive VERIFY, and
verification evidence is delivered only to a later invocation of the same work.

`runtime-evaluations.json` records authoritative context, overall timestamps,
aggregate evaluation, individual checks, process observations and operational
errors. Each check records ID, timestamps, process status, exit status, signal,
bounded stdout/stderr, truncation, pass/fail and error. Check output is limited
to 1 MiB per stream, with a 1 MiB process capture budget; each check uses the
configured process timeout. An operational failure has a null aggregate evaluation
and retains all individual check evidence. Ordinary outcomes include
`{passed, reason, completionPolicy, checks}`. Engine events also record evaluation
requests and outcomes, including negative and operational outcomes.

Configuration must be public; the same criteria are supplied to the solver.
Passing authorizes runtime completion (D039/D044), without experimental correctness
claims. The frozen D032 file currently has command strings instead of executable
and argument arrays and lacks explicit public criteria. Validation reports that
incompatibility without rewriting or enriching the frozen file.

The solver receives the ordinary M2 envelope with two additional context fields:
`task` holds the exact frozen UTF-8 task, and `control` describes the available
generic actions. The root objective is also the unchanged task. Descendant
objectives may differ through normal FORK/SPAWN actions; `task` stays unchanged.
No experiment README, conditions, evaluation document or historical material is
loaded into solver input. Protocol text is separate from task bytes.

H and S use the same engine scheduling and M2 artifact operations as T, with
FORK rejected before artifact effects. SPAWN remains decomposition within a
single lineage. H adds the documented human gate; a structured
`BLOCK/HUMAN_DECISION_REQUIRED` stops further solver invocations in the run.
No response is synthesized. S adds no ambiguity-resolution policy: the executor's
ordinary policy and repository governance apply, and no human answer is supplied.
Its existing policy can be recorded in optional `baselinePolicy` metadata; this
field is evidence, not an injected prompt. Both conditions expose the same
CONTINUE/SPAWN/COMPLETE/BLOCK mechanics. T exposes normal FORK semantics.
No rationale is parsed to choose a transition or infer a semantic conclusion.

`--metadata` accepts executorVersion, model, modelVersion, effort, sampling, and
baselinePolicy strings. For preregistered Codex runs, model and effort come from
the required adapter arguments; matching free metadata is accepted, contradictory
metadata fails preflight, and omitted metadata is filled from the effective
executor configuration. That effective configuration is retained in evidence and
hashed into the executor configuration identity. Other missing metadata values are
null. Command/scaffold/limit metadata is also hashed into that identity. Steps and executor supervision
are unbounded when omitted; concurrency defaults to 1. `--timeout-ms` is a legacy
executor-only invocation wall-time option. Public evaluator timing is independent:
`--evaluator-wall-time-ms N` explicitly bounds each public evaluator process
(each check separately). Omission disables the wall-time limit for experiment
runs, including both JSON evaluators and command checks.
Output is limited
to 1 MiB per process. Execution awaits each invocation asynchronously; concurrency
remains the M0 batch setting, with unchanged serial scheduling order.

## Input and Git isolation

The manifest identifies repository, full source commit, task file and SHA-256.
The harness validates the hash and lossless UTF-8 encoding before creating a run.
It verifies the local origin identity (or supplied GitHub URL). A local source
may have a newer HEAD and dirty files: neither its working files nor its Git
directory are copied or used for execution. A missing commit or wrong identity
aborts before any solver invocation. Remote acquisition fetches the exact commit
without tags into a harness-only repository.

A fresh repository is populated with `pack-objects --revs` rooted only at the
specified commit, followed by `index-pack`. The transfer preserves the original
commit and its reachable history but copies no unrelated objects, refs, reflogs,
alternates, remotes, hooks or source configuration. Shallow sources are rejected.
The starting HEAD and clean working state are checked. Unlike a checkout inside
a clone of newer history, ordinary `git log --all` and object enumeration cannot
recover later answer commits that exist only in the source repository.

Each M2 work assignment gets a separate object database populated from its
assigned immutable base. Existing M2 handles its persistent worktree and commits.
Only committed outcomes are exported to the audit archive; sibling objects are
never imported into each other's databases. A parent can receive the artifact
objects returned by its own spawned work. Branch names are operational refs.
This preserves normal sibling and SPAWN boundaries without adding core semantics.

This is still trusted local process infrastructure, not an OS security sandbox.
A process with the invoking user's filesystem/network permissions can access
other paths deliberately. The harness prevents history/context leakage through
assigned Git databases and protocol inputs; it does not provide adversarial
filesystem or network containment. Solver HOME/TMPDIR are fresh per work and
only PATH, LANG and TZ are carried into the process environment.

## Evidence and accounting

Each UUID directory has `metadata.json`, exact `task.txt`, `result.json`, ordered
`invocations.jsonl`, `runtime-evaluations.json`, `state.json`, `state.sqlite`,
`events.jsonl`, `tree.txt`, and Git `artifacts`/`worlds` databases. Invocation
records include input, action/text, stdout/stderr hashes and captured sizes,
timestamps, exit status, signal and process errors. Raw process output is omitted.
`operational.jsonl` is appended during execution with a run-wide sequence,
invocation index, and sanitized event with its own invocation sequence. Events
are also retained in recorded executor operations in state/SQLite. Interleaved artifact records provide requested effects
and before/after immutable refs. Initialization and cleanup also appear there;
use their request work IDs, not the most recent invocation index, for ownership.
Final committed diffs are saved per work. Dirty/ignored workspaces remain available
and are also copied without `.git` into `pending-workspaces`, with dirty diffs
and status listings. Run directories are outside the source repository.

The result reports runtime observations and evidence paths, not semantic scores.
Resources aggregate all work: invocations, engine steps, measured wall time,
logical/scheduled lineages, counts for every lineage status, unique new artifact
commits, and actual supplied human interventions (zero for these unattended
runs). `lineageCounts.created` is the number of logical lineages created;
`scheduled` counts distinct lineages whose work consumed at least one engine
step. Required human decisions are recorded separately from supplied
interventions.

`resources.tokens` reports real provider `inputTokens`, `cachedInputTokens`,
`outputTokens`, and `reasoningOutputTokens`. Usage events within one executor
invocation are cumulative snapshots: the last available value for each field is
used, and each invocation contributes once. Cached input remains separate from
input. An unobserved field is `null`; an observed zero is `0`.
`resources.usageCoverage` separately reports the executor-invocation denominator,
invocations with any usable usage field, and measured invocation counts per
field. `operational.jsonl` is the canonical aggregation source;
`invocations.jsonl` supplies its denominator, while the duplicate observations
in state are consistency evidence. `resources.operational.latestUsage` remains a
single diagnostic snapshot and is never the run total. Missing provider usage is
not estimated, monetary cost remains null, and legacy synthetic engine token
counters remain only in raw state/events for replay.

Replay uses recorded public evaluator outcomes as well as the existing recorded
executor/artifact boundaries. It requires no repository, solver, public evaluator
process or private material, and verifies the resulting engine state/events.
It also verifies operational chronology and consistency between the incremental
file and recorded operations, reconstructs run accounting from persisted
invocation/operational/state evidence, and rejects reported totals, coverage, or
lineage counts that do not match. It does not deliver observations to live
external observers or verify external artifact integrity (D031).

Chronological files are written during execution; final state is saved after the
engine returns. A process killed mid-run leaves the `running` marker and partial
evidence. Recovery/resumption is deferred. Post-run hooks have a 60-second limit
and may be invoked only once per run directory. Real coding-agent adapters,
D032 public evaluator freezing, private semantic evaluation and repeated-run
scheduling remain separate work.

`runExperiment` now returns a Promise. Callers may supply an AbortSignal; CLI
SIGINT/SIGTERM request cancellation. Collected events, failure records and dirty
workspaces are retained, including pending-workspace copies. Cancellation records
`EXECUTOR_CANCELLED`, explicit invocation wall-time exhaustion records
`EXECUTOR_WALL_TIME_EXHAUSTED`; neither is semantic falsification or no-progress.
Telemetry does not select actions or alter H/S/T evaluation semantics.

## Executable preregistration

Pass `--preregistration /absolute/path/to/pilot.json` to `experiment run`, or set
`RunOptions.preregistration`. Keep supplying the manifest, condition, source,
executor command, public evaluator and output paths; no manual limit translation
is needed. The accepted pilot document uses `id`, `class: "pilot"`, `testcase`,
`condition`, `limits`, and `hiddenEvaluationDuringRun: false`. When `stirpiCommit` is present it must be an
exact, available commit in the repository containing the committed pilot file.
The pilot bytes must match that repository's HEAD; HEAD need not equal the pin.
The launcher transfers the pinned revision into a fresh clean repository,
compiles its TypeScript outside that checkout, and invokes its experiment harness
in a separate Node process. No built code, package scripts, or Node loaders from
the launching HEAD are executed in that process. The installed TypeScript compiler
and Node type declarations are build tools; compilation failure stops preflight.
The pinned revision must provide the experiment run API. Its policy validation
and execution semantics remain authoritative. Unpinned fixture pilots retain the
local execution path.

When launching an externally compiled runtime, use the wrapper in the active
Stirpi source checkout:

```sh
node /path/to/stirpi/tools/launch-pinned-runtime.mjs /path/to/external/build/cli/index.js experiment run ...
```

The wrapper derives `node_modules` relative to its own source-checkout location,
independently of the working directory. It replaces inherited `NODE_PATH` for
the outer Node process and first verifies that `typescript/bin/tsc` and
`@types/node/package.json` resolve within that dependency tree from the relocated
launcher. Missing dependencies fail before launcher execution or runtime
compilation. The wrapper does not install dependencies or write to the pinned
checkout. The pinned launcher's compiler and runtime children retain their
existing PATH-only environments; executors do not receive `NODE_PATH`.

The original preregistration is snapshotted as external input, along with its
explicitly referenced public evaluator file (which must stay within the input
repository). It need not exist in the runtime checkout. Testcase source Git
isolation is unchanged. Successful run evidence independently records exact
preregistration contents and SHA-256, `preregistration.containingCommit`,
`runtime.pinnedCommit`, and `runtime.actualCommit`. Replay checks consistency of
these identities against the embedded metadata and document without Git effects.

Optional `publicEvaluator`
contains `file` relative to the pilot file and `sha256`; its bytes and parsed
configuration must match the supplied evaluator. Testcase and condition must match
the run. Unknown pilot fields and unknown limits fail preflight.

| Preregistered limit                 | Runtime field                    |
| ----------------------------------- | -------------------------------- |
| `limits.maxSteps`                   | `budgets.steps`                  |
| `limits.maxExecutorInvocations`     | `budgets.invocations`            |
| `limits.maxLineages`                | `budgets.lineages`               |
| `limits.maxItemsPerInvocation`      | `supervision.budgets.items`      |
| `limits.maxCommandsPerInvocation`   | `supervision.budgets.commands`   |
| `limits.maxWallTimePerInvocationMs` | `supervision.budgets.wallTimeMs` |
| `limits.noProgressMs`               | `supervision.noProgressMs`       |
| `limits.maxEvaluatorWallTimeMs`     | `evaluatorWallTimeMs`            |

Limits are nonnegative safe integers; no-progress and evaluator durations must
be positive. Evaluator duration is at most 2147483647 ms. Omitted entries stay
absent and disabled, with no inherited defaults. An empty `limits` object is
valid. New derived configuration contains no compatibility aliases. Supplying
`maxSteps`/`timeoutMs` (CLI `--steps`/`--timeout-ms`) alongside preregistration is
an error, even when equal. Structured overrides must exactly equal the derived
policy; they cannot add undeclared limits.

Before invoking any executor, preflight validates the document and agreement.
`preflight.json` records the original public document, its SHA-256, declared limits,
derived budgets, supervision, and evaluator policy (`null` means unbounded).
`metadata.json` embeds that evidence and the effective runtime configuration;
engine state retains run budgets and invocation records retain supervision
observations. Configuration is snapshotted before execution so caller mutation
cannot change the applied policy. Invalid preregistration throws before output
creation or executor invocation. No private evaluation input is read by preflight.

Preregistration `executor.executableVersion` pins the reported executable version.
Optional `executor.executableSha256` pins its exact bytes as 64 lowercase hex
characters. Before launching experiment work, preflight resolves the configured
executable, verifies it is an accessible executable file, hashes its bytes, and
runs `--version`. Version or pinned hash mismatches fail preflight. For
`executor.adapter: "codex"`, these checks target the configured `--codex` binary,
not the Node adapter launcher; the version pin omits the reported `codex-cli `
prefix. Direct process executors pin the complete trimmed `--version` output.

Preflight records `executor.executablePath`, `executor.executableVersion` (the
actual reported string), and `executor.executableSha256`; run metadata retains
these as `executorIdentity` and in its preflight evidence. The resolved absolute
path is used for launch. Paths are deployment evidence: identical bytes at a
different path pass the same version/hash pins. Historical preregistrations may
omit the hash (and existing fixtures may omit executor pins); actual identity is
still measured and recorded. No executable is installed, copied, or repaired.
As with other runtime behavior, D054 applies: a pinned older runtime retains its
historical preflight behavior; new byte pins require a runtime supporting D055.

Trusted workspace preparation runs once per assignment before executor launch.
`RunOptions.preparation` configures npm lockfile installation, module resolution,
and disposable PostgreSQL prerequisites. Booking Invariants defaults to PostgreSQL
16 and `btree_gist`. Docker atomically allocates a loopback port; no fixed host port
or shared database is used. Credentials exist only in outer process environments.
The executor retains its existing workspace-write sandbox and environment allowlist;
it needs neither installation nor Docker operations.

`preparation.json` records package and lockfile hashes, package identity, preparation
steps, container/image identity, port, and cleanup. Public verification remains the
predeclared evaluator checks. The prepared path allows only `npm test`,
`npm run typecheck`, and `git diff --check`; only the test process receives
`DATABASE_URL`. Changed package or lockfile identity is rejected before verification.
These checks execute candidate code and are trusted outer operations, not a new
sandbox for arbitrary hostile test code. Existing runtime evaluation records retain
command results. Replay checks the preparation evidence digest and consumes recorded
runtime outcomes without installing, provisioning, or executing checks.

`metadata.json` and `result.json` record the effective verification mode and a
verification configuration identity. Metadata also records the exact available
public IDs. Each recorded VERIFY operation binds the requested ID, work ID and a
bounded workspace digest; attempts are numbered per work/ID. Replay consumes only
those recorded outcomes and never prepares a workspace, starts PostgreSQL or
executes a check.

Database resources are removed at run completion, including operational failure.
Dirty workspaces retain the existing diagnostic retention policy. Preparation does
not install into the frozen source checkout. No executor/backend sandbox settings
are changed by this infrastructure.

The P1 H*/S*/T* schema-3 pilot pins a closed, public trusted-local contract in
runtime R. Unlike schema 2 it is not an isolated verification profile. Contract
and governance bytes, public inputs and the Codex adapter are read from the
committed R checkout; public inputs are snapshotted after comparison with P.
Local tool locations are deployment locators only (`trustedLocalTools` in the
API); versions, executable hashes and npm/compiler/type-root installation
closures must match R before compilation or solver invocation. Closure SHA-256
v1 hashes JSON plus LF of sorted `[relative path, executable bits, file SHA256]`
entries, with no file exclusions and no symlink entries inside the closure.
The schema-3 preflight-only CLI additionally requires an absolute external
`--toolchain-root`. TypeScript and `@types/node` are resolved from that root's
`package.json`, never from the clean R checkout or an implicit environment
fallback. The root remains a locator only; evidence records the effective tool
locations and the existing contract hash checks remain authoritative.

The schema-3 preparation environment uses a dedicated external PATH with
verified Node/npm/Git/Docker, empty user/global npm configuration, fixed registry
and no inherited npm/Docker configuration or credentials. npm receives the
separately pinned, absolute script shell `/bin/sh`; its bytes are rechecked before
the trusted environment is exposed. `/bin` is not added to PATH and no `sh`
symlink is created in the trusted bin. The executor receives a separate verified
Node/npm/Git PATH without Docker, the script-shell setting, or the shell. Local PostgreSQL
image IDs have explicit OS/architecture, are inspected, and launch without pull;
they are never relabeled as registry digests. Baseline package/lock pins are
checked before the solver. Candidate operations are compared with baseline
authority before each preparation step and lease reuse, including new descendant
workspaces. Covered metadata changes require a fresh lease; uncovered operations
or dependency resolution fail operationally and do not rewrite candidates.

Governance is a separate verified context field. Adapter projection validates
its hash; the explicit common prompt section preserves its text, while task
stdin stays unchanged. Invocation evidence records expected prompt bytes/hash
and hashes returned by the effective adapter. Replay validates recorded contract,
input, governance and prompt identity without resolving toolchains or running
preparation/checks. Historical pilots do not receive this governance.
