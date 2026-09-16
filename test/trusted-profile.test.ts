import { git, initRepository } from "../src/experiments/inputs.js";
import { validatePreregisteredProfile } from "../src/experiments/profile-authority.js";
import {
  runExperiment,
  runExperimentLocally,
  type RunOptions,
} from "../src/experiments/run.js";
import assert from "node:assert/strict";
import {
  existsSync,
  realpathSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  effectivePolicyBytes,
  effectivePolicySha256,
  registryEgressPolicy,
  registryEgressPolicySha256,
  jcs,
  EGRESS_CONTRACTS,
  bundleIdentity,
  createEgressPolicyFile,
  dependencyBundleKey,
  dependencyPreparationPlan,
  DockerDependencyPreparationService,
  DependencyPreparationError,
  loadTrustedProfile,
  parseEgressPolicyFile,
  parseVerificationProfile,
  removeSealedDependencyBundle,
  sealDependencyBundle,
  sha256,
  validateProfilePin,
  validateReplayIdentity,
  type DockerDependencyCommandResult,
  type LoadedProfile,
  type ResolvedImageIdentity,
} from "../src/verification/index.js";
import {
  preregisteredOptions,
  schema2VerificationProfile,
} from "../src/experiments/preregistration.js";

const ref = (name: string, char: string) =>
  `registry.example.invalid/stirpi/${name}@sha256:${char.repeat(64)}`;
