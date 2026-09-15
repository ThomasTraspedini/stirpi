import { createHash, randomBytes } from "node:crypto";
import {
  isUnicodeScalarString,
  closedAuthorityObject,
  parseAuthorityJson,
  type AuthorityJson,
} from "../authority/json.js";

export const EGRESS_ARTIFACT_CONTRACT =
  "stirpi.registry-egress-proxy-artifact/1";
export const EGRESS_PROTOCOL = "stirpi.connect-only/1";
export const EGRESS_POLICY_SCHEMA = "stirpi.registry-egress-policy/1";
export const EGRESS_RESOLVER_POLICY = "stirpi.resolve-once/1";
export const EGRESS_ADDRESS_POLICY = "stirpi.public-address/1";
export const EGRESS_READINESS_SCHEMA = "stirpi.registry-egress-readiness/1";
export const EGRESS_BOUNDARY = "connect-proxy-v1";
export const EGRESS_PROXY_POLICY = "registry-connect-exact-v1";

/** The five D068 identities, with the same field names as D072 contracts. */
export const EGRESS_CONTRACTS = Object.freeze({
  artifact: EGRESS_ARTIFACT_CONTRACT,
  protocol: EGRESS_PROTOCOL,
  policySchema: EGRESS_POLICY_SCHEMA,
  resolverPolicy: EGRESS_RESOLVER_POLICY,
  addressPolicy: EGRESS_ADDRESS_POLICY,
});
export type EgressContracts = typeof EGRESS_CONTRACTS;
export function validateEgressContracts(value: unknown): EgressContracts {
  const record = closedAuthorityObject(
    value,
    Object.keys(EGRESS_CONTRACTS),
    "Egress contracts",
  );
  for (const [key, expected] of Object.entries(EGRESS_CONTRACTS))
    if (record[key] !== expected)
      throw new Error(`Egress contracts: unsupported ${key}`);
  return { ...EGRESS_CONTRACTS };
}

/** RFC 8785 serialization for validated JSON (UTF-16 key order, ECMAScript primitives). */
export const jcs = (value: AuthorityJson): string => {
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (
    value &&
    typeof value === "object" &&
    Object.keys(value).some((key) => !isUnicodeScalarString(key))
  )
    throw new Error("JCS: invalid authority member name");
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jcs(value[key]!)}`)
      .join(",")}}`;
  if (
    (typeof value === "number" && !Number.isSafeInteger(value)) ||
    (typeof value === "string" && !isUnicodeScalarString(value))
  )
    throw new Error("JCS: invalid authority value");
  return JSON.stringify(value);
};
const privateV4 = /^(10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const ipv4 =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export interface EgressLaunch {
  allowedClientAddress: string;
  listenerAddress: string;
  challenge: string;
}
export interface EgressDestination {
  host: string;
  port: 443;
}
export interface EffectivePolicyV1 {
  policySchema: typeof EGRESS_POLICY_SCHEMA;
  policy: {
    addressPolicy: typeof EGRESS_ADDRESS_POLICY;
    allowedDestinations: EgressDestination[];
    protocol: typeof EGRESS_PROTOCOL;
    resolverPolicy: typeof EGRESS_RESOLVER_POLICY;
  };
}
export interface EgressPolicyFile extends EffectivePolicyV1 {
  launch: EgressLaunch;
  policySha256: string;
}
export interface RegistryNetwork {
  mode: "registry-only";
  boundary: typeof EGRESS_BOUNDARY;
  proxyPolicy: typeof EGRESS_PROXY_POLICY;
  origins: string[];
  destinationPorts: [443];
}

/** Host normalization is for wire authorities; stored profile/policy input must
 * already equal the result. Never let URL parsing repair an authority string.
 */
export function normalizeEgressHost(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 253 ||
    /[^\x21-\x7e]/.test(value)
  )
    throw new Error("Egress policy: invalid hostname");
  const host = value.toLowerCase();
  const labels = host.split(".");
  if (
    labels.some(
      (label) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ||
        label.startsWith("xn--"),
    ) ||
    labels.every((label) => /^(?:[0-9]+|0x[0-9a-f]+)$/.test(label))
  )
    throw new Error("Egress policy: invalid hostname, IP, or IDN");
  return host;
}
export function canonicalRegistryOrigin(value: string): string {
  const match =
    typeof value === "string" ? /^https:\/\/([^/:]+):443$/.exec(value) : null;
  if (!match || normalizeEgressHost(match[1]!) !== match[1])
    throw new Error(
      "Egress policy: registry origin must be canonical HTTPS authority with explicit :443",
    );
  return value;
}
/** Candidate tarball URLs may have paths and omit the default HTTPS port;
 * their authority still uses the same hostname grammar and exact origin set.
 */
