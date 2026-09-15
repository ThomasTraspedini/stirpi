import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  closedAuthorityObject,
  parseAuthorityJson,
  type AuthorityJson,
} from "../authority/json.js";
import { repositoryPath } from "../authority/repository-file.js";
import {
  jcs,
  validateEgressContracts,
  type EgressContracts,
} from "../verification/egress-policy.js";

export const BUILD_TYPE =
  "https://stirpi.dev/build-types/registry-egress-proxy/v2";
export const BUILD_IDENTITY_KIND =
  "stirpi.registry-egress-proxy-build-identity/1";
export const BUILD_IDENTITY_DOMAIN =
  "stirpi.registry-egress-proxy.build-identity.v1\0";
export const sha256 = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const digestPattern = /^sha256:[0-9a-f]{64}$/;
export const referencePattern =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
export interface Platform {
  os: "linux";
  architecture: "amd64" | "arm64";
}
export interface BuildIdentityDocument {
  schemaVersion: 1;
  kind: typeof BUILD_IDENTITY_KIND;
  source: {
    repository: string;
    commit: { algorithm: "sha1" | "sha256"; value: string };
  };
  buildDefinition: { path: "proxy/build-definition.json"; sha256: string };
  builderImage: {
    reference: string;
    manifestDigest: string;
    platform: Platform;
  };
  target: Platform;
  buildParameters: {
    context: ".";
    dockerfile: "proxy/Dockerfile";
    targetStage: "final";
    additionalBuildArguments: [];
  };
  materials: [];
  contracts: EgressContracts;
}
export const identityFields = [
  "source",
  "buildDefinition",
  "builderImage",
  "target",
  "buildParameters",
  "materials",
  "contracts",
] as const;
export function sameJson(a: unknown, b: unknown): boolean {
  return jcs(a as AuthorityJson) === jcs(b as AuthorityJson);
}
export function requireDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !digestPattern.test(value))
    throw new Error("Build identity: invalid SHA-256");
}
export function validatePlatform(value: unknown): Platform {
  const p = closedAuthorityObject(
    value,
    ["os", "architecture"],
    "Build platform",
  );
  if (
    p.os !== "linux" ||
    (p.architecture !== "amd64" && p.architecture !== "arm64")
  )
    throw new Error("Build identity: unsupported platform");
  return p as unknown as Platform;
}
export function canonicalSourceRepository(value: unknown): string {
  const m =
    typeof value === "string" &&
    value.length <= 2048 &&
    /^https:\/\/([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::([1-9][0-9]{0,4}))?\/([A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)$/.exec(
      value,
    );
  if (
    !m ||
    isIP(m[1]!) ||
    m[1]!.split(".").every((label) => /^(?:[0-9]+|0x[0-9a-f]+)$/.test(label)) ||
    m[1]!
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    (m[2] && (Number(m[2]) > 65535 || Number(m[2]) === 443))
  )
    throw new Error("Build identity: noncanonical HTTPS repository");
  repositoryPath(m[3]);
  return value as string;
}
function ascii(value: unknown): void {
  if (typeof value === "string" && /[^\x00-\x7f]/.test(value))
    throw new Error("Build identity: non-ASCII string");
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      ascii(key);
      ascii(item);
    }
}
export function validateBuildIdentity(value: unknown): BuildIdentityDocument {
  ascii(value);
  const d = closedAuthorityObject(
    value,
    ["schemaVersion", "kind", ...identityFields],
    "BuildIdentityV1",
  );
  if (d.schemaVersion !== 1 || d.kind !== BUILD_IDENTITY_KIND)
    throw new Error("Build identity: unsupported version or kind");
  const source = closedAuthorityObject(
    d.source,
    ["repository", "commit"],
    "Build source",
  );
  canonicalSourceRepository(source.repository);
  const oid = closedAuthorityObject(
    source.commit,
    ["algorithm", "value"],
    "Build commit",
  );
  if (
    typeof oid.value !== "string" ||
    !(
      oid.algorithm === "sha1"
        ? /^[0-9a-f]{40}$/
        : oid.algorithm === "sha256"
          ? /^[0-9a-f]{64}$/
          : /a^/
    ).test(oid.value)
  )
    throw new Error("Build identity: invalid full Git OID");
  const definition = closedAuthorityObject(
    d.buildDefinition,
    ["path", "sha256"],
    "Build definition",
  );
  if (repositoryPath(definition.path) !== "proxy/build-definition.json")
    throw new Error("Build identity: invalid definition path");
  requireDigest(definition.sha256);
  const builder = closedAuthorityObject(
    d.builderImage,
    ["reference", "manifestDigest", "platform"],
    "Builder image",
  );
  requireDigest(builder.manifestDigest);
  if (
    typeof builder.reference !== "string" ||
    builder.reference.length > 327 ||
    !referencePattern.test(builder.reference) ||
    !builder.reference.endsWith(`@${builder.manifestDigest}`)
  )
    throw new Error("Build identity: builder reference/manifest mismatch");
  if (!sameJson(validatePlatform(builder.platform), validatePlatform(d.target)))
    throw new Error("Build identity: builder/target platform mismatch");
  const parameters = closedAuthorityObject(
    d.buildParameters,
    ["context", "dockerfile", "targetStage", "additionalBuildArguments"],
    "Build parameters",
  );
  if (
    parameters.context !== "." ||
    parameters.dockerfile !== "proxy/Dockerfile" ||
    parameters.targetStage !== "final" ||
    !Array.isArray(parameters.additionalBuildArguments) ||
    parameters.additionalBuildArguments.length ||
    !Array.isArray(d.materials) ||
    d.materials.length
  )
    throw new Error("Build identity: unsupported parameters or materials");
  validateEgressContracts(d.contracts);
  return structuredClone(value) as BuildIdentityDocument;
}
export function projectBuildIdentity(
  fields: Record<string, unknown>,
): BuildIdentityDocument {
  return validateBuildIdentity({
    schemaVersion: 1,
    kind: BUILD_IDENTITY_KIND,
    ...Object.fromEntries(identityFields.map((key) => [key, fields[key]])),
  });
}
export function deriveBuildIdentity(value: unknown) {
  const document = validateBuildIdentity(value);
  const canonicalDocumentBytes = Buffer.from(
    jcs(document as unknown as AuthorityJson),
    "utf8",
  );
  const preimage = Buffer.concat([
    Buffer.from(BUILD_IDENTITY_DOMAIN, "ascii"),
    canonicalDocumentBytes,
  ]);
  return {
    document,
    canonicalDocumentBytes,
    preimage,
    buildIdentity: sha256(preimage),
  };
}
export const parseBuildIdentity = (bytes: Buffer | string) =>
  deriveBuildIdentity(parseAuthorityJson(bytes));
