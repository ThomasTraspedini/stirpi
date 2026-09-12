import { diagnosticMetadata } from "./diagnostics.js";
import { createHash } from "node:crypto";

export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const kinds = [
  "process",
  "thread",
  "turn",
  "item",
  "command",
  "file",
  "tool",
  "agent",
  "reasoning",
  "output",
  "usage",
  "diagnostic",
  "termination",
] as const;
export const statuses = [
  "started",
  "updated",
  "completed",
  "failed",
  "in_progress",
  "cancelled",
  "resource_exhausted",
] as const;
export interface OperationalInput {
  kind: (typeof kinds)[number];
  scope?: string;
  status?: (typeof statuses)[number];
  metadata?: Record<string, string | number | boolean>;
}
export interface OperationalEvent extends OperationalInput {
  sequence: number;
  timestamp: string;
  invocationId: string;
  categories: ("activity" | "progress" | "resource")[];
}
export type OperationalObserver = (event: OperationalEvent) => void;
const numeric = new Set([
  "bytes",
  "exitCode",
  "durationMs",
  "budgetMs",
  "files",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "dropped",
]);
const digests = new Set([
  "commandHash",
  "toolHash",
  "outputHash",
  "fileChangesHash",
  "threadHash",
  "turnHash",
  "itemHash",
]);
// Closed metadata projection: arbitrary text, paths, commands and credentials never
// become persisted telemetry. Provider identities use stable SHA-256 digests.
export function sanitize(input: unknown): OperationalInput {
  const v = input as OperationalInput;
  if (!v || !kinds.includes(v.kind))
    return { kind: "diagnostic", metadata: { eventClass: "normalized" } };
  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(v.metadata ?? {})) {
    if (diagnosticMetadata(key, value)) metadata[key] = value;
    if (
      numeric.has(key) &&
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      (key === "exitCode" || value >= 0)
    )
      metadata[key] = value;
    if (
      digests.has(key) &&
      typeof value === "string" &&
      /^[a-f0-9]{64}$/.test(value)
    )
      metadata[key] = value;
  }
  if (v.kind === "diagnostic" && !metadata.eventClass)
    metadata.eventClass = "normalized";
  return {
    kind: v.kind,
    ...(typeof v.scope === "string" && /^[a-f0-9]{64}$/.test(v.scope)
      ? { scope: v.scope }
      : {}),
    ...(v.status && statuses.includes(v.status) ? { status: v.status } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}
export class OperationalChannel {
  private sequence = 0;
  private transitions = new Set<string>();
  private resources = new Map<string, string>();
  constructor(
    readonly invocationId: string,
    private readonly observe: OperationalObserver,
  ) {}
  emit(input: OperationalInput, timestamp = new Date().toISOString()) {
    const v = sanitize(input);
    const categories: OperationalEvent["categories"] = ["activity"];
    if (v.scope && v.status && v.status !== "updated") {
      const key = `${v.kind}:${v.scope}:${v.status}`;
      if (!this.transitions.has(key)) {
        this.transitions.add(key);
        categories.push("progress");
      }
    }
    const resource = Object.entries(v.metadata ?? {})
      .filter(([k]) => numeric.has(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const key = `${v.kind}:${v.scope ?? ""}`;
    if (
      resource.length &&
      this.resources.get(key) !== JSON.stringify(resource)
    ) {
      this.resources.set(key, JSON.stringify(resource));
      categories.push("resource");
    }
    if (
      ["command", "tool", "item", "file", "agent", "reasoning"].includes(
        v.kind,
      ) &&
      v.status === "started" &&
      categories.includes("progress") &&
      !categories.includes("resource")
    )
      categories.push("resource");
    const event: OperationalEvent = {
      ...v,
      sequence: ++this.sequence,
      timestamp,
      invocationId: this.invocationId,
      categories,
    };
    this.observe(structuredClone(event));
    return event;
  }
}
export function verifyObservations(events: OperationalEvent[]) {
  if (!events.length) return [];
  const reconstructed: OperationalEvent[] = [];
  const channel = new OperationalChannel(events[0]!.invocationId, (e) =>
    reconstructed.push(e),
  );
  for (const event of events) {
    if (!Number.isFinite(Date.parse(event.timestamp)))
      throw new Error("Replay operational timestamp mismatch");
    channel.emit(event, event.timestamp);
  }
  // Property order is immaterial to persisted JSON.
  return reconstructed;
}
export function summarize(events: OperationalEvent[]) {
  const selected = (category: OperationalEvent["categories"][number]) =>
    events.filter((e) => e.categories.includes(category));
  const activity = selected("activity"),
    progress = selected("progress");
  const scopes = (kinds: string[]) =>
    new Set(
      events
        .filter((e) => e.scope && kinds.includes(e.kind))
        .map((e) => `${e.invocationId}:${e.scope}`),
    ).size;
  return {
    activityEvents: activity.length,
    progressEvents: progress.length,
    resourceEvents: selected("resource").length,
    commandCount: scopes(["command"]),
    toolCount: scopes(["tool"]),
    itemCount: scopes([
      "command",
      "tool",
      "file",
      "agent",
      "reasoning",
      "item",
    ]),
    firstActivityAt: activity[0]?.timestamp ?? null,
    lastActivityAt: activity.at(-1)?.timestamp ?? null,
    firstProgressAt: progress[0]?.timestamp ?? null,
    lastProgressAt: progress.at(-1)?.timestamp ?? null,
    latestUsage:
      events.filter((e) => e.kind === "usage").at(-1)?.metadata ?? null,
  };
}
