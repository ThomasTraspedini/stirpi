import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  bundleIdentity,
  dependencyBundleKey,
  sealDependencyBundle,
  type BundleProvenance,
} from "./dependency-bundle.js";
import type { ResolvedImageIdentity } from "./preflight.js";
import { type LoadedProfile } from "./trusted-profile.js";
import {
  registryOriginForUrl,
  registryEgressPolicy,
  createEgressPolicyFile,
  freshLaunchChallenge,
} from "./egress-policy.js";

export type DependencyPreparationFailureCode =
  | "DEPENDENCY_EGRESS_POLICY_INVALID"
  | "DEPENDENCY_PROXY_ARTIFACT_IDENTITY_MISMATCH"
  | "DEPENDENCY_PROXY_POLICY_MALFORMED"
  | "DEPENDENCY_PROXY_IMAGE_UNAVAILABLE"
  | "DEPENDENCY_NETWORK_CAPABILITY_UNAVAILABLE"
  | "DEPENDENCY_NETWORK_CREATE_FAILED"
  | "DEPENDENCY_PROXY_STARTUP_FAILED"
  | "DEPENDENCY_PROXY_READINESS_TIMEOUT"
  | "DEPENDENCY_PROXY_EFFECTIVE_POLICY_MISMATCH"
  | "DEPENDENCY_PROXY_DNS_RESOLUTION_FAILED"
  | "DEPENDENCY_PROXY_PROHIBITED_ADDRESS"
  | "DEPENDENCY_PROXY_DESTINATION_DENIED"
  | "DEPENDENCY_PROXY_OPERATIONAL_FAILURE"
  | "DEPENDENCY_PROXY_LAUNCH_FAILED"
  | "DEPENDENCY_PROXY_POLICY_MISMATCH"
  | "DEPENDENCY_TOPOLOGY_ATTESTATION_MISMATCH"
  | "DEPENDENCY_TOPOLOGY_MISMATCH"
  | "DEPENDENCY_EGRESS_ALLOWED_PROBE_FAILED"
  | "DEPENDENCY_EGRESS_DENY_PROBE_FAILED"
  | "DEPENDENCY_REGISTRY_POLICY_DENIED"
  | "DEPENDENCY_REGISTRY_INSTALL_FAILED"
  | "DEPENDENCY_BUNDLE_OUTPUT_MISSING"
  | "DEPENDENCY_BUNDLE_SEAL_FAILED"
  | "DEPENDENCY_CLEANUP_FAILED";
export class DependencyPreparationError extends Error {
  cleanupFailures: readonly string[];
  constructor(
    readonly code: DependencyPreparationFailureCode,
    message: string,
    cleanupFailures: readonly string[] = [],
  ) {
    super(message);
    this.name = "DependencyPreparationError";
    this.cleanupFailures = cleanupFailures;
  }
}
export interface DockerDependencyCommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}
export type DockerDependencyCommand = (
  args: readonly string[],
  timeoutMs?: number,
) => DockerDependencyCommandResult;
export const dockerDependencyCommand: DockerDependencyCommand = (
  args,
  timeoutMs,
) => {
  const result = spawnSync("docker", [...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "" },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? undefined,
    stderr: result.stderr ?? undefined,
    ...(result.error ? { error: result.error } : {}),
  };
};
export interface PreparedDependencyBundle {
  provenance: BundleProvenance;
  readOnlyMount: readonly string[];
}
const ok = (r: DockerDependencyCommandResult) => r.status === 0 && !r.error;
const reason = (r: DockerDependencyCommandResult) =>
  r.stderr || r.error?.message || "Docker command failed";
