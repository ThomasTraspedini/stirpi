# Proxy BuildIdentityV1

Status: normative design for D072

This document defines the deterministic, non-circular build identity required by
D071 for the Stirpi registry-egress proxy. It specifies only pre-build identity
authority and its representation in already-defined release evidence. It does
not authorize a runtime, proxy, builder, registry, or release implementation.

## 1. Strict schema

The identity input is a closed JSON object using JSON Schema draft 2020-12:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://stirpi.dev/schemas/registry-egress-proxy-build-identity-v1.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "kind", "source", "buildDefinition", "builderImage", "target", "buildParameters", "materials", "contracts"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "kind": { "const": "stirpi.registry-egress-proxy-build-identity/1" },
    "source": { "$ref": "#/$defs/source" },
    "buildDefinition": { "$ref": "#/$defs/buildDefinition" },
    "builderImage": { "$ref": "#/$defs/builderImage" },
    "target": { "$ref": "#/$defs/platform" },
    "buildParameters": { "$ref": "#/$defs/buildParameters" },
    "materials": { "type": "array", "maxItems": 0 },
    "contracts": { "$ref": "#/$defs/contracts" }
  },
  "$defs": {
    "sha256": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
    "source": {
      "type": "object", "additionalProperties": false,
      "required": ["repository", "commit"],
      "properties": {
        "repository": { "type": "string", "pattern": "^https://[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[1-9][0-9]{0,4})?/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$", "maxLength": 2048 },
        "commit": {
          "oneOf": [
            { "type": "object", "additionalProperties": false, "required": ["algorithm", "value"], "properties": { "algorithm": { "const": "sha1" }, "value": { "type": "string", "pattern": "^[0-9a-f]{40}$" } } },
            { "type": "object", "additionalProperties": false, "required": ["algorithm", "value"], "properties": { "algorithm": { "const": "sha256" }, "value": { "type": "string", "pattern": "^[0-9a-f]{64}$" } } }
          ]
        }
      }
    },
    "buildDefinition": {
      "type": "object", "additionalProperties": false,
      "required": ["path", "sha256"],
      "properties": { "path": { "const": "proxy/build-definition.json" }, "sha256": { "$ref": "#/$defs/sha256" } }
    },
    "ociReference": { "type": "string", "pattern": "^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$", "maxLength": 327 },
    "platform": {
      "type": "object", "additionalProperties": false, "required": ["os", "architecture"],
      "properties": { "os": { "const": "linux" }, "architecture": { "enum": ["amd64", "arm64"] } }
    },
    "builderImage": {
      "type": "object", "additionalProperties": false, "required": ["reference", "manifestDigest", "platform"],
      "properties": { "reference": { "$ref": "#/$defs/ociReference" }, "manifestDigest": { "$ref": "#/$defs/sha256" }, "platform": { "$ref": "#/$defs/platform" } }
    },
    "buildParameters": {
      "type": "object", "additionalProperties": false,
      "required": ["context", "dockerfile", "targetStage", "additionalBuildArguments"],
      "properties": { "context": { "const": "." }, "dockerfile": { "const": "proxy/Dockerfile" }, "targetStage": { "const": "final" }, "additionalBuildArguments": { "type": "array", "maxItems": 0 } }
    },
    "contracts": {
      "type": "object", "additionalProperties": false,
      "required": ["artifact", "protocol", "policySchema", "resolverPolicy", "addressPolicy"],
      "properties": {
        "artifact": { "const": "stirpi.registry-egress-proxy-artifact/1" },
        "protocol": { "const": "stirpi.connect-only/1" },
        "policySchema": { "const": "stirpi.registry-egress-policy/1" },
        "resolverPolicy": { "const": "stirpi.resolve-once/1" },
        "addressPolicy": { "const": "stirpi.public-address/1" }
      }
    }
  }
}
```

The schema is closed. Version 1 permits no additional build arguments and no
additional downloaded build materials. Either requires a later schema version.

## 2. Semantic constraints

The following constraints are normative in addition to JSON Schema:

1. The source repository is canonical HTTPS: lowercase scheme and DNS host;
   no userinfo, query, fragment, percent escapes, dot segments, or trailing
   slash; default port 443 is omitted; explicit ports are `1..65535`.
2. All v1 strings are ASCII. Repository paths use `/`, are relative, and have
   no empty, `.` or `..` segments. Git OIDs and SHA-256 values are lowercase.
3. The source is a clean materialization of the complete Git tree at the exact
   recorded commit. No working-tree overlay, untracked file, or mutable
   subdirectory is part of the build context.
4. `buildDefinition.sha256` is the digest of the exact regular-file blob at
   `buildDefinition.path` in that commit, without parsing or reserialization.
5. `builderImage.reference` ends in `@` followed by the exact
   `builderImage.manifestDigest`. The resolved digest reference has the recorded
   platform, and `builderImage.platform` equals `target`.
6. `buildParameters` fixes the context, Dockerfile, final output stage, and no
   extra arguments. `BUILDER_IMAGE` is derived from `builderImage.reference`.
   `BUILD_IDENTITY` is derived after hashing and is never an input member.
7. The referenced build definition must select these same Dockerfile, stage,
   target, builder argument, and identity-injection semantics.
8. Release version, output repository, executable, OCI manifest/config/layers,
   SBOM, provenance, conformance, approval, index, timestamps, invocation IDs,
   and all other post-build values are excluded.

## 3. Canonical bytes and hash

Input is decoded as strict UTF-8 JSON with no BOM. Duplicate names, unknown
members, malformed UTF-8, lone surrogate escapes, non-integer numbers, and
trailing non-whitespace bytes are rejected. No input is trimmed, case-folded,
URI-rewritten, path-rewritten, or Unicode-normalized.

After validation, object member order is ignored and the semantic object is
serialized with RFC 8785 JSON Canonicalization Scheme. The result has no
insignificant whitespace and no trailing line feed, and is encoded as strict
UTF-8. Call it `canonicalDocumentBytes`.

The domain string `stirpi.registry-egress-proxy.build-identity.v1` is 46 ASCII
bytes. The domain prefix is those 46 bytes followed by one NUL byte, for a
total of 47 bytes. Formally:

```text
domainBytes = UTF8("stirpi.registry-egress-proxy.build-identity.v1") || 0x00
identityPreimage = domainBytes || canonicalDocumentBytes
BuildIdentityV1 = "sha256:" || lowercaseHex(SHA256(identityPreimage))
```

There is no BOM, length prefix, separator, or trailing LF.

## 4. Authority and evidence representation

The identity document is projected from authoritative release fields. It is not
a second artifact selector.

The proxy executable receives the derived value as `BUILD_IDENTITY`. Readiness
contains the same value in `buildIdentity`; it means the BuildIdentityV1 digest,
never the OCI manifest or provenance subject digest.

The release candidate schema advances to version 2 and adds:

```json
{
  "buildIdentity": "sha256:<64 lowercase hex>",
  "buildParameters": { "context": ".", "dockerfile": "proxy/Dockerfile", "targetStage": "final", "additionalBuildArguments": [] },
  "materials": []
}
```

Candidate validation reconstructs the identity document from candidate
`source`, `buildDefinition`, `builderImage`, `target`, `buildParameters`,
`materials`, and `contracts`, then requires equality with `buildIdentity` and
the embedded executable value.

The SLSA provenance subject remains the final OCI platform-manifest digest.
Its build type advances to
`https://stirpi.dev/build-types/registry-egress-proxy/v2`. Its closed
`externalParameters` contains the exact candidate source, build definition,
release version, target, build parameters, empty materials, contracts, and
`arguments.BUILD_IDENTITY`. Its `internalParameters` contains the exact
builder-image object. Provenance verification reconstructs BuildIdentityV1 and
requires equality with that argument, the candidate value, executable value,
and readiness value. The manifest subject remains a separate result identity.

