import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
export const nativeType = (v) =>
  typeof v === "string" &&
  /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}$/.test(v) &&
  v.length <= 80
    ? v
    : undefined;
const categories = new Set([
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
]);
export function errorFields(event) {
  const source =
    event.error && typeof event.error === "object" ? event.error : event;
  const result = {};
  for (const key of ["code", "category", "type"])
    if (categories.has(source[key])) result[`error_${key}`] = source[key];
  result.structuredCategoryAvailable = Object.keys(result).length > 0;
  for (const key of ["http_status", "status_code"])
    if (
      Number.isInteger(source[key]) &&
      source[key] >= 100 &&
      source[key] <= 599
    )
      result[key] = source[key];
  for (const key of ["retryable", "retry"])
    if (typeof source[key] === "boolean") result[key] = source[key];
  for (const key of ["attempt", "retry_count"])
    if (Number.isSafeInteger(source[key]) && source[key] >= 0)
      result[key] = source[key];
  // Identifiers are fingerprints: even an identifier-shaped credential cannot leak.
  for (const key of ["provider", "model"])
    if (
      typeof source[key] === "string" &&
      source[key].length <= 128 &&
      /^[a-zA-Z0-9_.-]+$/.test(source[key])
    )
      result[`${key}Hash`] = createHash("sha256")
        .update(source[key])
        .digest("hex");
  if (typeof source.message === "string") {
    result.messageBytes = Buffer.byteLength(source.message);
    result.messageHash = createHash("sha256")
      .update(source.message)
      .digest("hex");
  }
  return result;
}
export function permissions(path) {
  const result = { exists: false, readable: false, writable: false };
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
  ])
    try {
      accessSync(path, flag);
      result[key] = true;
    } catch {
      /* Metadata only. */
    }
  return result;
}
export function environmentEvidence(parent, child) {
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

export function statePlacement(path) {
  if (path.includes("/executor-home/") || path.endsWith("/executor-home"))
    return "experiment_local";
  if (
    ["/private/tmp", "/tmp", "/private/var/folders", "/var/folders"].some(
      (root) => path === root || path.startsWith(root + "/"),
    )
  )
    return "system_temp";
  return "configured_temp";
}
