# Final H*/S*/T* preregistrations — frozen inputs used for the pilot

Status: these are the frozen preregistrations used by the subsequently executed
H/S/T pilot. The paragraphs below preserve their pre-run provenance; they are
not a statement that launch or preflight remains pending today.

Post-run status: the pilot used final input commit P
`2be4aedc12176639b31cef6360e88cc13cd7857d`. H ended BLOCKED after an operational
process failure; S and T completed the public runtime contract. Post-run
evaluation found contract and concurrency limitations, and the pilot did not
reach its minimum threshold because T did not use FORK. See the public
[results report](../RESULTS.md) and the derived [redacted offline replay
package](../REPLAY.md). The original audit bundles remain private.

## Preserved pre-run provenance

All three schema-3 pilots pin runtime R5
`b8cab81b0889d912c48b11bcf1c3eeec6f3c77d9` and the frozen contract SHA-256
`207d4917ae5f4a3b708562f60c0a8193931d466b56399dd0d18ff570c176ec5e`.
Only ID and condition differ. The shared executor retains the approved
locators, R adapter designation, gpt-6-astra / medium and 900000 ms timeout.
Historical drafts remain unchanged and unresolved.

The committed baseline P is `a954f87c26f91d78d195571bee8f76b0b5a8efc2`.
The current auth provision delta is outside P and requires review and a separately
authorized subsequent commit before any launch can consume it. The launch forms
retain `<P>` for that future reviewed input commit; no document includes its own
future commit or content hash.

The common executor's pre-run configuration selected a local login file through
`--auth-file`; credentials remained outside the repository. See the historical
[auth provision review](AUTH-PROVISION.md) for the pre-run metadata and
verification provenance.

The read-only controller `scripts/p3/check-final-preregistrations.mts` checks
strict JSON, exact configurations, the fixed contract hash and equality of
contract/public input bytes to R5 Git blobs. Its PASS concerns document
integrity only. It neither assesses current authentication/quota nor verifies
operational R5 or grants permission to launch. The historical R4 preflight
remains evidence for R4, not operational evidence for R5.

See the historical [launch command forms](LAUNCH.md). The pre-run review,
separate P commit, verification and execution authorization described there were
completed before the pilot; their historical wording is preserved rather than
rewritten. This directory is not a replay package.
