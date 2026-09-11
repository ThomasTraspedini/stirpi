export type Condition = "H" | "S" | "T";
export function control(condition: Condition) {
  return {
    version: 1,
    actions:
      condition === "T"
        ? ["CONTINUE", "SPAWN", "COMPLETE", "BLOCK", "FORK"]
        : ["CONTINUE", "SPAWN", "COMPLETE", "BLOCK"],
    semantics: {
      CONTINUE:
        "Continue the assigned work in the same workspace, retaining uncommitted edits.",
      SPAWN:
        "Decompose required work within the same lineage. Parent waits for all children and receives their outcomes; artifacts are not automatically merged.",
      COMPLETE:
        "Request public/runtime evaluation of result. Only a passing evaluation completes work. Commit artifact changes explicitly first.",
      BLOCK:
        "Stop assigned work with a structured reason. Use reason code HUMAN_DECISION_REQUIRED when requesting a human decision. No human answer is supplied by this harness.",
      ...(condition === "T"
        ? {
            FORK: "Main work may create at least two descendant lineages, each introducing exactly one path-defining assumption. Parent becomes BRANCHED. Children inherit the same committed parent artifact and see only their own world. Siblings need not converge or produce a winner.",
          }
        : {}),
    },
    effects:
      "Request coherent commits through effects: [{type: 'COMMIT', message: 'description'}]. The runtime controls commits. Dirty state cannot be inherited or declared complete.",
    ...(condition === "H"
      ? {
          policy:
            "Stop and report if progress requires a new human-owned semantic decision. Do not silently revise the human-owned contract.",
        }
      : {}),
  };
}
