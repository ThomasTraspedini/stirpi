import { closedAuthorityObject } from "../authority/json.js";
import { repositoryPath } from "../authority/repository-file.js";
import {
  deriveBuildIdentity,
  referencePattern,
  requireDigest,
} from "./build-identity.js";
import { candidateIdentity } from "./release-identity.js";

export const IMAGE_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export function validateDescriptor(value: unknown, mediaType?: string) {
  const d = closedAuthorityObject(
    value,
    ["mediaType", "digest", "size"],
    "OCI descriptor",
  );
  requireDigest(d.digest);
  if (
    typeof d.mediaType !== "string" ||
    !d.mediaType.length ||
    d.mediaType.length > 255 ||
    (mediaType && d.mediaType !== mediaType) ||
    !Number.isSafeInteger(d.size) ||
    (d.size as number) < 0
  )
    throw new Error("Invalid OCI descriptor");
  return d as { mediaType: string; digest: string; size: number };
}
/** Schema 2 retains the closed D069 factual record and adds only D072 fields. */
export function validateCandidateRecord(value: unknown) {
  const identity = candidateIdentity(value);
  const c = value as Record<string, unknown>;
  const release = closedAuthorityObject(
    c.release,
    ["name", "version"],
    "Candidate release",
  );
  if (
    release.name !== "stirpi-registry-egress-proxy" ||
    typeof release.version !== "string" ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      release.version,
    )
  )
    throw new Error("Invalid candidate release");
  const oci = closedAuthorityObject(
    c.oci,
    ["repository", "reference", "manifest", "config", "layers"],
    "Candidate OCI",
  );
  const manifest = validateDescriptor(oci.manifest, IMAGE_MANIFEST);
  validateDescriptor(oci.config, "application/vnd.oci.image.config.v1+json");
  if (
    typeof oci.repository !== "string" ||
    oci.repository.length > 255 ||
    !referencePattern.test(`${oci.repository}@${manifest.digest}`) ||
    oci.reference !== `${oci.repository}@${manifest.digest}` ||
    !Array.isArray(oci.layers) ||
    !oci.layers.length ||
    oci.layers.length > 8
  )
    throw new Error("Invalid candidate OCI identity");
  for (const layer of oci.layers)
    if (
      ![
        "application/vnd.oci.image.layer.v1.tar",
        "application/vnd.oci.image.layer.v1.tar+gzip",
        "application/vnd.oci.image.layer.v1.tar+zstd",
      ].includes(validateDescriptor(layer).mediaType)
    )
      throw new Error("Unsupported OCI layer");
  const executable = closedAuthorityObject(
    c.executable,
    ["path", "sha256"],
    "Candidate executable",
  );
  requireDigest(executable.sha256);
  if (executable.path !== "/stirpi-registry-egress-proxy")
    throw new Error("Invalid executable path");
  const directory = `releases/registry-egress-proxy/${release.version}/${identity.document.target.os}-${identity.document.target.architecture}`;
  for (const [key, file, schema, mediaType, artifactType] of [
    [
      "sbom",
      "sbom.cdx.json",
      "CycloneDX-1.6",
      "application/vnd.cyclonedx+json; version=1.6",
      "application/vnd.cyclonedx+json",
    ],
    [
      "provenance",
      "provenance.intoto.json",
      "SLSA-Provenance-v1",
      "application/vnd.in-toto+json",
      "application/vnd.in-toto+json",
    ],
  ] as const) {
    const e = closedAuthorityObject(
      c[key],
      [
        "schema",
        "path",
        "sha256",
        "size",
        "mediaType",
        "artifactType",
        "ociRepository",
        "ociArtifactManifest",
      ],
      `Candidate ${key}`,
    );
    requireDigest(e.sha256);
    validateDescriptor(e.ociArtifactManifest, IMAGE_MANIFEST);
    if (
      repositoryPath(e.path) !== `${directory}/${file}` ||
      e.schema !== schema ||
      e.mediaType !== mediaType ||
      e.artifactType !== artifactType ||
      e.ociRepository !== oci.repository ||
      !Number.isSafeInteger(e.size) ||
      (e.size as number) < 1 ||
      (e.size as number) > 16777216
    )
      throw new Error(`Invalid ${key} evidence`);
  }
  const conformance = closedAuthorityObject(
    c.conformance,
    ["schemaVersion", "path", "sha256", "suite", "result"],
    "Candidate conformance",
  );
  requireDigest(conformance.sha256);
  if (
    conformance.schemaVersion !== 1 ||
    repositoryPath(conformance.path) !== `${directory}/conformance.json` ||
    !["passed", "failed", "error"].includes(String(conformance.result))
  )
    throw new Error("Invalid conformance summary");
  const suite = closedAuthorityObject(
    conformance.suite,
    ["version", "source", "definition"],
    "Conformance suite",
  );
  if (!Number.isSafeInteger(suite.version) || (suite.version as number) < 1)
    throw new Error("Invalid suite version");
  deriveBuildIdentity({ ...identity.document, source: suite.source });
  const definition = closedAuthorityObject(
    suite.definition,
    ["path", "sha256"],
    "Suite definition",
  );
  requireDigest(definition.sha256);
  repositoryPath(definition.path);
  return { ...identity, directory };
}
