import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  makeAttachment,
  makeSBOM,
  verifyCandidate,
} from "../scripts/proxy-release.mjs";
import {
  deriveBuildIdentity,
  parseBuildIdentity,
  sha256,
} from "../src/proxy-release/build-identity.js";
import {
  readSourceTree,
  validateBuildInput,
  verifyBuilder,
} from "../src/proxy-release/build-authority.js";
import { executableBuildIdentity } from "../src/proxy-release/executable.js";
import { validateCandidateRecord } from "../src/proxy-release/candidate-schema.js";
import {
  candidateIdentity,
  makeProvenance,
  resolvedDependencies,
  verifyProvenanceIdentity,
  verifyReleaseIdentityBindings,
} from "../src/proxy-release/release-identity.js";
const digest = (char: string) => `sha256:${char.repeat(64)}`;
const golden = () =>
  parseBuildIdentity(
    readFileSync(
      new URL("./fixtures/build-identity-v1/golden-1.json", import.meta.url),
    ),
  );
// Minimal ELF fixture with a real Go string header and symbol. Distractor text
// models copied flags: only the variable selected by the symbol may be trusted.
function elf(identity: string, architecture = "arm64") {
  const bytes = Buffer.alloc(1024);
  bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(architecture === "amd64" ? 62 : 183, 18);
  bytes.writeBigUInt64LE(512n, 40);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(5, 60);
  const section = (
    i: number,
    type: number,
    address: number,
    offset: number,
    size: number,
    link = 0,
    entrySize = 0,
  ) => {
    const at = 512 + 64 * i;
    bytes.writeUInt32LE(type, at + 4);
    bytes.writeBigUInt64LE(type === 1 ? 2n : 0n, at + 8);
    bytes.writeBigUInt64LE(BigInt(address), at + 16);
    bytes.writeBigUInt64LE(BigInt(offset), at + 24);
    bytes.writeBigUInt64LE(BigInt(size), at + 32);
    bytes.writeUInt32LE(link, at + 40);
    bytes.writeBigUInt64LE(BigInt(entrySize), at + 56);
  };
  section(1, 1, 4096, 128, 128);
  section(2, 1, 8192, 256, 16);
  section(3, 3, 0, 300, 20);
  section(4, 2, 0, 336, 24, 3, 24);
  bytes.write(identity, 128);
  bytes.writeBigUInt64LE(4096n, 256);
  bytes.writeBigUInt64LE(71n, 264);
  bytes.write("\0main.buildIdentity\0", 300);
  bytes.writeUInt32LE(1, 336);
  bytes.writeBigUInt64LE(8192n, 344);
  bytes.writeBigUInt64LE(16n, 352);
  return bytes;
}
function evidence() {
  const g = golden();
  const { schemaVersion: _version, kind: _kind, ...fields } = g.document;
  void _version;
  void _kind;
  const executable = elf(g.buildIdentity);
  const candidate = {
    schemaVersion: 2,
    release: { name: "stirpi-registry-egress-proxy", version: "1.0.0" },
    ...fields,
    buildIdentity: g.buildIdentity,
    oci: {
      repository: "ghcr.io/stirpi/proxy",
      reference: `ghcr.io/stirpi/proxy@${digest("d")}`,
      manifest: {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: digest("d"),
        size: 42,
      },
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: digest("e"),
        size: 42,
      },
      layers: [
        {
          mediaType: "application/vnd.oci.image.layer.v1.tar",
          digest: digest("f"),
          size: 0,
        },
      ],
    },
    executable: {
      path: "/stirpi-registry-egress-proxy",
      sha256: sha256(executable),
    },
    sbom: {
      schema: "CycloneDX-1.6",
      path: "releases/registry-egress-proxy/1.0.0/linux-arm64/sbom.cdx.json",
      sha256: digest("f"),
      size: 42,
      mediaType: "application/vnd.cyclonedx+json; version=1.6",
      artifactType: "application/vnd.cyclonedx+json",
      ociRepository: "ghcr.io/stirpi/proxy",
      ociArtifactManifest: {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: digest("f"),
        size: 42,
      },
    },
    provenance: {
      schema: "SLSA-Provenance-v1",
      path: "releases/registry-egress-proxy/1.0.0/linux-arm64/provenance.intoto.json",
      sha256: digest("f"),
      size: 42,
      mediaType: "application/vnd.in-toto+json",
      artifactType: "application/vnd.in-toto+json",
      ociRepository: "ghcr.io/stirpi/proxy",
      ociArtifactManifest: {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: digest("f"),
        size: 42,
      },
    },
    conformance: {
      schemaVersion: 1,
      path: "releases/registry-egress-proxy/1.0.0/linux-arm64/conformance.json",
      sha256: digest("f"),
      suite: {
        version: 1,
        source: fields.source,
        definition: {
          path: "proxy/conformance-suite.json",
          sha256: digest("f"),
        },
      },
      result: "passed",
    },
  };
  const facts = {
    repository: candidate.oci.repository,
    manifestDigest: candidate.oci.manifest.digest,
    ...fields,
    buildIdentity: g.buildIdentity,
    releaseVersion: candidate.release.version,
    invocationId: "run-1",
    startedOn: "2026-01-01T00:00:00Z",
    finishedOn: "2026-01-01T00:01:00Z",
    resolvedDependencies: resolvedDependencies(g.document),
  };
  const provenance = makeProvenance(facts);
  const readiness = {
    addressClassifierTableSha256: digest("e"),
    addressPolicy: fields.contracts.addressPolicy,
    artifactContract: fields.contracts.artifact,
    attestationSchema: "stirpi.registry-egress-readiness/1",
    buildIdentity: g.buildIdentity,
    effectivePolicySha256: digest("f"),
    event: "ready",
    executableSha256: sha256(executable),
    launchChallenge: "a".repeat(64),
    listener: {
      address: "10.0.0.2",
      allowedClientAddress: "10.0.0.3",
      port: 3128,
    },
    policySchema: fields.contracts.policySchema,
    protocol: fields.contracts.protocol,
    resolverEndpoints: [{ address: "10.0.0.1", port: 53 }],
    resolverPolicy: fields.contracts.resolverPolicy,
    runtime: { uid: 65532, gid: 65532 },
  };
  return { g, candidate, facts, provenance, executable, readiness };
}
function set(value: unknown, path: string[], replacement: unknown) {
  let obj = value as Record<string, unknown>;
  for (const key of path.slice(0, -1))
    obj = obj[key] as Record<string, unknown>;
  obj[path.at(-1)!] = replacement;
}
test("schema 2 independently binds candidate, provenance v2, executable string, and readiness", () => {
  const e = evidence();
  assert.doesNotThrow(() => validateCandidateRecord(e.candidate));
  assert.equal(candidateIdentity(e.candidate).buildIdentity, e.g.buildIdentity);
  assert.doesNotThrow(() =>
    verifyReleaseIdentityBindings(
      e.candidate,
      e.provenance,
      e.executable,
      e.readiness,
    ),
  );
  assert.equal(
    executableBuildIdentity(e.executable, e.g.document.target),
    e.g.buildIdentity,
  );
  assert.equal(
    e.provenance.predicate.buildDefinition.buildType,
    "https://stirpi.dev/build-types/registry-egress-proxy/v2",
  );
  assert.notEqual(
    e.provenance.subject[0]!.digest.sha256,
    e.g.buildIdentity.slice(7),
  );
});
for (const [path, value] of [
  [["schemaVersion"], 1],
  [["buildIdentity"], digest("d")],
  [["source", "commit", "value"], "b".repeat(40)],
  [["buildDefinition", "sha256"], digest("d")],
  [["builderImage", "reference"], `ghcr.io/stirpi/other@${digest("c")}`],
  [["target", "architecture"], "amd64"],
  [["contracts", "artifact"], "other"],
  [["materials"], [{}]],
  [["buildParameters", "context"], "proxy"],
  [["unknown"], true],
] as [string[], unknown][])
  test(`candidate rejects ${path.join(".")}`, () => {
    const e = evidence();
    set(e.candidate, path, value);
    assert.throws(() => verifyProvenanceIdentity(e.candidate, e.provenance));
  });
