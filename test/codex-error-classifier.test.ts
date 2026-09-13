import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyErrorMessage,
  supportedVersion,
  diagnosticCategories,
} from "../adapters/codex/error-classifier.mjs";
import { CodexEvents } from "../adapters/codex/events.mjs";
import {
  OperationalChannel,
  type OperationalEvent,
} from "../src/operational/index.js";
import { adapterEvidence } from "../src/operational/diagnostics.js";

const examples = [
  [
    "Your access token could not be refreshed. Please log out and sign in again.",
    "AUTHENTICATION",
  ],
  ["unexpected status 401 Unauthorized: sensitive body", "AUTHENTICATION"],
  ["unexpected status 403: sensitive body", "AUTHORIZATION"],
  ["You've hit your usage limit.", "RATE_OR_USAGE_LIMIT"],
  ["rate limit exceeded: sensitive details", "RATE_OR_USAGE_LIMIT"],
  [
    "exceeded retry limit, last status: 429 Too Many Requests",
    "RATE_OR_USAGE_LIMIT",
  ],
  [
    "unexpected status 503 Service Unavailable: sensitive body",
    "PROVIDER_SERVER",
  ],
  ["server overloaded", "PROVIDER_SERVER"],
  ["Connection failed: sensitive cause", "NETWORK_CONNECTION"],
  [
    "stream disconnected before completion: sensitive cause",
    "RESPONSE_STREAM_DISCONNECTED",
  ],
  ["auth refresh request timed out after 30s", "TIMEOUT"],
  [
    "Codex cannot access session files at /secret (permission denied). If sessions were created using sudo, fix ownership: sudo chown -R $(whoami) /secret",
    "FILESYSTEM_STATE_PERMISSION",
  ],
  ["404", "OTHER"],
  ["unexpected status 404 Not Found: model missing", "OTHER"],
  ["not found", "OTHER"],
  ["permission denied", "OTHER"],
  ["some text containing 429", "OTHER"],
  [
    'Error while reading the server response: {"status":503,"cause":"connection timed out"}',
    "OTHER",
  ],
  ["Failed to refresh token: ambiguous cause", "OTHER"],
  ["request timed out", "OTHER"],
  ["unexpected status 401: body\nConnection failed: cause", "OTHER"],
] as const;
for (const [message, category] of examples)
  test(`bounded classifier case ${examples.findIndex((e) => e[0] === message)} -> ${category}`, () => {
    const result = classifyErrorMessage(message, supportedVersion);
    assert.equal(result.diagnosticCategory, category);
    assert.ok(diagnosticCategories.includes(result.diagnosticCategory));
    for (const version of [
      undefined,
      "codex-cli fixture",
      "codex-cli 0.154.0-alpha.6.3",
      "0.154.0-alpha.6.2",
    ])
      assert.deepEqual(classifyErrorMessage(message, version), {
        diagnosticCategory: "OTHER",
        classificationSource: "codex-exec-bounded-message-v1",
        classifierVersionSupported: false,
      });
  });

test("HTTP extraction has strict digits, boundaries, positions and reason phrases", () => {
  for (const status of [100, 401, 403, 429, 500, 599]) {
    for (const message of [
      `unexpected status ${status}: body`,
      `exceeded retry limit, last status: ${status}`,
    ])
      assert.equal(
        classifyErrorMessage(message, supportedVersion)
          .messageDerivedHttpStatus,
        status,
      );
  }
  for (const text of [
    "99",
    "099",
    "600",
    "999",
    "4010",
    "４０１",
    "٤٠١",
    "+401",
    "401x",
    "401.0",
    "401 Wrong Reason",
    "401 UnauthorizedX",
  ])
    assert.equal(
      classifyErrorMessage(`unexpected status ${text}: body`, supportedVersion)
        .messageDerivedHttpStatus,
      undefined,
    );
  for (const message of [
    "unexpected status 401",
    "unexpected status 401:body",
    " unexpected status 401: body",
    "nested unexpected status 401: body",
    "exceeded retry limit, last status: 429xyz",
    "exceeded retry limit, last status: 429, body",
    "unexpected status 401 Unauthorized:body",
  ])
    assert.equal(
      classifyErrorMessage(message, supportedVersion).messageDerivedHttpStatus,
      undefined,
    );
});

