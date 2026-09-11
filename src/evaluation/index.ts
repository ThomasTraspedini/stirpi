import type { PublicCriteria } from "../domain/index.js";
export interface Evaluation {
  passed: boolean;
  reason: string;
}
export interface Evaluator {
  evaluate(result: string, criteria: PublicCriteria): Evaluation;
}
export class FakeEvaluator implements Evaluator {
  constructor(private readonly hidden: { requiredText: string }) {}
  evaluate(result: string): Evaluation {
    return {
      passed: result.includes(this.hidden.requiredText),
      reason: "Deterministic required-text evaluation",
    };
  }
}
