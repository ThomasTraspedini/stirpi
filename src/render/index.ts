import {
  dna,
  sumResources,
  type State,
  type WorkUnit,
} from "../domain/index.js";
export function tree(state: State): string {
  const lines: string[] = [];
  const work = (w: WorkUnit, prefix: string) => {
    for (const child of state.work.filter((c) => c.parentId === w.id)) {
      lines.push(
        `${prefix}SPAWN ${child.name} [${child.status}] (${child.id})`,
      );
      work(child, prefix + "  ");
    }
  };
  const lineage = (id: string, prefix: string) => {
    const l = state.lineages.find((l) => l.id === id)!;
    lines.push(
      `${prefix}${l.parentId ? "FORK " : ""}${l.name} [${l.status}] (${l.id})${l.assumption ? ` assumption=${JSON.stringify(l.assumption)}` : ""}`,
    );
    for (const w of state.work.filter(
      (w) => w.lineageId === id && w.parentId === null,
    ))
      work(w, prefix + "  ");
    for (const child of state.lineages.filter((c) => c.parentId === id))
      lineage(child.id, prefix + "  ");
  };
  lineage(state.lineages[0]!.id, "");
  return lines.join("\n");
}
export function inspect(state: State, lineageId?: string): unknown {
  if (lineageId) {
    const lineage = state.lineages.find((l) => l.id === lineageId);
    if (!lineage) throw new Error(`Unknown lineage: ${lineageId}`);
    const work = state.work.filter((w) => w.lineageId === lineageId);
    return {
      lineage,
      dna: dna(state, lineageId),
      resources: sumResources(work),
      work,
    };
  }
  const { scenario, ...rest } = state;
  const visible = {
    name: scenario.name,
    objective: scenario.objective,
    publicEvaluation: scenario.publicEvaluation,
    scripts: scenario.scripts,
  };
  return { ...rest, scenario: visible };
}
