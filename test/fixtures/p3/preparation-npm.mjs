#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("fixture-npm");
  process.exit(0);
}
if (process.argv.includes("ci")) {
  for (const name of ["pg", "typescript", "@types/pg", "@types/node"]) {
    mkdirSync(`node_modules/${name}`, { recursive: true });
    writeFileSync(
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, main: "index.js", type: "module" }),
    );
    writeFileSync(
      `node_modules/${name}/index.js`,
      name === "pg"
        ? "export default {Client: class {async connect(){} async query(){} async end(){}}};"
        : "",
    );
  }
}