test("only designated string fields classify; malformed messages preserve lifecycle", () => {
  const out: OperationalEvent[] = [];
  const channel = new OperationalChannel("test", (e) => out.push(e));
  const events = new CodexEvents(
    (v) => channel.emit(v),
    undefined,
    supportedVersion,
  );
  for (const message of [undefined, null, 401, {}, []]) {
    events.map({ type: "error", message });
    events.map({ type: "turn.started" });
    events.map({ type: "turn.failed", error: { message } });
    assert.equal(events.turnOpen, false);
    assert.equal(events.lifecycle.turn, "failed");
    assert.equal(out.at(-1)?.kind, "turn");
    assert.equal(out.at(-1)?.metadata?.eventClass, "malformed");
    assert.equal(out.at(-1)?.metadata?.diagnosticCategory, undefined);
  }
  const message = "unexpected status 429: secret";
  for (const event of [
    { type: "error", error: { message } },
    { type: "turn.failed", message },
    { type: "future.event", message },
    {
      type: "item.completed",
      item: { id: "a", type: "agent_message", text: message },
    },
    {
      type: "item.completed",
      item: { id: "b", type: "command_execution", aggregated_output: message },
    },
  ]) {
    events.map(event);
    assert.equal(out.at(-1)?.metadata?.diagnosticCategory, undefined);
  }
  events.map({ type: "error", message: "", error: { message } });
  assert.equal(out.at(-1)?.metadata?.diagnosticCategory, "OTHER");
});

test("native errors persist only safe derived fields and do not become progress or termination", () => {
  const dir = mkdtempSync(join(tmpdir(), "stirpi-error-test-"));
  try {
    const out: OperationalEvent[] = [];
    const channel = new OperationalChannel("test", (e) => out.push(e));
    const events = new CodexEvents(
      (v) => channel.emit(v),
      undefined,
      supportedVersion,
    );
    const message =
      "unexpected status 429 Too Many Requests: credential-sentinel https://secret.invalid/private, request id: account-sentinel, cf-ray: ray-sentinel";
    for (const event of [
      { type: "error", message },
      { type: "turn.failed", error: { message } },
    ]) {
      const bytes = Buffer.from(JSON.stringify(event) + "\n");
      for (let i = 0; i < bytes.length; i += 7)
        events.write(bytes.subarray(i, i + 7));
    }
    events.end();
    const evidence = adapterEvidence(
      JSON.stringify({
        adapter: "codex-m2-v1",
        diagnostics: { errors: events.errors },
      }),
    );
    const path = join(dir, "evidence.json");
    writeFileSync(path, JSON.stringify({ out, evidence }));
    const persisted = readFileSync(path, "utf8");
    for (const secret of [
      message,
      "sentinel",
      "secret.invalid",
      "request id",
      "cf-ray",
    ])
      assert.equal(persisted.includes(secret), false);
    for (const event of out) {
      assert.equal(event.metadata?.diagnosticCategory, "RATE_OR_USAGE_LIMIT");
      assert.equal(event.metadata?.messageDerivedHttpStatus, 429);
      assert.equal(event.metadata?.http_status, undefined);
      assert.equal(event.metadata?.structuredCategoryAvailable, false);
      assert.equal(
        event.metadata?.classificationSource,
        "codex-exec-bounded-message-v1",
      );
      assert.equal(event.metadata?.classifierVersionSupported, true);
      assert.equal(event.metadata?.messageBytes, Buffer.byteLength(message));
      assert.match(String(event.metadata?.messageHash), /^[a-f0-9]{64}$/);
      for (const key of ["retryable", "attempt", "providerHash", "modelHash"])
        assert.equal(event.metadata?.[key], undefined);
    }
    assert.deepEqual(out[0]?.categories, ["activity"]);
    assert.equal(out[1]?.kind, "turn");
    assert.equal(out[1]?.status, "failed");
    assert.equal(
      out.some((e) => e.kind === "termination"),
      false,
    );
    assert.equal(events.pending, "");
    assert.equal(JSON.stringify(events).includes("sentinel"), false);
    assert.equal(
      (evidence?.errors as Record<string, unknown>[])[0]
        ?.messageDerivedHttpStatus,
      429,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
