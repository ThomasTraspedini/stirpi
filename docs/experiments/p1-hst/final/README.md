# Final H*/S*/T* preregistrations — review preparation

Status: prepared for steward review, uncommitted; no launch authorization.

All three schema-3 pilots pin runtime R5
`b8cab81b0889d912c48b11bcf1c3eeec6f3c77d9` and the frozen contract SHA-256
`207d4917ae5f4a3b708562f60c0a8193931d466b56399dd0d18ff570c176ec5e`.
Only ID and condition differ. The shared executor retains the approved
locators, R adapter designation, gpt-6-astra / medium and 900000 ms timeout.
Historical drafts remain unchanged and unresolved.

The distinct preregistration commit P is unresolved until a separately
authorized subsequent commit. P must be recorded externally after that commit;
no document includes its own future commit or content hash.

The read-only controller `scripts/p3/check-final-preregistrations.mts` checks
strict JSON, exact configurations, the fixed contract hash and equality of
contract/public input bytes to R5 Git blobs. Its PASS concerns document
integrity only. It neither assesses current authentication/quota nor verifies
operational R5 or grants permission to launch. The historical R4 preflight
remains evidence for R4, not operational evidence for R5.

See [launch command forms](LAUNCH.md). Steward review, separate P commit,
required milestone/operational verification and explicit execution authorization
remain outstanding. No preflight, Docker or model invocation occurred here.
