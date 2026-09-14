# Trusted registry-only egress boundary

Status: design proposal; no implementation or accepted decision is changed.

This proposal refines the dependency-preparation boundary required by D058,
D060, D061, D062, and D066. It does not change D056-D066, frozen experiments,
or S003/T003.

## 1. Recommendation

Use a per-preparation, deny-by-default Docker topology with a digest-pinned,
CONNECT-only forward proxy:

```text
preparation container
  eth0: per-preparation internal network only
  DNS: loopback blackhole
  HTTPS_PROXY: http://<proxy-internal-ip>:3128
                |
                | HTTP CONNECT for exact host:port only
                v
trusted egress-proxy container
  eth0: per-preparation internal network
  eth1: per-preparation outbound network
  resolves allowed names; rejects non-public results
                |
                v
declared HTTPS registry origins only
```

The concrete proxy primitive should be a small, versioned proxy image whose
only data-plane operation is HTTP `CONNECT`. Its policy language is
`registry-connect-exact-v1`, defined below. A mature proxy such as Squid may be
packaged in that image, provided the image has a fixed entrypoint which emits
and enforces exactly this restricted policy. Stirpi must not expose a general
Squid configuration surface in the profile.

This is preferable to treating an arbitrary named Docker bridge as trusted.
A normal bridge provides masqueraded external access by default. Docker
documents `--internal` networks for containers that do not need external
access, and Docker Engine 28 added bridge `gateway_mode=isolated` to prevent an
internal network from retaining a host-accessible bridge address. The design
requires both properties and fails preflight when the active engine cannot
attest them. See [Docker networking](https://docs.docker.com/engine/network/),
[bridge networking](https://docs.docker.com/engine/network/drivers/bridge/),
and [isolated gateway mode](https://docs.docker.com/engine/network/port-publishing/#gateway-modes).

### Alternatives considered

| Alternative | Result |
| --- | --- |
| Manually pre-created/named bridge | Reject. Its name does not attest topology, routes, occupants, or lifecycle. |
| `--internal` bridge alone | Reject. It removes ordinary external egress but, without isolated gateway mode, may retain access to services on the bridge gateway/host. |
| Proxy variables on a normal bridge | Reject. Proxy variables are routing hints and direct sockets bypass them. |
| macOS `pf`, OrbStack VM rules, or host firewall rules | Reject for this milestone. They are host-global, environment-specific, race-prone to install/remove, and harder to bind to one preparation and attest through Docker. |
| Transparent proxy using container iptables | Reject. It requires `NET_ADMIN`, complicates DNS and TLS, and enlarges the trusted boundary. |
| TLS interception | Reject. It adds a private CA/key, weakens end-to-end registry authentication, and is unnecessary for origin enforcement. |
| Registry mirror/cache | Defer. It can provide a stronger content boundary later, but adds service state and registry semantics not required here. |
| General-purpose CONNECT proxy with generated ACLs | Accept only behind the fixed `registry-connect-exact-v1` image contract. Raw product configuration is not profile authority. |

## 2. Exact Docker topology

For preparation instance `P`, the trusted runtime creates all names from a
random instance ID and applies ownership labels containing that ID. Names are
diagnostic only and never establish trust.

### Internal network

`P-internal` is a user-defined IPv4 bridge with:

- `Internal=true`;
- `EnableIPv6=false`;
- `com.docker.network.bridge.gateway_mode_ipv4=isolated`;
- no published ports;
- no manually configured external gateway;
- exactly two members after launch: `P-proxy` and `P-preparer`.

The runtime selects a non-overlapping private subnet and fixed addresses for
the two containers. The proxy ACL accepts clients only from the exact preparer
address, not the entire subnet. No other container may be attached.

### Outbound network

`P-outbound` is a separate, non-internal user-defined IPv4 bridge with IPv6
disabled and no published ports. It has exactly one member: `P-proxy`.
The outbound bridge is not the enforcement point; it merely supplies the proxy
with ordinary egress. The proxy process and its policy are the destination
enforcement point.

### Containers

`P-preparer` is created with only `P-internal`. It has no network attachment
operation after creation. It retains the existing read-only root, non-root
user, capability drop, no-new-privileges, bounded tmpfs/volumes, and bounded
resources. It receives no Docker socket, host filesystem, host environment,
credential store, candidate `.npmrc`, or candidate `node_modules`.

`P-proxy` is created on `P-outbound`, then attached to `P-internal` before it is
started. It has a read-only root, a non-root uid, all capabilities dropped,
no-new-privileges, no Docker socket, no host filesystem, no published port, no
shared candidate/input/output volume, bounded tmpfs, bounded processes/memory,
and IP forwarding disabled. Its only read-only bind is a runtime-generated
policy file from Stirpi-owned temporary storage. It has no configuration reload
API. The runtime removes that temporary file during cleanup.

The outbound network does not make the preparer transitively routed through the
dual-homed proxy: kernel forwarding is disabled and the proxy has no routing
capability. The only intended cross-boundary operation is a TCP connection to
the proxy listener on its fixed internal address.

## 3. Proxy behavior

`registry-connect-exact-v1` has this complete behavior:

1. Listen only on the proxy's internal IPv4 address and fixed unprivileged port.
2. Accept only syntactically valid HTTP/1.1 `CONNECT host:port` from the exact
   preparer IPv4 address.
3. Reject ordinary HTTP methods, absolute-form HTTP requests, missing or
   ambiguous ports, userinfo, IP-literal destinations, wildcard names,
   non-ASCII names, malformed IDNA, trailing-dot aliases, and overlong input.
4. Canonicalize the requested host as lower-case ASCII/Punycode with no trailing
   dot, and compare the pair `(host, port)` for exact equality with the compiled
   allowlist. An allowlist entry never implies subdomains.
5. Allow only a port explicitly present in the profile. Version 1 requires port
   443; a profile cannot authorize plaintext port 80.
6. Resolve an allowed hostname itself. Reject the request if any usable result
   is loopback, link-local, private, carrier-grade NAT, multicast, unspecified,
   documentation/reserved, or otherwise non-global. Connect to one validated
   returned address without a second name lookup.
7. Return a bounded denial/error response for every other case. End the process
   on invalid effective policy or policy-file change; never switch to open or
   report-only behavior.
8. After a successful CONNECT, copy opaque bytes bidirectionally with bounded
   idle, connect, request, and total tunnel timeouts. Do not terminate TLS,
   inject a CA, cache content, rewrite requests, or add registry credentials.
9. Emit bounded structured observations: policy identity, requested authority,
   allow/deny class, DNS answer hashes/selected address, byte counts, and
   timing. Do not log URL paths, headers, authorization, response bodies, or
   package content.

The policy compiler accepts only the profile-derived canonical policy object;
there are no candidate-provided fragments. If an off-the-shelf proxy is used,
its generated product configuration is an internal implementation detail and
must be parse-checked before launch. Squid, for example, supports exact
`dstdomain`, `CONNECT`, and port ACLs with an explicit final deny; its own
documentation warns that rule order and a final `deny all` matter. See
[Squid `http_access`](https://www.squid-cache.org/Doc/config/http_access/) and
[Squid ACL behavior](https://wiki.squid-cache.org/SquidFaq/SquidAcl).

## 4. DNS behavior

The preparation container does not obtain usable registry or arbitrary
external name resolution. It receives the proxy as a literal internal IPv4
address and is created with its only configured upstream DNS server set to a
container-local loopback address with no listener. On a user-defined network,
Docker may still place its embedded `127.0.0.11` stub in the container's
resolver file; Docker documents that this stub normally forwards external
lookups. For the preparer, its effective upstream must instead be the
unreachable container-local resolver, and the connectivity preflight must
prove that arbitrary queries do not resolve or leave through a host resolver.
The local Docker DNS stub, if present, is not treated as an allowed external
destination and must not have a usable external upstream.

The proxy is the only resolver. `proxy-resolve-public-once-v1` means:

- resolve only after an exact hostname/port allowlist match;
- issue only A/AAAA queries for that allowed hostname;
- reject rather than connect if resolution fails or no public result exists;
- validate every candidate address against the non-public/special-use deny set;
- choose one validated address and dial that numeric address without resolving
  again, preventing check/use DNS rebinding;
- record the effective resolver endpoints, answers, selected address, TTL when
  available, and outcome as non-secret preparation provenance.

The profile pins the resolver *policy identity*, not a public recursive DNS
provider. Resolver service identity is deployment evidence because answers and
host DNS configuration can change. A later experiment that needs a particular
resolver may define and pin a separate trusted resolver service; version 1 does
not silently introduce one.

## 5. Redirects and tarball origins

The CONNECT proxy sees only the initial CONNECT authority, not paths or HTTPS
responses. This intentionally preserves end-to-end TLS. Origin policy is still
enforced because a redirect or tarball URL on another HTTPS origin requires a
new connection and therefore a new CONNECT authority. The proxy denies that
connection unless the new exact origin is independently declared. HTTP
destinations fail because version 1 permits CONNECT to port 443 only and permits
no ordinary HTTP forwarding.

Before resource creation, the runtime also parses the supported lockfile form
as data and rejects absolute `resolved` URLs whose canonical origin is outside
the profile allowlist. This gives an early, legible policy failure but is not a
substitute for the proxy: registry metadata and redirects can still introduce
runtime destinations.

For the public npm registry, the default registry is
`https://registry.npmjs.org/`, and npm lockfiles normally express registry
tarballs relative to that registry or as URLs on the same host. npm documents
that an off-registry tarball is represented by a complete URL. Therefore the
minimal npmjs profile should authorize only `https://registry.npmjs.org:443`.
If npm or a dependency needs a CDN, Git host, or any other origin, preparation
fails closed until a human adds that exact origin to a new trusted profile
version. See [npm registry behavior](https://docs.npmjs.com/misc/registry/) and
[npm lockfile `resolved` behavior](https://docs.npmjs.com/cli/v7/configuring-npm/package-lock-json/).

## 6. Profile authority and schema additions

The trusted verification profile must own every semantic egress input. These
new required authority fields must use verification-profile `schemaVersion: 2`;
silently changing the meaning of an already accepted schema-1 profile would be
unsafe. Schema-1 bytes may remain parseable for historical provenance and
replay, but they do not authorize new live dependency preparation after this
boundary is adopted. This does not amend frozen preregistrations or their
historical outcomes.

The following is the proposed schema-2 shape. Field names are normative for the
design but are not implemented by this task:

```json
{
  "schemaVersion": 2,
  "images": {
    "egressProxy": {
      "reference": "registry.example/stirpi/registry-egress-proxy@sha256:<64 hex>"
    }
  },
  "dependencies": {
    "installPolicy": {
      "network": {
        "mode": "registry-only",
        "boundary": "connect-proxy-v1",
        "proxyPolicy": "registry-connect-exact-v1",
        "resolverPolicy": "proxy-resolve-public-once-v1",
        "origins": ["https://registry.npmjs.org:443"],
        "destinationPorts": [443]
      }
    }
  }
}
```

Validation requires:

- `egressProxy.reference` is a fully qualified digest reference and resolves
  for the profile's exact platform and architecture;
- origins are sorted, unique, canonical HTTPS origins with no credentials,
  path, query, fragment, wildcard, trailing dot, or IP literal;
- an omitted port canonicalizes to 443 at parse time, but canonical profile
  bytes should state `:443` explicitly;
- destination ports are sorted, unique, and equal to the ports represented by
  the origins; version 1 accepts only `[443]`;
- boundary, proxy-policy, and resolver-policy identifiers are closed enums;
- no machine-level `registryNetwork`, CLI flag, environment variable, candidate
  file, executor request, or evaluator input may add or override these values.

Define:

```text
RegistryEgressPolicyV1 = {
  schemaVersion: 1,
  boundary,
  proxyPolicy,
  resolverPolicy,
  canonicalOrigins,
  destinationPorts
}

registryEgressPolicySha256 =
  SHA256(canonical-json(RegistryEgressPolicyV1))
```

The dependency-bundle key and provenance must add the configured and resolved
egress-proxy image identities and `registryEgressPolicySha256`. Although the
network policy is already nested in the install policy, the explicit hash makes
the security boundary independently attestable and replay-checkable. The
profile's exact byte hash remains the ultimate authority.

## 7. npm environment contract

Proxy environment variables are necessary routing inputs but not enforcement.
The isolated network is what prevents bypass.

The fixed preparation environment supplies both upper- and lower-case
`HTTP_PROXY`/`HTTPS_PROXY` forms with the literal internal proxy URL, plus
explicit npm `proxy` and `https-proxy` configuration. It supplies the exact
profile registry and keeps `strict-ssl=true`. npm documents that its underlying
fetch library honors these proxy environment variables and that `strict-ssl`
defaults to true. See [npm configuration](https://docs.npmjs.com/cli/using-npm/config/).

The runtime constructs the environment from an empty allowlist and does not
inherit the host. It explicitly clears or sets empty all bypass and alternate
routing inputs, including upper/lower-case `NO_PROXY`, `ALL_PROXY`, npm
`noproxy`, candidate/user/global npm configuration paths, and credential helper
inputs. Only a trusted empty npmrc plus fixed profile-generated npm settings are
visible. The profile-owned executable and argv still include `--ignore-scripts`;
package lifecycle code never runs during preparation.

## 8. Lifecycle ownership

`DockerDependencyPreparationService`, as part of the trusted runtime, owns the
entire per-preparation lifecycle:

1. validate profile, package inputs, lockfile origins, image pins, and engine
   capabilities;
2. resolve/attest both preparation and proxy images for exact platform/arch;
3. create input/output volumes and trusted policy/config temporary material;
4. create `P-internal` and `P-outbound`;
5. create, attach, inspect, and start `P-proxy`;
6. read and validate the proxy's effective-policy startup attestation;
7. create `P-preparer` with only `P-internal` and fixed proxy settings;
8. inspect both containers and networks again;
9. execute fixed connectivity probes;
10. run the fixed dependency installation and export/seal the bundle;
11. stop/remove the preparer, then proxy, then both networks, volumes, and
    temporary configuration;
12. inspect by exact IDs/ownership labels to prove cleanup.

Cleanup is attempted in reverse dependency order after every failure. Resource
IDs, not names or broad label queries, are authoritative cleanup targets. A
manually existing network is never accepted, and an existing same-name resource
causes failure rather than adoption.

## 9. Attestation and preflight contract

### Static validation (no resources, no connectivity)

Static preflight validates:

- exact profile bytes/identity and the closed egress schema;
- canonical origin and destination-port equality;
- supported policy versions;
- package/lockfile input bounds and statically visible lockfile origins;
- digest-pinned preparation and proxy references;
- exact platform/architecture resolution and recorded manifest/image identity;
- Docker Engine capability for internal bridge plus isolated IPv4 gateway;
- absence of fallback configuration and unsupported IPv6 behavior;
- canonical policy bytes and `registryEgressPolicySha256`;
- generated proxy configuration using the proxy image's fixed parse/check mode.

No allowed-origin request is made during static validation.

### Runtime topology attestation

Before any install command reads package inputs, inspect by container/network ID
and require:

- `P-internal` has `Internal=true`, isolated IPv4 gateway mode, IPv6 disabled,
  no published ports, and exactly the proxy and preparer endpoints;
- `P-outbound` is non-internal, IPv6 disabled, has no published ports, and has
  exactly the proxy endpoint;
- the preparer has exactly one network, `P-internal`;
- the proxy has exactly the two intended networks and its internal listener is
  not published;
- both actual images, resolved manifests, platform, users, security options,
  capabilities, mounts, tmpfs, resource limits, and labels match the plan;
- neither container has the Docker socket, host paths, host network/pid/ipc
  namespaces, added hosts, devices, or candidate-controlled environment;
- the preparer's effective DNS upstream is the loopback blackhole, arbitrary
  external resolution fails, and its proxy URI is the exact fixed proxy
  address;
- proxy IP forwarding is disabled;
- proxy startup attestation reports the expected binary/policy version,
  canonical origins/ports, resolver policy, generated-config hash, and
  `registryEgressPolicySha256`.

Any mismatch stops and removes resources before package installation.

### Real connectivity smoke tests

Connectivity checks are distinct from topology/configuration evidence. In the
already-created preparer container, a fixed trusted probe must show:

1. end-to-end-TLS HTTPS through the proxy succeeds for a declared registry;
2. HTTPS through the proxy to a fixed undeclared hostname receives a proxy deny;
3. with all proxy settings removed for the probe, a direct TCP/TLS attempt to a
   currently resolved public registry address fails;
4. external DNS from the preparer fails;
5. the proxy's effective policy remains unchanged after the probes.

Both an allowed request failure and an undeclared request success are
infrastructure failures. These probes are mandatory for the dedicated local
acceptance smoke. Whether they run for every production preparation is a
runtime-policy choice: topology and effective-policy attestation are mandatory
for every preparation, while per-preparation external probes may be disabled
only by a future explicit trusted runtime policy, never by candidate input.

## 10. Fail-closed taxonomy

Failures retain phase and cause; they do not collapse into an npm exit code.

| Code | Class | Meaning |
| --- | --- | --- |
| `DEPENDENCY_EGRESS_POLICY_INVALID` | trusted configuration/preflight | Profile policy is malformed, unsupported, noncanonical, or inconsistent. |
| `DEPENDENCY_PROXY_IMAGE_UNAVAILABLE` | infrastructure | Proxy digest/platform cannot be resolved or inspected exactly. |
| `DEPENDENCY_NETWORK_CAPABILITY_UNAVAILABLE` | infrastructure | Engine cannot establish/attest internal isolated gateway semantics or required IPv4-only behavior. |
| `DEPENDENCY_NETWORK_CREATE_FAILED` | infrastructure | Per-preparation network creation failed. |
| `DEPENDENCY_PROXY_LAUNCH_FAILED` | infrastructure | Proxy could not be created or started with its hardened configuration. |
| `DEPENDENCY_PROXY_POLICY_MISMATCH` | infrastructure/security | Effective proxy policy/config/image differs from profile-derived expectation. |
| `DEPENDENCY_TOPOLOGY_MISMATCH` | infrastructure/security | Attachments, routes, members, mounts, namespace, or hardening differ from the plan. |
| `DEPENDENCY_EGRESS_ALLOWED_PROBE_FAILED` | infrastructure | A declared registry cannot be reached with verified TLS through the proxy. |
| `DEPENDENCY_EGRESS_DENY_PROBE_FAILED` | infrastructure/security | An undeclared or direct-bypass probe succeeds, or fails in an unprovable way. |
| `DEPENDENCY_REGISTRY_POLICY_DENIED` | candidate/profile mismatch | Lockfile, redirect, metadata, or tarball requires an undeclared origin/port. |
| `DEPENDENCY_REGISTRY_INSTALL_FAILED` | ordinary preparation result | Network policy held, but npm failed for another bounded candidate/package reason. |
| `DEPENDENCY_CLEANUP_FAILED` | infrastructure | One or more exact owned resources remain after cleanup attempts. |

Primary failures retain all cleanup failures. The service never falls back to a
normal bridge, host npm, inherited proxy, broader origin, plaintext transport,
unverified image, or manually provisioned network. An ambiguous deny reason is
not reclassified as an ordinary package failure.

## 11. Replay provenance

Live preparation evidence adds:

- exact profile identity and bytes;
- configured and resolved preparation and proxy image identities;
- `registryEgressPolicySha256` and policy identifiers;
- canonical origins and ports;
- generated proxy configuration hash and effective-policy attestation;
- Docker engine/network capability observations and topology attestation;
- non-secret resolver observations and bounded proxy allow/deny summaries;
- dependency-bundle key/identity and complete preparation outcome;
- cleanup outcome and exact leaked resource IDs, if any.

Replay validates internal hashes and cross-references among the recorded
profile, proxy image, policy, preparation outcome, and bundle. It does not
inspect Docker, resolve DNS, probe a registry, start a proxy/network/container,
read the current bundle store, or repeat cleanup. Missing live resources are
expected during replay. This is a refinement of D066, not a new replay effect.

## 12. Deterministic test plan

Use injected Docker-command, image-resolution, policy-compiler, process-output,
clock, and storage adapters. Deterministic tests prove orchestration and
fail-closed interpretation, not real packet isolation.

1. Golden canonical origin and `RegistryEgressPolicyV1` hash vectors.
2. Parser matrices for paths/userinfo, HTTP, wildcards, Unicode/Punycode,
   trailing dots, IP literals, duplicate origins/ports, non-443 ports, and
   unknown policy versions.
3. Bundle-key vectors showing any proxy digest, resolved manifest, policy ID,
   resolver ID, origin, or port change changes the key.
4. Exact command-plan tests for two fresh networks, isolated/internal options,
   fixed IPs, attachment order, IPv6 off, no published ports, and exact IDs.
5. Container-plan tests for read-only roots, users, caps, namespaces, mounts,
   environment allowlists, DNS blackhole, forwarding off, and no Docker socket.
6. Proxy-policy fixtures proving exact-host (not suffix) behavior, CONNECT-only,
   port gating, numeric/special/private address denial, resolve-once dialing,
   bounded logs, and final deny.
7. npm environment tests covering every upper/lower-case proxy and no-proxy
   variable, empty npmrc authority, exact registry, and strict TLS.
8. Lockfile fixtures for same-origin relative/absolute tarballs, other-origin
   tarballs, HTTP, Git, local paths, and redirects represented by the proxy
   transcript.
9. Transcript tests for every inspect/effective-policy mismatch and probe
   outcome, proving installation is never invoked afterward.
10. Cleanup matrices injecting failure after every lifecycle step and checking
    reverse-order exact-ID cleanup and preserved primary/cleanup errors.
11. No-fallback spies proving host npm, default bridge, pre-existing network,
    widened policy, and external adapters are never selected.
12. Replay fixtures whose Docker, DNS, image, proxy, registry, and bundle-store
    adapters throw if called, while every recorded identity mismatch is detected.

These tests must not claim that mocked Docker commands prove packet-level
isolation. Only the real acceptance smoke does that.

## 13. Dedicated local acceptance smoke

Run one opt-in smoke on the supported macOS + OrbStack/Docker environment before
experiment-runner integration and after the proxy image digest is approved. It
uses a public fixture package with no lifecycle scripts and no private material.
It is not a pilot.

The smoke:

1. records Docker/OrbStack versions and resolves the pinned preparation/proxy
   images for the exact host-selected profile platform;
2. creates the complete per-preparation topology and passes every static and
   runtime attestation;
3. fetches a fixed small endpoint from `registry.npmjs.org` through the proxy
   with normal CA validation and records success;
4. attempts `https://example.com:443` through the proxy and requires an explicit
   policy denial before destination connection;
5. resolves a current public registry address in the proxy, then attempts that
   address directly from the preparer with proxy settings removed and requires
   a route/connect failure; it also requires arbitrary DNS from the preparer to
   fail;
6. attempts all candidate-visible mutation surfaces: proxy filesystem path,
   policy path, management endpoint, signal/pid namespace, and Docker socket;
   each must be absent, read-only, unreachable, or denied, and the post-probe
   effective-policy hash must be unchanged;
7. runs the exact fixed npm installation and produces/seals a bounded immutable
   dependency bundle;
8. starts the verifier with network `none`, revalidates and mounts the bundle
   read-only, and runs a fixed offline module-resolution check successfully;
9. forces removal of preparer and proxy, then removes networks, volumes, and
   temporary configuration;
10. queries by the smoke's exact IDs and ownership label and requires that no
    container, network, volume, mount, or temporary policy resource remains.

The smoke fails if a negative test merely times out without evidence of the
expected boundary. Proxy denial must be explicit; direct denial must be
supported by topology/route inspection plus the failed connection. The smoke
emits a bounded non-secret JSON report containing all A-G acceptance outcomes,
identities, attestations, and cleanup status.

## 14. Exact candidate human-owned decision

The following text is proposed for addition after human approval. It is not
added to `docs/DECISIONS.md` by this design task.

### D067 — Dependency preparation uses an attestable registry-only egress boundary

Status: proposed

Dependency preparation that retrieves packages must have no direct route to
general external networks. The trusted runtime creates and owns a disposable
per-preparation internal network and a digest-pinned egress-proxy container. The
preparation container is attached only to the internal network; only the proxy
is attached to an outbound network.

The trusted verification profile owns the proxy image identity, exact allowed
HTTPS registry origins and destination ports, and versioned proxy and DNS
resolution policies. Candidate/package data, executors, evaluators, host
environment, and machine-local defaults cannot add or override that authority.

The proxy permits only CONNECT tunnels to exact declared origin host-and-port
pairs, preserves end-to-end TLS, resolves allowed names itself, rejects
non-public destination addresses, and denies every undeclared destination.
Dependency-preparation containers receive no external DNS path, Docker socket,
trusted-host filesystem, secrets, or authority to modify proxy policy or
network topology.

Before installation, the runtime must attest the configured and resolved proxy
image identity, effective proxy and resolver policy, exact container/network
attachments, absence of a direct preparation-container egress path, and
deny-by-default behavior. Failure to create or attest the boundary is an
operational failure and must not fall back to ordinary Docker networking, host
package installation, or widened origins.

The runtime owns teardown of the preparation container, proxy, networks,
volumes, and policy material. Evidence preserves profile, proxy, egress-policy,
dependency-bundle, preparation, and cleanup identities and outcomes. Replay
validates the recorded identities and outcomes without creating or contacting
any live network, proxy, container, image, registry, resolver, or bundle-store
resource.
