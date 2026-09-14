# Trusted registry-egress proxy artifact contract

Status: design proposal; no implementation or accepted decision is changed.

This document supplies the proxy-artifact authority missing from D067. It is
deliberately narrower than a general forward proxy. It does not amend D056-D067,
frozen experiments, S003/T003, or any existing implementation. It supersedes
only the provisional proxy-artifact choices in
`trusted-registry-egress-boundary-design.md` if the proposed D068 is accepted.

## 1. Recommended implementation strategy

Approve a small Stirpi-owned proxy image implementing this contract directly.
Its single executable should use a memory-safe language with a small,
inspectable networking surface; the reference implementation should be a
statically linked Go executable built with `CGO_ENABLED=0`. Any DNS wire-format
package needed to make the resolve-once boundary explicit must be narrowly
pinned and included in source/build provenance; it must not be replaced by the
host libc resolver. The production image contains the executable and the
minimum required identity files only. It contains no shell, package manager,
dynamic loader, general proxy daemon, CA private key, configuration generator,
or administrative endpoint.

A digest-pinned third-party proxy is not recommended. Products such as Squid
can express CONNECT and destination ACLs, but the required behavior also needs
strict authority parsing, resolve-once then numeric-address dialing, rejection
when _any_ answer is non-public, a versioned embedded address classifier, and a
deterministic effective-policy attestation. Proving those properties would
require a Stirpi-owned wrapper and product-specific configuration audit. That
would be a larger trusted computing base than the purpose-built proxy.

This choice does not create a general proxy platform. Version 1 has one
listener, one policy file, one protocol, one resolver algorithm, one address
classifier, and no extension or plugin mechanism.

## 2. Artifact and release identity

An approved release consists of:

- the source revision in the Stirpi proxy source repository;
- an exact, reviewed build recipe and builder/toolchain image digest;
- dependency lock/material identities (the reference implementation should
  have no non-standard-library runtime dependency);
- the resulting OCI manifest digest for each approved `os/architecture`;
- the OCI config digest and layer digests reachable from that manifest;
- SHA-256 of the executable bytes;
- an SBOM and build-provenance statement binding those inputs to the output;
- conformance results for the exact resulting image digest.

The reviewed release record is shipped with the pinned Stirpi runtime and is
looked up by `(artifact-contract identity, platform manifest digest)`. It is not
a second artifact selector and the profile does not reference it separately.
Its exact bytes and SHA-256 are retained as evidence. Preflight fails if the
configured/resolved digest has no approval record or if the record's source,
build, executable, OCI, SBOM, or conformance bindings are internally
inconsistent. No live transparency service or mutable registry metadata is
required to establish approval at run time.

The verification profile is authoritative for:

```text
configured OCI digest reference
profile os/architecture
artifact contract = stirpi.registry-egress-proxy-artifact/1
proxy protocol    = stirpi.connect-only/1
policy schema     = stirpi.registry-egress-policy/1
resolver policy   = stirpi.resolve-once/1
address policy    = stirpi.public-address/1
```

The runtime resolves the configured reference for the exact platform and
records both the configured digest and the resolved platform manifest, config,
and image identities. It rejects a local image that merely has a matching tag
or name.

The profile does not separately pin the executable, layer, source-revision, or
build-recipe hashes. The immutable platform manifest already commits to its OCI
config and layers, including the executable. Repeating subordinate hashes as
independent profile authority would create disagreement cases without adding a
stronger trust boundary. Those identities remain required release provenance
and run evidence, and are checked when approving an image digest. A future
decision may require signed or reproducible-build verification; version 1 does
not claim bit-for-bit reproducibility merely because provenance is recorded.

## 3. Fixed OCI and entrypoint contract

The approved image has this exact observable OCI configuration:

```text
Entrypoint:  ["/stirpi-registry-egress-proxy"]
Cmd:         []
WorkingDir:  "/"
User:        "65532:65532"
Env:         []
ExposedPorts: empty
Volumes:      empty
StopSignal:   "SIGTERM"
Healthcheck:  absent
```

