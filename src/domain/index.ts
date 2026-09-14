import type { Artifact, ArtifactOperation } from "../artifacts/index.js";
import type { VerificationOperation } from "../verification/index.js";
export type LineageStatus =
  "ACTIVE" | "WAITING" | "BLOCKED" | "BRANCHED" | "DEAD" | "COMPLETED";
// M0 run aggregation only produces these states.
export type RunStatus = "ACTIVE" | "BLOCKED" | "COMPLETED";
// Main work records FORK as BRANCHED; spawned work cannot FORK.
export type WorkUnitStatus = LineageStatus;
export interface RunIdentity {
  taskId: string;
  runId: string;
}
export interface Reason {
  code: string;
  message: string;
  stop?: import("../supervision/index.js").StopEvidence;
}
export interface Resources {
  steps: number;
  tokens: number;
  cost: number;
  wallTimeMs: number;
}
export const zero = (): Resources => ({
  steps: 0,
  tokens: 0,
  cost: 0,
  wallTimeMs: 0,
});
export interface Alternative {
  name: string;
  assumption: string;
  rationale: string;
  objective?: string;
  priority?: number;
}
export interface SpawnSpec {
  name: string;
  objective: string;
  priority?: number;
}
export type Action =
  | { type: "CONTINUE" }
  | { type: "FORK"; alternatives: Alternative[] }
  | { type: "SPAWN"; work: SpawnSpec[] }
  | { type: "COMPLETE"; result: string; artifacts?: string[] }
  | { type: "BLOCK"; reason: Reason };
export interface PublicCriteria {
  description: string;
  criteria: string[];
}
export interface Scenario {
  name: string;
  objective: string;
  publicEvaluation: PublicCriteria;
  hiddenEvaluation: { requiredText: string };
  scripts: Record<string, unknown[]>;
}
export interface Config {
  maxConcurrency: number;
  maxSteps?: number;
  budgets?: import("../supervision/index.js").RunBudgets;
}
export interface Lineage {
  artifact?: Artifact;
  id: string;
  parentId: string | null;
  name: string;
  objective: string;
  assumption: string | null;
  rationale: string | null;
  status: LineageStatus;
  priority: number;
  reason: Reason | null;
}
export interface WorkUnit {
  artifact?: Artifact;
  id: string;
  lineageId: string;
  parentId: string | null;
  name: string;
  objective: string;
  status: WorkUnitStatus;
  priority: number;
  queue: number;
  cursor: number;
  result: string | null;
  artifacts: string[];
  reason: Reason | null;
  resources: Resources;
}
export interface Event {
  seq: number;
  type: string;
  subject: string;
  data: unknown;
}
export interface State extends RunIdentity {
  artifactOperations?: ArtifactOperation[];
  verificationOperations?: VerificationOperation[];
  status: RunStatus;
  reason: Reason | null;
  scenario: Scenario;
  config: Config;
  lineages: Lineage[];
  work: WorkUnit[];
  events: Event[];
  resources: Resources;
  nextQueue: number;
}
export function dna(state: State, lineageId: string): string[] {
  const lineage = state.lineages.find((l) => l.id === lineageId);
  if (!lineage) throw new Error(`Unknown lineage: ${lineageId}`);
  return [
    ...(lineage.parentId ? dna(state, lineage.parentId) : []),
    ...(lineage.assumption === null ? [] : [lineage.assumption]),
  ];
}
export function sumResources(work: WorkUnit[]): Resources {
  return work.reduce((sum, w) => {
    for (const key of Object.keys(sum) as (keyof Resources)[])
      sum[key] += w.resources[key];
    return sum;
  }, zero());
}
