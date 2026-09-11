import type { Scenario } from "../domain/index.js";
export const reference: Scenario = {
  name: "reference",
  objective: "Explore two conditional solutions",
  publicEvaluation: {
    description: "Return a completed simulation result",
    criteria: ["Provide a result"],
  },
  hiddenEvaluation: { requiredText: "done" },
  scripts: {
    root: [
      { type: "CONTINUE" },
      {
        type: "FORK",
        alternatives: [
          {
            name: "A",
            assumption: "Use strategy A",
            rationale: "Explore first strategy",
            priority: 1,
          },
          {
            name: "B",
            assumption: "Use strategy B",
            rationale: "Explore second strategy",
          },
        ],
      },
    ],
    A: [
      {
        type: "SPAWN",
        work: [
          { name: "X", objective: "Compute X" },
          { name: "Y", objective: "Compute Y" },
        ],
      },
      { type: "COMPLETE", result: "A done" },
    ],
    X: [{ type: "COMPLETE", result: "X done" }],
    Y: [{ type: "COMPLETE", result: "Y done" }],
    B: [
      {
        type: "BLOCK",
        reason: {
          code: "MISSING_INPUT",
          message: "Strategy B requires additional input",
        },
      },
    ],
  },
};
