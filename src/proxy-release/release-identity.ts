import {
  closedAuthorityObject,
  type AuthorityJson,
} from "../authority/json.js";
import {
  EGRESS_READINESS_SCHEMA,
  validateEgressContracts,
} from "../verification/egress-policy.js";
import {
  BUILD_TYPE,
  deriveBuildIdentity,
  identityFields,
  projectBuildIdentity,
  requireDigest,
  sameJson,
  sha256,
  type BuildIdentityDocument,
} from "./build-identity.js";
import { executableBuildIdentity } from "./executable.js";

export function candidateIdentity(value: unknown) {
  const c = closedAuthorityObject(
    value,
    [
      "schemaVersion",
      "release",
      ...identityFields,
      "buildIdentity",
      "oci",
      "executable",
      "sbom",
      "provenance",
      "conformance",
    ],
    "Candidate",
  );
  if (c.schemaVersion !== 2) throw new Error("Candidate schema 2 required");
  const derived = deriveBuildIdentity(projectBuildIdentity(c));
  if (c.buildIdentity !== derived.buildIdentity)
    throw new Error("Candidate BuildIdentityV1 mismatch");
  return derived;
}
/** SLSA dependencies are observations of the three pre-build authorities.
 * Their profile representation follows SLSA ResourceDescriptor URI/digest fields.
 */
export function resolvedDependencies(d: BuildIdentityDocument) {
  return [
    {
      uri: d.source.repository,
      digest: { [d.source.commit.algorithm]: d.source.commit.value },
    },
    {
      uri: d.buildDefinition.path,
      digest: { sha256: d.buildDefinition.sha256.slice(7) },
    },
    {
      uri: d.builderImage.reference,
      digest: { sha256: d.builderImage.manifestDigest.slice(7) },
    },
  ];
}
export function makeProvenance(value: unknown) {
  const f = closedAuthorityObject(
    value,
    [
      "repository",
      "manifestDigest",
      ...identityFields,
      "buildIdentity",
      "releaseVersion",
      "invocationId",
      "startedOn",
      "finishedOn",
      "resolvedDependencies",
    ],
    "Build facts",
  );
  const derived = deriveBuildIdentity(projectBuildIdentity(f));
  requireDigest(f.manifestDigest);
  if (
    f.buildIdentity !== derived.buildIdentity ||
    !sameJson(f.resolvedDependencies, resolvedDependencies(derived.document))
  )
    throw new Error("Provenance pre-build facts mismatch");
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: f.repository, digest: { sha256: f.manifestDigest.slice(7) } },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: BUILD_TYPE,
        externalParameters: {
          ...Object.fromEntries(
            identityFields
              .filter((key) => key !== "builderImage")
              .map((key) => [key, f[key]]),
          ),
          releaseVersion: f.releaseVersion,
          arguments: { BUILD_IDENTITY: derived.buildIdentity },
        },
        internalParameters: { builderImage: f.builderImage },
        resolvedDependencies: f.resolvedDependencies,
      },
      runDetails: {
        builder: { id: "https://stirpi.dev/builders/registry-egress-proxy/v1" },
        metadata: {
          invocationId: f.invocationId,
          startedOn: f.startedOn,
          finishedOn: f.finishedOn,
        },
        byproducts: [],
      },
    },
  };
}
/** Reconstruct from provenance's own fields before comparing to the candidate.
 * The manifest subject is deliberately checked independently from build identity.
 */