The runtime must not override the entrypoint and must pass no command or argv.
The profile contains no argv, environment, listen address, attestation path, or
product-configuration field for the proxy.

The executable has these fixed inputs and outputs:

- reads exactly one policy file at `/run/stirpi-egress/policy.json`;
- listens only on the per-preparation internal IPv4 address in the trusted
  launch object and fixed port `3128`;
- accepts clients only from the exact preparer IPv4 address in that launch
  object;
- reads resolver endpoints from `/etc/resolv.conf` once during startup;
- writes exactly one readiness record as one JSON line to stdout;
- writes bounded diagnostic events to stderr and never writes secrets there;
- accepts termination through `SIGTERM`/`SIGINT`; `SIGHUP` terminates rather
  than reloading configuration;
- exposes no other file, socket, signal, environment, flag, API, or management
  interface that can change effective policy.

Any argv causes startup failure. The proxy does not consult environment
variables. The runtime supplies no environment override and attests the image's
empty configured environment. The policy is opened without following symlinks,
must be a regular file, is read once before the listener is created, and is
closed after parsing. Effective policy is immutable in process memory. The
runtime mounts that one file
read-only; it does not mount a writable attestation channel into the container.

## 4. Strict policy file

The complete policy-file shape is:

```json
{
  "launch": {
    "allowedClientAddress": "<canonical internal IPv4 address>",
    "challenge": "<64 lower-case hexadecimal characters>",
    "listenerAddress": "<canonical internal IPv4 address>"
  },
  "policy": {
    "addressPolicy": "stirpi.public-address/1",
    "allowedDestinations": [{ "host": "registry.npmjs.org", "port": 443 }],
    "protocol": "stirpi.connect-only/1",
    "resolverPolicy": "stirpi.resolve-once/1"
  },
  "policySchema": "stirpi.registry-egress-policy/1",
  "policySha256": "sha256:<64 lower-case hexadecimal characters>"
}
```

`launch.challenge` is a fresh 256-bit value generated by the trusted runtime.
The two addresses are taken from the runtime's already validated,
non-overlapping per-preparation internal-network plan. They must be distinct
canonical private IPv4 addresses within that network. These fields bind the
process to one launch and topology but are not profile authority. Define:

```text
EffectivePolicyV1 = {
  policySchema: "stirpi.registry-egress-policy/1",
  policy: <the policy object above>
}

policySha256 = "sha256:" +
  lower-hex(SHA-256(JCS(EffectivePolicyV1)))
```

JCS means RFC 8785 JSON Canonicalization Scheme. Because version 1 admits only
ASCII strings and integers, no implementation-dependent Unicode or floating
point behavior is involved. The entire file must itself equal the JCS encoding
of its parsed value followed by one LF byte. It must be UTF-8 without BOM and
at most 32 KiB.

Validation is closed and fail-closed:

- exactly the displayed fields are allowed at every object level;
- JSON duplicate member names are rejected before ordinary object decoding;
- the destination array has 1 through 32 entries, sorted by host byte order
  then numeric port, with no duplicates;
- version 1 permits only port `443`;
- all identifiers must equal the supported literals exactly;
- launch addresses must be distinct canonical private unicast IPv4 addresses
  that exactly equal the runtime's independently inspected network plan;
- `policySha256` must equal the independently recomputed digest;
- unknown fields, unknown versions, noncanonical bytes, invalid values,
  trailing data, and over-limit input terminate startup before binding.

The runtime derives `allowedDestinations` from sorted, canonical HTTPS origins
and the allowed ports in the trusted profile. Candidate files never contribute
policy bytes. There is no include, default, wildcard, environment substitution,
template, DNS override, authentication, or reload facility.

## 5. Host and authority normalization

Profile origins, generated policy destinations, and CONNECT authorities use one
normalization algorithm:

1. An origin must parse as an absolute `https` origin with no userinfo, path
   other than empty or `/`, query, or fragment.
2. A CONNECT target must be an HTTP/1.1 authority-form target containing
   exactly one explicit decimal port and no userinfo, scheme, path, query,
   fragment, percent escape, whitespace, control byte, or NUL.
3. The host is ASCII only. Uppercase ASCII letters are folded to lowercase.
4. The host contains 1-63 byte labels separated by single dots and is at most
   253 bytes. Empty labels, leading/trailing hyphens, underscores, and a final
   dot are rejected rather than repaired.
5. Version 1 rejects Unicode U-labels and every `xn--` A-label. IDN support is
   intentionally absent, so no locale, UTS-46 mapping, or library version can
   change authority. A future policy version must define IDNA processing before
   either form is accepted.
6. Wildcards and suffix matching are forbidden. An allowed host authorizes
   only that exact normalized host.
7. IPv4 literals, bracketed or unbracketed IPv6 literals, IPvFuture literals,
   zone identifiers, legacy numeric IPv4 spellings, and numeric-looking names
   are forbidden. Version 1 cannot explicitly allow a direct IP CONNECT.

The `Host` header must occur exactly once and its normalized authority must
equal the request-target authority. Conflicting or ambiguous representations
are malformed requests, not alternate spellings.

## 6. Resolver and public-address algorithm

`stirpi.resolve-once/1` is the following algorithm for each accepted CONNECT;
it has no cross-request DNS cache:

1. Complete exact host/port authorization before issuing DNS traffic.
2. Query only the startup-snapshotted resolver endpoints, using an absolute DNS
   name (no search suffix), for A and AAAA records. Normal UDP-to-TCP fallback
   for a truncated answer is part of the same logical resolution attempt.
3. Follow at most eight valid CNAME links within that attempt, reject loops,
   malformed answers, and answers without at least one address, and impose one
   fixed total DNS deadline.
4. Deduplicate returned addresses by their 16-byte normalized value. Convert an
   IPv4-mapped IPv6 address to IPv4 before classification so it cannot bypass
   the IPv4 rules.
5. Apply `stirpi.public-address/1` to every returned candidate. If any candidate
   is prohibited, reject the whole CONNECT. Do not select only a convenient
   public subset from a mixed public/private answer.
6. Sort the validated result deterministically by address family and numeric
   bytes. Dial candidates, with a fixed total connect deadline, only by numeric
   socket address from this saved result. A failed dial may advance to the next
   address in the saved result but must never trigger another resolution.

The resolver must not call a convenience dial API with a hostname. Tests and
review must be able to see the boundary between `Resolve(host) -> []IP` and
`Dial(IP, port)`.

`stirpi.public-address/1` is a Stirpi-owned, versioned classifier with an
embedded, reviewed CIDR table and table SHA-256 recorded in build provenance.
For each address it:

- rejects IPv4-mapped IPv6 after applying the IPv4 classifier;
- rejects any address matched by an entry in the embedded IANA IPv4 or IPv6
  special-purpose registry whose `Global` property is not true;
- rejects unspecified, loopback, private-use/unique-local, link-local,
  shared/carrier-grade NAT, benchmarking, protocol-assignment exceptions that
  are not global, documentation/test, reserved, multicast, discard-only, and
  future-use ranges;
- rejects IPv6 site-local and zone-scoped addresses even if a platform API
  classifies them differently;
- allows an ordinary unicast address not present in the special-purpose table,
  or a matched special-purpose entry only when its embedded entry explicitly
  has `Global=true`.

This positive rule avoids platform-dependent meanings of `isPrivate` or
`isGlobal`. The exact table is immutable for version 1. Later IANA changes
require review, a new address-policy identity, a new image digest, and a new
profile version; they do not silently change an existing run. Multicast and
non-unicast destinations are never dialed.