export function registryOriginForUrl(value: string): string {
  const match = /^https:\/\/([^/?#]+)(?:[/?#]|$)/.exec(value);
  const authority = match && /^([^:]+)(?::443)?$/.exec(match[1]!);
  if (!authority)
    throw new Error("Egress policy: invalid registry URL authority");
  return canonicalRegistryOrigin(
    `https://${normalizeEgressHost(authority[1]!)}:443`,
  );
}
export function validateRegistryNetwork(value: unknown): RegistryNetwork {
  const network = closedAuthorityObject(
    value,
    ["mode", "boundary", "proxyPolicy", "origins", "destinationPorts"],
    "Egress network",
  );
  if (
    network.mode !== "registry-only" ||
    network.boundary !== EGRESS_BOUNDARY ||
    network.proxyPolicy !== EGRESS_PROXY_POLICY
  )
    throw new Error(
      "Egress network: unsupported mode, boundary, or proxyPolicy",
    );
  if (
    !Array.isArray(network.destinationPorts) ||
    network.destinationPorts.length !== 1 ||
    network.destinationPorts[0] !== 443
  )
    throw new Error("Egress network: destinationPorts must equal [443]");
  if (
    !Array.isArray(network.origins) ||
    !network.origins.length ||
    network.origins.length > 32
  )
    throw new Error("Egress network: origins must have 1 through 32 entries");
  const origins = network.origins.map((origin) =>
    canonicalRegistryOrigin(origin as string),
  );
  if (origins.some((origin, i) => i > 0 && origins[i - 1]! >= origin))
    throw new Error(
      "Egress network: origins must be sorted unique canonical origins",
    );
  return {
    mode: "registry-only",
    boundary: EGRESS_BOUNDARY,
    proxyPolicy: EGRESS_PROXY_POLICY,
    origins,
    destinationPorts: [443],
  };
}
function launchAddress(value: string) {
  if (!ipv4.test(value) || !privateV4.test(value))
    throw new Error(
      "Egress policy: launch address must be canonical private IPv4",
    );
  return value;
}
export function effectivePolicy(
  destinations: readonly EgressDestination[],
): EffectivePolicyV1 {
  if (
    !Array.isArray(destinations) ||
    !destinations.length ||
    destinations.length > 32
  )
    throw new Error("Egress policy: destination count out of bounds");
  const normalized = destinations.map((d) => {
    closedAuthorityObject(d, ["host", "port"], "Egress destination");
    const host = normalizeEgressHost(d.host);
    if (host !== d.host || d.port !== 443)
      throw new Error("Egress policy: noncanonical destination");
    return { host, port: d.port };
  });
  if (
    normalized.some(
      (d, index) => index > 0 && normalized[index - 1]!.host >= d.host,
    )
  )
    throw new Error(
      "Egress policy: destinations must be sorted, exact HTTPS entries",
    );
  return {
    policySchema: EGRESS_POLICY_SCHEMA,
    policy: {
      addressPolicy: EGRESS_ADDRESS_POLICY,
      allowedDestinations: normalized,
      protocol: EGRESS_PROTOCOL,
      resolverPolicy: EGRESS_RESOLVER_POLICY,
    },
  };
}
export function effectivePolicyBytes(value: EffectivePolicyV1): Buffer {
  closedAuthorityObject(value, ["policySchema", "policy"], "EffectivePolicyV1");
  const policy = closedAuthorityObject(
    value.policy,
    ["addressPolicy", "allowedDestinations", "protocol", "resolverPolicy"],
    "EffectivePolicyV1.policy",
  );
  if (
    value.policySchema !== EGRESS_POLICY_SCHEMA ||
    policy.addressPolicy !== EGRESS_ADDRESS_POLICY ||
    policy.protocol !== EGRESS_PROTOCOL ||
    policy.resolverPolicy !== EGRESS_RESOLVER_POLICY
  )
    throw new Error("Egress policy: unsupported contract");
  return Buffer.from(
    jcs(
      effectivePolicy(
        value.policy.allowedDestinations,
      ) as unknown as AuthorityJson,
    ),
    "utf8",
  );
}
export const effectivePolicySha256 = (value: EffectivePolicyV1) =>
  `sha256:${createHash("sha256").update(effectivePolicyBytes(value)).digest("hex")}`;
export function registryEgressPolicy(profile: {
  schemaVersion: 2;
  images: { egressProxy: { contracts: EgressContracts } };
  dependencies: { installPolicy: { network: RegistryNetwork } };
}): EffectivePolicyV1 {
  if (profile.schemaVersion !== 2)
    throw new Error("Egress policy: live profile schema 2 is required");
  validateEgressContracts(profile.images.egressProxy.contracts);
  const network = validateRegistryNetwork(
    profile.dependencies.installPolicy.network,
  );
  return effectivePolicy(
    network.origins.map((origin) => ({ host: origin.slice(8, -4), port: 443 })),
  );
}
export const registryEgressPolicySha256 = (
  profile: Parameters<typeof registryEgressPolicy>[0],
) => effectivePolicySha256(registryEgressPolicy(profile));

export function createEgressPolicyFile(
  destinations: readonly EgressDestination[],
  launch: EgressLaunch,
): Buffer {
  const semantic = effectivePolicy(destinations);
  closedAuthorityObject(
    launch,
    ["allowedClientAddress", "listenerAddress", "challenge"],
    "Egress launch",
  );
  if (
    launchAddress(launch.allowedClientAddress) ===
      launchAddress(launch.listenerAddress) ||
    !/^[a-f0-9]{64}$/.test(launch.challenge)
  )
    throw new Error("Egress policy: invalid launch binding");
  return Buffer.from(
    `${jcs({ launch: { ...launch }, ...semantic, policySha256: effectivePolicySha256(semantic) } as unknown as AuthorityJson)}\n`,
  );
}
export const freshLaunchChallenge = () => randomBytes(32).toString("hex");
export function parseEgressPolicyFile(bytes: Buffer): EgressPolicyFile {
  if (bytes.length > 32 * 1024 || !bytes.subarray(-1).equals(Buffer.from("\n")))
    throw new Error("Egress policy: noncanonical bytes");
  const parsed = parseAuthorityJson(bytes);
  closedAuthorityObject(
    parsed,
    ["launch", "policy", "policySchema", "policySha256"],
    "Egress policy file",
  );
  const v = parsed as unknown as EgressPolicyFile;
  if (
    v.policySha256 !==
    effectivePolicySha256({ policySchema: v.policySchema, policy: v.policy })
  )
    throw new Error("Egress policy: identity or digest mismatch");
  const expected = createEgressPolicyFile(
    v.policy.allowedDestinations,
    v.launch,
  );
  if (!expected.equals(bytes))
    throw new Error("Egress policy: noncanonical JSON");
  return v;
}
