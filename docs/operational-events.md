# Incremental operational observations

D047–D049 separate operational activity, progress, resource use, explicit
cancellation and final semantic decisions. No observation selects CONTINUE,
FORK, SPAWN, COMPLETE or BLOCK. The existing final v1 envelope and public
evaluation remain authoritative.

## Transport and API

`await ProcessExecutor.execute(context, observe?)` uses asynchronous `spawn`,
incrementally drains stdout/stderr and an optional JSONL pipe on descriptor 3.
The environment advertises `STIRPI_OPERATIONAL_FD=3`; legacy programs can ignore
it. Stdout contains exactly one final JSON value. Missing, malformed or multiple
values fail operationally. Envelope/action validation remains in the engine.

The process receives the unchanged v1 stdin assignment and filtered environment.
The optional pipe accepts generic `{kind, scope?, status?, metadata?}` observations;
it never carries a final response. Invalid telemetry becomes diagnostic activity.
Pipe lines are bounded to 16 KiB and selected output metadata is under 2 KiB.
A line exceeding the bound is discarded through its delimiter. UTF-8 boundaries
and EOF without a newline are handled explicitly.

`ProcessOptions.observeEvent` receives normalized events immediately, while
`observe` receives the bounded terminal process capture. Raw stdout/stderr capture
retains the existing 1 MiB safety bound. Observer callback failure terminates and
reaps the owned process as a local operational failure. A caller must keep
callbacks short; synchronous sinks can apply backpressure.

`simulateAsync` and synchronous `simulate` drive one shared transition generator.
Selection, work ordering, FORK/SPAWN, evaluation and artifact operations are
unchanged. Process callers and async wrappers must use `simulateAsync` and await
returned Promises. Deterministic executors and replay retain the synchronous API.

## Representation and classification

An event adds a monotonic per-invocation `sequence`, receiver UTC `timestamp`,
invocation UUID, and `categories` to the generic input. Scope is a SHA-256 identity.
Allowed kinds cover process/thread/turn/item/command/file/tool/agent/reasoning,
output, usage, diagnostics and operational termination. Provider payloads are not
part of the domain contract. No lineage or work identity is inferred from them.

Every observation is activity. A previously unseen `(kind, scope, state)` is
progress; a repeated notification of the same state is not. Unstructured updates
and output do not imply progress. Numeric changes are resource observations, as
is a newly started item/command/tool scope. Resource metadata comparison ignores
field order. No operational progress implies problem-solving success.

Metadata is a closed projection of selected integer counters and SHA-256 digests.
It excludes arbitrary text, raw commands, paths, output, tool arguments, secrets
and environment values. Provider identity digests support equality comparisons
without persisting original identifiers. Summary command/tool/item counts count
unique observed scopes, including scopes first seen at completion; zero means
none observed, not proof of no hidden tool activity.

## Persistence and replay

Experiments append `operational.jsonl` before invoking a live observer. Each row
has a run-wide sequence, invocation index and the event. This order survives
identical timestamps. Final executor operations retain the same observations on
success and failure; existing JSON/SQLite persistence stores them with the final
response or operational reason. Process capture evidence stores hashes/sizes,
not raw stdout/stderr. Final semantic responses remain separately recorded.

Run results include counts, first/last activity and progress times, unique scope
counts, and latest usage when exposed. Event size is bounded; chronology grows
with execution rather than silently dropping observations or imposing a resource
budget. State is finalized after execution; recovery from a hard host/process
crash remains outside this milestone.

Replay reconstructs and checks event sequences, scope classifications and
invocation identities, then supplies recorded responses/failures to the same
transition engine. Experiment replay also compares incremental evidence against
recorded operations. It launches no executor, command, evaluator or artifact
backend and does not notify live observers. Final state/event comparison checks
semantic transition consistency. This is consistency verification, not evidence
authentication or artifact-integrity checking.

## Explicit termination

There is no default invocation timer. Explicit `timeoutMs` (adapter:
`--timeout-ms`) means wall-time resource exhaustion. `AbortSignal` means caller
cancellation; a pre-aborted signal prevents launch. CLI SIGINT/SIGTERM request
cancellation and await evidence finalization. These are separate operational
reasons, never no-progress or semantic falsification.

On POSIX, termination signals the owned process group and escalates after one
second solely for cleanup. The Codex adapter forwards termination to its detached
agent group. Windows outer cleanup can terminate the immediate child; the Codex
adapter remains POSIX-only. Deliberately detached descendants or uncatchable host
termination are not contained by this trusted-process boundary.

Existing local operational-failure handling preserves BLOCKED versus DEAD and
retains inspectable dirty workspaces. Experiment cancellation also preserves
incremental evidence and pending-workspace copies. Evaluator timeout behavior is
unchanged. No no-progress, repeated-cycle, token or command budget policy is added.

## Codex coverage

The adapter uses the public `exec --json` interface documented in
[non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), tested
against host `codex-cli 0.153.4`. It maps thread/turn and item lifecycle, command,
file, MCP/web tool, agent/reasoning activity and usage when exposed. Native usage
is sampled at `turn.completed`; undocumented counters are not estimated.
See [adapter documentation](../adapters/codex/README.md) and
[smoke observations](../adapters/codex/SMOKE.md) for coverage and limitations.
