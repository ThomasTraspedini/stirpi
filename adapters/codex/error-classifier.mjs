// Diagnostic-only rules for inspected build strings; see error-classifier.md.
export const diagnosticCategories = Object.freeze([
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
]);
export const classifierSource = "codex-exec-bounded-message-v1";
export const supportedVersion = "codex-cli 0.154.0-alpha.6.2";
const authentication = new Set([
  "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
  "Your access token could not be refreshed. Please log out and sign in again.",
]);
// StatusCode Display may include a canonical reason. No free-form reason phrases.
const reasons = new Map([
  [401, "Unauthorized"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [429, "Too Many Requests"],
  [500, "Internal Server Error"],
  [501, "Not Implemented"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
  [504, "Gateway Timeout"],
  [505, "HTTP Version Not Supported"],
]);
function httpStatus(message) {
  const match =
    /^(unexpected status |exceeded retry limit, last status: )([1-5][0-9]{2})(?: ([A-Za-z][A-Za-z ]*))?(: |$)/.exec(
      message,
    );
  if (!match) return undefined;
  const status = Number(match[2]);
  if (match[3] && reasons.get(status) !== match[3]) return undefined;
  // Unexpected-status formatter always separates the body with ': '.
  if (match[1] === "unexpected status " && match[4] !== ": ") return undefined;
  return status;
}
export function classifyErrorMessage(message, version) {
  const result = {
    diagnosticCategory: "OTHER",
    classificationSource: classifierSource,
    classifierVersionSupported: version === supportedVersion,
  };
  // No coercion, trimming, nested extraction or arbitrary number scanning.
  if (
    typeof message !== "string" ||
    version !== supportedVersion ||
    /[\r\n]/.test(message)
  )
    return result;
  const status = httpStatus(message);
  if (status !== undefined) {
    result.messageDerivedHttpStatus = status;
    result.diagnosticCategory =
      status === 401
        ? "AUTHENTICATION"
        : status === 403
          ? "AUTHORIZATION"
          : status === 429
            ? "RATE_OR_USAGE_LIMIT"
            : status >= 500
              ? "PROVIDER_SERVER"
              : "OTHER";
  } else if (authentication.has(message))
    result.diagnosticCategory = "AUTHENTICATION";
  else if (
    message === "You've hit your usage limit." ||
    /^You've hit your usage limit\. (?:Upgrade to Plus to continue using Codex \(https:\/\/chatgpt\.com\/explore\/plus\),|Visit https:\/\/chatgpt\.com\/codex\/settings\/usage to purchase more credits|To get more access now, send a request to your admin)/.test(
      message,
    ) ||
    /^rate limit exceeded: .+/.test(message)
  )
    result.diagnosticCategory = "RATE_OR_USAGE_LIMIT";
  else if (message === "server overloaded")
    result.diagnosticCategory = "PROVIDER_SERVER";
  else if (/^Connection failed: .+/.test(message))
    result.diagnosticCategory = "NETWORK_CONNECTION";
  else if (/^stream disconnected before completion: .+/.test(message))
    result.diagnosticCategory = "RESPONSE_STREAM_DISCONNECTED";
  else if (/^auth refresh request timed out after [0-9]{1,9}s$/.test(message))
    result.diagnosticCategory = "TIMEOUT";
  else if (
    /^Codex cannot access session files at .+ \(permission denied\)\. If sessions were created using sudo, fix ownership: sudo chown -R \$\(whoami\) .+$/.test(
      message,
    )
  )
    result.diagnosticCategory = "FILESYSTEM_STATE_PERMISSION";
  return result;
}
