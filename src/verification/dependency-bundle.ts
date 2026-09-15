import type { AuthorityJson } from "../authority/json.js";
import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { VerificationProfile } from "./trusted-profile.js";
import { jcs, registryEgressPolicySha256 } from "./egress-policy.js";

const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export interface BundleKey {
  schemaVersion: 1;
  kind: "node-modules";
  manifest: { path: string; sha256: string };
  lockfile: { path: string; sha256: string };
  preparationImage: {
    requestedDigest: string;
    resolvedPlatformManifestDigest: string;
  };
  egressProxy?: { requestedDigest: string };
  registryEgressPolicySha256?: string;
  platform: { os: string; architecture: string };
  installPolicySha256: string;
}
export interface BundleIdentity {
  key: BundleKey;
  keySha256: string;
  treeSha256: string;
  fileCount: number;
  byteCount: number;
}
export interface BundleProvenance {
  identity: BundleIdentity;
  preparationImage: string;
  resolvedPlatformManifestDigest: string;
  installPolicySha256: string;
  egressProxyImage?: string;
  registryEgressPolicySha256?: string;
  immutable: true;
}
export function dependencyBundleKey(
  profile: VerificationProfile,
  manifest: Buffer,
  lockfile: Buffer,
  resolvedPlatformManifestDigest: string,
): BundleKey {
  if (!/^[a-f0-9]{64}$/.test(resolvedPlatformManifestDigest))
    throw new Error(
      "Bundle: resolved preparation manifest digest must be SHA-256",
    );
  const d067 = {
    egressProxy: { requestedDigest: profile.images.egressProxy!.reference },
    registryEgressPolicySha256: registryEgressPolicySha256(profile),
  };
  return {
    schemaVersion: 1,
    kind: "node-modules",
    manifest: {
      path: profile.dependencies.inputs.manifest,
      sha256: hash(manifest),
    },
    lockfile: {
      path: profile.dependencies.inputs.lockfile,
      sha256: hash(lockfile),
    },
    preparationImage: {
      requestedDigest: profile.images.dependencyPreparation.reference,
      resolvedPlatformManifestDigest,
    },
    ...d067,
    platform: structuredClone(profile.platform),
    installPolicySha256: hash(
      jcs(profile.dependencies.installPolicy as unknown as AuthorityJson),
    ),
  };
}
export const bundleKeySha256 = (key: BundleKey) =>
  hash(jcs(key as unknown as AuthorityJson));
