# Real smoke observation

Executed once successfully on 2026-09-11 UTC (2026-09-12 Europe/Rome), after
deterministic automated verification. This is adapter integration evidence only.

- Interface: `/Applications/ChatGPT.app/Contents/Resources/codex`,
  `codex-cli 0.153.4`, model argument `gpt-6-astra`.
- Fresh temporary Git fixture; one ephemeral agent invocation.
- Task SHA-256: `cf60cbe409fdb365e5f21e6235e84629a01bb1da16e308f8fb9842962c06d104`.
- Projected context SHA-256: `4a0f2c324f86f4615749ed01ddb1540980b22c73fdac59f5fcc4556da7e554f3`.
- Generic prompt/context argument SHA-256: `63cc37d7571278b0268b5c59c89f5d97831f4df742fa48cb952e096fc237de30`.
- Agent exit: 0; native schema output accepted without action inference.
- Returned action: COMPLETE, reporting the pure `twice(n)` function and three
  passing focused tests.
- Effect: COMMIT, message “Add pure twice function and tests for zero, positive
  and negative numbers”.
- Starting fixture commit: `613a14daf135ce6c524ba3d32cd107ee0217b35d`.
- Stirpi-created fixture commit: `28a0d2086127a0448c558cec6a9d5fbe32e7c84a`.
  This identity belongs to the temporary fixture, not this repository.
- Runtime outcome: COMPLETED. Independent evaluator reran the focused tests and
  checked inputs 0, 1, -1, 7 and -9 against `n * 2` on the committed workspace.
- Exactly one new canonical commit; source checkout remained clean at its
  starting HEAD. Replay matched without repeating agent or artifact effects.
- End-to-end wall time: 35,575 ms; adapter wall time: 35,295 ms.
- Native usage: 53,066 input tokens, including 38,784 cached input tokens;
  596 output tokens; 0 reported reasoning output tokens. Monetary cost: null.

The opt-in `smoke.mjs` script retains exact task, report and state in its printed
temporary evidence directory. The hashes above identify this particular run;
workspace paths and generated IDs change on later runs. No raw diagnostic output
or credentials are included here. No second real ambiguity smoke was needed;
all five action shapes, including FORK, have deterministic protocol coverage.

Run the command in README to reproduce the test. Normal automated verification
does not invoke the real agent. Other providers, adversarial containment, and
credential provisioning beyond an existing explicit login file remain deferred.
