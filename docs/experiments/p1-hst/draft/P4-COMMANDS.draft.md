# P4 commands — draft only

These are reviewable command forms, not authorization to run them. P3 must be
closed, final preregistrations committed, F1 approved with an enforceable stop,
the acquired toolchain/image identities successfully verified by the dedicated
schema-3 preflight and frozen, and the selected authentication mechanism made
available before any command below may run. The
executor config intentionally contains no auth file, so a successful local
`--version` probe is not evidence of backend access.

For each condition, build the external CLI launcher from the committed
preregistration checkout, then run the pinned runtime through it. `R` below is
the exact committed runtime hash inserted in the preregistration; `P` is the
distinct commit that contains that final preregistration.

```sh
git -C /Users/thomastraspedini/stirpi worktree add --detach /private/tmp/stirpi-p4-hst/launcher-checkout <P>
node /Users/thomastraspedini/stirpi/node_modules/typescript/bin/tsc --project /private/tmp/stirpi-p4-hst/launcher-checkout/tsconfig.json --outDir /private/tmp/stirpi-p4-hst/external-build
node /Users/thomastraspedini/stirpi/tools/launch-pinned-runtime.mjs /private/tmp/stirpi-p4-hst/external-build/cli/index.js experiment run /Users/thomastraspedini/stirpi/docs/experiments/d032-counterfactual/manifest.json --preregistration /Users/thomastraspedini/stirpi/docs/experiments/p1-hst/draft/H.json --condition H --verification-mode trusted-local --source /Users/thomastraspedini/booking-invariants --executor /Users/thomastraspedini/stirpi/docs/experiments/p1-hst/draft/executor-common.json --public-evaluator /Users/thomastraspedini/stirpi/docs/experiments/d032/public-evaluator-v2.json --concurrency 1 --output /private/tmp/stirpi-p4-hst/attempt-01-H
```

Run the same third command next with `S.json`, `--condition S`, and
`/private/tmp/stirpi-p4-hst/attempt-01-S`; then with `T.json`, `--condition T`,
and `/private/tmp/stirpi-p4-hst/attempt-01-T`. The `*.json` names above are the
post-freeze replacements of the `*.draft.json` files. A permitted operational
replacement changes only `attempt-01-<condition>` to `attempt-02-<condition>`;
it must retain R, P, task, executor, environment identity, evaluator, and
treatment.

No additional `--steps`, `--budgets`, `--supervision`, `--timeout-ms`, or
`--evaluator-wall-time-ms` flag belongs on a preregistered command: the
preregistration supplies those values and the runtime rejects contradictory
overrides. The replay path is the exact external run directory printed by the
launch command:

```sh
node /Users/thomastraspedini/stirpi/tools/launch-pinned-runtime.mjs /private/tmp/stirpi-p4-hst/external-build/cli/index.js experiment replay /private/tmp/stirpi-p4-hst/attempt-01-H/<RUN_ID>
```

`<P>`, the renamed committed JSON paths, `<RUN_ID>`, F1's approved control, and
the adapter's authentication provision are intentionally unresolved. Filling
them is a post-review/freeze action, not an inference this draft can make.