for (const [path, value] of [
  [["subject"], []],
  [
    ["subject"],
    [
      {
        name: "ghcr.io/stirpi/proxy",
        digest: { sha256: golden().buildIdentity.slice(7) },
      },
    ],
  ],
  [
    ["predicate", "buildDefinition", "buildType"],
    "https://stirpi.dev/build-types/registry-egress-proxy/v1",
  ],
  ...[
    "source",
    "buildDefinition",
    "target",
    "buildParameters",
    "materials",
    "contracts",
  ].map((key) => [
    ["predicate", "buildDefinition", "externalParameters", key],
    {},
  ]),
  [
    ["predicate", "buildDefinition", "externalParameters", "releaseVersion"],
    "2.0.0",
  ],
  [
    [
      "predicate",
      "buildDefinition",
      "externalParameters",
      "arguments",
      "BUILD_IDENTITY",
    ],
    digest("d"),
  ],
  [
    [
      "predicate",
      "buildDefinition",
      "externalParameters",
      "arguments",
      "EXTRA",
    ],
    "x",
  ],
  [["predicate", "buildDefinition", "externalParameters", "unknown"], true],
  [["predicate", "buildDefinition", "internalParameters", "builderImage"], {}],
  [["predicate", "buildDefinition", "internalParameters", "unknown"], true],
  [["predicate", "buildDefinition", "resolvedDependencies"], []],
] as [string[], unknown][])
  test(`provenance rejects ${path.join(".")}`, () => {
    const e = evidence();
    set(e.provenance, path, value);
    assert.throws(() => verifyProvenanceIdentity(e.candidate, e.provenance));
  });