export function verifyProvenanceIdentity(
  candidate: unknown,
  provenance: unknown,
) {
  const expected = candidateIdentity(candidate);
  const c = candidate as Record<string, unknown>;
  const release = closedAuthorityObject(
    c.release,
    ["name", "version"],
    "Candidate release",
  );
  const oci = closedAuthorityObject(
    c.oci,
    ["repository", "reference", "manifest", "config", "layers"],
    "Candidate OCI",
  );
  const manifest = closedAuthorityObject(
    oci.manifest,
    ["mediaType", "digest", "size"],
    "Candidate manifest",
  );
  const p = closedAuthorityObject(
    provenance,
    ["_type", "subject", "predicateType", "predicate"],
    "Provenance",
  );
  if (
    p._type !== "https://in-toto.io/Statement/v1" ||
    p.predicateType !== "https://slsa.dev/provenance/v1" ||
    !sameJson(p.subject, [
      {
        name: oci.repository,
        digest: { sha256: String(manifest.digest).slice(7) },
      },
    ])
  )
    throw new Error("Provenance statement or subject mismatch");
  const predicate = closedAuthorityObject(
    p.predicate,
    ["buildDefinition", "runDetails"],
    "Provenance predicate",
  );
  const definition = closedAuthorityObject(
    predicate.buildDefinition,
    [
      "buildType",
      "externalParameters",
      "internalParameters",
      "resolvedDependencies",
    ],
    "Provenance definition",
  );
  if (definition.buildType !== BUILD_TYPE)
    throw new Error("Provenance build type v2 required");
  const external = closedAuthorityObject(
    definition.externalParameters,
    [
      ...identityFields.filter((key) => key !== "builderImage"),
      "releaseVersion",
      "arguments",
    ],
    "Provenance external parameters",
  );
  const internal = closedAuthorityObject(
    definition.internalParameters,
    ["builderImage"],
    "Provenance internal parameters",
  );
  const args = closedAuthorityObject(
    external.arguments,
    ["BUILD_IDENTITY"],
    "Provenance arguments",
  );
  const actual = deriveBuildIdentity(
    projectBuildIdentity({ ...external, builderImage: internal.builderImage }),
  );
  if (
    actual.buildIdentity !== args.BUILD_IDENTITY ||
    actual.buildIdentity !== expected.buildIdentity ||
    !sameJson(actual.document, expected.document) ||
    external.releaseVersion !== release.version ||
    !sameJson(
      definition.resolvedDependencies,
      resolvedDependencies(actual.document),
    )
  )
    throw new Error(
      "Provenance/candidate build identity cross-binding mismatch",
    );
  const run = closedAuthorityObject(
    predicate.runDetails,
    ["builder", "metadata", "byproducts"],
    "Provenance run details",
  );
  const builder = closedAuthorityObject(
    run.builder,
    ["id"],
    "Provenance builder",
  );
  const metadata = closedAuthorityObject(
    run.metadata,
    ["invocationId", "startedOn", "finishedOn"],
    "Provenance metadata",
  );
  if (
    builder.id !== "https://stirpi.dev/builders/registry-egress-proxy/v1" ||
    typeof metadata.invocationId !== "string" ||
    !metadata.invocationId ||
    [metadata.startedOn, metadata.finishedOn].some(
      (v) =>
        typeof v !== "string" ||
        !v.endsWith("Z") ||
        !Number.isFinite(Date.parse(v)),
    ) ||
    !Array.isArray(run.byproducts)
  )
    throw new Error("Invalid provenance run details");
  return expected;
}
/** Readiness is an independently retained launch observation, not a new
 * candidate field. Runtime topology/challenge attestation remains with D068.
 */
export function verifyReleaseIdentityBindings(
  candidate: unknown,
  provenance: unknown,
  executable: Buffer,
  readiness: unknown,
) {
  const derived = verifyProvenanceIdentity(candidate, provenance);
  const c = candidate as Record<string, unknown>;
  const descriptor = closedAuthorityObject(
    c.executable,
    ["path", "sha256"],
    "Executable descriptor",
  );
  if (
    descriptor.path !== "/stirpi-registry-egress-proxy" ||
    descriptor.sha256 !== sha256(executable) ||
    executableBuildIdentity(executable, derived.document.target) !==
      derived.buildIdentity
  )
    throw new Error("Executable build identity or bytes mismatch");
  const r = closedAuthorityObject(
    readiness,
    [
      "addressClassifierTableSha256",
      "addressPolicy",
      "artifactContract",
      "attestationSchema",
      "buildIdentity",
      "effectivePolicySha256",
      "event",
      "executableSha256",
      "launchChallenge",
      "listener",
      "policySchema",
      "protocol",
      "resolverEndpoints",
      "resolverPolicy",
      "runtime",
    ],
    "Readiness",
  );
  validateEgressContracts({
    artifact: r.artifactContract,
    protocol: r.protocol,
    policySchema: r.policySchema,
    resolverPolicy: r.resolverPolicy,
    addressPolicy: r.addressPolicy,
  });
  if (
    r.attestationSchema !== EGRESS_READINESS_SCHEMA ||
    r.event !== "ready" ||
    r.buildIdentity !== derived.buildIdentity ||
    r.executableSha256 !== descriptor.sha256
  )
    throw new Error("Readiness build identity cross-binding mismatch");
  return {
    buildIdentity: derived.buildIdentity,
    executableSha256: descriptor.sha256,
  } as AuthorityJson;
}
