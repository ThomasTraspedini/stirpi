// Run this wrapper from the active source checkout, never from the pinned tree.
import { execFileSync, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

try {
  const [entry, ...args] = process.argv.slice(2);
  if (!entry)
    throw new Error(
      "Usage: node tools/launch-pinned-runtime.mjs <external-compiled-launcher> [args...]",
    );
  const dependencies = fileURLToPath(
    new URL("../node_modules", import.meta.url),
  );
  if (!statSync(dependencies, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(
      `Preflight: build-tool node_modules directory missing: ${dependencies}`,
    );

  const launcher = resolve(entry);
  // NODE_PATH must be present at Node startup, before createRequire is used.
  const env = { ...process.env, NODE_PATH: dependencies };
  execFileSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `const { createRequire } = require('node:module');
       const { realpathSync } = require('node:fs');
       const { sep } = require('node:path');
       const fromLauncher = createRequire(process.argv[1]);
       const root = realpathSync(process.env.NODE_PATH) + sep;
       for (const tool of ['typescript/bin/tsc', '@types/node/package.json']) {
         const resolved = realpathSync(fromLauncher.resolve(tool));
         if (!resolved.startsWith(root))
           throw new Error(tool + ' resolved outside supplied NODE_PATH: ' + resolved);
       }`,
      launcher,
    ],
    { env, stdio: "pipe" },
  );
  // The pinned launcher retains responsibility for its PATH-only child envs.
  const child = spawnSync(process.execPath, [launcher, ...args], {
    env,
    stdio: "inherit",
  });
  if (child.error) throw child.error;
  if (child.signal) process.kill(process.pid, child.signal);
  else process.exitCode = child.status ?? 1;
} catch (error) {
  console.error(
    `Pinned runtime build-tool preflight/launch failed: ${error.message}`,
  );
  process.exitCode = 1;
}
