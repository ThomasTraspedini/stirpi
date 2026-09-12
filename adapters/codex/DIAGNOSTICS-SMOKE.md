# Safe diagnostics smoke — 2026-09-12

One opt-in isolated arithmetic fixture smoke ran with codex-cli 0.153.4,
using the existing explicit auth file and no requested model override.
No credentials were modified and no authentication failure was induced.

Result: COMPLETED in 30,527 ms. Focused tests, independent arithmetic checks,
one Stirpi-controlled commit, unchanged source checkout and replay checks passed.

Native event counts:

| Type           | Count |
| -------------- | ----: |
| thread.started |     1 |
| turn.started   |     1 |
| item.started   |     5 |
| item.completed |     7 |
| turn.completed |     1 |

All 15 native events were recognized. Unknown and malformed counts were zero.
There were no native error or failed-turn events. Error category, HTTP status,
retry flags/counts and structured provider/model error identifiers were therefore
not observed live; their retention and validation are covered by deterministic
fixtures, not claimed as fields promised by this installed exec interface.

The normalized evidence retained native event type/class, thread/item identity
hashes, command/output hashes, byte counts, item duration, exit code, file-change
count/fingerprint, and input/cached-input/output/reasoning-output token counters.
Final lifecycle observations were thread started, turn completed, item completed.

The selected auth file existed and was readable. User config was present and
ignored. Adapter state used system-temp placement with mode 0700 and readable/
writable access. HOME, CODEX_HOME and TMPDIR pointed into adapter state. Evidence
retained only environment variable presence/policy and filesystem metadata, with
no auth contents or auth hashes.

D032 was not run. Frozen experiment files, private oracle material, supervision
semantics, no-progress timing and state placement were unchanged by this task.