The effective resolver endpoints and embedded classifier-table digest are
reported in readiness and evidence, but only the named resolver/address-policy
identities are profile authority. Version 1 does not promise a fixed recursive
DNS provider or DNSSEC validation.

## 7. CONNECT data-plane behavior

For each TCP client the proxy:

1. applies fixed connection, header-size, header-count, and header-read limits;
2. accepts exactly one HTTP/1.1 `CONNECT` request and rejects every other
   method, absolute-form request, HTTP/2 preface, and malformed request;
3. normalizes and exactly authorizes `(host, port)` as described above;
4. resolves, validates, saves, and dials only the numeric result as described
   above;
5. returns `200 Connection Established` only after the upstream TCP connection
   exists, then copies opaque bytes bidirectionally under fixed idle, byte, and
   total-duration limits;
6. never parses tunneled TLS, intercepts TLS, follows an HTTP redirect, rewrites
   a destination, adds credentials, or performs generic HTTP forwarding;
7. returns a bounded `400`, `403`, `405`, `502`, or `504` response and closes
   for malformed, unauthorized, resolution/dial, or deadline failures.

Version 1 fixes the relevant bounds: 64 concurrent clients, 8 KiB of request
headers, 64 header fields, a five-second header deadline, a five-second total
DNS deadline, a ten-second total connect deadline, a 60-second tunnel idle
deadline, a ten-minute total tunnel lifetime, and 2 GiB transferred in either
direction per tunnel. Reaching a limit closes only that connection and emits a
bounded reason code; no limit is profile- or candidate-configurable.

Redirects cannot bypass authority: because TLS remains end-to-end, a client
following a redirect to another origin must make a new CONNECT, which undergoes
the same exact check. Direct IP targets are always rejected.

CONNECT-only and proxy-owned DNS are release acceptance properties, not claims
inferred from configuration. The exact image must pass white-box tests with an
injected resolver and numeric dialer, plus black-box tests using controlled DNS
and upstream servers. The tests must demonstrate that non-CONNECT bytes never
reach an upstream, denied authorities cause no DNS query, DNS is emitted by the
proxy namespace rather than the client namespace, the dial target equals a
member of the one saved answer set, and rebinding on a later DNS answer cannot
change an in-flight attempt.

## 8. Readiness and effective-policy attestation

After policy validation, resolver snapshot, listener bind, privilege check, and
installation of the immutable in-memory policy—but before accepting clients—the
proxy writes exactly this JCS object plus LF as its sole stdout record:

```json
{
  "addressClassifierTableSha256": "sha256:<64 lower-case hexadecimal characters>",
  "addressPolicy": "stirpi.public-address/1",
  "artifactContract": "stirpi.registry-egress-proxy-artifact/1",
  "attestationSchema": "stirpi.registry-egress-readiness/1",
  "buildIdentity": "sha256:<approved build-provenance subject digest>",
  "effectivePolicySha256": "sha256:<policy digest>",
  "event": "ready",
  "executableSha256": "sha256:<executable bytes digest>",
  "launchChallenge": "<copied launch.challenge>",
  "listener": {
    "address": "<copied launch.listenerAddress>",
    "allowedClientAddress": "<copied launch.allowedClientAddress>",
    "port": 3128
  },
  "policySchema": "stirpi.registry-egress-policy/1",
  "protocol": "stirpi.connect-only/1",
  "resolverEndpoints": [{ "address": "<canonical numeric IP>", "port": 53 }],
  "resolverPolicy": "stirpi.resolve-once/1",
  "runtime": { "gid": 65532, "uid": 65532 }
}
```

Resolver endpoints are sorted and unique and must be numeric addresses.
Resolver search domains and options are not used because the proxy emits only
absolute queries; environment-derived resolver or proxy values are forbidden.
The process exits if it cannot produce the complete record. It emits no partial
or second readiness record. The proxy begins accepting only after the complete
line has been written.

