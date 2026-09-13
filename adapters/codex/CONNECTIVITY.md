# Minimal connectivity reproducer

Run each stage independently, in this order. Stop at the first discriminating
failure; there is intentionally no command that automatically runs all stages.

```sh
node adapters/codex/connectivity.mjs env
node adapters/codex/connectivity.mjs dns chatgpt.com
node adapters/codex/connectivity.mjs connect chatgpt.com
```

The last command performs only a certificate-verified TLS handshake on port 443.
It sends no HTTP request or credentials. `api.openai.com` is also accepted as an
explicit destination. Both hostnames occur in the locally installed Codex binary;
the successful smoke used explicit login authentication, so the local DNS probe
selected `chatgpt.com`. This does not establish which URL a future exec will use.

A reconstructs the smoke's inherited ProcessExecutor environment, then the
adapter's six-variable Codex environment. B reconstructs the experiment runner's
per-work HOME/TMPDIR and allowlist, then that same adapter transformation. Each
transformation and leaf probe runs in a fresh Node process. Construction mirrors
`smoke.mjs`, `src/executor/process.ts`, `src/experiments/run.ts`, and `adapter.mjs`
without importing or executing them. Temporary state is removed after each run.
The experiment directory is synthetic and outside the repository; this isolates
environment construction, not historical directory permissions or sandbox rules.
Both cases inherit the diagnostic process's execution boundary and cwd.

There are no retry loops. Each child has a five-second cap (TLS has a three-second
socket timeout). Exit 2 means A/B success/error outcomes differ; address ordering
alone is not treated as a connectivity failure. JSON retains both observations.
No auth/config files are read, and no runtime, evaluator, replay, Git workflow,
or model is invoked. A Codex exec stage was unnecessary and is not implemented.

## Local observation — 2026-09-13

Environment construction succeeded for both cases. The first behavior-changing
difference was the execution boundary:

| Node lookup of chatgpt.com   | A: smoke construction   | B: experiment construction |
| ---------------------------- | ----------------------- | -------------------------- |
| Restricted tool sandbox      | ENOTFOUND / getaddrinfo | ENOTFOUND / getaddrinfo    |
| Same command outside sandbox | Resolved                | Resolved                   |

Stopped at this difference: no TLS or Codex exec probe was run. Environment
construction alone did not reproduce an A/B DNS difference. This observation
does not establish the execution boundary of either historical run or prove
that their original failure had the same cause.
