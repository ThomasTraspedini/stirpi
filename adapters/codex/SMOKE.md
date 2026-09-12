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

## Incremental operational channel — 2026-09-12

One real invocation, after deterministic verification, using `codex-cli 0.153.4`
at the executable above and model `gpt-6-astra`. No implicit or explicit invocation
timer was used. No historical experiment or private evaluator was run.

- Disposable pure-function fixture, same task SHA-256 as above.
- Start of outer process: `2026-09-12T11:40:37.654Z`.
- Outer process completion: `2026-09-12T11:41:07.357Z`.
- End-to-end duration: 29,962 ms; adapter duration: 29,675 ms.
- 33 generic observations: 33 activity, 17 progress, 28 resource classifications
  (categories overlap). All 31 non-process observations arrived before the
  terminal process callback; 16 were structured provider lifecycle/usage mappings.
- Native events actually observed: `thread.started` ×1, `turn.started` ×1,
  `item.started` ×5, `item.completed` ×7, `turn.completed` ×1.
- Items actually observed: four commands (eight lifecycle observations), one
  file-change item (two lifecycle observations), two agent-message items.
  No MCP/web tool, reasoning item or `item.updated` event was observed in this run.
- Usage arrived once at `turn.completed`, sequence 30,
  `2026-09-12T11:41:06.280Z`, 1,077 ms before outer completion: 53,024 input tokens,
  38,656 cached input tokens, 589 output tokens, 0 reasoning output tokens.
  No cache-write counter, total-token counter, intermediate usage or monetary cost
  was exposed or estimated.
- Final semantic response: protocol v1 COMPLETE, reporting `twice(n)` and three
  passing tests; one COMMIT effect, “Add pure twice function and tests for zero,
  positive and negative inputs”. Operational events did not select this action.
- Independent public evaluation passed tests and arithmetic checks. Runtime
  COMPLETED; one canonical fixture commit; source checkout remained unchanged.
- Starting fixture commit: `b7bd7ef963dd83339195541a232db186d3d9d906`.
- Stirpi-created fixture commit: `f68d9f835dc3512121d6022587405ba046370a37`.
- Replay matched without relaunching Codex, commands, evaluator or Git effects.

The smoke retained `task.txt`, `report.json` (including timestamped operational
observations) and `state.json` in its printed temporary directory. The published
record contains selected counts and hashes rather than raw provider output or
credentials. These facts establish incremental visibility for this invocation,
not exhaustive provider coverage or an experimental evaluation conclusion.

Automated verification: `npm run format`, `npm run check`, `npm run build`, and
`npm test` passed; 79 deterministic tests, including telemetry and cancellation.
The real smoke is opt-in and is never part of the normal automated suite.
