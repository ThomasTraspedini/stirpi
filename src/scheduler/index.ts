import type { WorkUnit } from "../domain/index.js";
export function select(work: WorkUnit[], capacity: number): WorkUnit[] {
  return work
    .filter((w) => w.status === "ACTIVE")
    .sort((a, b) => b.priority - a.priority || a.queue - b.queue)
    .slice(0, capacity);
}
