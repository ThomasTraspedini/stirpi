# H/S/T redacted offline replay

The derived package in [replay/](replay/) is a redacted copy of the three
private original audit bundles. It is not original evidence. Its manifest pins
each original condition, run, source base, and candidate ref separately, and
records the approved SHA-256 of the corresponding source
`bundle-sha256.json` manifest.

After building this checkout, verify each recorded package without any external
execution:

```sh
npm run build
node dist/cli/index.js experiment replay docs/experiments/p1-hst/replay/H
node dist/cli/index.js experiment replay docs/experiments/p1-hst/replay/S
node dist/cli/index.js experiment replay docs/experiments/p1-hst/replay/T
node scripts/p6/build-public-replay.mjs verify --package "$PWD/docs/experiments/p1-hst/replay" --cli "$PWD/dist/cli/index.js"
```

The replay reconstructs and verifies the recorded, redacted state transitions.
It does not invoke a model, public evaluator, test suite, Docker, database,
network, Git, or candidate code. It therefore does not establish semantic
correctness or reproduce the solver's original text. A new execution is a
different operation and requires the frozen inputs plus the separately
documented environment and resources.

The package deliberately excludes SQLite state, Git artifacts, candidate and
pending-workspace source, raw operator logs, authentication material, and
private evaluation. Redacted values use deterministic markers; the package
manifest lists the transformations and every replay artifact hash. Before it
replays, the verifier requires exactly the 29 regular distributed files
(manifest, package README, and the 27 H/S/T artifacts), only the three H/S/T
directories, and no symlinks. It scans the bytes of every one of those files
for prohibited host, temporary, auth-locator, `CODEX_HOME`, or username
disclosure; a file added outside the manifest is rejected before replay.
The builder creates a package as `not-yet-verified`; only the separate verifier
can write `replay-verified`, after checking hashes and replaying H/S/T through
the supplied absolute CLI path. A changed distributed file fails before replay.
When rebuilding, `--replace` uses a sibling backup and rollback path; this is a
recoverable scoped replacement, not a claim of filesystem atomicity.
