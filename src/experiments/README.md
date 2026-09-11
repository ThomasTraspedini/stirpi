# Pilot harness

The `strpi experiment` command runs one pilot at a time. It uses the M2 process
boundary, the existing engine and Git workspace lifecycle. It contains no D032
answer, semantic evaluator, provider integration, or repeated-run scheduler.
The actual D032 public evaluator configuration must be frozen separately before
running a real pilot. Fixture runs validate infrastructure only.

```sh
strpi experiment run docs/experiments/d032/manifest.json \
  --condition T --source /absolute/path/to/source-repository \
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

The public evaluator receives `{result, criteria}` on stdin and must return
`{passed: boolean, reason: string}`. This preserves the current M2 evaluator
interface: it evaluates the result text and public criteria, not arbitrary
artifact paths. Its configuration must be public. The same criteria are supplied
to the solver. Evaluator failures block the current work; passing only authorizes
runtime completion (D039/D044), without experimental correctness claims.
The deterministic test evaluator checks a fixture result prefix. It is not the
D032 runtime contract.

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
baselinePolicy strings. Missing values are null. Command/scaffold/limit metadata
is hashed into an executor configuration identity. `--steps`, `--concurrency`,
and `--timeout-ms` default to 100, 1, and 60000; output is limited to 1 MiB per
process. Scheduling remains synchronous; concurrency is the M0 batch setting.

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
records include input, action/text, raw stdout/stderr, timestamps, exit status,
signal and process errors. Interleaved artifact records provide requested effects
and before/after immutable refs. Initialization and cleanup also appear there;
use their request work IDs, not the most recent invocation index, for ownership.
Final committed diffs are saved per work. Dirty/ignored workspaces remain available
and are also copied without `.git` into `pending-workspaces`, with dirty diffs
and status listings. Run directories are outside the source repository.

The result reports runtime observations and evidence paths, not semantic scores.
Resources aggregate all work: invocations, engine steps, measured wall time,
logical/scheduled lineages, unique new artifact commits, and actual supplied human
interventions (zero for these unattended runs). Required human decisions are
recorded separately from supplied interventions. Tokens and monetary cost are
null because M2 v1 has no reliable reporting fields. Legacy synthetic engine
counters remain in raw state/events for replay and are not reported as real usage.

Replay uses recorded public evaluator outcomes as well as the existing recorded
executor/artifact boundaries. It requires no repository, solver, public evaluator
process or private material, and verifies the resulting engine state/events.
It does not verify external artifact integrity (D031).

Chronological files are written during execution; final state is saved after the
engine returns. A process killed mid-run leaves the `running` marker and partial
evidence. Recovery/resumption is deferred. Post-run hooks have a 60-second limit
and may be invoked only once per run directory. Real coding-agent adapters,
D032 public evaluator freezing, private semantic evaluation and repeated-run
scheduling remain separate work.