const limits = {
  wallTimeMs: 1,
  cpu: 1,
  memoryBytes: 1,
  pids: 1,
  fileDescriptors: 1,
  outputBytesPerStream: 1,
};
function document() {
  return {
    schemaVersion: 2,
    id: "node-linux",
    version: 1,
    platform: { os: "linux", architecture: "arm64" },
    images: {
      verifier: { reference: ref("verifier", "a") },
      dependencyPreparation: { reference: ref("preparer", "b") },
      egressProxy: {
        reference: ref("proxy", "c"),
        contracts: { ...EGRESS_CONTRACTS },
      },
    },
    dependencies: {
      kind: "node-modules",
      inputs: { manifest: "package.json", lockfile: "package-lock.json" },
      installPolicy: {
        id: "npm-ci-v1",
        executable: "/usr/local/bin/npm",
        argv: ["ci", "--ignore-scripts"],
        lifecycleScripts: "deny",
        network: {
          mode: "registry-only",
          boundary: "connect-proxy-v1",
          proxyPolicy: "registry-connect-exact-v1",
          origins: ["https://registry.npmjs.org:443"],
          destinationPorts: [443],
        },
      },
      limits,
      isolation: {
        readOnlyRootFilesystem: true,
        preparerUser: "65532:65532",
        dropCapabilities: "all",
        noNewPrivileges: true,
        dockerSocket: "absent",
        hostFilesystem: "absent",
        candidateRuntimeSecrets: "absent",
        environment: "fixed-dependency-preparation-v1",
        writablePaths: ["/output", "/tmp"],
      },
      bundle: {
        exportPath: "node_modules",
        targetPath: "/workspace/node_modules",
        delivery: "read-only-mount",
      },
    },
    toolchain: [
      {
        id: "node",
        imageRole: "verifier",
        executable: "/usr/local/bin/node",
        versionArgv: ["--version"],
        expectedStdout: "v1",
      },
    ],
    operations: [
      {
        id: "node.test",
        publicInvocation: {
          executable: "npm",
          argv: ["test"],
          workingDirectory: "candidate",
        },
        executable: "/usr/local/bin/npm",
        argv: ["test"],
        cwd: "/workspace",
        workspaceView: "sanitized-git-worktree-v1",
        dependencyBundle: "required",
        database: "none",
        limits,
      },
    ],
    workspace: {
      maxFiles: 1,
      maxBytes: 1,
      rejectSpecialFiles: true,
      rejectEscapingSymlinks: true,
      acceptCandidateNodeModules: false,
    },
    isolation: {
      network: "none",
      readOnlyRootFilesystem: true,
      candidateUser: "65532:65532",
      dropCapabilities: "all",
      noNewPrivileges: true,
      dockerSocket: "absent",
      hostFilesystem: "absent",
      privateStirpiState: "absent",
      privateEvaluatorMaterial: "absent",
      environment: "fixed-minimal-v1",
      writablePaths: ["/workspace", "/tmp"],
    },
  };
}
test("strict trusted profile hashes exact bytes and rejects mutable/duplicate authority", () => {
  const valid = document();
  const bytes = Buffer.from(JSON.stringify(valid));
  const profile = parseVerificationProfile(bytes);
  assert.equal(profile.id, "node-linux");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "stirpi-profile-"));
  try {
    mkdirSync(join(root, "verification-profiles"));
    const path = join(root, "verification-profiles", "p.json");
    writeFileSync(path, bytes);
    const loaded = loadTrustedProfile(root, "verification-profiles/p.json");
    assert.equal(
      validateProfilePin(root, { ...loaded.identity, path: loaded.path })
        .identity.sha256,
      loaded.identity.sha256,
    );
    writeFileSync(path, Buffer.concat([bytes, Buffer.from("\n")]));
    assert.notEqual(
      loadTrustedProfile(root, "verification-profiles/p.json").identity.sha256,
      loaded.identity.sha256,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.throws(
    () => parseVerificationProfile(JSON.stringify({ ...valid, extra: true })),
    /unknown root/,
  );
  assert.throws(
    () =>
      parseVerificationProfile(
        JSON.stringify({
          ...valid,
          images: { ...valid.images, verifier: { reference: "node:latest" } },
        }),
      ),
    /digest reference/,
  );
  assert.throws(
    () =>
      parseVerificationProfile(
        JSON.stringify({
          ...valid,
          operations: [valid.operations[0], valid.operations[0]],
        }),
      ),
    /duplicate verification ID/,
  );
});
test("bundle keys and sealed provenance are deterministic trusted inputs", () => {
  const profile = parseVerificationProfile(JSON.stringify(document()));
  const a = dependencyBundleKey(
    profile,
    Buffer.from("{}"),
    Buffer.from("lock"),
    "c".repeat(64),
  );
  const b = dependencyBundleKey(
    profile,
    Buffer.from("{}"),
    Buffer.from("lock"),
    "c".repeat(64),
  );
  assert.deepEqual(a, b);
  assert.notDeepEqual(
    a,
    dependencyBundleKey(
      profile,
      Buffer.from("x"),
      Buffer.from("lock"),
      "c".repeat(64),
    ),
  );
  const plan = dependencyPreparationPlan(
    profile,
    "package.json",
    "package-lock.json",
  );
  assert.equal(plan.noHostNodeFallback, true);
  assert.deepEqual(plan.command.argv, ["ci", "--ignore-scripts"]);
  const root = mkdtempSync(join(realpathSync(tmpdir()), "stirpi-bundle-"));
  let sealed: string | undefined;
  try {
    const modules = join(root, "node_modules");
    mkdirSync(modules);
    writeFileSync(join(modules, "safe.js"), "export {}\n");
    const identity = bundleIdentity(a, modules);
    const provenance = sealDependencyBundle(
      join(root, "store"),
      identity,
      modules,
    );
    sealed = identity.keySha256;
    assert.equal(provenance.immutable, true);
    validateReplayIdentity({
      profile: {
        id: profile.id,
        version: profile.version,
        path: "verification-profiles/p.json",
        sha256: "d".repeat(64),
      },
      bundle: provenance,
      images: [
        {
          role: "verifier",
          requestedReference: profile.images.verifier.reference,
          resolvedPlatformManifestDigest: "e".repeat(64),
          imageConfigDigest: "f".repeat(64),
          runtimeImageId: "runtime",
          os: "linux",
          architecture: "arm64",
          rootfsDiffIds: ["x"],
        },
      ],
      candidateWorkspaceSha256: "a".repeat(64),
      operationId: "node.test",
    });
  } finally {
    if (sealed) removeSealedDependencyBundle(join(root, "store"), sealed);
    rmSync(root, { recursive: true, force: true });
  }
});
test("schema-2 profile pin is exact while historical documents have no implied profile", () => {
  assert.deepEqual(
    schema2VerificationProfile({
      id: "node-linux",
      version: 1,
      path: "verification-profiles/p.json",
      sha256: "a".repeat(64),
    }),
    {
      id: "node-linux",
      version: 1,
      path: "verification-profiles/p.json",
      sha256: "a".repeat(64),
    },
  );
  assert.throws(
    () =>
      schema2VerificationProfile({
        id: "node-linux",
        version: 1,
        path: "../p",
        sha256: "a".repeat(64),
      }),
    /invalid/,
  );
});
test("D068 policy bytes are canonical, bounded, exact-host, and launch-bound", () => {
  const bytes = createEgressPolicyFile(
    [{ host: "registry.npmjs.org", port: 443 }],
    {
      allowedClientAddress: "172.30.0.3",
      listenerAddress: "172.30.0.2",
      challenge: "a".repeat(64),
    },
  );
  const parsed = parseEgressPolicyFile(bytes);
  assert.equal(
    parsed.policy.allowedDestinations[0]?.host,
    "registry.npmjs.org",
  );
  assert.match(parsed.policySha256, /^sha256:[a-f0-9]{64}$/);
  assert.throws(
    () =>
      createEgressPolicyFile([{ host: "registry.npmjs.org.", port: 443 }], {
        allowedClientAddress: "172.30.0.3",
        listenerAddress: "172.30.0.2",
        challenge: "a".repeat(64),
      }),
    /invalid hostname/,
  );
  assert.throws(
    () => parseEgressPolicyFile(Buffer.concat([bytes, Buffer.from(" ")])),
    /noncanonical bytes/,
  );
});

