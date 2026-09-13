# Exec message diagnostics v1

This is diagnostic telemetry, not a semantic action, retry policy, termination
signal, or new progress observation. Only `error.message` and
`turn.failed.error.message` enter the classifier. Agent prose, command output,
stderr, nested causes and provider payloads are never searched for a category.
Malformed/missing message fields have `eventClass: malformed` and no category;
the existing failed-turn lifecycle mapping still applies.

Rules run only for the exact reported version `codex-cli 0.154.0-alpha.6.2`.
A missing or different version yields `OTHER`, `classifierVersionSupported: false`
and no message-derived status. The source is `codex-exec-bounded-message-v1`.
Version support does not certify executable byte identity; experiment executable
identity remains a separate check. New versions require explicit rule review.

## Inspected evidence

On 2026-09-13, the installed executable reported the version above and had SHA-256
`ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb`.
Read-only binary string inspection found these literal formatter components
(`{...}` below denotes a dynamic slot, not extracted or persisted content):

- `Your access token could not be refreshed. Please log out and sign in again.`
- `Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.`
- `unexpected status {...}: {...}`
- `exceeded retry limit, last status: {...}`
- `You've hit your usage limit.` and the explicit Plus-upgrade, credits-page and
  admin-request continuations in the classifier
- `rate limit exceeded: {...}`
- `server overloaded`
- `Connection failed: {...}`
- `stream disconnected before completion: {...}`
- `auth refresh request timed out after {...}s`
- `Codex cannot access session files at {...} (permission denied). If sessions were created using sudo, fix ownership: sudo chown -R $(whoami) {...}`

These are build-string evidence, not induced live failures or proof that every
formatter is reachable in exec. In particular, the specific auth-refresh timeout
string appears alongside app-server thread-state code. It is classified only if
received in a designated exec message field; no app-server events are consumed.
Unsupported timeout forms remain OTHER. No experiment or private evaluator
material was accessed to derive these rules.

## Conservative boundaries

The finite categories are AUTHENTICATION, AUTHORIZATION, RATE_OR_USAGE_LIMIT,
MODEL_UNAVAILABLE, PROVIDER_SERVER, NETWORK_CONNECTION,
RESPONSE_STREAM_DISCONNECTED, TIMEOUT, FILESYSTEM_STATE_PERMISSION and OTHER.
MODEL_UNAVAILABLE has no rule. Bare 404, generic not-found/permission/timeout text,
unknown refresh causes and generic response-reading wrappers remain OTHER.
Multiline messages are deliberately unsupported. Outer connection and stream
wrappers describe the outer failure only; their nested causes are not classified.

HTTP status extraction starts at one of the two documented formatter prefixes,
accepts exactly three ASCII digits in 100–599, and requires the body delimiter
`: ` or the retry-formatter end. Optional reason phrases come from a small closed
canonical list; unsupported phrases yield no status. Numbers elsewhere, nested
statuses, URLs and bodies are not inspected. 401 maps to AUTHENTICATION, 403 to
AUTHORIZATION, 429 to RATE_OR_USAGE_LIMIT, and 5xx to PROVIDER_SERVER. Other valid
statuses may be retained with category OTHER. No underlying authorization policy
or model availability is inferred.

## Persistence boundary

The message-derived fields are `diagnosticCategory`, `classificationSource`,
`classifierVersionSupported`, and optional `messageDerivedHttpStatus`. They pass
through both the operational metadata allowlist and the independent adapter
stderr projection. They do not masquerade as native structured fields.
`structuredCategoryAvailable` remains false for the actual message-only exec
payload. Existing independently structured fields retain their existing projection;
retryability, attempt counts, provider and model identity are never inferred.

Existing `nativeType`, `eventClass`, `messageBytes` and `messageHash` remain.
Only safe derived objects enter the bounded error summaries and emitted events.
Raw messages exist transiently in JSONL framing/parsing and classification, never
in persisted metadata or exceptions. The parser clears its pending line before
mapping. JavaScript garbage collection does not offer secure memory erasure.

Deterministic tests cover strict matching, unsupported versions, malformed fields,
non-designated fields, unchanged lifecycle/progress, and serialization through both
persistence projections with sensitive sentinels. The real smoke uses the ordinary
pure-function fixture and never intentionally creates an error.
