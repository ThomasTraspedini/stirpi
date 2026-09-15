// Mechanical release helpers for D068-D072. None of these commands publishes,
// approves, or creates a candidate record; release facts must already exist.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, basename, relative, resolve } from "node:path";
import {
  parseAuthorityJson,
  closedAuthorityObject,
} from "../src/authority/json.ts";
import { readRepositoryFile } from "../src/authority/repository-file.ts";
import { validateEgressContracts } from "../src/verification/egress-policy.ts";
import { sameJson } from "../src/proxy-release/build-identity.ts";
import {
  validateBuildInput,
  readSourceTree,
  verifyBuilder,
} from "../src/proxy-release/build-authority.ts";
import {
  makeProvenance,
  verifyReleaseIdentityBindings,
} from "../src/proxy-release/release-identity.ts";
import {
  validateCandidateRecord,
  validateDescriptor,
} from "../src/proxy-release/candidate-schema.ts";
export { validateBuildInput, makeProvenance };

const sha = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hex = (digest) => digest.slice(7);
const digestRE = /^sha256:[a-f0-9]{64}$/;
const digestRefRE =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/;
const fail = (message) => {
  throw new Error(`proxy release: ${message}`);
};
const read = (path) => {
  const full = resolve(path);
  return readRepositoryFile(dirname(full), basename(full));
};
const json = (path) => parseAuthorityJson(read(path));
const write = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const requireKeys = (value, keys, label) =>
  closedAuthorityObject(value, keys, label);
const descriptor = (value) => {
  validateDescriptor(value);
  return true;
};
const contracts = (value) => {
  validateEgressContracts(value);
  return true;
};
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (
    i < 0 ||
    !args[i + 1] ||
    args.lastIndexOf(name) !== i ||
    args[i + 1].startsWith("--")
  )
    fail(`missing ${name}`);
  return args[i + 1];
};

