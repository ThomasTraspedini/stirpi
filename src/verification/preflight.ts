import { dirname, basename, resolve } from "node:path";
import { closedAuthorityObject } from "../authority/json.js";
import {
  readRepositoryFile,
  repositoryPath,
} from "../authority/repository-file.js";
import type { BundleProvenance } from "./dependency-bundle.js";
import {
  loadTrustedProfile,
  type LoadedProfile,
  type ProfileIdentity,
  stableId,
  sha256,
} from "./trusted-profile.js";

export interface VerificationProfilePin extends ProfileIdentity {
  path: string;
}
export interface ResolvedImageIdentity {
  role: "verifier" | "dependencyPreparation" | "egressProxy" | "postgres";
  requestedReference: string;
  resolvedPlatformManifestDigest: string;
  imageConfigDigest: string;
  runtimeImageId: string;
  os: string;
  architecture: string;
  rootfsDiffIds: string[];
}
export interface TrustedPreflight {
  profile: LoadedProfile;
  images: ResolvedImageIdentity[];
  bundle?: BundleProvenance;
}
export function parseVerificationProfilePin(
  value: unknown,
): VerificationProfilePin {
  const pin = closedAuthorityObject(
    value,
    ["id", "version", "path", "sha256"],
    "Preflight: verification profile pin",
  );
  const path = repositoryPath(
    pin.path,
    "Preflight: verification profile pin path",
  );
  if (
    typeof pin.id !== "string" ||
    !stableId.test(pin.id) ||
    !Number.isSafeInteger(pin.version) ||
    (pin.version as number) < 1 ||
    !path.startsWith("verification-profiles/") ||
    !path.endsWith(".json") ||
    typeof pin.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(pin.sha256)
  )
    throw new Error("Preflight: invalid verification profile pin");
  return {
    id: pin.id,
    version: pin.version as number,
    path,
    sha256: pin.sha256,
  };
}
export function validateProfilePin(
  root: string,
  pin: VerificationProfilePin,
): LoadedProfile {
  pin = parseVerificationProfilePin(pin);
  const loaded = loadTrustedProfile(root, pin.path);
  if (
    loaded.identity.id !== pin.id ||
    loaded.identity.version !== pin.version ||
    loaded.identity.sha256 !== pin.sha256
  )
    throw new Error("Preflight: verification profile identity mismatch");
  return loaded;
}
export function validateResolvedImages(
  profile: LoadedProfile,
  images: readonly ResolvedImageIdentity[],
) {
  const expected = Object.entries(profile.profile.images).map(
    ([role, image]) => [role, image.reference] as const,
  );
  if (images.length !== expected.length)
    throw new Error("Preflight: image identity set is incomplete");
  for (const [role, reference] of expected) {
    const image = images.find((i) => i.role === role);
    if (
      !image ||
      image.requestedReference !== reference ||
      image.os !== profile.profile.platform.os ||
      image.architecture !== profile.profile.platform.architecture ||
      !/^[a-f0-9]{64}$/.test(image.resolvedPlatformManifestDigest) ||
      !/^[a-f0-9]{64}$/.test(image.imageConfigDigest) ||
      !image.runtimeImageId ||
      !image.rootfsDiffIds.length
    )
      throw new Error(`Preflight: invalid resolved ${role} image identity`);
  }
}
export function validateBundleAvailability(
  profile: LoadedProfile,
  bundle: BundleProvenance | undefined,
) {
  const required = profile.profile.operations.some(
    (o) => o.dependencyBundle === "required",
  );
  if (required && !bundle)
    throw new Error("Preflight: required dependency bundle unavailable");
  if (!bundle) return;
  if (
    !bundle.immutable ||
    bundle.preparationImage !==
      profile.profile.images.dependencyPreparation.reference ||
    bundle.installPolicySha256 !== bundle.identity.key.installPolicySha256 ||
    bundle.identity.key.platform.os !== profile.profile.platform.os ||
    bundle.identity.key.platform.architecture !==
      profile.profile.platform.architecture
  )
    throw new Error("Preflight: dependency bundle provenance mismatch");
}
export function validateDatabaseAuthority(profile: LoadedProfile) {
  const required = profile.profile.operations.some(
    (o) => o.database === "required",
  );
  if (
    required !==
    Boolean(profile.profile.database && profile.profile.images.postgres)
  )
    throw new Error("Preflight: database policy/image authority mismatch");
}
export function profileBytesHash(path: string) {
  return sha256(readRepositoryFile(dirname(resolve(path)), basename(path)));
}

export interface VerificationReplayIdentity {
  profile: VerificationProfilePin;
  bundle: BundleProvenance | null;
  images: ResolvedImageIdentity[];
  candidateWorkspaceSha256: string;
  operationId: string;
}
export function validateReplayIdentity(value: VerificationReplayIdentity) {
  if (
    !/^[a-f0-9]{64}$/.test(value.profile.sha256) ||
    !/^[a-f0-9]{64}$/.test(value.candidateWorkspaceSha256) ||
    !value.operationId ||
    !value.images.length
  )
    throw new Error("Replay: exact verification identity is required");
  for (const image of value.images)
    if (
      !/^[a-f0-9]{64}$/.test(image.resolvedPlatformManifestDigest) ||
      !/^[a-f0-9]{64}$/.test(image.imageConfigDigest)
    )
      throw new Error("Replay: resolved image identity is invalid");
  if (
    value.bundle &&
    (!value.bundle.immutable ||
      !/^[a-f0-9]{64}$/.test(value.bundle.identity.keySha256) ||
      !/^[a-f0-9]{64}$/.test(value.bundle.identity.treeSha256))
  )
    throw new Error("Replay: dependency bundle identity is invalid");
}
