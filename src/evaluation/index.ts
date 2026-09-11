import type { PublicCriteria, Reason } from "../domain/index.js";
export interface EvaluationContext {
  result: string;
  criteria: PublicCriteria;
  workId: string;
  lineageId: string;
  artifactRef?: string;
  workspacePath?: string;
}
export interface CheckResult {
  id: string;
  startedAt: string;
  completedAt: string;
  processStatus: "exited" | "signaled" | "operational_error";
  exitStatus: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  passed: boolean;
  error: string | null;
}
export interface Evaluation {
  passed: boolean;
  reason: string;
  completionPolicy?: "all_checks_pass";
  checks?: CheckResult[];
}
export interface Evaluator {
  evaluate(context: EvaluationContext): Evaluation;
}
export interface EvaluationOperation {
  context: EvaluationContext;
  outcome: { ok: true; evaluation: Evaluation } | { ok: false; reason: Reason };
}
export class FakeEvaluator implements Evaluator {
  constructor(private readonly hidden: { requiredText: string }) {}
  evaluate({ result }: EvaluationContext): Evaluation {
    return {
      passed: result.includes(this.hidden.requiredText),
      reason: "Deterministic required-text evaluation",
    };
  }
}