function loaded(): LoadedProfile {
  const bytes = Buffer.from(JSON.stringify(document()));
  return {
    profile: parseVerificationProfile(bytes),
    path: "verification-profiles/p.json",
    bytes,
    identity: { id: "node-linux", version: 1, sha256: sha256(bytes) },
    images: {},
  };
}
function resolved(profile: LoadedProfile): ResolvedImageIdentity {
  return {
    role: "dependencyPreparation",
    requestedReference: profile.profile.images.dependencyPreparation.reference,
    resolvedPlatformManifestDigest: "c".repeat(64),
    imageConfigDigest: "d".repeat(64),
    runtimeImageId: "image",
    os: "linux",
    architecture: "arm64",
    rootfsDiffIds: ["layer"],
  };
}
function resolvedProxy(profile: LoadedProfile): ResolvedImageIdentity {
  return {
    ...resolved(profile),
    role: "egressProxy",
    requestedReference: profile.profile.images.egressProxy!.reference,
  };
}
test("dependency preparation owns image, policy, registry network, inputs, and read-only consumption", () => {
  const profile = loaded();
  const root = mkdtempSync(join(realpathSync(tmpdir()), "stirpi-preparer-"));
  const store = mkdtempSync(
    join(realpathSync(tmpdir()), "stirpi-preparer-store-"),
  );
  const calls: string[][] = [];
  try {
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}');
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "candidate.js"), "untrusted");
    const command = (
      args: readonly string[],
    ): DockerDependencyCommandResult => {
      calls.push([...args]);
      if (args[0] === "inspect" && args[1]?.endsWith("-proxy"))
        return {
          status: 0,
          stdout: `${String(args[1]).replace(/-proxy$/, "-internal")} ${String(args[1]).replace(/-proxy$/, "-outbound")}`,
        };
      if (args[0] === "inspect" && args[1]?.endsWith("-preparer"))
        return {
          status: 0,
          stdout: String(args[1]).replace(/-preparer$/, "-internal"),
        };
      if (
        args[0] === "cp" &&
        String(args[1]).includes(":/output/node_modules")
      ) {
        mkdirSync(join(String(args[2]), "node_modules"));
        writeFileSync(
          join(String(args[2]), "node_modules", "from-preparer.js"),
          "trusted",
        );
      }
      return { status: 0 };
    };
    const prepared = new DockerDependencyPreparationService(command).prepare(
      profile,
      root,
      store,
      resolved(profile),
      resolvedProxy(profile),
    );
    const install = calls.find(
      (call) =>
        call[0] === "create" && call.includes("npm_config_ignore_scripts=true"),
    )!;
    assert.ok(
      install.includes(profile.profile.images.dependencyPreparation.reference),
    );
    assert.ok(install.some((x) => x.includes("-internal")));
    assert.ok(install.includes("--read-only"));
    assert.ok(install.includes("--cap-drop"));
    assert.ok(install.includes("npm_config_ignore_scripts=true"));
    assert.equal(
      calls.some((call) => call.includes("npm") && call[0] !== "run"),
      false,
    );
    assert.equal(
      calls.some((call) =>
        call.some((value) => value.includes("candidate.js")),
      ),
      false,
    );
    assert.ok(prepared.provenance.identity.fileCount > 0);
    assert.ok(prepared.readOnlyMount.join(" ").includes("readonly"));
    assert.ok(
      prepared.readOnlyMount.join(" ").includes("/workspace/node_modules"),
    );
    assert.ok(calls.some((call) => call.join(" ").includes("volume rm -f")));
    removeSealedDependencyBundle(store, prepared.provenance.identity.keySha256);
    assert.equal(
      existsSync(join(store, prepared.provenance.identity.keySha256)),
      false,
    );
  } finally {
    for (const entry of readdirSync(store))
      if (/^[a-f0-9]{64}$/.test(entry))
        removeSealedDependencyBundle(store, entry);
    rmSync(root, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});
