# H/S/T pilot results

## Scope and status

This report summarizes one controlled H/S/T pilot executed from frozen public
inputs. It reports runtime observations and the post-run evaluation conclusions
that can be stated publicly. The experimental level was **not reached**. It does
not claim a general benchmark, provider comparison, or semantic validity of any
candidate.

The original audit bundles are preserved privately. This report and its
machine-readable summary are derived public material, not original evidence.
The redacted public [offline replay package](REPLAY.md) is separately derived
and verifies recorded transitions, not original solver text or semantic validity.

## Design and identities

All conditions used runtime R `b8cab81b0889d912c48b11bcf1c3eeec6f3c77d9`, final
input P `2be4aedc12176639b31cef6360e88cc13cd7857d`, and source base
`bd9ae09ac74374199c48d22ec36c739600cfee59`.

| Condition | Canonical ref                              | Runtime observation                                          | Invocations | Usage coverage |
| --------- | ------------------------------------------ | ------------------------------------------------------------ | ----------: | -------------: |
| H         | `4c68b6f10b5cdb8bca9a8c120423e1839f83d54f` | BLOCKED: operational process failure                         |           5 |            4/5 |
| S         | `a836a4a8b2392928da406738c0a912dcad0e5528` | COMPLETED; public checks 96/96                               |           4 |            4/4 |
| T         | `76bb8923481e89d338e907169a9c4470a80ceb69` | COMPLETED; public checks 95/95 plus typecheck and diff-check |           2 |            2/2 |

Each condition produced one root lineage (`l1`), with DNA `[]` and one local
commit. The actual tree had three independent roots and no descendants:

```text
H: l1  DNA []  one commit
S: l1  DNA []  one commit
T: l1  DNA []  one commit
```

T did not issue FORK. Therefore the pilot's minimum threshold and its desirable
two-valid-alternatives result were not reached.

## Runtime completion and post-run evaluation

S and T completed the public runtime contract on the exact refs above. That is
not a finding that either candidate is semantically valid overall. H's public
binding result is indeterminate because it ended in an operational process
failure; the retained diagnostics do not determine its cause.

Post-run evaluation found a contract gap at the first-effect boundary (F-01).
All candidates commit `UNKNOWN` before `pay`; after a pre-call crash and expiry,
that can permit the first effect even though the frozen contract forbids it. The
same local state can also represent a prior contact, for which reconciliation is
required. The available create-or-repeat operation cannot distinguish those
histories. This is a contract gap found by post-run evaluation, not an accepted
contract change or an implemented correction.

It also found F-02 for S: a static interleaving can retain a Unit while waiting
indirectly for provider I/O through an attempt lock. This is neither an observed
deadlock nor a failed test, and it is not generalized to H or T.

## Accounting and limits

Provider usage was recorded as four separate fields. Cached input is included in
input reporting and must not be added to it; reasoning output can overlap output.
H is incomplete. Monetary cost is unavailable and is not estimated.

| Condition |   Input | Cached input | Output | Reasoning output |
| --------- | ------: | -----------: | -----: | ---------------: |
| H         | 926,499 |      775,680 | 10,909 |              374 |
| S         | 808,580 |      651,008 |  9,942 |              480 |
| T         | 642,507 |      557,184 |  7,928 |              313 |

## Claims

Supported claims: the controlled H/S/T pilot ran with auditable bundles retained
privately; S/T completed their public runtime contract; each candidate contains
locally useful contributions; T did not use FORK; and post-run evaluation found
F-01 and F-02.

Unsupported claims: that Stirpi or FORK improved quality, reliability, cost or
speed; that any candidate is semantically valid overall; that H was caused by a
specific quota condition; or that this is a complete monetary comparison or a
general benchmark.

## Summary JSON

[`results/summary.json`](results/summary.json) is UTF-8 JSON with a closed,
report-local schema: `schema`, `level`, `identities`, `conditions`, `tree`,
`findings`, `accounting`, `claims`, and `distribution`. Arrays and objects use
only the fields shown there; unknown fields are not part of this report schema.
