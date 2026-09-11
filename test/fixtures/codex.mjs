#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) {
  console.log("codex-cli fixture");
  process.exit(0);
}
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const task = readFileSync(0, "utf8");
if (task === "exit") {
  console.error("secret diagnostic sentinel");
  process.exit(7);
}
if (task === "timeout") await new Promise((r) => setTimeout(r, 10000));
if (task === "overflow") console.log("x".repeat(1024 * 1024 + 1));
const response = {
  version: 1,
  action: { type: "COMPLETE", result: "done" },
  effects: [],
  text: "FORK is prose, not control",
};
if (task === "edit") {
  writeFileSync("change.txt", "coherent change\n");
  response.effects.push({ type: "COMMIT", message: "Add coherent change" });
}
if (task === "invalid-action") response.action.type = "WIN";
if (task === "continue") response.action = { type: "CONTINUE" };
writeFileSync(
  option("--output-last-message"),
  task === "prose" ? "I am COMPLETE" : JSON.stringify(response),
);
writeFileSync(
  join(process.cwd(), "../observed.json"),
  JSON.stringify({
    cwd: process.cwd(),
    args,
    task,
    environment: Object.keys(process.env),
    home: process.env.HOME,
    codexHome: process.env.CODEX_HOME,
    schema: JSON.parse(readFileSync(option("--output-schema"), "utf8")),
    personalConfig: existsSync(join(process.env.CODEX_HOME, "config.toml")),
  }),
);
console.log(
  JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 2,
      output_tokens: 3,
      secret: "omit",
    },
  }),
);
