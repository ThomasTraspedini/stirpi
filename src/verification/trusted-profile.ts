import { createHash } from "node:crypto";
import { parseAuthorityJson } from "../authority/json.js";
import {
  readRepositoryFile,
  repositoryPath,
} from "../authority/repository-file.js";
import {
  validateEgressContracts,
  validateRegistryNetwork,
  type EgressContracts,
  type RegistryNetwork,
} from "./egress-policy.js";

export const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const digestReference =
  /^(?:[a-z0-9][a-z0-9.-]*(?::[1-9][0-9]{0,4})?\/)[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/;

export interface ProfileIdentity {
  id: string;
  version: number;
  sha256: string;
}
export interface ImageIdentity {
  reference: string;
}
export interface VerificationProfile {
  schemaVersion: 2;
  id: string;
  version: number;
  platform: { os: string; architecture: string };
  images: {
    verifier: ImageIdentity;
    dependencyPreparation: ImageIdentity;
    egressProxy: ImageIdentity & { contracts: EgressContracts };
    postgres?: ImageIdentity;
  };
  dependencies: {
    kind: "node-modules";
    inputs: { manifest: string; lockfile: string };
    installPolicy: {
      id: string;
      executable: string;
      argv: string[];
      lifecycleScripts: "deny";
      network: RegistryNetwork;
    };
    limits: Limits;
    isolation: PreparationIsolation;
    bundle: {
      exportPath: "node_modules";
      targetPath: "/workspace/node_modules";
      delivery: "read-only-mount";
    };
  };
  toolchain: ToolchainExpectation[];
  operations: ProfileOperation[];
  database?: DatabasePolicy;
  workspace: WorkspacePolicy;
  isolation: VerifierIsolation;
}
export interface Limits {
  wallTimeMs: number;
  cpu: number;
  memoryBytes: number;
  pids: number;
  fileDescriptors: number;
  outputBytesPerStream: number;
}
export interface PreparationIsolation {
  readOnlyRootFilesystem: true;
  preparerUser: string;
  dropCapabilities: "all";
  noNewPrivileges: true;
  dockerSocket: "absent";
  hostFilesystem: "absent";
  candidateRuntimeSecrets: "absent";
  environment: "fixed-dependency-preparation-v1";
  writablePaths: string[];
}
export interface VerifierIsolation {
  network: "none";
  readOnlyRootFilesystem: true;
  candidateUser: string;
  dropCapabilities: "all";
  noNewPrivileges: true;
  dockerSocket: "absent";
  hostFilesystem: "absent";
  privateStirpiState: "absent";
  privateEvaluatorMaterial: "absent";
  environment: "fixed-minimal-v1";
  writablePaths: string[];
}
export interface ToolchainExpectation {
  id: string;
  imageRole: "verifier" | "dependencyPreparation" | "postgres";
  executable: string;
  versionArgv: string[];
  expectedStdout: string;
}
export interface ProfileOperation {
  id: string;
  publicInvocation: {
    executable: string;
    argv: string[];
    workingDirectory: "candidate";
  };
  executable: string;
  argv: string[];
  cwd: "/workspace";
  workspaceView: "sanitized-git-worktree-v1";
  dependencyBundle: "required" | "none";
  database: "required" | "none";
  limits: Limits;
}
export interface DatabasePolicy {
  engine: "postgresql";
  bootstrapPolicy: "disposable-schema-owner-v1";
  extensions: string[];
  transport: "unix-socket-only";
  socketPath: string;
  candidateRole: {
    superuser: false;
    createDatabase: false;
    createRole: false;
    inherit: false;
  };
  limits: Limits;
}
export interface WorkspacePolicy {
  maxFiles: number;
  maxBytes: number;
  rejectSpecialFiles: true;
  rejectEscapingSymlinks: true;
  acceptCandidateNodeModules: false;
}
export interface LoadedProfile {
  profile: VerificationProfile;
  path: string;
  bytes: Buffer;
  identity: ProfileIdentity;
  images: Record<string, string>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Profile: ${label} must be an object`);
  return value as Record<string, unknown>;
}
function closed(value: unknown, keys: readonly string[], label: string) {
  const record = object(value, label);
  for (const key of Object.keys(record))
    if (!keys.includes(key))
      throw new Error(`Profile: unknown ${label} field ${key}`);
  for (const key of keys)
    if (!Object.hasOwn(record, key))
      throw new Error(`Profile: missing ${label} field ${key}`);
  return record;
}
function allowed(
  value: unknown,
  keys: readonly string[],
  required: readonly string[],
  label: string,
) {
  const record = object(value, label);
  for (const key of Object.keys(record))
    if (!keys.includes(key))
      throw new Error(`Profile: unknown ${label} field ${key}`);
  for (const key of required)
    if (!Object.hasOwn(record, key))
      throw new Error(`Profile: missing ${label} field ${key}`);
  return record;
}
function string(value: unknown, label: string) {
  if (typeof value !== "string" || !value)
    throw new Error(`Profile: ${label} must be a nonempty string`);
  return value;
}
function literal<T>(value: unknown, expected: T, label: string): T {
  if (value !== expected)
    throw new Error(`Profile: ${label} must be ${String(expected)}`);
  return expected;
}
function positive(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`Profile: ${label} must be a positive safe integer`);
  return value as number;
}
function strings(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
    throw new Error(`Profile: ${label} must be a string array`);
  return value as string[];
}
function safe(value: unknown, label: string) {
  const v = string(value, label);
  if (!stableId.test(v)) throw new Error(`Profile: invalid ${label}`);
  return v;
}
function abs(value: unknown, label: string) {
  const v = string(value, label);
  if (!v.startsWith("/"))
    throw new Error(`Profile: ${label} must be an absolute container path`);
  if (v !== "/") repositoryPath(v.slice(1), label);
  return v;
}

function limits(value: unknown, label: string): Limits {
  const v = closed(
    value,
    [
      "wallTimeMs",
      "cpu",
      "memoryBytes",
      "pids",
      "fileDescriptors",
      "outputBytesPerStream",
    ],
    label,
  );
  return {
    wallTimeMs: positive(v.wallTimeMs, `${label}.wallTimeMs`),
    cpu: positive(v.cpu, `${label}.cpu`),
    memoryBytes: positive(v.memoryBytes, `${label}.memoryBytes`),
    pids: positive(v.pids, `${label}.pids`),
    fileDescriptors: positive(v.fileDescriptors, `${label}.fileDescriptors`),
    outputBytesPerStream: positive(
      v.outputBytesPerStream,
      `${label}.outputBytesPerStream`,
    ),
  };
}
function image(value: unknown, label: string): ImageIdentity {
  const v = closed(value, ["reference"], label);
  const reference = string(v.reference, `${label}.reference`);
  if (!digestReference.test(reference))
    throw new Error(
      `Profile: ${label}.reference must be a fully qualified digest reference`,
    );
  return { reference };
}

export function parseVerificationProfile(
  bytes: Buffer | string,
): VerificationProfile {
  const raw = parseAuthorityJson(bytes);
  const root = allowed(
    raw,
    [
      "schemaVersion",
      "id",
      "version",
      "platform",
      "images",
      "dependencies",
      "toolchain",
      "operations",
      "database",
      "workspace",
      "isolation",
    ],
    [
      "schemaVersion",
      "id",
      "version",
      "platform",
      "images",
      "dependencies",
      "toolchain",
      "operations",
      "workspace",
      "isolation",
    ],
    "root",
  );
  if (root.schemaVersion !== 2)
    throw new Error("Profile: live schemaVersion must be 2");
  const schemaVersion = root.schemaVersion;
  const id = safe(root.id, "id"),
    version = positive(root.version, "version");
  const p = closed(root.platform, ["os", "architecture"], "platform");
  const platform = {
    os: literal(p.os, "linux", "platform.os"),
    architecture: string(p.architecture, "platform.architecture"),
  };
  if (platform.architecture !== "amd64" && platform.architecture !== "arm64")
    throw new Error("Profile: unsupported platform architecture");
  const i = allowed(
    root.images,
    ["verifier", "dependencyPreparation", "egressProxy", "postgres"],
    ["verifier", "dependencyPreparation", "egressProxy"],
    "images",
  );
  const proxy = closed(
    i.egressProxy,
    ["reference", "contracts"],
    "images.egressProxy",
  );
  const images = {
    verifier: image(i.verifier, "images.verifier"),
    dependencyPreparation: image(
      i.dependencyPreparation,
      "images.dependencyPreparation",
    ),
    egressProxy: {
      ...image({ reference: proxy.reference }, "images.egressProxy"),
      contracts: validateEgressContracts(proxy.contracts),
    },
    ...(i.postgres === undefined
      ? {}
      : { postgres: image(i.postgres, "images.postgres") }),
  };
  const d = closed(
    root.dependencies,
    ["kind", "inputs", "installPolicy", "limits", "isolation", "bundle"],
    "dependencies",
  );
  literal(d.kind, "node-modules", "dependencies.kind");
  const input = closed(
    d.inputs,
    ["manifest", "lockfile"],
    "dependencies.inputs",
  );
  const policy = closed(
    d.installPolicy,
    ["id", "executable", "argv", "lifecycleScripts", "network"],
    "dependencies.installPolicy",
  );
  const network = validateRegistryNetwork(policy.network);
  literal(
    policy.lifecycleScripts,
    "deny",
    "dependencies.installPolicy.lifecycleScripts",
  );
  const pi = closed(
    d.isolation,
    [
      "readOnlyRootFilesystem",
      "preparerUser",
      "dropCapabilities",
      "noNewPrivileges",
      "dockerSocket",
      "hostFilesystem",
      "candidateRuntimeSecrets",
      "environment",
      "writablePaths",
    ],
    "dependencies.isolation",
  );
  const b = closed(
    d.bundle,
    ["exportPath", "targetPath", "delivery"],
    "dependencies.bundle",
  );
  const dependencies: VerificationProfile["dependencies"] = {
    kind: "node-modules",
    inputs: {
      manifest: repositoryPath(input.manifest, "dependencies.inputs.manifest"),
      lockfile: repositoryPath(input.lockfile, "dependencies.inputs.lockfile"),
    },
    installPolicy: {
      id: safe(policy.id, "dependencies.installPolicy.id"),
      executable: abs(
        policy.executable,
        "dependencies.installPolicy.executable",
      ),
      argv: strings(policy.argv, "dependencies.installPolicy.argv"),
      lifecycleScripts: "deny",
      network,
    },
    limits: limits(d.limits, "dependencies.limits"),
    isolation: {
      readOnlyRootFilesystem: literal(
        pi.readOnlyRootFilesystem,
        true,
        "dependencies.isolation.readOnlyRootFilesystem",
      ),
      preparerUser: string(
        pi.preparerUser,
        "dependencies.isolation.preparerUser",
      ),
      dropCapabilities: literal(
        pi.dropCapabilities,
        "all",
        "dependencies.isolation.dropCapabilities",
      ),
      noNewPrivileges: literal(
        pi.noNewPrivileges,
        true,
        "dependencies.isolation.noNewPrivileges",
      ),
      dockerSocket: literal(
        pi.dockerSocket,
        "absent",
        "dependencies.isolation.dockerSocket",
      ),
      hostFilesystem: literal(
        pi.hostFilesystem,
        "absent",
        "dependencies.isolation.hostFilesystem",
      ),
      candidateRuntimeSecrets: literal(
        pi.candidateRuntimeSecrets,
        "absent",
        "dependencies.isolation.candidateRuntimeSecrets",
      ),
      environment: literal(
        pi.environment,
        "fixed-dependency-preparation-v1",
        "dependencies.isolation.environment",
      ),
      writablePaths: strings(
        pi.writablePaths,
        "dependencies.isolation.writablePaths",
      ).map((x) => abs(x, "dependencies.isolation.writablePath")),
    },
    bundle: {
      exportPath: literal(
        b.exportPath,
        "node_modules",
        "dependencies.bundle.exportPath",
      ),
      targetPath: literal(
        b.targetPath,
        "/workspace/node_modules",
        "dependencies.bundle.targetPath",
      ),
      delivery: literal(
        b.delivery,
        "read-only-mount",
        "dependencies.bundle.delivery",
      ),
    },
  };
  if (!Array.isArray(root.toolchain) || !root.toolchain.length)
    throw new Error("Profile: toolchain must be nonempty");
  const toolchain: ToolchainExpectation[] = [];
  const seenTools = new Set<string>();
  for (let n = 0; n < root.toolchain.length; n++) {
    const t = closed(
      root.toolchain[n],
      ["id", "imageRole", "executable", "versionArgv", "expectedStdout"],
      `toolchain[${n}]`,
    );
    const tid = safe(t.id, `toolchain[${n}].id`);
    if (seenTools.has(tid)) throw new Error("Profile: duplicate toolchain ID");
    seenTools.add(tid);
    const role = t.imageRole;
    if (
      role !== "verifier" &&
      role !== "dependencyPreparation" &&
      role !== "postgres"
    )
      throw new Error("Profile: invalid toolchain imageRole");
    if (role === "postgres" && !images.postgres)
      throw new Error("Profile: postgres toolchain requires postgres image");
    toolchain[n] = {
      id: tid,
      imageRole: role,
      executable: abs(t.executable, `toolchain[${n}].executable`),
      versionArgv: strings(t.versionArgv, `toolchain[${n}].versionArgv`),
      expectedStdout: string(
        t.expectedStdout,
        `toolchain[${n}].expectedStdout`,
      ),
    };
  }
  if (!Array.isArray(root.operations) || !root.operations.length)
    throw new Error("Profile: operations must be nonempty");
  const operations: ProfileOperation[] = [];
  const ids = new Set<string>(),
    invocations = new Set<string>();
  for (let n = 0; n < root.operations.length; n++) {
    const o = closed(
      root.operations[n],
      [
        "id",
        "publicInvocation",
        "executable",
        "argv",
        "cwd",
        "workspaceView",
        "dependencyBundle",
        "database",
        "limits",
      ],
      `operations[${n}]`,
    );
    const oid = safe(o.id, `operations[${n}].id`);
    if (ids.has(oid))
      throw new Error(`Profile: duplicate verification ID ${oid}`);
    ids.add(oid);
    const q = closed(
      o.publicInvocation,
      ["executable", "argv", "workingDirectory"],
      `operations[${n}].publicInvocation`,
    );
    const invocation = {
      executable: string(q.executable, "public invocation executable"),
      argv: strings(q.argv, "public invocation argv"),
      workingDirectory: literal(
        q.workingDirectory,
        "candidate",
        "public invocation workingDirectory",
      ) as "candidate",
    };
    const invocationKey = JSON.stringify(invocation);
    if (invocations.has(invocationKey))
      throw new Error("Profile: duplicate public invocation");
    invocations.add(invocationKey);
    const database = o.database;
    if (database !== "required" && database !== "none")
      throw new Error("Profile: invalid operation database");
    const dependencyBundle = o.dependencyBundle;
    if (dependencyBundle !== "required" && dependencyBundle !== "none")
      throw new Error("Profile: invalid operation dependency bundle");
    operations.push({
      id: oid,
      publicInvocation: invocation,
      executable: abs(o.executable, `operations[${n}].executable`),
      argv: strings(o.argv, `operations[${n}].argv`),
      cwd: literal(o.cwd, "/workspace", `operations[${n}].cwd`) as "/workspace",
      workspaceView: literal(
        o.workspaceView,
        "sanitized-git-worktree-v1",
        `operations[${n}].workspaceView`,
      ) as "sanitized-git-worktree-v1",
      dependencyBundle,
      database,
      limits: limits(o.limits, `operations[${n}].limits`),
    });
  }
  let database: DatabasePolicy | undefined;
  if (root.database !== undefined) {
    const x = closed(
      root.database,
      [
        "engine",
        "bootstrapPolicy",
        "extensions",
        "transport",
        "socketPath",
        "candidateRole",
        "limits",
      ],
      "database",
    );
    const role = closed(
      x.candidateRole,
      ["superuser", "createDatabase", "createRole", "inherit"],
      "database.candidateRole",
    );
    const extensions = strings(x.extensions, "database.extensions");
    if (
      new Set(extensions).size !== extensions.length ||
      [...extensions].sort().some((v, n) => v !== extensions[n])
    )
      throw new Error("Profile: database extensions must be sorted and unique");
    database = {
      engine: literal(x.engine, "postgresql", "database.engine"),
      bootstrapPolicy: literal(
        x.bootstrapPolicy,
        "disposable-schema-owner-v1",
        "database.bootstrapPolicy",
      ),
      extensions,
      transport: literal(x.transport, "unix-socket-only", "database.transport"),
      socketPath: abs(x.socketPath, "database.socketPath"),
      candidateRole: {
        superuser: literal(
          role.superuser,
          false,
          "database.candidateRole.superuser",
        ),
        createDatabase: literal(
          role.createDatabase,
          false,
          "database.candidateRole.createDatabase",
        ),
        createRole: literal(
          role.createRole,
          false,
          "database.candidateRole.createRole",
        ),
        inherit: literal(role.inherit, false, "database.candidateRole.inherit"),
      },
      limits: limits(x.limits, "database.limits"),
    };
  }
  if (
    Boolean(database) !== Boolean(images.postgres) ||
    operations.some((o) => o.database === "required") !== Boolean(database)
  )
    throw new Error(
      "Profile: database and postgres image must exactly match operation requirements",
    );
  const w = closed(
    root.workspace,
    [
      "maxFiles",
      "maxBytes",
      "rejectSpecialFiles",
      "rejectEscapingSymlinks",
      "acceptCandidateNodeModules",
    ],
    "workspace",
  );
  const z = closed(
    root.isolation,
    [
      "network",
      "readOnlyRootFilesystem",
      "candidateUser",
      "dropCapabilities",
      "noNewPrivileges",
      "dockerSocket",
      "hostFilesystem",
      "privateStirpiState",
      "privateEvaluatorMaterial",
      "environment",
      "writablePaths",
    ],
    "isolation",
  );
  return {
    schemaVersion,
    id,
    version,
    platform,
    images,
    dependencies,
    toolchain,
    operations,
    ...(database ? { database } : {}),
    workspace: {
      maxFiles: positive(w.maxFiles, "workspace.maxFiles"),
      maxBytes: positive(w.maxBytes, "workspace.maxBytes"),
      rejectSpecialFiles: literal(
        w.rejectSpecialFiles,
        true,
        "workspace.rejectSpecialFiles",
      ),
      rejectEscapingSymlinks: literal(
        w.rejectEscapingSymlinks,
        true,
        "workspace.rejectEscapingSymlinks",
      ),
      acceptCandidateNodeModules: literal(
        w.acceptCandidateNodeModules,
        false,
        "workspace.acceptCandidateNodeModules",
      ),
    },
    isolation: {
      network: literal(z.network, "none", "isolation.network"),
      readOnlyRootFilesystem: literal(
        z.readOnlyRootFilesystem,
        true,
        "isolation.readOnlyRootFilesystem",
      ),
      candidateUser: string(z.candidateUser, "isolation.candidateUser"),
      dropCapabilities: literal(
        z.dropCapabilities,
        "all",
        "isolation.dropCapabilities",
      ),
      noNewPrivileges: literal(
        z.noNewPrivileges,
        true,
        "isolation.noNewPrivileges",
      ),
      dockerSocket: literal(z.dockerSocket, "absent", "isolation.dockerSocket"),
      hostFilesystem: literal(
        z.hostFilesystem,
        "absent",
        "isolation.hostFilesystem",
      ),
      privateStirpiState: literal(
        z.privateStirpiState,
        "absent",
        "isolation.privateStirpiState",
      ),
      privateEvaluatorMaterial: literal(
        z.privateEvaluatorMaterial,
        "absent",
        "isolation.privateEvaluatorMaterial",
      ),
      environment: literal(
        z.environment,
        "fixed-minimal-v1",
        "isolation.environment",
      ),
      writablePaths: strings(z.writablePaths, "isolation.writablePaths").map(
        (x) => abs(x, "isolation.writablePath"),
      ),
    },
  };
}

export function loadTrustedProfile(root: string, path: string): LoadedProfile {
  repositoryPath(path, "Profile path");
  if (!path.startsWith("verification-profiles/") || !path.endsWith(".json"))
    throw new Error(
      "Profile: path must name a JSON file under verification-profiles/",
    );
  const bytes = readRepositoryFile(root, path);
  const profile = parseVerificationProfile(bytes);
  const identity = {
    id: profile.id,
    version: profile.version,
    sha256: sha256(bytes),
  };
  return {
    profile,
    path,
    bytes,
    identity,
    images: Object.fromEntries(
      Object.entries(profile.images).map(([role, image]) => [
        role,
        image.reference,
      ]),
    ),
  };
}
