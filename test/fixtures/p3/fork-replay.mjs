import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const { context } = input;
const { work, dna } = context;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const observation = {
  dna,
  files: git("ls-tree", "--name-only", "HEAD"),
  head: git("rev-parse", "HEAD"),
  taskSha256: createHash("sha256").update(context.task).digest("hex"),
};

if (work.name === "root" && work.cursor === 0) {
  process.stdout.write(
    JSON.stringify({
      version: 1,
      effects: [{ type: "VERIFY", id: "full-postgres-suite" }],
      action: { type: "CONTINUE" },
      text: JSON.stringify(observation),
    }),
  );
  process.exit(0);
}

if (work.name === "root") {
  process.stdout.write(
    JSON.stringify({
      version: 1,
      effects: [],
      action: {
        type: "FORK",
        alternatives: [
          {
            name: "alpha",
            assumption: "Treat capacity as fixed for this conditional world.",
            rationale: "Exercise one explicit fixture assumption per edge.",
          },
          {
            name: "beta",
            assumption: "Treat capacity as elastic for this conditional world.",
            rationale:
              "Exercise a distinct explicit fixture assumption per edge.",
          },
        ],
      },
      text: JSON.stringify(observation),
    }),
  );
  process.exit(0);
}

if (work.cursor === 0) {
  writeFileSync(`${work.name}.txt`, `${work.name} fixture artifact\n`);
  process.stdout.write(
    JSON.stringify({
      version: 1,
      effects: [
        { type: "COMMIT", message: `Add ${work.name} fixture artifact` },
      ],
      action: { type: "CONTINUE" },
      text: JSON.stringify(observation),
    }),
  );
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    version: 1,
    effects: [],
    action: { type: "COMPLETE", result: `done ${work.name}` },
    text: JSON.stringify(observation),
  }),
);
