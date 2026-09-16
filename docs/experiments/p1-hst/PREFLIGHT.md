# P3 trusted-local preflight

This procedure prepares and checks the frozen booking-invariants baseline before
any H*/S*/T* execution. It is a target-environment preflight, not a solver run,
not a preregistration, and not evidence that the T* semantic threshold has been
met.

The harness transfers only the reachable closure of the frozen commit
`bd9ae09ac74374199c48d22ec36c739600cfee59` into a new disposable workspace.
It does not use the target's `HEAD`, working tree, or later history. Its
state, dependency installation, PostgreSQL container, and report are outside
the target under `/private/tmp/stirpi-p3-c01/`.

## Luna command

Run this command only as the expressly authorized P3.a Luna check. Choose a
previously nonexistent output directory; do not delete or reuse an earlier one.

```sh
node --import tsx scripts/p3/booking-preflight.mts \
  --source /Users/thomastraspedini/booking-invariants \
  --output /private/tmp/stirpi-p3-c01/luna-target-preflight
```

The command intentionally performs trusted harness operations only: `npm ci`,
module resolution, target typecheck, a disposable `postgres:16` container
bound to loopback, connectivity, `btree_gist`, the three frozen public checks,
and container cleanup. `npm ci` may contact the configured package registry and
Docker may acquire `postgres:16` when it is not already local; Luna must
delimit that operational access before the check. The command does not invoke a
model, adapter, or any command selected by a solver.

`preflight-report.json` must show all of the following before P3 may advance:

- source identity, frozen commit, a clean transferred workspace, and a
  `git rev-list --all` closure equal to `git rev-list` of that frozen commit.
  This compares the reachable commit set; it is not an inventory of all Git
  objects, so the harness transfer remains the primary guarantee that unrelated
  or dangling source objects were not copied;
- effective Node/npm versions, package and lock hashes, resolved required
  module paths, PostgreSQL image identity and port, plus passed `btree_gist`
  setup;
- the frozen evaluator v2 IDs `full-postgres-suite`, `typecheck`, and
  `diff-check`, each passed with the `all_checks_pass` policy;
- a passed disposable-container cleanup. The report never stores the database
  URL or password.

Failure leaves its report as operational preflight evidence. It is not a failed
lineage and must not trigger a switch away from explicit `trusted-local` mode.

## Deterministic fixture check

This independent, purely local command has no Docker, PostgreSQL, network, or
model access:

```sh
node --import tsx --test test/p3-fixture.test.ts
```

It uses a fake trusted-process boundary to exercise the authoritative
preparation contract. The fixture creates exactly one T-condition FORK with two
scheduled descendants, one assumption per edge, a BRANCHED parent, isolated
sibling artifacts with different canonical commits, individual public
evaluation, and effect-free replay after artifact databases are removed.

Its evidence is infrastructure-only; it is not a substitute for the required
preflight nor evidence of a real T* result.

## P4 command inventory (not authorized to run)

P3.c must first create and commit the three preregistrations that pin the
runtime separately from their containing commit (D054), then verify the CLI
byte identity and `gpt-6-astra`/`medium` support without invoking the solver.
Only after P3 closure and the separate F1 approval may the following pattern be
instantiated with those frozen paths for H*, then S*, then T*:

```sh
node tools/launch-pinned-runtime.mjs /absolute/external-build/cli/index.js \
  experiment run /absolute/committed-pilot-manifest.json \
  --preregistration /absolute/committed-pilot-preregistration.json \
  --condition H --verification-mode trusted-local \
  --source /Users/thomastraspedini/booking-invariants \
  --executor /absolute/frozen-executor.json \
  --public-evaluator /absolute/frozen-public-evaluator.json \
  --output /private/tmp/stirpi-p3-c01/future-pilot-evidence
```

The future preregistrations supply the approved limits: 20 steps, 20 executor
invocations, 20 lineages, 200 items and 100 commands per invocation, 180000 ms
no-progress, 900000 ms executor wall time, 300000 ms per public check, and
concurrency 1. Retry policy remains at most one purely operational replacement
per condition, at most six attempts total; failed tests or absent FORK never
authorize a retry. F1 is unresolved, so these commands are documentation only.