function inside(root: string, candidate: string) {
  const path = resolve(root, candidate);
  if (relative(root, path).startsWith(".."))
    throw new DependencyPreparationError(
      "DEPENDENCY_EGRESS_POLICY_INVALID",
      "Dependency input escapes authoritative workspace",
    );
  return path;
}
function lockfileOrigins(lock: Buffer, allowed: readonly string[]) {
  let json: unknown;
  try {
    json = JSON.parse(lock.toString("utf8"));
  } catch {
    throw new DependencyPreparationError(
      "DEPENDENCY_EGRESS_POLICY_INVALID",
      "Supported package lockfile must be JSON",
    );
  }
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        k === "resolved" &&
        typeof v === "string" &&
        /^https?:\/\//i.test(v)
      ) {
        let origin: string;
        try {
          origin = registryOriginForUrl(v);
        } catch {
          throw new DependencyPreparationError(
            "DEPENDENCY_REGISTRY_POLICY_DENIED",
            "Invalid lockfile resolved URL",
          );
        }
        if (!allowed.includes(origin))
          throw new DependencyPreparationError(
            "DEPENDENCY_REGISTRY_POLICY_DENIED",
            `Lockfile declares undeclared registry origin ${origin}`,
          );
      }
      walk(v);
    }
  };
  walk(json);
}
/** Owns the complete disposable D067 topology. No caller can inject a network or proxy policy. */
export class DockerDependencyPreparationService {
  constructor(private readonly command: DockerDependencyCommand) {}
  prepare(
    profile: LoadedProfile,
    workspace: string,
    store: string,
    preparer: ResolvedImageIdentity,
    proxy: ResolvedImageIdentity,
  ): PreparedDependencyBundle {
    const trusted = profile.profile;
    let policy;
    try {
      policy = registryEgressPolicy(trusted);
    } catch (e) {
      throw new DependencyPreparationError(
        "DEPENDENCY_EGRESS_POLICY_INVALID",
        e instanceof Error ? e.message : String(e),
      );
    }
    if (
      preparer.role !== "dependencyPreparation" ||
      proxy.role !== ("egressProxy" as never) ||
      preparer.requestedReference !==
        trusted.images.dependencyPreparation.reference ||
      proxy.requestedReference !== trusted.images.egressProxy?.reference ||
      preparer.os !== trusted.platform.os ||
      proxy.os !== trusted.platform.os ||
      preparer.architecture !== trusted.platform.architecture ||
      proxy.architecture !== trusted.platform.architecture
    )
      throw new DependencyPreparationError(
        "DEPENDENCY_EGRESS_POLICY_INVALID",
        "Resolved image authority does not match trusted profile",
      );
    const root = resolve(workspace);
    let manifest: Buffer;
    let lock: Buffer;
    try {
      manifest = readFileSync(
        inside(root, trusted.dependencies.inputs.manifest),
      );
      lock = readFileSync(inside(root, trusted.dependencies.inputs.lockfile));
      lockfileOrigins(lock, trusted.dependencies.installPolicy.network.origins);
    } catch (e) {
      if (e instanceof DependencyPreparationError) throw e;
      throw new DependencyPreparationError(
        "DEPENDENCY_EGRESS_POLICY_INVALID",
        e instanceof Error ? e.message : String(e),
      );
    }
    const id = randomUUID(),
      label = `stirpi.preparation=${id}`,
      internal = `stirpi-${id}-internal`,
      outbound = `stirpi-${id}-outbound`,
      proxyName = `stirpi-${id}-proxy`,
      preparerName = `stirpi-${id}-preparer`,
      input = `stirpi-${id}-input`,
      output = `stirpi-${id}-output`;
    const proxyAddress = "172.30.0.2",
      preparerAddress = "172.30.0.3";
    const policyDir = mkdtempSync(join(tmpdir(), "stirpi-egress-policy-")),
      policyPath = join(policyDir, "policy.json"),
      exportRoot = mkdtempSync(join(tmpdir(), "stirpi-dependency-export-"));
    try {
      writeFileSync(
        policyPath,
        createEgressPolicyFile(policy.policy.allowedDestinations, {
          allowedClientAddress: preparerAddress,
          listenerAddress: proxyAddress,
          challenge: freshLaunchChallenge(),
        }),
        { mode: 0o400 },
      );
    } catch (e) {
      rmSync(policyDir, { recursive: true, force: true });
      rmSync(exportRoot, { recursive: true, force: true });
      throw new DependencyPreparationError(
        "DEPENDENCY_PROXY_POLICY_MALFORMED",
        e instanceof Error ? e.message : String(e),
      );
    }
    const made: { kind: string; id: string }[] = [],
      cleanup: string[] = [];
    let primary: DependencyPreparationError | undefined;
    const run = (a: string[]) =>
      this.command(a, trusted.dependencies.limits.wallTimeMs);
    const req = (a: string[], code: DependencyPreparationFailureCode) => {
      const r = run(a);
      if (!ok(r)) throw new DependencyPreparationError(code, reason(r));
      return r;
    };
    try {
      req(
        ["image", "inspect", trusted.images.dependencyPreparation.reference],
        "DEPENDENCY_PROXY_IMAGE_UNAVAILABLE",
      );
      req(
        ["image", "inspect", trusted.images.egressProxy!.reference],
        "DEPENDENCY_PROXY_IMAGE_UNAVAILABLE",
      );
      req(
        [
          "network",
          "create",
          "--label",
          label,
          "--internal",
          "--ipv6=false",
          "--opt",
          "com.docker.network.bridge.gateway_mode_ipv4=isolated",
          "--subnet",
          "172.30.0.0/29",
          internal,
        ],
        "DEPENDENCY_NETWORK_CREATE_FAILED",
      );
      made.push({ kind: "network", id: internal });
      req(
        [
          "network",
          "create",
          "--label",
          label,
          "--ipv6=false",
          "--subnet",
          "172.30.1.0/29",
          outbound,
        ],
        "DEPENDENCY_NETWORK_CREATE_FAILED",
      );
      made.push({ kind: "network", id: outbound });
      req(
        ["volume", "create", "--label", label, input],
        "DEPENDENCY_NETWORK_CREATE_FAILED",
      );
      made.push({ kind: "volume", id: input });
      req(
        ["volume", "create", "--label", label, output],
        "DEPENDENCY_NETWORK_CREATE_FAILED",
      );
      made.push({ kind: "volume", id: output });
      req(
        [
          "create",
          "--name",
          proxyName,
          "--label",
          label,
          "--network",
          outbound,
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "65532:65532",
          "--sysctl",
          "net.ipv4.ip_forward=0",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=16m",
          "--mount",
          `type=bind,src=${policyPath},dst=/run/stirpi-egress/policy.json,readonly`,
          trusted.images.egressProxy!.reference,
        ],
        "DEPENDENCY_PROXY_STARTUP_FAILED",
      );
      made.push({ kind: "container", id: proxyName });
      req(
        ["network", "connect", "--ip", proxyAddress, internal, proxyName],
        "DEPENDENCY_PROXY_STARTUP_FAILED",
      );
      req(["start", proxyName], "DEPENDENCY_PROXY_STARTUP_FAILED");
      const pi =
        req(["inspect", proxyName], "DEPENDENCY_TOPOLOGY_MISMATCH").stdout ??
        "";
      if (
        !pi.includes(internal) ||
        !pi.includes(outbound) ||
        pi.includes("/var/run/docker.sock")
      )
        throw new DependencyPreparationError(
          "DEPENDENCY_TOPOLOGY_MISMATCH",
          "Proxy topology is not D067 compliant",
        );
      req(
        [
          "create",
          "--name",
          preparerName,
          "--label",
          label,
          "--network",
          internal,
          "--ip",
          preparerAddress,
          "--dns",
          "127.0.0.1",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          trusted.dependencies.isolation.preparerUser,
          "--pids-limit",
          String(trusted.dependencies.limits.pids),
          "--memory",
          String(trusted.dependencies.limits.memoryBytes),
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=64m",
          "--mount",
          `type=volume,src=${input},dst=/input,readonly`,
          "--mount",
          `type=volume,src=${output},dst=/output`,
          "--env",
          "HOME=/tmp",
          "--env",
          `HTTP_PROXY=http://${proxyAddress}:3128`,
          "--env",
          `HTTPS_PROXY=http://${proxyAddress}:3128`,
          "--env",
          `http_proxy=http://${proxyAddress}:3128`,
          "--env",
          `https_proxy=http://${proxyAddress}:3128`,
          "--env",
          "NO_PROXY=",
          "--env",
          "no_proxy=",
          "--env",
          "ALL_PROXY=",
          "--env",
          "all_proxy=",
          "--env",
          `npm_config_proxy=http://${proxyAddress}:3128`,
          "--env",
          `npm_config_https_proxy=http://${proxyAddress}:3128`,
          "--env",
          `npm_config_registry=${trusted.dependencies.installPolicy.network.origins[0]}/`,
          "--env",
          "npm_config_strict_ssl=true",
          "--env",
          "npm_config_ignore_scripts=true",
          trusted.images.dependencyPreparation.reference,
          "/bin/sh",
          "-c",
          'cp /input/package.json /output/package.json && cp /input/package-lock.json /output/package-lock.json && exec "$@"',
          "stirpi-profile-install",
          trusted.dependencies.installPolicy.executable,
          ...trusted.dependencies.installPolicy.argv,
        ],
        "DEPENDENCY_REGISTRY_INSTALL_FAILED",
      );
      made.push({ kind: "container", id: preparerName });
      const ci =
        req(["inspect", preparerName], "DEPENDENCY_TOPOLOGY_MISMATCH").stdout ??
        "";
      if (
        !ci.includes(internal) ||
        ci.includes(outbound) ||
        ci.includes("/var/run/docker.sock")
      )
        throw new DependencyPreparationError(
          "DEPENDENCY_TOPOLOGY_MISMATCH",
          "Preparer has an invalid egress topology",
        );
      req(["start", "-a", preparerName], "DEPENDENCY_REGISTRY_INSTALL_FAILED");
      req(
        ["cp", `${preparerName}:/output/node_modules`, exportRoot],
        "DEPENDENCY_BUNDLE_OUTPUT_MISSING",
      );
      let provenance: BundleProvenance;
      try {
        provenance = sealDependencyBundle(
          store,
          bundleIdentity(
            dependencyBundleKey(
              trusted,
              manifest,
              lock,
              preparer.resolvedPlatformManifestDigest,
            ),
            join(exportRoot, "node_modules"),
          ),
          join(exportRoot, "node_modules"),
        );
      } catch (e) {
        throw new DependencyPreparationError(
          "DEPENDENCY_BUNDLE_SEAL_FAILED",
          e instanceof Error ? e.message : String(e),
        );
      }
      return {
        provenance,
        readOnlyMount: [
          "--mount",
          `type=bind,src=${join(store, provenance.identity.keySha256, "node_modules")},dst=${trusted.dependencies.bundle.targetPath},readonly`,
        ],
      };
    } catch (e) {
      primary =
        e instanceof DependencyPreparationError
          ? e
          : new DependencyPreparationError(
              "DEPENDENCY_REGISTRY_INSTALL_FAILED",
              String(e),
            );
      throw primary;
    } finally {
      for (const item of [...made].reverse()) {
        const r = run(
          item.kind === "container"
            ? ["rm", "-f", item.id]
            : item.kind === "network"
              ? ["network", "rm", item.id]
              : ["volume", "rm", "-f", item.id],
        );
        if (!ok(r)) cleanup.push(`${item.kind}:${item.id}`);
      }
      rmSync(policyDir, { recursive: true, force: true });
      rmSync(exportRoot, { recursive: true, force: true });
      if (cleanup.length && primary) primary.cleanupFailures = cleanup;
      else if (cleanup.length)
        throw new DependencyPreparationError(
          "DEPENDENCY_CLEANUP_FAILED",
          "D067 cleanup failed",
          cleanup,
        );
    }
  }
}
