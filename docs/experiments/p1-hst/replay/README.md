# Redacted H/S/T offline replay package

This derived package preserves enough recorded state to verify replay offline. It is not original evidence. The command reconstructs recorded redacted transitions; it does not run a model, evaluator, tests, Docker, network, Git, or candidate code. It does not establish semantic correctness or reproduce solver responses. A new execution requires the separately documented prerequisites and resources.

The package is built as `not-yet-verified`. A verifier must check every manifest hash and run all three replays before it writes a `replay-verified` attestation:

`node scripts/p6/build-public-replay.mjs verify --package "$PWD/docs/experiments/p1-hst/replay" --cli "$PWD/dist/cli/index.js"

See [REPLAY.md](../REPLAY.md) and [manifest.json](manifest.json).
