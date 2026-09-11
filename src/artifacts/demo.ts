import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitWork } from "./git.js";

// A deliberately small demonstration, not a general editing protocol.
export const demoWork: GitWork = ({ name }, workspace) => {
  if (name !== "X" && name !== "Y") return;
  writeFileSync(
    join(workspace.path, "artifact-example.txt"),
    `Result ${name}\n`,
  );
  workspace.commit(`Add example result ${name}`);
};
