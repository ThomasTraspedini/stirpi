import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexEvents } from "../adapters/codex/events.mjs";
import { permissions, statePlacement } from "../adapters/codex/diagnostics.mjs";
import { sanitize } from "../src/operational/index.js";
import {
  adapterEvidence,
  environmentEvidence,
  pathEvidence,
} from "../src/operational/diagnostics.js";

test("native diagnostics retain origin and validated fields without raw payloads", () => {
  const out: ReturnType<typeof sanitize>[] = [];
  const events = new CodexEvents((v: unknown) => out.push(sanitize(v)));
  for (const v of [
    { type: "thread.started", thread_id: "secret" },
    { type: "future.event", message: "secret" },
    {
      type: "error",
      code: "rate_limit_exceeded",
      message: "secret",
      http_status: 429,
      retryable: true,
      attempt: 2,
      additionalDetails: "secret",
      provider: "openai",
    },
    {
      type: "turn.failed",
      error: {
        message: "secret",
        http_status: "401",
        retry: "yes",
        retry_count: -1,
        code: "secret",
      },
    },
    { type: "item.started" },
  ])
    events.write(Buffer.from(JSON.stringify(v) + "\n"));
  events.write(Buffer.from("not json\n"));
  events.end();
  assert.equal(out[0].metadata?.nativeType, "thread.started");
  assert.equal(out[1].metadata?.eventClass, "unknown");
  assert.equal(out[2].metadata?.eventClass, "recognized");
  assert.equal(out[2].metadata?.error_code, "rate_limit_exceeded");
  assert.equal(out[2].metadata?.http_status, 429);
  assert.equal(out[2].metadata?.retryable, true);
  assert.equal(out[2].metadata?.attempt, 2);
  assert.equal(out[3].metadata?.structuredCategoryAvailable, false);
  for (const k of ["http_status", "retry", "retry_count", "error_code"])
    assert.equal(out[3].metadata?.[k], undefined);
  assert.equal(out[4].metadata?.eventClass, "malformed");
  assert.equal(out[4].metadata?.nativeType, "item.started");
  assert.equal(out[5].metadata?.eventClass, "malformed");
  assert.equal(sanitize(null).metadata?.eventClass, "normalized");
  assert.equal(JSON.stringify(out).includes("secret"), false);
  assert.deepEqual(events.counts, { recognized: 3, unknown: 1, malformed: 2 });
});

test("adapter evidence uses a closed projection and auth metadata never reads or hashes contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "safe-diagnostics-"));
  try {
    const auth = join(dir, "auth.json");
    writeFileSync(auth, "credential-sentinel", { mode: 0o600 });
    const environment = environmentEvidence(
      { OPENAI_API_KEY: "credential-sentinel", PATH: "path-sentinel" },
      { PATH: "path-sentinel", HOME: "home-sentinel" },
    );
    const record = adapterEvidence(
      JSON.stringify({
        adapter: "codex-m2-v1",
        model: "gpt-6-astra",
        effort: "medium",
        failure: { code: "AGENT_EXIT_FAILED", message: "credential-sentinel" },
        status: 1,
        diagnostics: {
          counts: { recognized: 2, unknown: 1, malformed: 1 },
          eventTypes: { error: 2 },
          lastNativeType: "error",
          lifecycle: { turn: "failed" },
          errors: [
            {
              eventClass: "recognized",
              nativeType: "error",
              error_code: "unauthorized",
              message: "credential-sentinel",
            },
          ],
        },
        configuration: {
          executor: { model: "gpt-6-astra", effort: "medium", secret: "omit" },
          auth: {
            kind: "explicit_file",
            ...permissions(auth),
            contents: "credential-sentinel",
            sha256: "credential-sentinel",
          },
          state: { ...pathEvidence(dir), placement: "system_temp" },
          environment,
        },
      }),
    );
    assert.deepEqual(record?.failure, { code: "AGENT_EXIT_FAILED" });
    assert.equal(record?.status, 1);
    assert.equal(record?.requestedModel, "gpt-6-astra");
    assert.equal(record?.requestedEffort, "medium");
    assert.deepEqual(
      (record?.configuration as Record<string, unknown>).executor,
      {
        model: "gpt-6-astra",
        effort: "medium",
      },
    );
    assert.deepEqual(record?.counts, {
      recognized: 2,
      unknown: 1,
      malformed: 1,
    });
    assert.equal(JSON.stringify(record).includes("sentinel"), false);
    assert.equal(JSON.stringify(record).includes("sha256"), false);
    assert.deepEqual(
      environment.find((e) => e.name === "OPENAI_API_KEY"),
      { name: "OPENAI_API_KEY", present: true, policy: "stripped" },
    );
    assert.equal(pathEvidence(dir).mode, 0o700);
    assert.equal(pathEvidence(dir).readable, true);
    assert.equal(pathEvidence(dir).writable, true);
    assert.equal(adapterEvidence("arbitrary stderr"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("experiment-local temp classification takes precedence over its system-temp ancestor", () => {
  assert.equal(
    statePlacement("/private/tmp/run/executor-home/work"),
    "experiment_local",
  );
  assert.equal(statePlacement("/private/tmp"), "system_temp");
  assert.equal(statePlacement("/tmp-custom"), "configured_temp");
});
