# Codex CLI adapter

External M2 protocol-v1 process adapter for the locally installed Codex CLI.
Tested interface: `codex-cli 0.153.4`, including `exec --output-schema`,
`--output-last-message`, `--json`, `--ephemeral`, and `--ignore-user-config`.
No provider code, dependencies, or imports are added to Stirpi core.
Removing this directory leaves core execution functional.

The [official non-interactive CLI documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
describes native schema output and JSONL usage events. Check local `exec --help`
before using another CLI version; unsupported flags fail operationally.

## Configuration

Use the existing M2 process configuration, with absolute paths:

```json
{
  "id": "codex-local",
  "executable": "/absolute/path/to/node",
  "args": [
    "/absolute/path/to/stirpi/adapters/codex/adapter.mjs",
    "--codex",
    "/absolute/path/to/codex",
    "--auth-file",
    "/absolute/path/to/already-authenticated/auth.json",
    "--model",
    "your-model",
    "--effort",
    "medium"
  ]
}
```

`--codex`, `--model`, and `--effort` are required exactly once. Supported effort
names are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`;
unsupported, absent, or duplicate values fail before the CLI is launched. The
adapter passes the model through `--model`, applies effort through the verified
`model_reasoning_effort` CLI configuration key, and enables `--strict-config`.
There is no implicit invocation timeout. An explicitly
supplied `--timeout-ms` is a wall-time resource limit. Exhaustion reports
`AGENT_WALL_TIME_EXHAUSTED`; caller termination reports `AGENT_CANCELLED`.
Both terminate the owned agent process group on this POSIX interface. The existing
1 MiB combined agent-output safety limit remains; it is not a token/command budget.

`--auth-file` optionally selects an existing CLI login file. The adapter never
reads or copies its contents: a temporary symlink allows the CLI to use and
refresh the selected login. No credentials belong in arguments, tasks, or logs.
Without an available login this invocation fails; no login or install flow runs.
Credential provisioning for environments without that explicit file is deferred.

## Contract and execution

Stdin contains one `{ "version": 1, "context": ... }` M2 invocation. The adapter
projects task/objective, assumptions, public criteria, own child outcomes and
supported public control fields. Unknown fields and descendant workspace paths
are omitted. `context.task`, when present, is passed unchanged as CLI stdin;
otherwise the work objective is used. Generic protocol instructions and projected
context are a separate CLI prompt argument. No experiment files are opened.

Success writes exactly one v1 `{version, action, effects, text}` JSON envelope to
stdout. The native response schema and instructions are derived for each
invocation from `context.control.actions`; unavailable actions are neither
described nor accepted. Trusted IDs in `context.verification.available` add a
closed VERIFY effect `{type:"VERIFY",id:<available ID>}` valid only with CONTINUE;
without available IDs no VERIFY effect is exposed. The adapter preserves the
allowlisted `available` and `latest` evidence fields but never accepts solver-owned
verification commands, argv, cwd, environment, timeout, network, or policy. The
final response file is validated against this invocation-specific closed schema.
Nullable optional priority/objective fields are removed syntactically.
No prose, intermediate events, or diagnostics select an action. Core still applies
its authoritative semantic validation and public evaluation.

Failure writes no stdout and exits nonzero, with a structured failure in the
stderr evidence record. M2 v1 has no process-level operational-error envelope;
ProcessExecutor records `PROCESS_EXIT_FAILED` for ordinary adapter failures.
Explicit resource exhaustion and cancellation have distinct generic failure codes.
Raw stderr is excluded from generic failure messages. It never receives an invented BLOCK or falsification action.

## Workspace and commits

Both process cwd and Codex `--cd` are the assigned active linked worktree. The
adapter rejects ordinary source checkouts, mismatched cwd and changed managed
HEAD/branch identity. Workspace edits persist. Only Stirpi executes returned
COMMIT effects; the adapter never stages or commits changes or silently repairs
Git identity. A COMMIT requests the whole current workspace. Multiple effects
pass through, but separate groups of edits require separate CONTINUE invocations
to create distinct coherent commits. No changes means no required commit.

Each invocation gets fresh HOME/CODEX_HOME and temporary schema/response files
outside the worktree, removed on exit. Personal config, rules and prior sessions
are not loaded. Only PATH and explicit runtime home/locale variables reach the
CLI; tool shells get a restricted environment without auth variables. Web search
is disabled. Workspace-write mode and approval policy `never` are explicit.

This is trusted local execution/workspace isolation, **not a security sandbox**.
The adapter trusts Stirpi's assignment and repository instructions. It does not
prove containment of malicious repository code, arbitrary reads, detached child
processes, system configuration, or writes that are later undone. Git identity
checks detect ordinary unmanaged commits; they cannot prevent malicious history
manipulation. History/object isolation remains the artifact backend's job.
The selected login is accessible to the trusted CLI. Do not use this boundary
alone for hostile code or secret-bearing workspaces.

## Evidence and smoke test

Stderr is one JSON evidence record: executable/version, configured model/effort, task,
context and prompt SHA-256, start/end, exit status/signal, structured response,
safe event counts, stderr byte count/hash, and native usage counters. Missing
usage/cost is null. Arbitrary raw command output and stderr are deliberately not
persisted because they can contain credentials. No environment dump is recorded.
M2 observers can retain this sanitized adapter record alongside the response.
The experiment harness stores only hashes/sizes for process stdout/stderr.

When `STIRPI_OPERATIONAL_FD=3` is supplied by ProcessExecutor, descriptor 3 carries
incremental generic operational JSONL. Standalone use still needs only stdin,
stdout and stderr. `events.mjs` frames UTF-8 across chunks and maps complete lines
immediately. A complete final JSON value without a newline is accepted; malformed
or oversized lines produce diagnostic activity and never select an action.

Thread/turn lifecycle, item lifecycle (including updates), commands, file changes,
MCP/web tool items, agent messages, reasoning and turn-completed usage are mapped
conservatively. Provider identities, commands, tool names and outputs are hashed;
command identity trims surrounding whitespace and normalizes CRLF, preserving
whitespace inside shell syntax. Durations measure receipt intervals, not native
command timings. File hashes describe notifications, not filesystem state.

The public CLI usage fields used here are input, cached input, output and reasoning
output tokens. Missing counters stay absent; cache-write and total tokens are not
estimated. The CLI does not promise a turn ID, command cwd or intermediate token
updates. A local turn ordinal provides scope only. Native type counts remain in
the final sanitized adapter record. See the [operational contract](../../docs/operational-events.md).

Deterministic tests (no paid calls):

```sh
node --import tsx --test test/codex-adapter.test.ts
npm run check
npm run build
```

Explicit real-agent smoke, using a new temporary pure-function Git fixture:

```sh
node adapters/codex/smoke.mjs --real-agent \
  --codex /absolute/path/to/codex \
  --auth-file /absolute/path/to/already-authenticated/auth.json \
  --model your-model \
  --effort medium
```

This spends one real invocation. The fixture asks for `twice(n)`, focused tests,
one COMMIT effect and COMPLETE. Existing M2 executes it; the evaluator independently
runs its tests and arithmetic checks. The script verifies one canonical commit,
unchanged source checkout, and replay. It retains task, report and state outside
the target, prints the evidence directory, and fails if completion fails. It is
not part of `npm test` and does not run any historical experiment. A larger or
ambiguity smoke is unnecessary for the deterministic FORK schema round trip.

### Safe diagnostics

Native JSON events carry `metadata.nativeType` and `eventClass` (`recognized`,
`unknown`, or `malformed`) through operational normalization. Generic normalized
protocol diagnostics use `normalized`. Event type labels must be bounded protocol
identifiers; invalid labels are classified as malformed and never copied verbatim.
These fields do not change event progress classification or supervision timing.

Error and failed-turn records project only explicitly present, validated fields:
a closed error-category vocabulary, integer HTTP status 100–599, booleans for
retry/retryable, and nonnegative safe integer attempt/retry counts. Provider/model
identifiers and messages use SHA-256 fingerprints; messages also retain byte size.
`structuredCategoryAvailable: false` explicitly records the message-only case.
No app-server fields are inferred. Error summaries are capped at 32 and distinct
native event counters at 64. Raw messages, nested details, URLs and headers are
excluded. Unrecognized category strings are dropped.

The process boundary independently projects adapter stderr into
`adapterDiagnostics`, which the experiment harness retains alongside stderr
size/hash. This includes failure code, child status/signal, event counts,
lifecycle state, validated executable version and configuration metadata.
Environment evidence uses fixed relevant variable names and presence/policy only.
Auth files are only stat/access checked: their contents and hashes are never
recorded. Config presence and ignored policy, state permissions (mode and access
checks), and placement categories are retained before adapter state cleanup.
Placement is unchanged. Requested GPT model names are retained when validated;
other model identifiers are omitted at the process boundary.

Message-only exec errors additionally use the [versioned bounded classifier](error-classifier.md).
Only derived category/source/version-support and strictly validated
`messageDerivedHttpStatus` fields are retained alongside existing message size/hash.
Unsupported versions produce OTHER. Classification does not change lifecycle,
progress, evaluation or retry behavior.

For the dedicated P1 trusted-local pilot, the harness supplies a separate
`governance: {text, sha256}` context field verified against runtime R's public
contract. `invocationFrom` rejects malformed/hash-mismatched governance and
preserves it; `promptFrom` adds its unchanged text in an explicit common section.
The task is still passed unchanged via stdin. Adapter stderr records
`governanceSha256`, `promptSha256` and `taskSha256`; the dedicated harness compares
these hashes with its expected prompt before accepting a returned response.
Historical invocations omit this field and retain their existing prompt format.