test("dependency preparation reports failures distinctly and always cleans up", () => {
  const profile = loaded();
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "stirpi-preparer-failure-"),
  );
  const calls: string[][] = [];
  try {
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "package-lock.json"), "{}");
    const command = (
      args: readonly string[],
    ): DockerDependencyCommandResult => {
      calls.push([...args]);
      if (args[0] === "inspect" && args[1]?.endsWith("-proxy"))
        return {
          status: 0,
          stdout: `${String(args[1]).replace(/-proxy$/, "-internal")} ${String(args[1]).replace(/-proxy$/, "-outbound")}`,
        };
      if (args[0] === "inspect" && args[1]?.endsWith("-preparer"))
        return {
          status: 0,
          stdout: String(args[1]).replace(/-preparer$/, "-internal"),
        };
      return {
        status: args[0] === "start" && args.includes("-a") ? 1 : 0,
        stderr: "registry denied",
      };
    };
    assert.throws(
      () =>
        new DockerDependencyPreparationService(command).prepare(
          profile,
          root,
          join(root, "store"),
          resolved(profile),
          resolvedProxy(profile),
        ),
      (error: unknown) =>
        error instanceof DependencyPreparationError &&
        error.code === "DEPENDENCY_REGISTRY_INSTALL_FAILED",
    );
    assert.ok(calls.some((call) => call.join(" ").includes("volume rm -f")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("dependency preparation distinguishes image, launch, and missing-output failures", () => {
  const profile = loaded();
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "stirpi-preparer-taxonomy-"),
  );
  const fails =
    (predicate: (args: readonly string[]) => boolean) =>
    (args: readonly string[]): DockerDependencyCommandResult => ({
      status: predicate(args) ? 1 : 0,
      stderr: "failed",
    });
  try {
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "package-lock.json"), "{}");
    const expect = (
      command: (args: readonly string[]) => DockerDependencyCommandResult,
      store: string,
      code: string,
    ) =>
      assert.throws(
        () =>
          new DockerDependencyPreparationService((args) => {
            if (args[0] === "inspect" && args[1]?.endsWith("-proxy"))
              return {
                status: 0,
                stdout: `${String(args[1]).replace(/-proxy$/, "-internal")} ${String(args[1]).replace(/-proxy$/, "-outbound")}`,
              };
            if (args[0] === "inspect" && args[1]?.endsWith("-preparer"))
              return {
                status: 0,
                stdout: String(args[1]).replace(/-preparer$/, "-internal"),
              };
            return command(args);
          }).prepare(
            profile,
            root,
            store,
            resolved(profile),
            resolvedProxy(profile),
          ),
        (error: unknown) =>
          error instanceof DependencyPreparationError && error.code === code,
      );
    expect(
      fails((args) => args[0] === "image"),
      join(root, "store-image"),
      "DEPENDENCY_PROXY_IMAGE_UNAVAILABLE",
    );
    expect(
      fails((args) => args[0] === "volume" && args[1] === "create"),
      join(root, "store-launch"),
      "DEPENDENCY_NETWORK_CREATE_FAILED",
    );
    expect(
      fails(
        (args) =>
          args[0] === "cp" && String(args[1]).includes(":/output/node_modules"),
      ),
      join(root, "store-output"),
      "DEPENDENCY_BUNDLE_OUTPUT_MISSING",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("replay identity validation does not invoke dependency preparation", () => {
  validateReplayIdentity({
    profile: {
      id: "node-linux",
      version: 1,
      path: "verification-profiles/p.json",
      sha256: "a".repeat(64),
    },
    bundle: null,
    images: [
      {
        role: "verifier",
        requestedReference:
          "registry.example.invalid/stirpi/verifier@sha256:" + "a".repeat(64),
        resolvedPlatformManifestDigest: "b".repeat(64),
        imageConfigDigest: "c".repeat(64),
        runtimeImageId: "image",
        os: "linux",
        architecture: "arm64",
        rootfsDiffIds: ["layer"],
      },
    ],
    candidateWorkspaceSha256: "d".repeat(64),
    operationId: "node.test",
  });
});

function mutateAuthority(value: object, path: string[], replacement?: unknown) {
  let parent = value as Record<string, unknown>;
  for (const key of path.slice(0, -1))
    parent = parent[key] as Record<string, unknown>;
  const key = path.at(-1)!;
  if (replacement === undefined) delete parent[key];
  else parent[key] = replacement;
}

test("live profile has one closed contracts object and no legacy schema or resolver", () => {
  const mutations: [string[], unknown?][] = [
    [["schemaVersion"], 1],
    [["images", "egressProxy"]],
    [["images", "egressProxy", "contracts"]],
    ...Object.keys(EGRESS_CONTRACTS).flatMap(
      (key) =>
        [
          [["images", "egressProxy", "contracts", key]],
          [["images", "egressProxy", "contracts", key], "unsupported"],
        ] as [string[], unknown?][],
    ),
    [["images", "egressProxy", "contracts", "extra"], true],
    [["images", "egressProxy", "artifactContract"], EGRESS_CONTRACTS.artifact],
    [
      ["dependencies", "installPolicy", "network", "resolverPolicy"],
      "proxy-resolve-public-once-v1",
    ],
    [
      ["dependencies", "installPolicy", "network", "addressPolicy"],
      EGRESS_CONTRACTS.addressPolicy,
    ],
    [
      ["dependencies", "installPolicy", "network", "proxyPolicy"],
      EGRESS_CONTRACTS.protocol,
    ],
    [["dependencies", "installPolicy", "network", "boundary"]],
    [["dependencies", "inputs", "manifest"], "./package.json"],
    [["dependencies", "inputs", "manifest"], "dir\\package.json"],
    [["operations", "0", "executable"], "/usr/../bin/npm"],
    [["platform", "architecture"], "aarch64"],
    [["platform", "os"], "darwin"],
    [["images", "postgres"], { reference: ref("pg", "d") }],
    [
      ["images", "verifier", "reference"],
      "registry.example/stirpi/../verifier@sha256:" + "a".repeat(64),
    ],
  ];
  for (const [path, replacement] of mutations) {
    const value = document();
    mutateAuthority(value, path, replacement);
    assert.throws(() => parseVerificationProfile(JSON.stringify(value)));
  }
  const value = document();
  const bytes = JSON.stringify(value);
  for (const invalid of [
    bytes.replace('"schemaVersion":2', '"schemaVersion":1,"schemaVersion":2'),
    bytes.replace('"version":1', '"version":1,"\\u0076ersion":1'),
    bytes.replace('"v1"', '"\\ud800"'),
    bytes.replace('"wallTimeMs":1', '"wallTimeMs":1.0000000000000001'),
    "\uFEFF" + bytes,
    bytes + "{}",
    Buffer.concat([
      Buffer.from(bytes.slice(0, -1)),
      Buffer.from([0xff]),
      Buffer.from("}"),
    ]),
  ])
    assert.throws(() => parseVerificationProfile(invalid), /Authority JSON/);
});
test("profile origins reject noncanonical, numeric, IDN, ambiguous, and duplicate authority", () => {
  const hosts = [
    "127.0.0.1",
    "127.1",
    "2130706433",
    "0177.0.0.1",
    "0x7f000001",
    "0x7f.0.0.1",
    "[::1]",
    "123.456",
    "xn--bcher-kva.example",
    "bücher.example",
    "reg_istry.example",
    "registry.example.",
    "a..example",
    "-a.example",
    "a-.example",
    "a".repeat(64) + ".example",
    Array(5).fill("a".repeat(63)).join("."),
  ];
  const origins = [
    ...hosts.map((host) => `https://${host}:443`),
    "https://REGISTRY.npmjs.org:443",
    "https://registry.npmjs.org",
    "https://registry.npmjs.org:443/",
    "HTTPS://registry.npmjs.org:443",
    "https://registry.npmjs.org:0443",
    "https://registry.npmjs.org:444",
    "https://registry.npmjs.org:443?",
    "https://registry.npmjs.org:443#",
    "https://user@registry.npmjs.org:443",
    "https://%72egistry.npmjs.org:443",
    " https://registry.npmjs.org:443",
    "https://registry.npmjs.org:443\n",
  ];
  for (const origin of origins) {
    const value = document();
    value.dependencies.installPolicy.network.origins = [origin];
    assert.throws(
      () => parseVerificationProfile(JSON.stringify(value)),
      undefined,
      origin,
    );
  }
  for (const origins of [
    [],
    ["https://a.example:443", "https://a.example:443"],
    ["https://b.example:443", "https://a.example:443"],
    Array.from(
      { length: 33 },
      (_, i) => `https://a${String(i).padStart(2, "0")}.example:443`,
    ),
  ]) {
    const value = document();
    value.dependencies.installPolicy.network.origins = origins;
    assert.throws(() => parseVerificationProfile(JSON.stringify(value)));
  }
  for (const ports of [[], [80], [443, 443], [443, 8443]]) {
    const value = document();
    value.dependencies.installPolicy.network.destinationPorts = ports;
    assert.throws(() => parseVerificationProfile(JSON.stringify(value)));
  }
});

test("profile, bundle, and launch policy share the exact EffectivePolicyV1 golden bytes and digest", () => {
  const profile = parseVerificationProfile(JSON.stringify(document()));
  const policy = registryEgressPolicy(profile);
  const canonical =
    '{"policy":{"addressPolicy":"stirpi.public-address/1","allowedDestinations":[{"host":"registry.npmjs.org","port":443}],"protocol":"stirpi.connect-only/1","resolverPolicy":"stirpi.resolve-once/1"},"policySchema":"stirpi.registry-egress-policy/1"}';
  const digest =
    "sha256:32d6fdcdacc4576c5d0dbc184230114559749d1bd79569e3abad56cdb086b809";
  assert.equal(effectivePolicyBytes(policy).toString(), canonical);
  assert.equal(effectivePolicyBytes(policy).length, 244);
  assert.equal(effectivePolicySha256(policy), digest);
  assert.equal(registryEgressPolicySha256(profile), digest);
  assert.equal(
    dependencyBundleKey(
      profile,
      Buffer.from("{}"),
      Buffer.from("{}"),
      "a".repeat(64),
    ).registryEgressPolicySha256,
    digest,
  );
  const launches = [
    {
      allowedClientAddress: "172.30.0.3",
      listenerAddress: "172.30.0.2",
      challenge: "a".repeat(64),
    },
    {
      allowedClientAddress: "10.0.0.3",
      listenerAddress: "10.0.0.2",
      challenge: "b".repeat(64),
    },
  ].map((launch) =>
    createEgressPolicyFile(policy.policy.allowedDestinations, launch),
  );
  assert.notDeepEqual(launches[0], launches[1]);
  for (const bytes of launches)
    assert.equal(parseEgressPolicyFile(bytes).policySha256, digest);
  const reordered = {
    policy: {
      resolverPolicy: policy.policy.resolverPolicy,
      protocol: policy.policy.protocol,
      allowedDestinations: policy.policy.allowedDestinations,
      addressPolicy: policy.policy.addressPolicy,
    },
    policySchema: policy.policySchema,
  };
  assert.equal(effectivePolicySha256(reordered), digest);
  profile.dependencies.installPolicy.network.origins = [
    "https://another.example:443",
  ];
  assert.notEqual(registryEgressPolicySha256(profile), digest);
});
test("policy parser rejects unknown fields at every level and noncanonical authority bytes", () => {
  const bytes = createEgressPolicyFile(
    [{ host: "registry.npmjs.org", port: 443 }],
    {
      allowedClientAddress: "172.30.0.3",
      listenerAddress: "172.30.0.2",
      challenge: "a".repeat(64),
    },
  );
  const mutations: [string[], unknown][] = [
    [["extra"], 1],
    [["launch", "extra"], 1],
    [["policy", "extra"], 1],
    [["policy", "allowedDestinations", "0", "extra"], 1],
    [["policy", "allowedDestinations", "0", "host"], "REGISTRY.npmjs.org"],
    [["policy", "allowedDestinations", "0", "port"], 80],
    [["policy", "resolverPolicy"], "unsupported"],
    [["policySha256"], "sha256:" + "0".repeat(64)],
    [["launch", "allowedClientAddress"], "172.030.0.3"],
  ];
  for (const [path, replacement] of mutations) {
    const value = JSON.parse(bytes.toString());
    mutateAuthority(value, path, replacement);
    assert.throws(() => parseEgressPolicyFile(Buffer.from(jcs(value) + "\n")));
  }
  for (const invalid of [
    Buffer.from("\uFEFF" + bytes),
    Buffer.from(
      bytes.toString().replace('"port":443', '"port":443,"port":443'),
    ),
    Buffer.from(bytes.toString().replace('"port":443', '"port":443.0')),
    Buffer.from(
      bytes.toString().replace('"host":', '"host": "\\ud800", "host":'),
    ),
    Buffer.from(bytes.toString().replace('"host":', '"\\u0068ost":')),
    Buffer.from(bytes.toString().replace("{", "{ ")),
    Buffer.concat([bytes, Buffer.from("{}\n")]),
  ])
    assert.throws(() => parseEgressPolicyFile(invalid));
});

function profileCheckout() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "stirpi-profile-pin-"));
  const checkout = join(root, "checkout");
  initRepository(checkout);
  const path = "verification-profiles/p.json";
  mkdirSync(join(checkout, "verification-profiles"));
  const bytes = Buffer.from(JSON.stringify(document()) + "\n");
  writeFileSync(join(checkout, path), bytes);
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "Profile authority fixture");
  const commit = git(checkout, "rev-parse", "HEAD");
  const pin = { id: "node-linux", version: 1, path, sha256: sha256(bytes) };
  const pilot = {
    schemaVersion: 2,
    id: "fixture",
    class: "pilot",
    testcase: "fixture",
    condition: "T",
    stirpiCommit: commit,
    verificationProfile: pin,
    hiddenEvaluationDuringRun: false,
    limits: { maxSteps: 0 },
  };
  return {
    root,
    checkout,
    path,
    bytes,
    pin,
    pilot,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("schema-2 preregistration binds every profile field and the clean runtime commit before executor probes", () => {
  const f = profileCheckout();
  const cwd = process.cwd();
  try {
    process.chdir(f.checkout);
    const registration = join(f.root, "pilot.json");
    const output = join(f.root, "output");
    const options = {
      preregistration: registration,
      condition: "T",
      verificationMode: "none",
      executor: { executable: "/nonexistent-milestone1-executor" },
      output,
    } as RunOptions;
    const invalid = [
      { ...f.pilot, verificationProfile: undefined },
      { ...f.pilot, stirpiCommit: undefined },
      { ...f.pilot, stirpiCommit: "HEAD" },
      { ...f.pilot, stirpiCommit: "0".repeat(40) },
      ...[
        { ...f.pin, id: "wrong" },
        { ...f.pin, version: 2 },
        { ...f.pin, sha256: "b".repeat(64) },
        { ...f.pin, path: "verification-profiles/missing.json" },
        { ...f.pin, path: "verification-profiles/./p.json" },
        { ...f.pin, path: "verification-profiles\\p.json" },
        { ...f.pin, schemaVersion: 2 },
      ].map((verificationProfile) => ({ ...f.pilot, verificationProfile })),
    ];
    for (const pilot of invalid) {
      writeFileSync(registration, JSON.stringify(pilot));
      assert.throws(
        () => preregisteredOptions(options, "fixture"),
        (error) => error instanceof Error && !/executor/.test(error.message),
      );
      assert.equal(existsSync(output), false);
    }
    writeFileSync(registration, JSON.stringify(f.pilot));
    const valid = preregisteredOptions(
      { ...options, executor: { executable: process.execPath } },
      "fixture",
    );
    assert.deepEqual(
      valid.evidence!.preregistration.verificationProfile,
      f.pin,
    );
    writeFileSync(join(f.checkout, "untracked"), "dirty");
    assert.throws(
      () => preregisteredOptions(options, "fixture"),
      /checkout dirty/,
    );
    rmSync(join(f.checkout, "untracked"));
    writeFileSync(
      join(f.checkout, f.path),
      Buffer.concat([f.bytes, Buffer.from("\n")]),
    );
    assert.throws(
      () => preregisteredOptions(options, "fixture"),
      /checkout dirty/,
    );
    // Git's skip-worktree flag cannot conceal profile bytes from the blob check.
    git(f.checkout, "update-index", "--skip-worktree", f.path);
    const overlay = {
      ...f.pilot,
      verificationProfile: {
        ...f.pin,
        sha256: sha256(readFileSync(join(f.checkout, f.path))),
      },
    };
    assert.throws(
      () => validatePreregisteredProfile(overlay, f.checkout),
      /bytes differ/,
    );
  } finally {
    process.chdir(cwd);
    f.close();
  }
});
test("local schema-2 failures precede output creation and all executor activity; historical schema 1 needs no profile", async () => {
  const f = profileCheckout();
  const cwd = process.cwd();
  try {
    process.chdir(f.checkout);
    const task = Buffer.from("fixture task");
    writeFileSync(join(f.root, "task.md"), task);
    const manifest = join(f.root, "manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        id: "fixture",
        sourceRepository: "fixture/repo",
        sourceCommit: "a".repeat(40),
        taskFile: "task.md",
        taskSha256: sha256(task),
      }),
    );
    const preregistration = join(f.root, "pilot.json");
    const output = join(f.root, "output");
    const options = {
      preregistration,
      manifest,
      output,
      condition: "T",
      verificationMode: "none",
      executor: { executable: "/nonexistent-milestone1-executor" },
    } as RunOptions;
    for (const invalid of [
      { ...f.pilot, stirpiCommit: undefined },
      { ...f.pilot, verificationProfile: { ...f.pin, sha256: "a".repeat(64) } },
      { ...f.pilot, verificationProfile: undefined },
    ]) {
      writeFileSync(preregistration, JSON.stringify(invalid));
      await assert.rejects(
        runExperimentLocally(options),
        (error) => error instanceof Error && !/executor/.test(error.message),
      );
      assert.equal(existsSync(output), false);
    }
    const historical = Object.fromEntries(
      Object.entries(f.pilot).filter(
        ([key]) =>
          !["schemaVersion", "verificationProfile", "stirpiCommit"].includes(
            key,
          ),
      ),
    );
    writeFileSync(preregistration, JSON.stringify(historical));
    const result = preregisteredOptions(
      { ...options, executor: { executable: process.execPath } },
      "fixture",
    );
    assert.equal(result.evidence!.preregistration.schemaVersion, 1);
    assert.equal(result.evidence!.preregistration.verificationProfile, null);
    writeFileSync(
      preregistration,
      JSON.stringify({ ...f.pilot, stirpiCommit: undefined }),
    );
    await assert.rejects(runExperiment(options), /runtime pin/);
    assert.equal(existsSync(output), false);
  } finally {
    process.chdir(cwd);
    f.close();
  }
});
test("launcher validates profiles from the pinned tree, before compiling or executing the runtime", async () => {
  const f = profileCheckout();
  try {
    const value = document();
    value.schemaVersion = 1;
    const oldBytes = Buffer.from(JSON.stringify(value));
    writeFileSync(join(f.checkout, f.path), oldBytes);
    git(f.checkout, "add", ".");
    git(f.checkout, "commit", "-m", "Legacy profile fixture");
    const oldCommit = git(f.checkout, "rev-parse", "HEAD");
    // The containing commit has a valid schema-2 profile, but cannot supply it
    // as an overlay for the preregistered schema-1 bytes in the runtime pin.
    writeFileSync(join(f.checkout, f.path), f.bytes);
    const preregistration = join(f.checkout, "pilot.json");
    writeFileSync(
      preregistration,
      JSON.stringify({
        ...f.pilot,
        stirpiCommit: oldCommit,
        verificationProfile: { ...f.pin, sha256: sha256(oldBytes) },
      }),
    );
    git(f.checkout, "add", ".");
    git(f.checkout, "commit", "-m", "Later registration fixture");
    const output = join(f.root, "output");
    await assert.rejects(
      runExperiment({
        preregistration,
        output,
        verificationMode: "none",
      } as RunOptions),
      /live schemaVersion must be 2/,
    );
    assert.equal(existsSync(output), false);
  } finally {
    f.close();
  }
});
