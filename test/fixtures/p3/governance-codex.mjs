#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
if (process.argv.includes("--version")) {
  console.log("codex-cli fixture");
  process.exit(0);
}
const task = readFileSync(0, "utf8");
const prompt = process.argv.at(-1);
const context = JSON.parse(prompt.split("Lineage-local context (JSON):\n")[1]);
const { work } = context;
const response = {
  version: 1,
  action: { type: "COMPLETE", result: "done" },
  effects: [],
  text: JSON.stringify({
    taskSha256: createHash("sha256").update(task).digest("hex"),
    governance: context.governance,
    workspace: process.cwd(),
  }),
};
if (work.name === "root" && work.cursor === 0) {
  response.action = { type: "CONTINUE" };
  response.effects = [{ type: "VERIFY", id: "full-postgres-suite" }];
} else if (work.name === "root" && work.cursor === 1) {
  response.action = {
    type: "SPAWN",
    work: [
      { name: "child", objective: "Bounded fixture work", priority: null },
    ],
  };
} else if (work.name === "root" && context.control.actions.includes("FORK")) {
  response.action = {
    type: "FORK",
    alternatives: ["alpha", "beta"].map((name) => ({
      name,
      assumption: `Assume ${name} for this fixture.`,
      rationale: "Conditional fixture",
      objective: null,
      priority: null,
    })),
  };
}
writeFileSync(
  process.argv[process.argv.indexOf("--output-last-message") + 1],
  JSON.stringify(response),
);
