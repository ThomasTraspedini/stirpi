import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  closedAuthorityObject,
  parseAuthorityJson,
} from "../authority/json.js";
import {
  readRepositoryFile,
  repositoryPath,
} from "../authority/repository-file.js";
import {
  BUILD_TYPE,
  deriveBuildIdentity,
  sameJson,
  sha256,
  type BuildIdentityDocument,
} from "./build-identity.js";

// Local object reads only. Replacement objects and lazy promisor fetching cannot
// substitute another tree or silently turn offline validation into network work.
function git(root: string, args: string[]) {
  return execFileSync("git", ["--no-replace-objects", "-C", root, ...args], {
    env: {
      ...process.env,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
export function validateBuildDefinition(
  bytes: Buffer,
  document: BuildIdentityDocument,
) {
  if (sha256(bytes) !== document.buildDefinition.sha256)
    throw new Error("Build definition exact-blob mismatch");
  const d = closedAuthorityObject(
    parseAuthorityJson(bytes),
    [
      "schemaVersion",
      "buildType",
      "context",
      "dockerfile",
      "targetStage",
      "builderArgument",
      "builderIdentity",
      "buildIdentityArgument",
      "buildIdentity",
      "target",
      "additionalBuildArguments",
      "materials",
      "output",
      "forbidden",
    ],
    "Build definition",
  );
  const target = closedAuthorityObject(
    d.target,
    ["os", "architectures"],
    "Definition target",
  );
  const output = closedAuthorityObject(
    d.output,
    ["path", "base"],
    "Definition output",
  );
  if (
    d.schemaVersion !== 1 ||
    d.buildType !== BUILD_TYPE ||
    d.context !== "." ||
    d.dockerfile !== "proxy/Dockerfile" ||
    d.targetStage !== "final" ||
    d.builderArgument !== "BUILDER_IMAGE" ||
    d.buildIdentityArgument !== "BUILD_IDENTITY" ||
    d.buildIdentity !==
      "BuildIdentityV1: domain-separated JCS pre-build authority, injected into main.buildIdentity" ||
    d.builderIdentity !==
      "OCI digest reference resolved for the target platform" ||
    target.os !== document.target.os ||
    !sameJson(target.architectures, ["amd64", "arm64"]) ||
    !sameJson(d.additionalBuildArguments, []) ||
    !sameJson(d.materials, []) ||
    output.path !== "/stirpi-registry-egress-proxy" ||
    output.base !== "scratch" ||
    !sameJson(d.forbidden, [
      "mutable builder references",
      "host Go",
      "build without derived BUILD_IDENTITY",
    ])
  )
    throw new Error(
      "Build definition does not select BuildIdentityV1 semantics",
    );
}
interface TreeFile {
  path: string;
  mode: string;
  oid: string;
}
export function readSourceTree(
  root: string,
  document: BuildIdentityDocument,
): TreeFile[] {
  if (
    git(root, ["config", "--get", "remote.origin.url"]).toString().trimEnd() !==
    document.source.repository
  )
    throw new Error("Source repository authority mismatch");
  if (
    git(root, ["rev-parse", "--show-object-format"]).toString().trim() !==
      document.source.commit.algorithm ||
    git(root, ["cat-file", "-t", document.source.commit.value])
      .toString()
      .trim() !== "commit"
  )
    throw new Error(
      "Source must select an exact commit of the recorded algorithm",
    );
  const entries = git(root, [
    "ls-tree",
    "-rz",
    "--full-tree",
    document.source.commit.value,
  ])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/.exec(entry);
      if (!match || /[^\x20-\x7e]/.test(match[3]!))
        throw new Error(
          "Build context: unsupported tree entry (links/submodules are forbidden)",
        );
      return {
        mode: match[1]!,
        oid: match[2]!,
        path: repositoryPath(match[3]),
      };
    });
  const definition = entries.find(
    (file) => file.path === document.buildDefinition.path,
  );
  if (
    !definition ||
    !entries.some((file) => file.path === document.buildParameters.dockerfile)
  )
    throw new Error("Source build files unavailable");
  validateBuildDefinition(
    git(root, ["cat-file", "blob", definition.oid]),
    document,
  );
  return entries;
}
export function readBlob(
  ociDir: string,
  digest: string,
  size?: number,
): Buffer {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest))
    throw new Error("Invalid blob digest");
  const bytes = readRepositoryFile(ociDir, digest.slice(7));
  if (sha256(bytes) !== digest || (size !== undefined && bytes.length !== size))
    throw new Error("OCI blob digest/size mismatch");
  return bytes;
}
export function verifyBuilder(ociDir: string, document: BuildIdentityDocument) {
  const manifest = closedAuthorityObject(
    parseAuthorityJson(readBlob(ociDir, document.builderImage.manifestDigest)),
    ["schemaVersion", "mediaType", "config", "layers"],
    "Builder manifest",
  );
  if (
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
    !Array.isArray(manifest.layers)
  )
    throw new Error("Builder must resolve to an OCI platform manifest");
  const config = closedAuthorityObject(
    manifest.config,
    ["mediaType", "digest", "size"],
    "Builder config descriptor",
  );
  if (
    config.mediaType !== "application/vnd.oci.image.config.v1+json" ||
    typeof config.digest !== "string" ||
    !Number.isSafeInteger(config.size) ||
    (config.size as number) < 0
  )
    throw new Error("Invalid builder config descriptor");
  const value = parseAuthorityJson(
    readBlob(ociDir, config.digest, config.size as number),
  );
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.os !== document.target.os ||
    value.architecture !== document.target.architecture ||
    Object.hasOwn(value, "variant")
  )
    throw new Error("Resolved builder platform mismatch");
}
/** The destination must not exist. Every byte and executable bit comes directly
 * from the selected tree; export-ignore/export-subst and checkout filters never run.
 */
export function validateBuildInput(
  root: string,
  input: unknown,
  context: string,
  ociDir: string,
) {
  const derived = deriveBuildIdentity(input);
  const entries = readSourceTree(root, derived.document);
  verifyBuilder(ociDir, derived.document);
  const destination = resolve(context);
  mkdirSync(destination, { recursive: false });
  try {
    for (const file of entries) {
      const path = resolve(destination, file.path);
      mkdirSync(dirname(path), { recursive: true });
      const bytes = git(root, ["cat-file", "blob", file.oid]);
      writeFileSync(path, bytes, {
        flag: "wx",
        mode: file.mode === "100755" ? 0o755 : 0o644,
      });
      chmodSync(path, file.mode === "100755" ? 0o755 : 0o644);
      if (!readRepositoryFile(destination, file.path).equals(bytes))
        throw new Error("Build context materialization mismatch");
    }
    return {
      document: derived.document,
      canonicalHex: derived.canonicalDocumentBytes.toString("hex"),
      preimageHex: derived.preimage.toString("hex"),
      buildIdentity: derived.buildIdentity,
      context: destination,
      platform: `${derived.document.target.os}/${derived.document.target.architecture}`,
      dockerfile: "proxy/Dockerfile",
      targetStage: "final",
      arguments: {
        BUILDER_IMAGE: derived.document.builderImage.reference,
        BUILD_IDENTITY: derived.buildIdentity,
      },
    };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
