# P3.c H*/S*/T* freeze drafts

**Status: unfrozen and unusable.** These documents authorize no run or Git
operation. Each schema-3 pilot has an invalid `UNRESOLVED-RUNTIME-COMMIT` and
pins the same public trusted-local contract by ID, version, path and SHA-256.
ID and condition are the only pilot differences. Schema 3 is separate from
historical pilots and isolated schema-2 profiles.

The common contract belongs in runtime R. It fixes the source, manifest,
unchanged counterfactual task, public evaluator, solver governance, budgets,
model `gpt-6-astra` / effort `medium`, preparation policy and executor identity.
It contains no hash of R itself. P follows R and pins its commit independently.
The launcher reads the contract and adapter from R, snapshots public input
bytes verified against both committed P and R, and compiles R outside its clean
checkout. `R:adapters/codex/adapter.mjs` in the shared executor draft designates
that adapter; it is resolved only by the pinned launcher.

The governance file is the exact two approved paragraphs about conditional
authority and runtime checkpoints: 498 bytes, SHA-256
`3d772fc6c57042b73933523bf5583a05c5371a981f93cd8cd56e187db85f2f75`.
It reaches every work's context, adapter projection and explicit prompt section.
Task stdin stays byte-identical. H has the human gate, S lacks FORK, and T has
general FORK; SPAWN retains its meaning in all conditions.

The global CLI help parse passed with `--ask-for-approval never` before `exec`.
The earlier incompatibility conclusion was incorrect. This establishes argv
parsing only; authentication and backend availability remain unverified. The
adapter approval policy has not changed.

Node/npm versions, executable/installation/compiler/type-root hashes, Git and
Docker byte hashes, and the PostgreSQL platform have now been acquired locally
and inserted in the common contract. The contract remains `unfrozen`: these are
candidate pins, not frozen authority and not yet operationally verified by the
dedicated schema-3 preflight. `observed-environment.draft.json` remains the
historical P3.a observation, not the new enforcement contract.

The Docker operational locator remains `/usr/local/bin/docker`; its symlink
targets the acquired OrbStack bytes whose SHA-256 is pinned. The locator is how
the argv0-sensitive dispatcher is invoked, while the hash identifies the bytes.
Neither value is inferred from the other, and neither changes the local image
ID into a registry manifest digest.

The npm script shell is a distinct closed authority: literal operational locator
`/bin/sh` plus SHA-256
`ad5c194b05f83bc5e793c1cd67b148a4b680467b5a5730ab1a31fe4e6460ee9f`.
It is supplied explicitly to npm after byte verification. It does not add
`/bin` to PATH, create a trusted-bin `sh`, or enter the executor environment.

The chosen database variant is **local Docker image ID** on `linux/arm64`, with
`--pull=never`. An image ID is not a registry manifest digest. Image inspection
checks ID/OS/architecture before use; container inspection checks the launched
image and loopback binding. Its relation to the earlier P3.a observation has
been acquired, but preservation and the complete schema-3 path still require
the dedicated operational preflight.

Package/lock pins apply only to the starting baseline. Candidate code remains
editable. Informational package fields (description, keywords, license, author,
bugs, homepage, funding) do not enlarge operations. Covered metadata drift
invalidates the lease and triggers fresh preparation. Other package operation/
dependency changes, lock changes and candidate `.npmrc` are currently uncovered:
they fail locally and operationally before new operations. This is not a
negative public check, falsification, or full support for dependency changes.
This fail-closed policy is approved for the final freeze: candidate files remain
editable, but their contents cannot enlarge harness authority. Any newly needed
operation class must return to a separate, scoped human decision.

Before freeze: review runtime and candidate pins, commit R when authorized, run
the dedicated schema-3 preflight only when separately authorized, freeze the
contract, prepare final pilots and commit P when authorized. Candidate input
policy is settled; F1 and auth/backend remain separate blockers. The draft
controller reports the pins as acquired but unfrozen and not schema-3-preflight
verified; it is not a controller for final frozen pilots. No scheduler, funding
enforcement or P4 is added.