export function makeSBOM(facts) {
  requireKeys(
    facts,
    [
      "repository",
      "manifestDigest",
      "release",
      "files",
      "modules",
      "generators",
    ],
    "image inventory",
  );
  if (
    !digestRE.test(facts.manifestDigest) ||
    !Array.isArray(facts.files) ||
    !Array.isArray(facts.modules) ||
    !Array.isArray(facts.generators)
  )
    fail("invalid image inventory identities");
  const containerRef = `container:${facts.repository}@${facts.manifestDigest}`;
  const files = facts.files.map((file) => ({
    type: "file",
    "bom-ref": `file:${file.path}`,
    name: file.path,
    hashes: [{ alg: "SHA-256", content: hex(file.sha256) }],
  }));
  if (
    facts.files.some(
      (file) =>
        typeof file.path !== "string" ||
        !file.path.startsWith("/") ||
        !digestRE.test(file.sha256),
    ) ||
    !facts.files.some((file) => file.path === "/stirpi-registry-egress-proxy")
  )
    fail("invalid shipped-file inventory");
  const modules = facts.modules.map((module) => ({
    type: "library",
    "bom-ref": `golang:${module.path}@${module.version}`,
    name: module.path,
    version: module.version,
    ...(module.purl ? { purl: module.purl } : {}),
  }));
  const components = [
    {
      type: "container",
      "bom-ref": containerRef,
      name: "stirpi-registry-egress-proxy",
      version: facts.release,
      hashes: [{ alg: "SHA-256", content: hex(facts.manifestDigest) }],
      externalReferences: [
        {
          type: "distribution",
          url: `${facts.repository}@${facts.manifestDigest}`,
        },
      ],
    },
    ...files,
    ...modules,
  ].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      lifecycles: [{ phase: "post-build" }],
      tools: {
        components: facts.generators.map((tool) => ({
          type: "application",
          name: tool.name,
          version: tool.version,
          hashes: [{ alg: "SHA-256", content: hex(tool.sha256) }],
        })),
      },
      component: components.find(
        (component) => component["bom-ref"] === containerRef,
      ),
    },
    components,
    dependencies: [
      {
        ref: containerRef,
        dependsOn: files.map((file) => file["bom-ref"]).sort(),
      },
      {
        ref: "file:/stirpi-registry-egress-proxy",
        dependsOn: modules.map((module) => module["bom-ref"]).sort(),
      },
    ],
    compositions: [{ aggregate: "complete", assemblies: [containerRef] }],
  };
}
export function makeAttachment(subject, payload, artifactType, mediaType) {
  if (
    !descriptor(subject) ||
    !Buffer.isBuffer(payload) ||
    !artifactType ||
    !mediaType
  )
    fail("invalid OCI attachment input");
  const config = Buffer.from("{}");
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType,
    config: {
      mediaType: "application/vnd.oci.empty.v1+json",
      digest: sha(config),
      size: config.length,
    },
    layers: [{ mediaType, digest: sha(payload), size: payload.length }],
    subject,
  };
}
function payloadAt(root, candidate, key) {
  const evidence = candidate[key];
  const path = resolve(root, evidence.path);
  if (!relative(root, path) || relative(root, path).startsWith(".."))
    fail("evidence path escapes root");
  const bytes = readRepositoryFile(root, evidence.path);
  if (sha(bytes) !== evidence.sha256 || bytes.length !== evidence.size)
    fail(`${key} exact bytes mismatch`);
  return { bytes, value: parseAuthorityJson(bytes), evidence };
}
export function verifyCandidate(root, candidatePath, ociDir, readinessPath) {
  const candidateBytes = read(candidatePath);
  const candidate = parseAuthorityJson(candidateBytes);
  const identity = validateCandidateRecord(candidate);
  if (relative(root, candidatePath) !== `${identity.directory}/candidate.json`)
    fail("candidate must use the fixed repository path");
  if (
    !contracts(candidate.contracts) ||
    !digestRefRE.test(candidate.oci.reference) ||
    candidate.oci.reference !==
      `${candidate.oci.repository}@${candidate.oci.manifest.digest}` ||
    !descriptor(candidate.oci.manifest) ||
    !descriptor(candidate.oci.config) ||
    !Array.isArray(candidate.oci.layers) ||
    candidate.oci.layers.length < 1 ||
    !digestRE.test(candidate.executable.sha256)
  )
    fail("candidate identity fields do not cross-bind");
  readSourceTree(root, identity.document);
  verifyBuilder(ociDir, identity.document);
  for (const [key, schema, mediaType] of [
    ["sbom", "CycloneDX-1.6", "application/vnd.cyclonedx+json; version=1.6"],
    ["provenance", "SLSA-Provenance-v1", "application/vnd.in-toto+json"],
  ]) {
    const evidence = candidate[key];
    if (
      evidence.schema !== schema ||
      evidence.mediaType !== mediaType ||
      !descriptor(evidence.ociArtifactManifest)
    )
      fail(`invalid ${key} evidence descriptor`);
  }
  const sbom = payloadAt(root, candidate, "sbom");
  const provenance = payloadAt(root, candidate, "provenance");
  const conformance = (() => {
    const e = candidate.conformance;
    const bytes = readRepositoryFile(root, e.path);
    if (sha(bytes) !== e.sha256) fail("conformance exact bytes mismatch");
    return parseAuthorityJson(bytes);
  })();
  if (
    sbom.value.bomFormat !== "CycloneDX" ||
    sbom.value.specVersion !== "1.6" ||
    provenance.value._type !== "https://in-toto.io/Statement/v1" ||
    provenance.value.predicateType !== "https://slsa.dev/provenance/v1"
  )
    fail("standard evidence schema mismatch");
  if (
    provenance.value.subject?.[0]?.name !== candidate.oci.repository ||
    provenance.value.subject?.[0]?.digest?.sha256 !==
      hex(candidate.oci.manifest.digest)
  )
    fail("provenance subject mismatch");
  if (
    conformance.result !== "passed" ||
    candidate.conformance.result !== conformance.result ||
    !sameJson(candidate.conformance.suite, conformance.suite) ||
    !sameJson(conformance.subject, {
      ociRepository: candidate.oci.repository,
      manifestDigest: candidate.oci.manifest.digest,
      platform: candidate.target,
    }) ||
    !contracts(conformance.contracts)
  )
    fail("conformance mismatch");
  const manifestBytes = read(
    resolve(ociDir, hex(candidate.oci.manifest.digest)),
  );
  if (
    sha(manifestBytes) !== candidate.oci.manifest.digest ||
    manifestBytes.length !== candidate.oci.manifest.size
  )
    fail("OCI manifest bytes mismatch");
  const manifest = parseAuthorityJson(manifestBytes);
  if (
    !sameJson(manifest.config, candidate.oci.config) ||
    !sameJson(manifest.layers, candidate.oci.layers)
  )
    fail("OCI manifest descriptors mismatch");
  const configBytes = read(resolve(ociDir, hex(candidate.oci.config.digest)));
  if (
    sha(configBytes) !== candidate.oci.config.digest ||
    configBytes.length !== candidate.oci.config.size
  )
    fail("OCI config bytes mismatch");
  const config = parseAuthorityJson(configBytes);
  const image = config.config ?? {};
  if (
    config.os !== candidate.target.os ||
    config.architecture !== candidate.target.architecture ||
    Object.hasOwn(config, "variant")
  )
    fail("OCI target platform mismatch");
  if (
    JSON.stringify(image.Entrypoint) !==
      JSON.stringify(["/stirpi-registry-egress-proxy"]) ||
    JSON.stringify(image.Cmd ?? []) !== "[]" ||
    image.WorkingDir !== "/" ||
    image.User !== "65532:65532" ||
    (image.Env ?? []).length ||
    (image.ExposedPorts && Object.keys(image.ExposedPorts).length) ||
    (image.Volumes && Object.keys(image.Volumes).length) ||
    image.StopSignal !== "SIGTERM" ||
    image.Healthcheck
  )
    fail("OCI configuration violates D068");
  const executable = read(
    resolve(ociDir, "rootfs/stirpi-registry-egress-proxy"),
  );
  if (sha(executable) !== candidate.executable.sha256)
    fail("executable bytes mismatch");
  verifyReleaseIdentityBindings(
    candidate,
    provenance.value,
    executable,
    json(readinessPath),
  );
  return {
    buildIdentity: identity.buildIdentity,
    candidateSha256: sha(candidateBytes),
    manifest: candidate.oci.manifest.digest,
    result: "valid",
  };
}
function main() {
  const command = args[0];
  const allowed = {
    "validate-build": ["--root", "--input", "--context", "--oci-dir"],
    sbom: ["--input", "--out"],
    provenance: ["--input", "--out"],
    "attachment-manifest": [
      "--subject",
      "--payload",
      "--artifact-type",
      "--media-type",
      "--out",
    ],
    "verify-candidate": ["--root", "--candidate", "--oci-dir", "--readiness"],
  }[command];
  if (
    !allowed ||
    args.length !== 1 + 2 * allowed.length ||
    args.slice(1).some((v, i) => i % 2 === 0 && !allowed.includes(v))
  )
    fail("unknown, duplicate, or missing command option");
  if (command === "validate-build")
    process.stdout.write(
      JSON.stringify(
        validateBuildInput(
          resolve(option("--root")),
          json(option("--input")),
          resolve(option("--context")),
          resolve(option("--oci-dir")),
        ),
      ) + "\n",
    );
  else if (command === "sbom")
    write(option("--out"), makeSBOM(json(option("--input"))));
  else if (command === "provenance")
    write(option("--out"), makeProvenance(json(option("--input"))));
  else if (command === "attachment-manifest")
    write(
      option("--out"),
      makeAttachment(
        json(option("--subject")),
        read(option("--payload")),
        option("--artifact-type"),
        option("--media-type"),
      ),
    );
  else if (command === "verify-candidate")
    process.stdout.write(
      JSON.stringify(
        verifyCandidate(
          resolve(option("--root")),
          resolve(option("--candidate")),
          resolve(option("--oci-dir")),
          resolve(option("--readiness")),
        ),
      ) + "\n",
    );
  else
    fail(
      "commands: validate-build, sbom, provenance, attachment-manifest, verify-candidate",
    );
}
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
