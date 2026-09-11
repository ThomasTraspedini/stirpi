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
    "your-model"
  ]
}
```

`--codex` is required. `--model` is optional; omission uses the CLI default,
not the user's config. `--timeout-ms` defaults to 180000; configure the outer
process timeout longer (e.g. 200000). Combined agent output is limited to 1 MiB.
Timeout and termination kill the agent process group on this POSIX interface.

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
stdout. The native response schema permits CONTINUE, FORK, SPAWN, COMPLETE and
BLOCK. The final response file is validated against the adapter's closed schema
subset. Nullable optional priority/objective fields are removed syntactically.
No prose, intermediate events, or diagnostics select an action. Core still applies
its authoritative semantic validation and public evaluation.

Failure writes no stdout and exits nonzero, with a structured failure in the
stderr evidence record. M2 v1 has no process-level operational-error envelope;
the existing ProcessExecutor records `PROCESS_EXIT_FAILED`, including the adapter
diagnostic. It never receives an invented BLOCK or falsification action.

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

Stderr is one JSON evidence record: executable/version, configured model, task,
context and prompt SHA-256, start/end, exit status/signal, structured response,
safe event counts, stderr byte count/hash, and native usage counters. Missing
usage/cost is null. Arbitrary raw command output and stderr are deliberately not
persisted because they can contain credentials. No environment dump is recorded.
M2 observers can retain this stderr alongside the response.

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
  --model your-model
```

This spends one real invocation. The fixture asks for `twice(n)`, focused tests,
one COMMIT effect and COMPLETE. Existing M2 executes it; the evaluator independently
runs its tests and arithmetic checks. The script verifies one canonical commit,
unchanged source checkout, and replay. It retains task, report and state outside
the target, prints the evidence directory, and fails if completion fails. It is
not part of `npm test` and does not run any historical experiment. A larger or
ambiguity smoke is unnecessary for the deterministic FORK schema round trip.
