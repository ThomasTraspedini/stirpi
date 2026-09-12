import type { OperationalEvent } from "../operational/index.js";

export interface InvocationPolicy {
  budgets?: { items?: number; commands?: number; wallTimeMs?: number };
  noProgressMs?: number;
}
export interface RunBudgets {
  steps?: number;
  invocations?: number;
  lineages?: number;
}
export type StopEvidence =
  | {
      kind: "RESOURCE_EXHAUSTED";
      scope: string;
      resource: string;
      budget: number;
      observed: number;
    }
  | {
      kind: "NO_PROGRESS";
      scope: string;
      lastProgressSequence: number | null;
      elapsedMs: number;
      limitMs: number;
    }
  | {
      kind: "CALLER_CANCELLED" | "PROCESS_PROTOCOL_FAILURE";
      scope: string;
      code: string;
    };
export interface SupervisionObservation {
  scope: string;
  policy: InvocationPolicy;
  consumption: { items: number; commands: number; wallTimeMs: number };
  lastProgressSequence: number | null;
  elapsedNoProgressMs: number;
  latestUsage: OperationalEvent["metadata"] | null;
  stop: StopEvidence | null;
}
export type SupervisionObserver = (observation: SupervisionObservation) => void;
export function validateLimits(limits: object) {
  for (const value of Object.values(limits))
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("Budgets must be nonnegative safe integers");
}
export function validatePolicy(policy: InvocationPolicy) {
  if (
    Object.keys(policy).some((k) => !["budgets", "noProgressMs"].includes(k)) ||
    Object.keys(policy.budgets ?? {}).some(
      (k) => !["items", "commands", "wallTimeMs"].includes(k),
    )
  )
    throw new Error("Unsupported supervision policy");
  validateLimits(policy.budgets ?? {});
  if (
    policy.noProgressMs !== undefined &&
    (!Number.isSafeInteger(policy.noProgressMs) || policy.noProgressMs < 1)
  )
    throw new Error("No-progress duration must be a positive safe integer");
}
// Invocation is the reliably observable ownership boundary. Item transitions
// inform this watchdog; they do not imply independently cancellable subscopes.
export class InvocationSupervisor {
  private readonly started: number;
  private lastProgress: number;
  private sequence: number | null = null;
  private readonly items = new Set<string>();
  private readonly commands = new Set<string>();
  private usage: OperationalEvent["metadata"] | null = null;
  private stopped: StopEvidence | null = null;
  readonly policy: InvocationPolicy;
  constructor(
    readonly scope: string,
    policy: InvocationPolicy = {},
    private readonly now = () => performance.now(),
  ) {
    validatePolicy(policy);
    this.policy = structuredClone(policy);
    this.started = this.lastProgress = now();
  }
  observe(event: OperationalEvent) {
    if (this.stopped) return;
    // An already elapsed deadline wins over a subsequently delivered event.
    if (this.check()) return;
    if (event.categories.includes("progress")) {
      this.lastProgress = this.now();
      this.sequence = event.sequence;
    }
    if (event.scope) {
      if (
        ["command", "tool", "file", "agent", "reasoning", "item"].includes(
          event.kind,
        )
      )
        this.items.add(event.scope);
      if (event.kind === "command") this.commands.add(event.scope);
    }
    if (event.kind === "usage") this.usage = event.metadata ?? null;
    this.check();
  }
  stop(reason: StopEvidence) {
    this.stopped ??= reason;
    return this.stopped;
  }
  check(): StopEvidence | null {
    if (this.stopped) return this.stopped;
    const consumption = this.consumption();
    for (const resource of ["items", "commands", "wallTimeMs"] as const) {
      const budget = this.policy.budgets?.[resource];
      if (budget !== undefined && consumption[resource] >= budget)
        return this.stop({
          kind: "RESOURCE_EXHAUSTED",
          scope: this.scope,
          resource,
          budget,
          observed: consumption[resource],
        });
    }
    const elapsedMs = this.now() - this.lastProgress;
    if (
      this.policy.noProgressMs !== undefined &&
      elapsedMs >= this.policy.noProgressMs
    )
      return this.stop({
        kind: "NO_PROGRESS",
        scope: this.scope,
        lastProgressSequence: this.sequence,
        elapsedMs,
        limitMs: this.policy.noProgressMs,
      });
    return null;
  }
  private consumption() {
    return {
      items: this.items.size,
      commands: this.commands.size,
      wallTimeMs: this.now() - this.started,
    };
  }
  snapshot(): SupervisionObservation {
    return structuredClone({
      scope: this.scope,
      policy: this.policy,
      consumption: this.consumption(),
      lastProgressSequence: this.sequence,
      elapsedNoProgressMs: this.now() - this.lastProgress,
      latestUsage: this.usage,
      stop: this.stopped,
    });
  }
  delay(): number | undefined {
    if (this.stopped) return undefined;
    const deadlines: number[] = [];
    if (this.policy.budgets?.wallTimeMs !== undefined)
      deadlines.push(this.started + this.policy.budgets.wallTimeMs);
    if (this.policy.noProgressMs !== undefined)
      deadlines.push(this.lastProgress + this.policy.noProgressMs);
    return deadlines.length
      ? Math.min(2147483647, Math.max(1, Math.min(...deadlines) - this.now()))
      : undefined;
  }
}