## 5. Golden fixtures

All fixtures use the fixed contract object above, empty `materials`, and empty
`additionalBuildArguments`. Repeated letters mean exactly the stated count.

| Fixture | Variable fields | Canonical JSON bytes | Expected BuildIdentityV1 |
|---|---|---:|---|
| 1 | `arm64`; repository `https://github.com/example/stirpi`; commit `sha1:` + 40 `a`; definition `sha256:` + 64 `b`; builder `sha256:` + 64 `c` | 1041 | `sha256:555f6aa92093a494221764bf5ec7927474a1c75293bfe8c498ab942343ca1311` |
| 2 | `amd64`; repository `https://git.example.org/research/stirpi`; commit `sha256:` + 64 `d`; definition `sha256:` + 64 `e`; builder `sha256:` + 64 `f` | 1073 | `sha256:b3bec68af6c0ed49e81b054b6029260c91b8a639b9151eb39d3b1f0130d3064f` |
| 3 | Same as fixture 1 except definition digest is `sha256:` + 64 `0` | 1041 | `sha256:1dacf8fee7d3e7a22f8afe2ad975e38cbd58120c1ff02927fc17923b70c35110` |

The complete preimage lengths are respectively 1088, 1120, and 1088 bytes.
Fixture 1's canonical bytes are:

