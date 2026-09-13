#!/usr/bin/env node
// Standalone reproduction; deliberately does not import the adapter or runtime.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns";
import { connect } from "node:tls";

const [probe, host, internal] = process.argv.slice(2);
if (!["env", "dns", "connect"].includes(probe))
  throw new Error(
    "Usage: node adapters/codex/connectivity.mjs env|dns|connect [chatgpt.com|api.openai.com]",
  );
if (probe !== "env" && !["chatgpt.com", "api.openai.com"].includes(host))
  throw new Error(
    "Choose an explicit known Codex destination: chatgpt.com or api.openai.com",
  );

const script = fileURLToPath(import.meta.url);
const run = (env, stage) => {
  const child = spawnSync(
    process.execPath,
    [script, probe, host ?? "", stage],
    {
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16384,
    },
  );
  if (child.error || child.status !== 0)
    return {
      ok: false,
      code: child.error?.code ?? `EXIT_${child.status}`,
      signal: child.signal,
    };
  return JSON.parse(child.stdout);
};

if (internal === "leaf") {
  const result = await new Promise((resolve) => {
    if (probe === "env") {
      resolve({
        ok: true,
        keys: Object.keys(process.env).sort(),
        LANG: process.env.LANG,
        TZ: process.env.TZ,
      });
      return;
    }
    // One lookup/handshake, no application request, credentials or retry loop.
    if (probe === "dns") {
      lookup(host, { all: true }, (error, addresses) =>
        resolve(
          error
            ? { ok: false, code: error.code, syscall: error.syscall }
            : { ok: true, addresses },
        ),
      );
      return;
    }
    const socket = connect({
      host,
      port: 443,
      servername: host,
      rejectUnauthorized: true,
    });
    socket.setTimeout(3000);
    socket.once("secureConnect", () => {
      socket.destroy();
      resolve({ ok: true });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ ok: false, code: "TIMEOUT" });
    });
    socket.once("error", (error) => {
      socket.destroy();
      resolve({ ok: false, code: error.code });
    });
  });
  console.log(JSON.stringify(result));
} else if (internal === "adapter") {
  // adapter.mjs: tmpdir is evaluated inside the process with the outer env.
  const root = realpathSync(tmpdir());
  const temporary = mkdtempSync(join(root, "stirpi-connectivity-adapter-"));
  try {
    const home = join(temporary, "home"),
      codexHome = join(temporary, "codex");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(codexHome, { mode: 0o700 });
    const env = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      TZ: "UTC",
      HOME: home,
      TMPDIR: temporary,
      CODEX_HOME: codexHome,
    };
    console.log(JSON.stringify({ tempRoot: root, result: run(env, "leaf") }));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
} else {
  const temporary = mkdtempSync(
    join(realpathSync(tmpdir()), "stirpi-connectivity-"),
  );
  try {
    const localHome = join(temporary, "executor-home", "probe-work");
    mkdirSync(localHome, { recursive: true });
    // smoke.mjs uses ProcessExecutor's inherited environment default.
    const smoke = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    smoke.STIRPI_OPERATIONAL_FD = "3";
    // run.ts overrides HOME/TMPDIR per work; process.ts adds the marker.
    const experiment = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      TZ: "UTC",
      HOME: localHome,
      TMPDIR: localHome,
      STIRPI_OPERATIONAL_FD: "3",
    };
    const A = run(smoke, "adapter");
    const B = run(experiment, "adapter");
    const outcome = (value) => {
      const r = value.result ?? value;
      return JSON.stringify([r.ok, r.code ?? null, r.syscall ?? null]);
    };
    const discriminating = outcome(A) !== outcome(B);
    console.log(
      JSON.stringify(
        { probe, host: host || undefined, A, B, discriminating },
        null,
        2,
      ),
    );
    if (discriminating) process.exitCode = 2;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