test("coordinated provenance forgery still disagrees with independently reconstructed candidate", () => {
  const e = evidence();
  e.facts.source.commit.value = "b".repeat(40);
  const g = deriveBuildIdentity({ ...e.g.document, source: e.facts.source });
  e.facts.buildIdentity = g.buildIdentity;
  e.facts.resolvedDependencies = resolvedDependencies(g.document);
  const forged = makeProvenance(e.facts);
  assert.throws(() => verifyProvenanceIdentity(e.candidate, forged));
});
test("post-build values never change BuildIdentityV1", () => {
  const e = evidence();
  e.facts.manifestDigest = digest("f");
  e.facts.releaseVersion = "9.0.0";
  e.facts.repository = "ghcr.io/stirpi/other";
  e.facts.invocationId = "other";
  const p = makeProvenance(e.facts);
  assert.equal(
    p.predicate.buildDefinition.externalParameters.arguments.BUILD_IDENTITY,
    e.g.buildIdentity,
  );
  assert.throws(() =>
    makeProvenance({ ...e.facts, buildIdentity: e.facts.manifestDigest }),
  );
});
for (const [path, value] of [
  [["buildIdentity"], digest("d")],
  [["executableSha256"], digest("d")],
  [["artifactContract"], "other"],
  [["unknown"], true],
] as [string[], unknown][])
  test(`readiness rejects ${path.join(".")}`, () => {
    const e = evidence();
    set(e.readiness, path, value);
    assert.throws(() =>
      verifyReleaseIdentityBindings(
        e.candidate,
        e.provenance,
        e.executable,
        e.readiness,
      ),
    );
  });
