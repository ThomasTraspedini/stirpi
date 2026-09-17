# Launch command forms — review only

**Not authorized for execution.** Baseline P is
`a954f87c26f91d78d195571bee8f76b0b5a8efc2`; it does not contain the prepared auth
provision delta. `<P>` below must select a separately authorized, reviewed input
commit containing that delta, distinct from R5. These forms create checkouts and launch runtime effects;
none was executed during preparation. R is fixed to
`b8cab81b0889d912c48b11bcf1c3eeec6f3c77d9` by each final pilot.
Before any execution require steward review, committed P, separately authorized
milestone/operational verification and explicit launch authorization.

F1 permits only included ChatGPT quota with €0 incremental spending. Before
each attempt check authentication and observable limits without invoking a model.
Stop on exhausted quota, payment requirements or unavailable gpt-6-astra; no
fallback or immediate retry to bypass F1. Missing monetary telemetry is recorded
as `costo monetario non disponibile`. No native monetary enforcement is claimed.
The historical non-model backend probe does not attest current authentication,
quota or actual model availability; its model limitation was accepted by the human.
The common executor explicitly selects the existing external login file with
`--auth-file /Users/thomastraspedini/.codex/auth.json`. The unchanged R5 adapter
links it into temporary `CODEX_HOME` without reading or copying credentials or
inheriting personal configuration. This prepared provision requires review
before launch; see [auth provision review](AUTH-PROVISION.md). It does not
attest current authentication/quota or broaden the frozen contract.

The build-tool wrapper runs from the active source checkout, as required by
its dependency locator. Before launch review must confirm its exact bytes equal
`P:tools/launch-pinned-runtime.mjs` and that the supplied build dependencies
match the contract, including the compiler and type roots closure before the build.
All experiment inputs and the compiled launcher below come
from P; the runtime launcher then resolves and executes R5.

For each condition, build the external CLI launcher from the committed
preregistration checkout, then run the pinned runtime through it. `R` below is
the exact committed runtime hash inserted in the preregistration; `P` is the
distinct commit that contains that final preregistration.

```sh
git -C /Users/thomastraspedini/stirpi worktree add --detach /private/tmp/stirpi-p4-hst/launcher-checkout <P>
node /Users/thomastraspedini/stirpi/node_modules/typescript/bin/tsc --project /private/tmp/stirpi-p4-hst/launcher-checkout/tsconfig.json --typeRoots /Users/thomastraspedini/stirpi/node_modules/@types --outDir /private/tmp/stirpi-p4-hst/external-build
node /Users/thomastraspedini/stirpi/tools/launch-pinned-runtime.mjs /private/tmp/stirpi-p4-hst/external-build/cli/index.js experiment run /private/tmp/stirpi-p4-hst/launcher-checkout/docs/experiments/d032-counterfactual/manifest.json --preregistration /private/tmp/stirpi-p4-hst/launcher-checkout/docs/experiments/p1-hst/final/H.json --condition H --verification-mode trusted-local --source /Users/thomastraspedini/booking-invariants --executor /private/tmp/stirpi-p4-hst/launcher-checkout/docs/experiments/p1-hst/final/executor-common.json --public-evaluator /private/tmp/stirpi-p4-hst/launcher-checkout/docs/experiments/d032/public-evaluator-v2.json --concurrency 1 --output /private/tmp/stirpi-p4-hst/attempt-01-H
```

Run in order H → S → T; the full S and T forms follow.

```sh
node /Users/thomastraspedini/stirpi/tools/launch-pinned-runtime.mjs /private/tmp/stirpi-p4-hst/external-build/cli/index.js experiment run /private/tmp/stirpi-p4-hst/launcher-checkout/docs/experiments/d032-counterfactual/manifest.json --preregistration /private/tmp/stirpi-p4-hst/launcher-checkout/docs/experiments/p1-hst/final/S.json --condition S --verification-mode trusted-local --source /Users/thomastraspedini/booking-invariants --executor /private/tmp/stirpi-p4-hst/launcher-checkout/docs/experiments/p1-hst/final/executor-common.json --public-evaluator /private/tmp/stirpi-p4-hst/launcher-checkout/docs/experiments/d032/public-evaluator-v2.json --concurrency 1 --output /private/tmp/stirpi-p4-hst/attempt-01-S
node /Users/thomastraspedini/stirpi/tools/launch-pinned-runtime.mjs /private/tmp/stirpi-p4-hst/external-build/cli/index.js experiment run /private/tmp/stirpi-p4-hst/launcher-checkout/docs/experiments/d032-counterfactual/manifest.json --preregistration /private/tmp/stirpi-p4-hst/launcher-checkout/docs/experiments/p1-hst/final/T.json --condition T --verification-mode trusted-local --source /Users/thomastraspedini/booking-invariants --executor /private/tmp/stirpi-p4-hst/launcher-checkout/docs/experiments/p1-hst/final/executor-common.json --public-evaluator /private/tmp/stirpi-p4-hst/launcher-checkout/docs/experiments/d032/public-evaluator-v2.json --concurrency 1 --output /private/tmp/stirpi-p4-hst/attempt-01-T
```

The final JSON files coexist with the preserved historical drafts. A permitted operational
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

`<P>` and `<RUN_ID>` remain unresolved. Maximum one purely operational
replacement per condition and six total attempts; absence of FORK or a failed
lineage is not grounds for retry. Keep all attempt evidence. Changes to common
authority require a new human decision and freeze. Replay command forms also
remain unexecuted and require separate authorization.