Stirpi reads stdout through Docker logs for the exact newly created container
ID, with a bounded byte count and deadline. It requires exactly one valid
record, the fresh challenge, supported literal identities, expected listener,
allowed client, expected uid/gid, approved build/executable evidence for that
image release, and exact equality between `effectivePolicySha256` and its independently
computed profile-derived digest. It then confirms the same container is still
running. Once the preparer exists, a fixed unauthorized-CONNECT probe runs
before installation. A port-open test alone is never readiness.

The readiness record does not self-authenticate the OCI image digest: a process
inside a normal container cannot authoritatively discover that identity.
Stirpi binds the record to the image by obtaining it from the exact container
ID, comparing the fresh challenge, and independently inspecting that
container's immutable configured/resolved image identities. Preparation code is
not started until this succeeds; it has no Docker API, log, stdout, pid, mount,
or network path capable of forging the record.

## 9. Docker-side attestation

Before starting dependency installation, inspection by immutable Docker object
ID must establish all of the following:

- configured and resolved proxy manifest, image, config, platform, and
  architecture equal the approved profile resolution;
- OCI entrypoint, empty command, user, working directory, stop signal, empty
  declared volumes/ports, and absence of a healthcheck equal section 3;
- runtime did not override entrypoint or add argv or policy-relevant environment;
- root filesystem is read-only; uid/gid is non-root; all capabilities are
  dropped; no-new-privileges is set; privileged mode is false; IP forwarding is
  disabled; host pid/ipc/user/network namespaces and added devices are absent;
- exactly one read-only policy-file bind exists at the fixed path, sourced from
  a freshly created Stirpi-owned directory; no Docker socket, candidate volume,
  preparation input/output, trusted host tree, secret, or unexpected mount is
  present;
- the proxy is attached exactly to the owned internal and outbound networks,
  at its planned addresses, with no published port;
- the preparer is attached only to the internal isolated network and cannot
  join, route through, or resolve through the outbound network;
- network membership contains only the exact expected container IDs and all
  inspected network options match D067;
- the proxy record, derived effective-policy digest, policy-file digest, and
  fresh launch challenge agree.

Inspection is repeated after the preparer is created and before installation.
Any ambiguity or mismatch is a failure; there is no adoption of pre-existing
resources or fallback topology.

## 10. Verification-profile authority

The minimum schema-2 authority is:

```json
{
  "platform": { "os": "linux", "architecture": "arm64" },
  "images": {
    "egressProxy": {
      "reference": "registry.example/stirpi/registry-egress-proxy@sha256:<64 hex>",
      "artifactContract": "stirpi.registry-egress-proxy-artifact/1",
      "protocol": "stirpi.connect-only/1",
      "policySchema": "stirpi.registry-egress-policy/1"
    }
  },
  "dependencies": {
    "installPolicy": {
      "network": {
        "mode": "registry-only",
        "boundary": "connect-proxy-v1",
        "proxyPolicy": "registry-connect-exact-v1",
        "resolverPolicy": "stirpi.resolve-once/1",
        "addressPolicy": "stirpi.public-address/1",
        "origins": ["https://registry.npmjs.org:443"],
        "destinationPorts": [443]
      }
    }
  }
}
```

`proxyPolicy` retains the D067/profile meaning of exact-host, CONNECT-only
authorization. `protocol` identifies the executable wire/data-plane contract;
they are related but not interchangeable. All identifiers are closed enums.
Origins and ports are sorted, canonical, and mutually consistent. The runtime
derives the semantic policy, per-launch topology fields, and concrete Docker
invocation; the profile does not contain low-level Docker options, executable
hashes, raw product configuration, DNS servers, argv, listener settings, or
readiness plumbing.

This proposal changes no existing profile or code. If D068 is accepted,
schema-2 validation and profiles must add the displayed artifact, protocol,
policy-schema, and address-policy authority before live preparation is enabled.

## 11. Lifecycle ownership

The trusted runtime exclusively owns:

1. profile validation and canonical effective-policy construction;
2. fresh challenge and private temporary policy-file creation;
3. exact image/platform resolution;
4. creation of both per-preparation networks and the proxy container;
5. policy mounting, startup, readiness capture, and effective-policy comparison;
6. Docker-side topology and hardening attestation;
7. creation and start of the preparation container only after proxy readiness;
8. fixed probes, dependency installation, bundle export, validation, and seal;
9. termination/removal of preparer then proxy, networks, volumes, and policy
   material, with exact-ID cleanup evidence.

Policy storage is created outside the candidate repository, owned by the
trusted runtime, inaccessible to the preparer, and mounted only read-only into
the proxy. Preparation/candidate code receives no shared mount, Docker socket,
namespace, signal channel, management port, or credential with which to mutate
the policy, proxy, or topology.

## 12. Failure taxonomy

Control-plane failures are distinct from data-plane denial observations:

| Code                                          | Meaning                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DEPENDENCY_PROXY_ARTIFACT_IDENTITY_MISMATCH` | Configured/resolved manifest, platform, OCI config, contract, build, or executable evidence does not identify the approved artifact. |
| `DEPENDENCY_PROXY_POLICY_MALFORMED`           | Policy bytes, schema, fields, normalization, bounds, ordering, or self-digest are invalid.                                           |
| `DEPENDENCY_PROXY_STARTUP_FAILED`             | Container/process exits or reports a startup error before valid readiness.                                                           |
| `DEPENDENCY_PROXY_READINESS_TIMEOUT`          | No complete valid readiness record arrives before the fixed deadline.                                                                |
| `DEPENDENCY_PROXY_EFFECTIVE_POLICY_MISMATCH`  | Attested effective digest or policy/protocol/resolver/address identity differs from the profile-derived expectation.                 |
| `DEPENDENCY_PROXY_DNS_RESOLUTION_FAILED`      | An authorized name produces timeout, malformed/looping DNS, or no usable address.                                                    |
| `DEPENDENCY_PROXY_PROHIBITED_ADDRESS`         | Any answer for an authorized name fails the versioned public-address classifier.                                                     |
| `DEPENDENCY_PROXY_DESTINATION_DENIED`         | CONNECT authority is well-formed but is not an exact declared host/port.                                                             |
| `DEPENDENCY_PROXY_REQUEST_REJECTED`           | Method or authority syntax violates the CONNECT-only protocol.                                                                       |
| `DEPENDENCY_TOPOLOGY_ATTESTATION_MISMATCH`    | Container, mount, namespace, network, route, membership, or hardening inspection differs from plan.                                  |
| `DEPENDENCY_PROXY_OPERATIONAL_FAILURE`        | An authorized, publicly resolved connection cannot be dialed or maintained within bounded operational limits.                        |
| `DEPENDENCY_CLEANUP_FAILED`                   | One or more exact owned resources or policy artifacts remain after cleanup attempts.                                                 |

The proxy's bounded denial reason is retained so the trusted runtime can map it
without guessing. Destination denial is a candidate/profile compatibility
outcome; malformed policy, identity, readiness, topology, prohibited-address,
and proxy infrastructure failures are operational/security failures. Primary
failures retain cleanup failures rather than being overwritten by them. None
permits a wider proxy, new origin, ordinary bridge, host installation, or other
fallback.

## 13. Provenance and replay

Live evidence persists:

- profile ID/version/path/exact-byte SHA-256 and platform;
- configured and resolved proxy OCI identities;
- artifact-contract, protocol, policy-schema, resolver-policy, and
  address-policy identities;
- approved source/build provenance identity, executable SHA-256, classifier
  table SHA-256, and conformance-suite identity;
- exact canonical policy bytes or a content-addressed immutable reference,
  policy-file SHA-256, and effective-policy SHA-256;
- readiness record and its binding to launch challenge and container ID;
- bounded non-secret DNS answer/selected-address observations and proxy
  allow/deny/operational summaries;
- complete topology/hardening attestation results;
- preparation outcome, bundle identity/seal, and cleanup outcome.

Evidence must not retain credentials, request headers, HTTPS paths, bodies, or
package contents merely to attest the proxy.

Replay validates the recorded hashes and cross-bindings among profile, artifact,
policy, readiness, topology result, preparation result, and bundle result. It
uses the recorded preparation and cleanup outcomes. It must not resolve DNS,
open sockets, inspect or start Docker, contact a registry/proxy/image service,
rebuild a bundle, query a live bundle store, or perform cleanup. A mismatch is a
replay-integrity failure, not a reason to repeat live work.

## 14. Deterministic test plan

Deterministic tests are required at these layers:

1. **Canonical data.** Golden JCS/digest vectors; duplicate-key detection;
   unknown fields/versions; every size/count boundary; ordering and duplicate
   destinations; challenge format; malformed UTF-8; trailing bytes.
2. **Authority parsing.** Matrices for case folding, label/host lengths,
   trailing dots, empty labels, userinfo, schemes/paths, missing/ambiguous ports,
   nondecimal ports, percent escapes, wildcards, Unicode and `xn--`, IPv4 forms,
   bracketed IPv6, mapped IPv6, zone IDs, and Host-header disagreement.
3. **Resolver/address behavior.** Golden CIDR boundary vectors for every
   embedded special-purpose entry; mixed public/private responses; duplicates;
   mapped addresses; CNAME loops/depth; truncation; A/AAAA ordering; empty and
   malformed answers; a spy proving no lookup before authorization, one logical
   resolution per accepted attempt, and numeric-only dials from the saved set.
4. **Protocol behavior.** CONNECT success; every other HTTP method; absolute
   form and HTTP/2 preface; bounded headers/timeouts/tunnels; upstream byte spy;
   no TLS interpretation; exact response classes; no redirect handling; no
   configuration reload.
5. **Artifact/entrypoint.** OCI config fixture equality, no shell/tools/extra
   files, static executable inspection, embedded build identities, policy-path
   file checks, stdout single-record rule, signal behavior, non-root operation.
6. **Readiness binding.** Wrong/stale challenge, wrong container, duplicate or
   oversized stdout, crash after ready, digest/identity/listener/resolver/table
   mismatches, deadline, and independently computed expected digest.
7. **Docker orchestration.** Exact create/inspect transcripts for image,
   entrypoint, argv, env, mounts, caps, namespaces, networks, members, routes,
   and repeated pre-install inspection; every mismatch prevents installation.
8. **Lifecycle/failure.** Fault injection after each acquisition/start step,
   exact reverse cleanup, combined primary/cleanup errors, and no-fallback spies.
9. **Replay.** Identity/hash mismatch fixtures and adapters that fail the test
   if DNS, sockets, Docker, registries, image services, proxies, bundle stores,
   or cleanup are touched.

The release conformance suite additionally runs controlled-namespace integration
tests proving CONNECT-only behavior, proxy-owned DNS, mixed-answer denial, and
resolve-once numeric dialing against the exact built image. Mocked Docker tests
are not represented as proof of packet isolation.

## 15. Real acceptance-smoke plan

After human approval, implementation, and approval of an exact proxy image
digest, one opt-in local smoke may validate the complete boundary. This design
task does not run it and it is not a pilot.

The smoke must:

1. resolve and attest the configured proxy/preparer image digests for the exact
   platform, start the owned topology, and validate readiness plus Docker state;
2. CONNECT to the declared registry and complete a small HTTPS operation with
   normal end-to-end certificate validation;
3. CONNECT to a stable undeclared public HTTPS host and receive an explicit
   proxy destination denial with evidence that no DNS/upstream connection was
   attempted for it;
4. use a controlled allowed DNS name returning loopback/private and then a
   mixed public/private result, requiring explicit prohibited-address denial
   and no upstream dial;
5. remove proxy variables in the preparer and require numeric direct TCP, DNS,
   and alternate HTTP/HTTPS attempts to fail, supported by route/topology
   inspection rather than timeout alone;
6. attempt every preparer-visible policy/proxy mutation surface and establish
   that the policy file, Docker API, pid/signal namespace, management endpoint,
   proxy mounts, and outbound network are absent or inaccessible; then require
   the effective-policy digest to remain unchanged;
7. perform the fixed dependency installation, validate and seal the bounded
   bundle, then run the verifier with network disabled and consume that bundle
   read-only in a fixed offline check;
8. force teardown, query every exact resource ID and ownership label, and prove
   all containers, networks, volumes, mounts, and policy material are gone.

The smoke report records each assertion separately. A denial that is only an
unexplained timeout is insufficient. Cleanup failure does not erase the primary
outcome.

## 16. Exact proposed human-owned decision

The following text is proposed for human acceptance and later addition to
`docs/DECISIONS.md`. It is not accepted or added by this task.

### D068 — Registry egress uses a fixed Stirpi-owned proxy artifact contract

Status: proposed

The D067 registry-egress proxy is a small Stirpi-owned, digest-pinned container
artifact whose only data-plane operation is HTTP/1.1 CONNECT. Its approved
artifact contract fixes its image entrypoint, empty argv, non-root runtime
identity, listener, policy path, protocol version, policy-schema version,
resolver behavior, public-address classifier, readiness record, and absence of
reload, management, generic HTTP-forwarding, and TLS-interception facilities.
A general-purpose or third-party proxy is not authorized merely because it can
be configured to approximate these behaviors.

The trusted verification profile pins the immutable proxy image digest for an
explicit platform and architecture together with the artifact-contract,
protocol, policy-schema, resolver-policy, and address-policy identities. The
image digest is the profile's artifact identity; subordinate executable,
source, build, config, layer, SBOM, and conformance identities are approval and
provenance evidence rather than redundant profile authority.

The trusted runtime creates the only proxy policy file from exact canonical
profile origins and ports. The closed, bounded, canonical policy file contains
exact runtime-derived listener/client topology, a fresh launch challenge, exact
host-and-port destinations, and versioned protocol, resolver, and
address-policy identities. Its semantic policy digest excludes only the
launch-specific topology and challenge, and therefore equals the trusted
runtime's digest of the exact profile-derived policy. It rejects duplicates,
unknown fields or versions, wildcards, IP literals, trailing-dot aliases, and
IDNs. The proxy fails before listening unless the policy is canonical and its
declared digest equals the digest of its effective semantic policy. Candidate
or preparation code cannot supply, mount, modify, or reload policy.

For every accepted CONNECT, the proxy authorizes the normalized hostname and
explicit port before DNS, resolves the name itself exactly once, rejects the
whole attempt if any returned address is not public under the pinned Stirpi
address-policy algorithm, and dials only numeric addresses from that saved
validated result without re-resolution. Direct IP CONNECT, ordinary HTTP
forwarding, redirects performed by the proxy, and TLS interception are
forbidden.

Readiness is a single bounded machine-readable record emitted by the fixed
process after policy validation, resolver snapshot, listener creation, and
effective-policy installation. It binds a fresh runtime challenge to the
artifact/protocol/policy identities, effective-policy digest, listener,
resolver observations, and build evidence. The runtime accepts it only from
the exact launched container ID, independently matches the effective-policy
digest to the profile-derived policy, confirms the container remains running,
and separately attests the exact image, OCI entrypoint, argv, mounts, hardening,
and network topology before dependency installation. A listening port alone is
not readiness.

The trusted runtime owns policy creation, networks, proxy, readiness and
topology attestation, preparation, bundle sealing, and exact-resource cleanup.
Evidence preserves their identities and distinct outcomes. Replay validates
the recorded identity bindings and outcomes without DNS, network, proxy,
Docker, image, registry, resolver, bundle-store, or cleanup work.