test("executable identity comes from ELF variable, not plausible digest strings or copied flags", () => {
  const e = evidence();
  const wrong = elf(digest("f"));
  wrong.write(e.g.buildIdentity, 850);
  e.candidate.executable.sha256 = sha256(wrong);
  e.readiness.executableSha256 = sha256(wrong);
  assert.throws(() =>
    verifyReleaseIdentityBindings(
      e.candidate,
      e.provenance,
      wrong,
      e.readiness,
    ),
  );
  for (const b of [
    Buffer.from(e.g.buildIdentity),
    e.executable.subarray(0, 300),
    elf(e.g.buildIdentity, "amd64"),
  ])
    assert.throws(() => executableBuildIdentity(b, e.g.document.target));
  const invalid = Buffer.from(e.executable);
  invalid.writeBigUInt64LE(0xffffffffffffffffn, 256);
  assert.throws(() => executableBuildIdentity(invalid, e.g.document.target));
});
test("build context uses exact commit blobs and resolved builder platform, never working overlays", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "stirpi-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "source");
  mkdirSync(join(root, "proxy"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  git("init");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "remote.origin.url", "https://github.com/example/stirpi");
  const definition = readFileSync(
    new URL("../proxy/build-definition.json", import.meta.url),
  );
  writeFileSync(join(root, "proxy/build-definition.json"), definition);
  writeFileSync(join(root, "proxy/Dockerfile"), "FROM scratch AS final\n");
  writeFileSync(join(root, "tracked"), "committed\n");
  writeFileSync(join(root, ".gitattributes"), "tracked export-ignore\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  const document = golden().document;
  document.source.commit.value = git("rev-parse", "HEAD");
  document.buildDefinition.sha256 = sha256(definition);
  const oci = join(dir, "oci");
  mkdirSync(oci);
  const config = Buffer.from(JSON.stringify(document.target));
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: sha256(config),
        size: config.length,
      },
      layers: [],
    }),
  );
  writeFileSync(join(oci, sha256(config).slice(7)), config);
  writeFileSync(join(oci, sha256(manifest).slice(7)), manifest);
  document.builderImage.manifestDigest = sha256(manifest);
  document.builderImage.reference = `ghcr.io/stirpi/proxy-builder@${sha256(manifest)}`;
  writeFileSync(join(root, "tracked"), "dirty\n");
  writeFileSync(join(root, "untracked"), "never included");
  writeFileSync(join(root, "proxy/build-definition.json"), "{}\n");
  const out = join(dir, "context");
  const validated = validateBuildInput(root, document, out, oci);
  assert.equal(
    validated.buildIdentity,
    deriveBuildIdentity(document).buildIdentity,
  );
  assert.equal(readFileSync(join(out, "tracked"), "utf8"), "committed\n");
  assert.deepEqual(
    readFileSync(join(out, "proxy/build-definition.json")),
    definition,
  );
  assert.throws(() => readFileSync(join(out, "untracked")));
  assert.throws(() => validateBuildInput(root, document, out, oci));

  const e = evidence();
  Object.assign(e.candidate, {
    ...document,
    schemaVersion: 2,
    buildIdentity: validated.buildIdentity,
  });
  delete (e.candidate as unknown as Record<string, unknown>).kind;
  const binary = elf(validated.buildIdentity);
  e.candidate.executable.sha256 = sha256(binary);
  mkdirSync(join(oci, "rootfs"));
  writeFileSync(join(oci, "rootfs/stirpi-registry-egress-proxy"), binary);
  const imageConfig = Buffer.from(
    JSON.stringify({
      ...document.target,
      config: {
        Entrypoint: ["/stirpi-registry-egress-proxy"],
        Cmd: [],
        WorkingDir: "/",
        User: "65532:65532",
        StopSignal: "SIGTERM",
      },
    }),
  );
  writeFileSync(join(oci, sha256(imageConfig).slice(7)), imageConfig);
  e.candidate.oci.config.digest = sha256(imageConfig);
  e.candidate.oci.config.size = imageConfig.length;
  const imageManifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: e.candidate.oci.manifest.mediaType,
      config: e.candidate.oci.config,
      layers: e.candidate.oci.layers,
    }),
  );
  writeFileSync(join(oci, sha256(imageManifest).slice(7)), imageManifest);
  e.candidate.oci.manifest.digest = sha256(imageManifest);
  e.candidate.oci.manifest.size = imageManifest.length;
  e.candidate.oci.reference = `${e.candidate.oci.repository}@${sha256(imageManifest)}`;
  const {
    schemaVersion: ignoredVersion,
    kind: ignoredKind,
    ...prebuild
  } = document;
  void ignoredVersion;
  void ignoredKind;
  const provenance = makeProvenance({
    ...e.facts,
    ...prebuild,
    buildIdentity: validated.buildIdentity,
    manifestDigest: sha256(imageManifest),
    resolvedDependencies: resolvedDependencies(document),
  });
  const payloads = {
    sbom: makeSBOM({
      repository: e.candidate.oci.repository,
      manifestDigest: sha256(imageManifest),
      release: "1.0.0",
      files: [{ path: e.candidate.executable.path, sha256: sha256(binary) }],
      modules: [],
      generators: [],
    }),
    provenance,
  };
  for (const key of ["sbom", "provenance"] as const) {
    const bytes = Buffer.from(JSON.stringify(payloads[key]));
    const field = e.candidate[key];
    field.sha256 = sha256(bytes);
    field.size = bytes.length;
    mkdirSync(join(root, field.path, ".."), { recursive: true });
    writeFileSync(join(root, field.path), bytes);
  }
  const conf = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      suite: e.candidate.conformance.suite,
      subject: {
        ociRepository: e.candidate.oci.repository,
        manifestDigest: sha256(imageManifest),
        platform: document.target,
      },
      contracts: document.contracts,
      result: "passed",
    }),
  );
  e.candidate.conformance.sha256 = sha256(conf);
  writeFileSync(join(root, e.candidate.conformance.path), conf);
  const candidatePath = join(
    root,
    "releases/registry-egress-proxy/1.0.0/linux-arm64/candidate.json",
  );
  writeFileSync(candidatePath, JSON.stringify(e.candidate));
  const readinessPath = join(dir, "readiness.json");
  writeFileSync(
    readinessPath,
    JSON.stringify({
      ...e.readiness,
      buildIdentity: validated.buildIdentity,
      executableSha256: sha256(binary),
    }),
  );
  assert.equal(
    verifyCandidate(root, candidatePath, oci, readinessPath).buildIdentity,
    validated.buildIdentity,
  );
  writeFileSync(
    readinessPath,
    JSON.stringify({
      ...e.readiness,
      buildIdentity: e.candidate.oci.manifest.digest,
      executableSha256: sha256(binary),
    }),
  );
  assert.throws(() => verifyCandidate(root, candidatePath, oci, readinessPath));
  writeFileSync(
    readinessPath,
    JSON.stringify({
      ...e.readiness,
      buildIdentity: validated.buildIdentity,
      executableSha256: sha256(binary),
    }),
  );
  const saved = readFileSync(join(root, e.candidate.provenance.path));
  writeFileSync(
    join(root, e.candidate.provenance.path),
    Buffer.concat([saved, Buffer.from(" ")]),
  );
  assert.throws(() => verifyCandidate(root, candidatePath, oci, readinessPath));
  writeFileSync(join(root, e.candidate.provenance.path), saved);
  const exactCandidate = readFileSync(candidatePath);
  writeFileSync(
    candidatePath,
    exactCandidate
      .toString()
      .replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'),
  );
  assert.throws(() => verifyCandidate(root, candidatePath, oci, readinessPath));
  writeFileSync(candidatePath, exactCandidate);

  const bad = structuredClone(document);
  bad.buildDefinition.sha256 = digest("a");
  assert.throws(() => validateBuildInput(root, bad, join(dir, "bad"), oci));
  bad.buildDefinition = document.buildDefinition;
  bad.target.architecture = "amd64";
  bad.builderImage.platform.architecture = "amd64";
  assert.throws(() => verifyBuilder(oci, bad));
  const missing = structuredClone(document);
  missing.source.commit.value = "f".repeat(40);
  assert.throws(() => readSourceTree(root, missing));
  symlinkSync(join(oci, sha256(config).slice(7)), join(oci, "link"));
  rmSync(join(oci, sha256(config).slice(7)));
  symlinkSync(join(oci, "link"), join(oci, sha256(config).slice(7)));
  assert.throws(() => verifyBuilder(oci, document));
});
test("retained SBOM and OCI attachment helpers keep standard evidence shapes", () => {
  const sbom = makeSBOM({
    repository: "ghcr.io/stirpi/proxy",
    manifestDigest: digest("c"),
    release: "1.0.0",
    files: [{ path: "/stirpi-registry-egress-proxy", sha256: digest("d") }],
    modules: [],
    generators: [],
  });
  assert.equal(sbom.specVersion, "1.6");
  const attachment = makeAttachment(
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: digest("c"),
      size: 12,
    },
    Buffer.from("{}"),
    "application/vnd.cyclonedx+json",
    "application/vnd.cyclonedx+json; version=1.6",
  );
  assert.equal(attachment.layers.length, 1);
});

