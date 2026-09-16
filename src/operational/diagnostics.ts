import { accessSync, constants, statSync } from "node:fs";

const enums: Record<string, readonly string[]> = {
  eventClass: ["recognized", "unknown", "malformed", "normalized"],
  error_code: [],
  error_category: [],
  error_type: [],
};
const errorCategories = [
  "authentication_error",
  "invalid_api_key",
  "unauthorized",
  "permission_denied",
  "rate_limit_exceeded",
  "rate_limit_error",
  "quota_exceeded",
  "insufficient_quota",
  "invalid_request_error",
  "context_length_exceeded",
  "server_error",
  "internal_error",
  "overloaded",
  "timeout",
  "connection_error",
  "model_not_found",
  "bad_request",
];
export const nativeType = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 80 &&
  /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}$/.test(v);
export function diagnosticMetadata(key: string, value: unknown): boolean {
  if (key === "diagnosticCategory")
    return (
      typeof value === "string" &&
      [
        "AUTHENTICATION",
        "AUTHORIZATION",
        "RATE_OR_USAGE_LIMIT",
        "MODEL_UNAVAILABLE",
        "PROVIDER_SERVER",
        "NETWORK_CONNECTION",
        "RESPONSE_STREAM_DISCONNECTED",
        "TIMEOUT",
        "FILESYSTEM_STATE_PERMISSION",
        "OTHER",
      ].includes(value)
    );
  if (key === "classificationSource")
    return value === "codex-exec-bounded-message-v1";
  if (key === "classifierVersionSupported") return typeof value === "boolean";
  if (key === "nativeType") return nativeType(value);
  if (key.startsWith("error_") && key in enums)
    return typeof value === "string" && errorCategories.includes(value);
  if (key === "eventClass") return enums.eventClass!.includes(value as string);
  if (["retry", "retryable", "structuredCategoryAvailable"].includes(key))
    return typeof value === "boolean";
  if (["http_status", "status_code", "messageDerivedHttpStatus"].includes(key))
    return (
      Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
    );
  if (["attempt", "retry_count", "messageBytes"].includes(key))
    return Number.isSafeInteger(value) && Number(value) >= 0;
  if (["messageHash", "providerHash", "modelHash"].includes(key))
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  return false;
}
export function pathEvidence(path: string | undefined) {
  const result = {
    exists: false,
    readable: false,
    writable: false,
    directory: false,
    mode: 0,
  };
  if (!path) return result;
  try {
    const s = statSync(path);
    result.exists = true;
    result.directory = s.isDirectory();
    result.mode = s.mode & 0o777;
  } catch {
    return result;
  }
  for (const [key, flag] of [
    ["readable", constants.R_OK],
    ["writable", constants.W_OK],
  ] as const)
    try {
      accessSync(path, flag);
      result[key] = true;
    } catch {
      /* No contents are read. */
    }
  return result;
}
export function environmentEvidence(
  parent: NodeJS.ProcessEnv,
  child: NodeJS.ProcessEnv,
) {
  return [
    "PATH",
    "LANG",
    "TZ",
    "HOME",
    "CODEX_HOME",
    "TMPDIR",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "GIT_DIR",
    "STIRPI_OPERATIONAL_FD",
  ].map((name) => ({
    name,
    present: parent[name] !== undefined,
    policy:
      child[name] === undefined
        ? "stripped"
        : child[name] === parent[name]
          ? "passed"
          : "overridden",
  }));
}
type RecordValue = Record<string, unknown>;
const object = (v: unknown): RecordValue =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as RecordValue) : {};
// Re-project untrusted adapter stderr, never spread it into persisted evidence.
export function adapterEvidence(stderr: string) {
  let v: RecordValue;
  try {
    v = object(JSON.parse(stderr));
  } catch {
    return undefined;
  }
  if (v.adapter !== "codex-m2-v1") return undefined;
  const result: RecordValue = { adapter: v.adapter };
  const code = object(v.failure).code;
  if (
    typeof code === "string" &&
    [
      "INVALID_CONFIGURATION",
      "INVALID_INPUT",
      "UNSUPPORTED_PROTOCOL_VERSION",
      "WORKSPACE_REQUIRED",
      "INVALID_WORKSPACE",
      "GIT_IDENTITY_CHANGED",
      "STATE_INSIDE_WORKSPACE",
      "INVALID_AUTH_FILE",
      "AGENT_UNAVAILABLE",
      "AGENT_LAUNCH_FAILED",
      "AGENT_WALL_TIME_EXHAUSTED",
      "AGENT_CANCELLED",
      "AGENT_OUTPUT_LIMIT",
      "AGENT_EXIT_FAILED",
      "INVALID_AGENT_RESPONSE",
      "ACTION_UNAVAILABLE",
      "ADAPTER_FAILED",
    ].includes(code)
  )
    result.failure = { code };
  if (Number.isSafeInteger(v.status)) result.status = v.status;
  if (
    ["SIGTERM", "SIGINT", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGPIPE"].includes(
      v.signal as string,
    )
  )
    result.signal = v.signal;
  if (
    typeof v.version === "string" &&
    /^codex-cli [\w.+-]{1,80}$/.test(v.version)
  )
    result.version = v.version;
  result.requestedModel =
    typeof v.model === "string" && /^gpt-[0-9][a-z0-9.-]{0,60}$/.test(v.model)
      ? v.model
      : null;
  result.requestedEffort = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ].includes(v.effort as string)
    ? v.effort
    : null;
  const d = object(v.diagnostics);
  result.eventTypes = Object.fromEntries(
    Object.entries(object(d.eventTypes))
      .filter(
        ([k, n]) => nativeType(k) && Number.isSafeInteger(n) && Number(n) >= 0,
      )
      .slice(0, 64),
  );
  result.counts = Object.fromEntries(
    Object.entries(object(d.counts)).filter(
      ([k, n]) =>
        ["recognized", "unknown", "malformed"].includes(k) &&
        Number.isSafeInteger(n) &&
        Number(n) >= 0,
    ),
  );
  if (nativeType(d.lastNativeType)) result.lastNativeType = d.lastNativeType;
  result.lifecycle = Object.fromEntries(
    Object.entries(object(d.lifecycle)).filter(
      ([k, s]) =>
        ["thread", "turn", "item"].includes(k) &&
        ["started", "updated", "completed", "failed"].includes(s as string),
    ),
  );
  const c = object(v.configuration);
  const safe: RecordValue = {};
  for (const key of ["executor", "auth", "config", "state", "placements"]) {
    safe[key] = Object.fromEntries(
      Object.entries(object(c[key])).filter(([k, value]) => {
        if (
          ["exists", "readable", "writable", "directory", "present"].includes(k)
        )
          return typeof value === "boolean";
        if (k === "mode")
          return (
            Number.isInteger(value) &&
            Number(value) >= 0 &&
            Number(value) <= 0o777
          );
        const allowed: Record<string, string[]> = {
          effort: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
          kind: ["explicit_file", "none"],
          policy: ["loaded", "ignored"],
          placement: ["system_temp", "configured_temp", "experiment_local"],
          HOME: ["adapter_state"],
          CODEX_HOME: ["adapter_state"],
          TMPDIR: ["adapter_state"],
        };
        if (k === "model")
          return (
            typeof value === "string" &&
            /^gpt-[0-9][a-z0-9.-]{0,60}$/.test(value)
          );
        return allowed[k]?.includes(value as string) ?? false;
      }),
    );
  }
  if (Array.isArray(c.environment))
    safe.environment = c.environment
      .map(object)
      .filter(
        (e) =>
          environmentEvidence({}, {}).some((v) => v.name === e.name) &&
          typeof e.present === "boolean" &&
          ["passed", "stripped", "overridden"].includes(e.policy as string),
      )
      .map((e) => ({ name: e.name, present: e.present, policy: e.policy }));
  if (Array.isArray(d.errors))
    result.errors = d.errors
      .slice(0, 32)
      .map((e) =>
        Object.fromEntries(
          Object.entries(object(e)).filter(([k, v]) =>
            diagnosticMetadata(k, v),
          ),
        ),
      );
  result.configuration = safe;
  return result;
}
