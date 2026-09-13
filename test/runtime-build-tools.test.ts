import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const wrapper = resolve("tools/launch-pinned-runtime.mjs");

test("relocated compiled launcher resolves both build tools through checkout NODE_PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "stirpi-build-tools-"));
  try {
    const entry = join(dir, "launcher.mjs");
    writeFileSync(
      entry,
      ts.transpileModule(
        `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const tools: string[] = ['typescript/bin/tsc', '@types/node/package.json'];
      console.log(JSON.stringify({path: process.env.NODE_PATH,
        tools: tools.map(tool => require.resolve(tool)), args: process.argv.slice(2)}));
    `,
        { compilerOptions: { module: ts.ModuleKind.ESNext } },
      ).outputText,
    );
    const without = spawnSync(process.execPath, [entry], {
      cwd: dir,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
    assert.notEqual(without.status, 0);
    assert.match(without.stderr, /Cannot find module 'typescript\/bin\/tsc'/);
    const result = spawnSync(
      process.execPath,
      [wrapper, entry, "argument with spaces"],
      {
        cwd: dir,
        env: { PATH: process.env.PATH, NODE_PATH: "/ignored-inherited-path" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.path, resolve("node_modules"));
    assert.deepEqual(observed.tools, [
      resolve("node_modules/typescript/bin/tsc"),
      resolve("node_modules/@types/node/package.json"),
    ]);
    assert.deepEqual(observed.args, ["argument with spaces"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing dependency directory or build tool fails before launching", () => {
  const dir = mkdtempSync(join(tmpdir(), "stirpi-missing-build-tools-"));
  try {
    mkdirSync(join(dir, "tools"));
    const isolatedWrapper = join(dir, "tools/launch-pinned-runtime.mjs");
    cpSync(wrapper, isolatedWrapper);
    const entry = join(dir, "launcher.mjs");
    writeFileSync(entry, 'console.log("LAUNCHER EXECUTED");');
    const run = () =>
      spawnSync(process.execPath, [isolatedWrapper, entry], {
        cwd: dir,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
      });
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /build-tool node_modules directory missing/);
    assert.equal(missing.stdout, "");
    mkdirSync(join(dir, "node_modules"));
    const noTypescript = run();
    assert.equal(noTypescript.status, 1);
    assert.match(noTypescript.stderr, /typescript\/bin\/tsc/);
    assert.equal(noTypescript.stdout, "");
    mkdirSync(join(dir, "node_modules/typescript/bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules/typescript/bin/tsc"), "");
    const noNodeTypes = run();
    assert.equal(noNodeTypes.status, 1);
    assert.match(noNodeTypes.stderr, /@types\/node/);
    assert.equal(noNodeTypes.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