for (const path of [
  ["release"],
  ["oci"],
  ["oci", "manifest"],
  ["oci", "config"],
  ["executable"],
  ["sbom"],
  ["provenance"],
  ["conformance"],
  ["conformance", "suite"],
  ["conformance", "suite", "definition"],
])
  test(`candidate closed schema rejects extra member in ${path.join(".")}`, () => {
    const e = evidence();
    set(e.candidate, [...path, "unexpected"], true);
    assert.throws(() => validateCandidateRecord(e.candidate));
  });
for (const [path, value] of [
  [["release", "version"], "../1.0.0"],
  [["executable", "path"], "/other"],
  [["oci", "reference"], "ghcr.io/stirpi/proxy:latest"],
  [["oci", "manifest", "size"], -1],
  [["oci", "manifest", "mediaType"], "application/vnd.oci.image.index.v1+json"],
  [["sbom", "path"], "../sbom.json"],
  [["provenance", "path"], "releases/registry-egress-proxy/other.json"],
  [["provenance", "ociRepository"], "ghcr.io/other"],
  [["conformance", "path"], "/tmp/conformance.json"],
  [["conformance", "schemaVersion"], 2],
] as [string[], unknown][])
  test(`candidate schema rejects ${path.join(".")}`, () => {
    const e = evidence();
    set(e.candidate, path, value);
    assert.throws(() => validateCandidateRecord(e.candidate));
  });
