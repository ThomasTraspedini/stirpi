import type { RunBudgets, StopEvidence } from "./index.js";
export interface RunSupervisionObservation {
  checkpoint: string;
  scope: string;
  budgets: RunBudgets;
  consumption: { steps: number; invocations: number; lineages: number };
  requestedLineages: number;
  stop: StopEvidence | null;
}
export type RunSupervisionEffect = (
  input: Omit<RunSupervisionObservation, "stop">,
) => RunSupervisionObservation;
export const superviseRun: RunSupervisionEffect = (input) => {
  let stop: StopEvidence | null = null;
  for (const resource of ["steps", "invocations", "lineages"] as const) {
    if (input.requestedLineages && resource !== "lineages") continue;
    const budget = input.budgets[resource];
    const observed = input.consumption[resource];
    if (
      budget !== undefined &&
      (observed >= budget ||
        (resource === "lineages" &&
          observed + input.requestedLineages > budget))
    ) {
      stop = {
        kind: "RESOURCE_EXHAUSTED",
        resource,
        budget,
        observed,
        scope: input.scope,
      };
      break;
    }
  }
  return { ...structuredClone(input), stop };
};