## P3.c binding increment (unfrozen)

The historical preflight above remains baseline evidence. Schema-3 pilots now
bind the public `trusted-local-contract.json` from runtime R and the exact
498-byte `solver-governance.txt`. The acquired toolchain hashes and
`linux/arm64` image platform are present, but the contract remains `unfrozen`
and the drafts retain `UNRESOLVED-RUNTIME-COMMIT`; they are intentionally
unusable as run preregistrations. The bounded variant uses the existing local
image ID and `--pull=never`, with platform and launched-container identity
checks. No registry digest is inferred from P3.a.

The Docker locator and byte identity remain separate. The operational locator
is `/usr/local/bin/docker`, which preserves the required argv0; reading that
symlink authenticates the pinned OrbStack target bytes. A canonical target path
is not substituted as the executable locator.

The corrected global help parse accepts `--ask-for-approval never` before
`exec`; the previous CLI incompatibility conclusion is invalid. No CLI policy
change follows, and a help parse does not establish auth/backend availability.

The identities have been acquired, inserted, and hash-pinned in the drafts, but
have not been frozen or verified through the new enforced path. The original
`booking-preflight.mts` remains historical and does not prove schema 3.

## Schema-3 preflight-only launcher (prepared, not run)

After R is reviewed and committed, and only with separate authorization, use a
fresh clean checkout of R, a schema-3 pilot candidate that names that R, the
controlled local target, and a new output directory outside both repositories:

```sh
cd /Users/thomastraspedini/stirpi
node --import tsx /private/tmp/stirpi-p3-c01/runtime-R/scripts/p3/schema3-preflight.mts \
  --runtime /private/tmp/stirpi-p3-c01/runtime-R \
  --pilot /absolute/path/H.schema3-preflight-candidate.json \
  --source /Users/thomastraspedini/booking-invariants \
  --output /private/tmp/stirpi-p3-c01/schema3-preflight-H \
  --toolchain-root /Users/thomastraspedini/stirpi
```

`--toolchain-root` is required by this CLI and must name an absolute external
dependency root with its own `package.json`, TypeScript and `@types/node`.
The command starts from that external root so the TypeScript loader can launch
the script committed in R without adding dependencies to R.
Resolution starts from that package file and may not escape the root. The root
is only an operational locator: it grants no authority, and the resolved
compiler and type-root closures are still checked against the contract hashes.
The effective leaf locators are recorded in the evidence `tools` object. R does
not need or receive `node_modules`, symlinks, or environment-based resolution
fallbacks such as `NODE_PATH`.

This launcher permits an `unfrozen` contract only because it is a preflight
candidate, never a run authorization. It verifies the clean R checkout and
committed authority, contract and public inputs, every toolchain pin and
operational locator, target-commit transfer and baseline package/lock, then the
fixed preparation with `--pull=never`, image ID/platform, loopback binding,
modules, typecheck, PostgreSQL connectivity and `btree_gist`. It executes all
allowlisted public evaluator checks and attempts disposable-container cleanup.

The output `schema3-preflight-evidence.json` distinguishes an operational
failure from a public check exit and records cleanup failure separately. Once
arguments and the output location are valid, dependency discovery failure is
recorded as an operational failure in the `bootstrap` phase. It
contains no database URL or password. The launcher has no executor, auth,
backend, model, run, or lineage input and records zero executor/model
invocations and zero lineages. It is fail-closed and is not a substitute for
committing P, freezing the contract, F1, auth/backend verification, or P4.

Remaining blockers are: review and commit R; authorized successful schema-3
preflight; final contract freeze and distinct pilot commit P; F1; and
auth/backend availability. The approved candidate policy remains fail-closed:
uncovered package/lock/config changes cannot enlarge harness authority and any
newly needed operation class returns to a scoped human decision.