```text
{"buildDefinition":{"path":"proxy/build-definition.json","sha256":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"buildParameters":{"additionalBuildArguments":[],"context":".","dockerfile":"proxy/Dockerfile","targetStage":"final"},"builderImage":{"manifestDigest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","platform":{"architecture":"arm64","os":"linux"},"reference":"ghcr.io/stirpi/proxy-builder@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},"contracts":{"addressPolicy":"stirpi.public-address/1","artifact":"stirpi.registry-egress-proxy-artifact/1","policySchema":"stirpi.registry-egress-policy/1","protocol":"stirpi.connect-only/1","resolverPolicy":"stirpi.resolve-once/1"},"kind":"stirpi.registry-egress-proxy-build-identity/1","materials":[],"schemaVersion":1,"source":{"commit":{"algorithm":"sha1","value":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"repository":"https://github.com/example/stirpi"},"target":{"architecture":"arm64","os":"linux"}}
```

## 6. Cross-implementation acceptance

Release acceptance requires two independent implementations, one in production
TypeScript/Node and one in Go, sharing no serializer, parser, or hash helper.
Each must independently:

- reject the strict negative cases: duplicate names, BOM, malformed UTF-8,
  unknown fields, uppercase digests, mutable/tagged references, mismatched
  builder/manifest or builder/target platforms, architecture aliases,
  additional arguments/materials, and any output digest inserted as an input;
- produce byte-identical canonical documents for all three fixtures;
- produce byte-identical 47-byte-prefixed preimages;
- produce the three expected displayed hashes; and
- change the digest for every single-field mutation of source, definition,
  builder, target, or contract identity.

An independent ordinary SHA-256 implementation must also hash each golden
preimage to the same value. The two implementations must fail closed on any
schema, normalization, or cross-field disagreement.

## 7. Migration map

The current repository uses `buildIdentity` in the following places:

- `docs/DECISIONS.md`: D072 is appended; D056–D071 remain unchanged.
- `docs/verification/trusted-registry-egress-proxy-artifact-contract.md`:
  readiness text changes from a provenance-subject placeholder to the
  BuildIdentityV1 digest.
- `docs/verification/proxy-release-governance-design.md`: candidate schema
  gains the identity projection and becomes version 2; provenance build type
  becomes `/v2`; the workflow computes identity before building.
- `proxy/build-definition.json`: its description and build type are updated to
  describe pre-build BuildIdentityV1, not the final manifest.
- `proxy/README.md`: the example computes identity before invoking Docker and
  removes the final-manifest-first sequence.
- `proxy/Dockerfile`: the injection mechanism remains, but callers must supply
  only the independently derived value.
- `proxy/main.go`: readiness comments and documentation use BuildIdentityV1
  semantics.
- `scripts/proxy-release.mjs`: `validate-build` derives and validates the
  identity document; provenance uses that value instead of `manifestDigest`;
  candidate verification reconstructs and checks it.
- `test/proxy-release.test.ts`: arbitrary-digest acceptance is replaced by the
  golden vectors, negative cases, and candidate/provenance cross-bindings.

No persisted release records require migration because no approved candidate,
approval, index, or release evidence exists in the repository.
