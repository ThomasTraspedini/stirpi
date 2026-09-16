import { test } from "node:test";
import assert from "node:assert/strict";
import {
  experimentAccounting,
  type ExecutorInvocationRecord,
  type IndexedOperationalObservation,
} from "../src/experiments/accounting.js";
import type { LineageStatus } from "../src/domain/index.js";

const invocation = (
  index: number,
  workId = "w1",
  lineageId = "l1",
): ExecutorInvocationRecord => ({ index, workId, lineageId });

const usage = (
  index: number,
  sequence: number,
  metadata: Record<string, number>,
): IndexedOperationalObservation => ({
  index,
  event: {
    kind: "usage",
    sequence,
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    invocationId: `invocation-${index}`,
    categories: ["activity", "resource"],
    metadata,
  },
});

const lineage = (id: string, status: LineageStatus = "COMPLETED") => ({
  id,
  status,
});

const work = (lineageId: string, steps: number) => ({
  lineageId,
  resources: { steps, tokens: 999, cost: 999, wallTimeMs: 999 },
});

test("cumulative and duplicate usage snapshots use the last field values and keep cached input separate", () => {
  const accounting = experimentAccounting(
    [invocation(1)],
    [
      usage(1, 1, {
        inputTokens: 10,
        cachedInputTokens: 3,
        outputTokens: 2,
      }),
      usage(1, 2, {
        inputTokens: 10,
        cachedInputTokens: 3,
        outputTokens: 2,
      }),
      usage(1, 3, {
        inputTokens: 15,
        cachedInputTokens: 4,
        outputTokens: 5,
        reasoningOutputTokens: 0,
      }),
    ],
    [lineage("l1")],
    [work("l1", 1)],
  );

  assert.deepEqual(accounting.tokens, {
    inputTokens: 15,
    cachedInputTokens: 4,
    outputTokens: 5,
    reasoningOutputTokens: 0,
  });
  assert.deepEqual(accounting.usageCoverage, {
    executorInvocations: 1,
    invocationsWithAnyUsage: 1,
    measuredInvocations: {
      inputTokens: 1,
      cachedInputTokens: 1,
      outputTokens: 1,
      reasoningOutputTokens: 1,
    },
  });
});

test("partial field coverage preserves measured zero and reports unobserved fields as null", () => {
  const accounting = experimentAccounting(
    [invocation(1), invocation(2), invocation(3)],
    [
      usage(1, 1, { inputTokens: 0 }),
      usage(2, 1, { outputTokens: 7 }),
      usage(3, 1, { totalTokens: 99 }),
    ],
    [lineage("l1")],
    [work("l1", 3)],
  );

  assert.deepEqual(accounting.tokens, {
    inputTokens: 0,
    cachedInputTokens: null,
    outputTokens: 7,
    reasoningOutputTokens: null,
  });
  assert.deepEqual(accounting.usageCoverage, {
    executorInvocations: 3,
    invocationsWithAnyUsage: 2,
    measuredInvocations: {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
    },
  });
});

test("multiple invocations of the same work and sibling lineages are each summed once", () => {
  const invocations = [
    invocation(1, "w1", "l1"),
    invocation(2, "w1", "l1"),
    invocation(3, "w2", "l2"),
    invocation(4, "w3", "l3"),
  ];
  const accounting = experimentAccounting(
    invocations,
    [
      usage(1, 1, { inputTokens: 10 }),
      usage(1, 2, { inputTokens: 10 }),
      usage(2, 1, { inputTokens: 20 }),
      usage(3, 1, { inputTokens: 7 }),
      usage(4, 1, { outputTokens: 2 }),
    ],
    [lineage("l1", "BRANCHED"), lineage("l2"), lineage("l3")],
    [work("l1", 2), work("l2", 1), work("l3", 1)],
  );

  assert.deepEqual(accounting.tokens, {
    inputTokens: 37,
    cachedInputTokens: null,
    outputTokens: 2,
    reasoningOutputTokens: null,
  });
  assert.equal(accounting.usageCoverage.executorInvocations, 4);
  assert.equal(accounting.usageCoverage.invocationsWithAnyUsage, 4);
  assert.deepEqual(accounting.lineageCounts, {
    created: 3,
    scheduled: 3,
    statuses: {
      ACTIVE: 0,
      WAITING: 0,
      BLOCKED: 0,
      BRANCHED: 1,
      DEAD: 0,
      COMPLETED: 2,
    },
  });
});

test("no-usage accounting retains null totals and exact counts for every lineage status", () => {
  const statuses: LineageStatus[] = [
    "ACTIVE",
    "WAITING",
    "BLOCKED",
    "BRANCHED",
    "DEAD",
    "COMPLETED",
  ];
  const accounting = experimentAccounting(
    [],
    [],
    statuses.map((status, index) => lineage(`l${index + 1}`, status)),
    statuses.map((_, index) => work(`l${index + 1}`, index % 2)),
  );

  assert.deepEqual(accounting.tokens, {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
  });
  assert.deepEqual(accounting.usageCoverage, {
    executorInvocations: 0,
    invocationsWithAnyUsage: 0,
    measuredInvocations: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
  });
  assert.deepEqual(accounting.lineageCounts, {
    created: 6,
    scheduled: 3,
    statuses: Object.fromEntries(statuses.map((status) => [status, 1])),
  });
});
