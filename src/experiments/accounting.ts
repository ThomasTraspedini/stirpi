import type { Lineage, LineageStatus, WorkUnit } from "../domain/index.js";
import type { OperationalEvent } from "../operational/index.js";

export const usageFields = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;
export type UsageField = (typeof usageFields)[number];

const lineageStatuses = [
  "ACTIVE",
  "WAITING",
  "BLOCKED",
  "BRANCHED",
  "DEAD",
  "COMPLETED",
] as const satisfies readonly LineageStatus[];

export interface ExecutorInvocationRecord {
  index: number;
  workId: string;
  lineageId: string;
}

export interface IndexedOperationalObservation {
  index: number;
  event: OperationalEvent;
}

type UsageValues<T> = Record<UsageField, T>;

export interface ExperimentAccounting {
  tokens: UsageValues<number | null>;
  usageCoverage: {
    executorInvocations: number;
    invocationsWithAnyUsage: number;
    measuredInvocations: UsageValues<number>;
  };
  lineageCounts: {
    created: number;
    scheduled: number;
    statuses: Record<LineageStatus, number>;
  };
}

const usageValues = <T>(value: T): UsageValues<T> => ({
  inputTokens: value,
  cachedInputTokens: value,
  outputTokens: value,
  reasoningOutputTokens: value,
});

const usable = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export function experimentAccounting(
  invocations: readonly ExecutorInvocationRecord[],
  observations: readonly IndexedOperationalObservation[],
  lineages: readonly Pick<Lineage, "id" | "status">[],
  work: readonly Pick<WorkUnit, "lineageId" | "resources">[],
): ExperimentAccounting {
  const invocationIndexes = new Set<number>();
  for (const invocation of invocations) {
    if (
      !Number.isSafeInteger(invocation.index) ||
      invocation.index < 1 ||
      invocationIndexes.has(invocation.index)
    )
      throw new Error("Experiment accounting invocation identity mismatch");
    invocationIndexes.add(invocation.index);
  }

  const snapshots = new Map<number, Partial<UsageValues<number>>>();
  for (const observation of observations) {
    if (!invocationIndexes.has(observation.index))
      throw new Error("Experiment accounting observation identity mismatch");
    if (observation.event.kind !== "usage") continue;
    const snapshot = snapshots.get(observation.index) ?? {};
    for (const field of usageFields) {
      const value = observation.event.metadata?.[field];
      if (usable(value)) snapshot[field] = value;
    }
    snapshots.set(observation.index, snapshot);
  }

  const totals = usageValues<number | null>(null);
  const measuredInvocations = usageValues(0);
  let invocationsWithAnyUsage = 0;
  for (const snapshot of snapshots.values()) {
    let measured = false;
    for (const field of usageFields) {
      const value = snapshot[field];
      if (value === undefined) continue;
      measured = true;
      measuredInvocations[field]++;
      const total = (totals[field] ?? 0) + value;
      if (!Number.isSafeInteger(total))
        throw new Error("Experiment accounting token total exceeds safe range");
      totals[field] = total;
    }
    if (measured) invocationsWithAnyUsage++;
  }

  const lineageIds = new Set<string>();
  const statuses = Object.fromEntries(
    lineageStatuses.map((status) => [status, 0]),
  ) as Record<LineageStatus, number>;
  for (const lineage of lineages) {
    if (lineageIds.has(lineage.id))
      throw new Error("Experiment accounting lineage identity mismatch");
    lineageIds.add(lineage.id);
    statuses[lineage.status]++;
  }
  const scheduled = new Set(
    work
      .filter((item) => item.resources.steps > 0)
      .map((item) => item.lineageId),
  );
  if ([...scheduled].some((lineageId) => !lineageIds.has(lineageId)))
    throw new Error("Experiment accounting scheduled lineage mismatch");

  return {
    tokens: totals,
    usageCoverage: {
      executorInvocations: invocations.length,
      invocationsWithAnyUsage,
      measuredInvocations,
    },
    lineageCounts: {
      created: lineages.length,
      scheduled: scheduled.size,
      statuses,
    },
  };
}
