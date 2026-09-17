import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseAuthorityJson, authorityObject } from "../authority/json.js";
import { sha256 } from "./inputs.js";
import type { TrustedLocalContract } from "./trusted-local-contract.js";
import {
  verifyLocalShell,
  verifyLocalTools,
  type LocalToolLocations,
} from "./trusted-local-identity.js";
import type { TrustedProcess } from "./preparation.js";

/** The baseline authorizes operations; candidate identity never grants authority. */
export class TrustedLocalAuthority {
  private baselinePackage?: Record<string, unknown>;
  private baselineLock?: string;
  private readonly config: TrustedLocalContract;
  private readonly locations: LocalToolLocations;
  get contract() {
    return structuredClone(this.config);
  }
  get tools() {
    return structuredClone(this.locations);
  }
  private readonly environment: NodeJS.ProcessEnv;
  private readonly executorPath: string;
  constructor(
    contract: TrustedLocalContract,
    tools: LocalToolLocations,
    stateRoot: string,
    private readonly run: TrustedProcess,
  ) {
    this.config = structuredClone(contract);
    this.locations = structuredClone(tools);
    const bin = join(stateRoot, "trusted-bin"),
      executorBin = join(stateRoot, "executor-bin"),
      home = join(stateRoot, "preparation-home");
    mkdirSync(bin, { recursive: true });
    mkdirSync(executorBin, { recursive: true });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    for (const name of ["node", "git", "docker"] as const)
      symlinkSync(this.locations[name], join(bin, name));
    symlinkSync(
      join(this.locations.npmRoot, "bin/npm-cli.js"),
      join(bin, "npm"),
    );
    for (const name of ["node", "git"] as const)
      symlinkSync(this.locations[name], join(executorBin, name));
    symlinkSync(
      join(this.locations.npmRoot, "bin/npm-cli.js"),
      join(executorBin, "npm"),
    );
    this.executorPath = executorBin;
    // npm 11 rejects loading one config file as both user and global config.
    // Keep both trusted, empty authority files while giving each role its own path.
    const userNpmrc = join(stateRoot, "empty-npmrc-user");
    const globalNpmrc = join(stateRoot, "empty-npmrc-global");
    writeFileSync(userNpmrc, "");
    writeFileSync(globalNpmrc, "");
    this.environment = {
      PATH: bin,
      HOME: home,
      TMPDIR: home,
      LANG: "C.UTF-8",
      TZ: "UTC",
      NPM_CONFIG_USERCONFIG: userNpmrc,
      NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
      NPM_CONFIG_REGISTRY: contract.preparation.npm.registry,
      NPM_CONFIG_SCRIPT_SHELL: this.locations.shell,
      NPM_CONFIG_IGNORE_SCRIPTS: "false",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      DOCKER_CONFIG: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
  }
  env() {
    // Exposing the npm shell authority is an authorized use, so authenticate
    // its current bytes every time before returning the environment.
    verifyLocalShell(this.config, this.locations);
    return { ...this.environment };
  }
  executorEnv(home: string) {
    return {
      PATH: this.executorPath,
      HOME: home,
      TMPDIR: home,
      LANG: "C.UTF-8",
      TZ: "UTC",
    };
  }
  assertTools() {
    verifyLocalTools(this.config, this.locations, this.run);
  }
  private operations(pkg: Buffer) {
    const object = authorityObject(
      parseAuthorityJson(pkg),
      "Candidate package",
    );
    // Only informational fields are removed. Everything else remains baseline authority.
    for (const key of [
      "description",
      "keywords",
      "license",
      "author",
      "bugs",
      "homepage",
      "funding",
    ])
      delete object[key];
    return object;
  }
  assertBaseline(workspace: string) {
    const pkg = readFileSync(join(workspace, "package.json")),
      lock = readFileSync(join(workspace, "package-lock.json"));
    if (
      sha256(pkg) !== this.config.baseline.packageSha256 ||
      sha256(lock) !== this.config.baseline.lockfileSha256
    )
      throw new Error("Preflight: baseline package/lock mismatch");
    this.baselinePackage = this.operations(pkg);
    this.baselineLock = sha256(lock);
    this.assertCandidate(workspace);
  }
  assertCandidate(workspace: string) {
    this.assertTools();
    if (!this.baselinePackage || !this.baselineLock)
      throw new Error("Preflight: baseline authority missing");
    if (existsSync(join(workspace, ".npmrc")))
      throw new Error(
        "Trusted-local operational failure: candidate npm configuration is not covered",
      );
    if (
      !isDeepStrictEqual(
        this.operations(readFileSync(join(workspace, "package.json"))),
        this.baselinePackage,
      )
    )
      throw new Error(
        "Trusted-local operational failure: candidate package operations/dependencies are not covered by baseline authority",
      );
    if (
      sha256(readFileSync(join(workspace, "package-lock.json"))) !==
      this.baselineLock
    )
      throw new Error(
        "Trusted-local operational failure: candidate lock resolution is not covered by baseline authority",
      );
  }
  assertContainer(workspace: string, instance: string, port?: number) {
    const container = JSON.parse(
      this.run(
        this.locations.docker,
        ["inspect", instance],
        workspace,
        this.env(),
      ),
    )[0];
    const binding = container?.NetworkSettings?.Ports?.["5432/tcp"];
    if (
      container?.Image !== this.config.preparation.postgres.imageId ||
      !Array.isArray(binding) ||
      binding.length !== 1 ||
      binding[0]?.HostIp !== "127.0.0.1" ||
      (port !== undefined && Number(binding[0]?.HostPort) !== port)
    )
      throw new Error(
        "Preflight: PostgreSQL container image/loopback lease mismatch",
      );
  }
  assertImage(workspace: string) {
    const pg = this.config.preparation.postgres;
    const image = JSON.parse(
      this.run(
        this.locations.docker,
        ["image", "inspect", pg.imageId],
        workspace,
        this.env(),
      ),
    )[0];
    if (
      image?.Id !== pg.imageId ||
      `${image?.Os}/${image?.Architecture}` !== pg.platform
    )
      throw new Error("Preflight: local image ID/platform mismatch");
  }
}
