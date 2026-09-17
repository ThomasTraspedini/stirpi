import { closedAuthorityObject } from "../authority/json.js";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { sha256 } from "./inputs.js";
import { executablePath } from "./executor-identity.js";
import { trustedProcess, type TrustedProcess } from "./preparation.js";
import type { TrustedLocalContract } from "./trusted-local-contract.js";

export interface LocalToolLocations {
  node: string;
  npmRoot: string;
  compilerRoot: string;
  typeRoots: string;
  git: string;
  docker: string;
  shell: string;
}
/** v1: sorted [relative POSIX path, executable bits, SHA256(bytes)] JSON + LF.
 * No exclusions or symlink following inside an installation closure. */
export function localTreeSha256(directory: string) {
  const root = realpathSync(directory);
  if (!lstatSync(root).isDirectory())
    throw new Error("Toolchain closure must be a directory");
  const entries: [string, number, string][] = [];
  const walk = (path: string, prefix: string) => {
    for (const name of readdirSync(path).sort()) {
      const target = join(path, name),
        rel = prefix + name,
        stat = lstatSync(target);
      if (stat.isDirectory()) walk(target, rel + "/");
      else if (stat.isFile())
        entries.push([rel, stat.mode & 0o111, sha256(readFileSync(target))]);
      else
        throw new Error(
          "Unsupported toolchain closure entry (including symlink)",
        );
    }
  };
  walk(root, "");
  return sha256(JSON.stringify(entries) + "\n");
}
function dependencyPackage(
  require: NodeJS.Require,
  request: string,
  toolchainRoot?: string,
) {
  let packageJson: string;
  try {
    packageJson = require.resolve(request);
  } catch {
    throw new Error(
      toolchainRoot
        ? `Preflight: ${request} unavailable from toolchain root ${toolchainRoot}`
        : `Preflight: ${request} unavailable`,
    );
  }
  if (toolchainRoot) {
    const rel = relative(toolchainRoot, realpathSync(packageJson));
    if (!rel || rel.startsWith("../") || isAbsolute(rel))
      throw new Error(
        `Preflight: ${request} resolved outside toolchain root ${toolchainRoot}`,
      );
  }
  return packageJson;
}

export function defaultLocalTools(
  explicitToolchainRoot?: string,
): LocalToolLocations {
  let toolchainRoot: string | undefined;
  let require: NodeJS.Require;
  if (explicitToolchainRoot === undefined)
    require = createRequire(import.meta.url);
  else {
    if (
      !isAbsolute(explicitToolchainRoot) ||
      explicitToolchainRoot !== resolve(explicitToolchainRoot)
    )
      throw new Error("Preflight: toolchain root must be absolute");
    try {
      toolchainRoot = realpathSync(explicitToolchainRoot);
      if (!lstatSync(toolchainRoot).isDirectory()) throw new Error();
      const packageJson = join(toolchainRoot, "package.json");
      if (!lstatSync(packageJson).isFile()) throw new Error();
      require = createRequire(packageJson);
    } catch {
      throw new Error(
        `Preflight: toolchain root unavailable ${explicitToolchainRoot}`,
      );
    }
  }
  const compilerPackage = dependencyPackage(
    require,
    "typescript/package.json",
    toolchainRoot,
  );
  const nodeTypesPackage = dependencyPackage(
    require,
    "@types/node/package.json",
    toolchainRoot,
  );
  return {
    node: realpathSync(process.execPath),
    npmRoot: join(realpathSync(executablePath("npm")), "../.."),
    compilerRoot: dirname(compilerPackage),
    typeRoots: dirname(dirname(nodeTypesPackage)),
    git: realpathSync(executablePath("git")),
    // Docker dispatchers can select behavior from argv0. Keep the discovered
    // executable name while readFileSync below still authenticates its target.
    docker: executablePath("docker"),
    // Preserve the human-approved operational locator; do not canonicalize it.
    shell: "/bin/sh",
  };
}
export function verifyLocalShell(
  contract: TrustedLocalContract,
  locations: LocalToolLocations,
) {
  if (
    locations.shell !== "/bin/sh" ||
    locations.shell !== contract.toolchain.shell.locator
  )
    throw new Error("Preflight: shell locator mismatch");
  if (sha256(readFileSync(locations.shell)) !== contract.toolchain.shell.sha256)
    throw new Error("Preflight: shell bytes mismatch/missing");
  return locations.shell;
}
export function verifyLocalTools(
  contract: TrustedLocalContract,
  locations: LocalToolLocations,
  run: TrustedProcess = trustedProcess,
) {
  closedAuthorityObject(
    locations,
    ["node", "npmRoot", "compilerRoot", "typeRoots", "git", "docker", "shell"],
    "Preflight: local tool locations",
  );
  if (
    !Object.values(locations).every(
      (path) => typeof path === "string" && isAbsolute(path),
    )
  )
    throw new Error("Preflight: tool locations must be absolute locators");
  const pin = contract.toolchain;
  if (pin.platform !== process.platform || pin.architecture !== process.arch)
    throw new Error("Preflight: toolchain platform mismatch");
  verifyLocalShell(contract, locations);
  for (const name of ["node", "git", "docker"] as const)
    if (
      !pin[name].sha256 ||
      sha256(readFileSync(locations[name])) !== pin[name].sha256
    )
      throw new Error(`Preflight: ${name} bytes mismatch/missing`);
  for (const [name, path] of [
    ["npm", locations.npmRoot],
    ["compiler", locations.compilerRoot],
    ["typeRoots", locations.typeRoots],
  ] as const)
    if (!pin[name].treeSha256 || localTreeSha256(path) !== pin[name].treeSha256)
      throw new Error(`Preflight: ${name} closure mismatch/missing`);
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC" };
  if (
    run(locations.node, ["--version"], locations.npmRoot, env) !==
      pin.node.version ||
    run(
      locations.node,
      [join(locations.npmRoot, "bin/npm-cli.js"), "--version"],
      locations.npmRoot,
      env,
    ) !== pin.npm.version
  )
    throw new Error("Preflight: Node/npm version mismatch");
  // All local Node children must use this same executable, including compiler/adapter.
  if (sha256(readFileSync(process.execPath)) !== pin.node.sha256)
    throw new Error("Preflight: runtime Node mismatch");
  return structuredClone(locations);
}