export function bundleTree(root: string) {
  const base = resolve(root);
  const entries: {
    path: string;
    type: "file" | "directory" | "symlink";
    mode: number;
    bytes?: number;
    sha256?: string;
    target?: string;
  }[] = [];
  let fileCount = 0,
    byteCount = 0;
  const visit = (path: string) => {
    const info = lstatSync(path);
    const rel = relative(base, path).split(sep).join("/");
    if (!rel || rel.startsWith("../"))
      throw new Error("Bundle: tree path escapes root");
    const mode = info.mode & 0o777;
    if (info.isDirectory()) {
      entries.push({ path: rel, type: "directory", mode });
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    if (info.isFile()) {
      const bytes = readFileSync(path);
      fileCount++;
      byteCount += bytes.length;
      entries.push({
        path: rel,
        type: "file",
        mode,
        bytes: bytes.length,
        sha256: hash(bytes),
      });
      return;
    }
    if (info.isSymbolicLink()) {
      const target = requireRelativeTarget(path);
      entries.push({ path: rel, type: "symlink", mode, target });
      return;
    }
    throw new Error("Bundle: special files are forbidden");
  };
  for (const child of readdirSync(base).sort()) visit(join(base, child));
  return {
    treeSha256: hash(
      jcs({ schemaVersion: 1, entries } as unknown as AuthorityJson),
    ),
    fileCount,
    byteCount,
  };
}
function requireRelativeTarget(path: string) {
  const target = readlinkSync(path);
  if (target.startsWith("/") || target.split(/[\\/]/).includes(".."))
    throw new Error("Bundle: unsafe symlink");
  return target;
}
export function bundleIdentity(
  key: BundleKey,
  nodeModules: string,
): BundleIdentity {
  const tree = bundleTree(nodeModules);
  return { key, keySha256: bundleKeySha256(key), ...tree };
}
export interface DependencyPreparationPlan {
  image: string;
  command: { executable: string; argv: string[] };
  network: { mode: "registry-only"; origins: string[] };
  inputs: readonly [string, string];
  readOnlyRootFilesystem: true;
  noCandidateRuntimeSecrets: true;
  noHostNodeFallback: true;
  exportPath: "node_modules";
}
export function dependencyPreparationPlan(
  profile: VerificationProfile,
  manifest: string,
  lockfile: string,
): DependencyPreparationPlan {
  return {
    image: profile.images.dependencyPreparation.reference,
    command: structuredClone(profile.dependencies.installPolicy),
    network: structuredClone(profile.dependencies.installPolicy.network),
    inputs: [manifest, lockfile],
    readOnlyRootFilesystem: true,
    noCandidateRuntimeSecrets: true,
    noHostNodeFallback: true,
    exportPath: "node_modules",
  };
}
/** Atomically seals an already-isolated preparer's export; it never executes package-manager code. */
export function sealDependencyBundle(
  store: string,
  identity: BundleIdentity,
  exportedNodeModules: string,
): BundleProvenance {
  const verified = bundleIdentity(identity.key, exportedNodeModules);
  if (
    verified.treeSha256 !== identity.treeSha256 ||
    verified.fileCount !== identity.fileCount ||
    verified.byteCount !== identity.byteCount
  )
    throw new Error("Bundle: export changed before sealing");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const target = join(store, identity.keySha256);
  if (!lstatSyncSafe(target)) {
    const staging = mkdtempSync(join(store, ".staging-"));
    try {
      cpSync(exportedNodeModules, join(staging, "node_modules"), {
        recursive: true,
        dereference: false,
      });
      chmodTree(staging);
      renameSync(staging, target);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  // Modes are part of the canonical tree. Record the post-sealing tree, whose
  // read-only permissions are the artifact a verifier will actually consume.
  const sealed = bundleIdentity(identity.key, join(target, "node_modules"));
  return {
    identity: sealed,
    preparationImage: identity.key.preparationImage.requestedDigest,
    resolvedPlatformManifestDigest:
      identity.key.preparationImage.resolvedPlatformManifestDigest,
    installPolicySha256: identity.key.installPolicySha256,
    ...(identity.key.egressProxy
      ? {
          egressProxyImage: identity.key.egressProxy.requestedDigest,
          registryEgressPolicySha256: identity.key.registryEgressPolicySha256,
        }
      : {}),
    immutable: true,
  };
}
/** Trusted store maintenance only; candidates never receive a writable store path. */
export function removeSealedDependencyBundle(store: string, keySha256: string) {
  if (!/^[a-f0-9]{64}$/.test(keySha256))
    throw new Error("Bundle: invalid bundle key");
  const target = join(store, keySha256);
  makeWritable(target);
  rmSync(target, { recursive: true, force: true });
}
function lstatSyncSafe(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
function chmodTree(path: string) {
  const info = lstatSync(path);
  if (!info.isSymbolicLink())
    chmodSync(path, info.isDirectory() ? 0o555 : 0o444);
  if (info.isDirectory())
    for (const child of readdirSync(path)) chmodTree(join(path, child));
}
function makeWritable(path: string) {
  const info = lstatSyncSafe(path);
  if (!info) return;
  if (!info.isSymbolicLink())
    chmodSync(path, info.isDirectory() ? 0o755 : 0o644);
  if (info.isDirectory())
    for (const child of readdirSync(path)) makeWritable(join(path, child));
}
