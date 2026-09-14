# Proxy release governance and supply-chain evidence

Status: design proposal; no implementation or accepted decision is changed.

This document defines the smallest release-governance contract needed to
produce and approve an artifact satisfying D068. It does not modify D056-D068,
verification-profile semantics, frozen experiments, or proxy source.

The design has four separate objects:

1. a candidate release record containing mechanically established facts;
2. standard SBOM and build-provenance documents plus a Stirpi conformance
   record, all pinned by the candidate;
3. a human approval record naming the exact candidate bytes approved; and
4. an approved-release index, committed in the pinned Stirpi revision, which
   pins the exact candidate and approval bytes usable by preflight.

No object changes from candidate to approved. A release becomes usable by
adding its immutable records to the approved-release index after review.

## 1. Common encoding and identity rules

Every Stirpi-defined record in this design is a regular UTF-8 JSON file with:

- no byte-order mark;
- exactly one JSON value and no trailing non-whitespace data;
- no duplicate object keys;
- no unpaired Unicode surrogates;
- integers in the JSON safe-integer range; and
- validation against the exact schema version named by the record.

Unknown fields are rejected by every Stirpi schema. Repository paths are
POSIX-style, normalized, repository-relative paths with no empty, `.` or `..`
segment and no symlink traversal when resolved.

An `sha256` field is the string `sha256:` followed by the lower-case hexadecimal
SHA-256 of the exact referenced bytes. A digest covers every byte, including
JSON whitespace and a final newline if present. There is no JSON
canonicalization step. Producers should emit stable formatting, but consumers
never parse and reserialize a file before hashing it.

Candidate and approval records do not contain their own hashes:

- the approval record pins the candidate record's exact-byte SHA-256;
- the approved-release index pins both candidate and approval exact-byte
  SHA-256 values; and
- the Stirpi Git revision that contains a verification profile also fixes the
  index and all committed evidence paths. Run evidence additionally records
  the index path and SHA-256 computed from its exact bytes.

This avoids self-reference. Git object identity is useful repository
provenance, but it is not substituted for the explicitly required SHA-256.

## 2. Stable repository layout

The repository layout is:

```text
releases/registry-egress-proxy/
  index.json
  <release-version>/
    <os>-<architecture>/
      candidate.json
      approval.json
      conformance.json
      sbom.cdx.json
      provenance.intoto.json
```

`<release-version>` is the exact `release.version` value and each platform
directory is the exact lower-case concatenation of `target.os`, `-`, and
`target.architecture`. One candidate covers one OCI platform manifest. A
multi-platform release therefore has one directory and approval per platform;
an OCI image index is not a substitute for the D068 platform-manifest identity.

The names are product- and release-oriented, not experiment-oriented. No D032
or target-repository state appears here. The five files in a platform directory
are append-only after index inclusion. Corrections require a new release
version and new records.

The SBOM, provenance, and conformance files are committed in full. There are no
separate repository metadata files for them: their paths, hashes, media types,
and publication identities live in `candidate.json`.

## 3. Candidate release-record schema

The following JSON Schema is normative. It uses JSON Schema draft 2020-12.
Cross-field requirements following the schema are also normative because JSON
Schema alone cannot conveniently express digest-reference equality, sortedness,
or identity agreement across documents.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://stirpi.dev/schemas/registry-egress-proxy-release-candidate-v1.schema.json",
  "title": "Stirpi registry-egress proxy release candidate version 1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "release",
    "source",
    "buildDefinition",
    "builderImage",
    "target",
    "contracts",
    "oci",
    "executable",
    "sbom",
    "provenance",
    "conformance"
  ],
  "properties": {
    "schemaVersion": { "const": 1 },
    "release": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "version"],
      "properties": {
        "name": { "const": "stirpi-registry-egress-proxy" },
        "version": {
          "type": "string",
          "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
        }
      }
    },
    "source": {
      "type": "object",
      "additionalProperties": false,
      "required": ["repository", "commit"],
      "properties": {
        "repository": { "$ref": "#/$defs/httpsUri" },
        "commit": { "$ref": "#/$defs/gitOid" }
      }
    },
    "buildDefinition": { "$ref": "#/$defs/repositoryFile" },
    "builderImage": { "$ref": "#/$defs/imageIdentity" },
    "target": { "$ref": "#/$defs/platform" },
    "contracts": { "$ref": "#/$defs/contracts" },
    "oci": {
      "type": "object",
      "additionalProperties": false,
      "required": ["repository", "reference", "manifest", "config", "layers"],
      "properties": {
        "repository": { "$ref": "#/$defs/ociRepository" },
        "reference": { "$ref": "#/$defs/ociDigestReference" },
        "manifest": {
          "allOf": [
            { "$ref": "#/$defs/descriptor" },
            {
              "type": "object",
              "properties": {
                "mediaType": { "const": "application/vnd.oci.image.manifest.v1+json" }
              }
            }
          ]
        },
        "config": {
          "allOf": [
            { "$ref": "#/$defs/descriptor" },
            {
              "type": "object",
              "properties": {
                "mediaType": { "const": "application/vnd.oci.image.config.v1+json" }
              }
            }
          ]
        },
        "layers": {
          "type": "array",
          "minItems": 1,
          "maxItems": 8,
          "items": { "$ref": "#/$defs/layerDescriptor" }
        }
      }
    },
    "executable": {
      "type": "object",
      "additionalProperties": false,
      "required": ["path", "sha256"],
      "properties": {
        "path": { "const": "/stirpi-registry-egress-proxy" },
        "sha256": { "$ref": "#/$defs/sha256" }
      }
    },
    "sbom": {
      "allOf": [
        { "$ref": "#/$defs/publishedEvidence" },
        {
          "type": "object",
          "properties": {
            "schema": { "const": "CycloneDX-1.6" },
            "mediaType": { "const": "application/vnd.cyclonedx+json; version=1.6" },
            "artifactType": { "const": "application/vnd.cyclonedx+json" }
          }
        }
      ]
    },
    "provenance": {
      "allOf": [
        { "$ref": "#/$defs/publishedEvidence" },
        {
          "type": "object",
          "properties": {
            "schema": { "const": "SLSA-Provenance-v1" },
            "mediaType": { "const": "application/vnd.in-toto+json" },
            "artifactType": { "const": "application/vnd.in-toto+json" }
          }
        }
      ]
    },
    "conformance": {
      "type": "object",
      "additionalProperties": false,
      "required": ["schemaVersion", "path", "sha256", "suite", "result"],
      "properties": {
        "schemaVersion": { "const": 1 },
        "path": { "$ref": "#/$defs/repositoryPath" },
        "sha256": { "$ref": "#/$defs/sha256" },
        "suite": {
          "type": "object",
          "additionalProperties": false,
          "required": ["version", "source", "definition"],
          "properties": {
            "version": { "type": "integer", "minimum": 1, "maximum": 9007199254740991 },
            "source": {
              "type": "object",
              "additionalProperties": false,
              "required": ["repository", "commit"],
              "properties": {
                "repository": { "$ref": "#/$defs/httpsUri" },
                "commit": { "$ref": "#/$defs/gitOid" }
              }
            },
            "definition": { "$ref": "#/$defs/repositoryFile" }
          }
        },
        "result": { "enum": ["passed", "failed", "error"] }
      }
    }
  },
  "$defs": {
    "sha256": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "httpsUri": {
      "type": "string",
      "pattern": "^https://[^?#]+(?:\\?[^#]*)?$",
      "maxLength": 2048
    },
    "repositoryPath": {
      "type": "string",
      "pattern": "^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$",
      "maxLength": 512
    },
    "repositoryFile": {
      "type": "object",
      "additionalProperties": false,
      "required": ["path", "sha256"],
      "properties": {
        "path": { "$ref": "#/$defs/repositoryPath" },
        "sha256": { "$ref": "#/$defs/sha256" }
      }
    },
    "gitOid": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["algorithm", "value"],
          "properties": {
            "algorithm": { "const": "sha1" },
            "value": { "type": "string", "pattern": "^[0-9a-f]{40}$" }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["algorithm", "value"],
          "properties": {
            "algorithm": { "const": "sha256" },
            "value": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
          }
        }
      ]
    },
    "platform": {
      "type": "object",
      "additionalProperties": false,
      "required": ["os", "architecture"],
      "properties": {
        "os": { "type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,31}$" },
        "architecture": { "type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,31}$" }
      }
    },
    "contracts": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "artifact",
        "protocol",
        "policySchema",
        "resolverPolicy",
        "addressPolicy"
      ],
      "properties": {
        "artifact": { "const": "stirpi.registry-egress-proxy-artifact/1" },
        "protocol": { "const": "stirpi.connect-only/1" },
        "policySchema": { "const": "stirpi.registry-egress-policy/1" },
        "resolverPolicy": { "const": "stirpi.resolve-once/1" },
        "addressPolicy": { "const": "stirpi.public-address/1" }
      }
    },
    "ociRepository": {
      "type": "string",
      "pattern": "^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$",
      "maxLength": 255
    },
    "ociDigestReference": {
      "type": "string",
      "pattern": "^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$",
      "maxLength": 327
    },
    "descriptor": {
      "type": "object",
      "additionalProperties": false,
      "required": ["mediaType", "digest", "size"],
      "properties": {
        "mediaType": { "type": "string", "minLength": 1, "maxLength": 255 },
        "digest": { "$ref": "#/$defs/sha256" },
        "size": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 }
      }
    },
    "layerDescriptor": {
      "allOf": [
        { "$ref": "#/$defs/descriptor" },
        {
          "type": "object",
          "properties": {
            "mediaType": {
              "enum": [
                "application/vnd.oci.image.layer.v1.tar",
                "application/vnd.oci.image.layer.v1.tar+gzip",
                "application/vnd.oci.image.layer.v1.tar+zstd"
              ]
            }
          }
        }
      ]
    },
    "imageIdentity": {
      "type": "object",
      "additionalProperties": false,
      "required": ["reference", "manifestDigest", "platform"],
      "properties": {
        "reference": { "$ref": "#/$defs/ociDigestReference" },
        "manifestDigest": { "$ref": "#/$defs/sha256" },
        "platform": { "$ref": "#/$defs/platform" }
      }
    },
    "publishedEvidence": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schema",
        "path",
        "sha256",
        "size",
        "mediaType",
        "artifactType",
        "ociRepository",
        "ociArtifactManifest"
      ],
      "properties": {
        "schema": { "type": "string", "minLength": 1, "maxLength": 64 },
        "path": { "$ref": "#/$defs/repositoryPath" },
        "sha256": { "$ref": "#/$defs/sha256" },
        "size": { "type": "integer", "minimum": 1, "maximum": 16777216 },
        "mediaType": { "type": "string", "minLength": 1, "maxLength": 255 },
        "artifactType": { "type": "string", "minLength": 1, "maxLength": 255 },
        "ociRepository": { "$ref": "#/$defs/ociRepository" },
        "ociArtifactManifest": {
          "allOf": [
            { "$ref": "#/$defs/descriptor" },
            {
              "type": "object",
              "properties": {
                "mediaType": { "const": "application/vnd.oci.image.manifest.v1+json" }
              }
            }
          ]
        }
      }
    }
  }
}
```

Candidate semantic validation additionally requires:

- the source commit exists in the named repository, and the regular file at
  `buildDefinition.path` in that exact commit hashes to
  `buildDefinition.sha256`;
- `oci.reference` equals `oci.repository + "@" + oci.manifest.digest`;
- `builderImage.reference` ends in `builderImage.manifestDigest` and resolves to
  `builderImage.platform`;
- `target` equals the actual OCI config platform and the verification-profile
  platform;
- the manifest bytes hash to `oci.manifest.digest`, have the recorded size,
  reference exactly `oci.config` and the ordered `oci.layers`, and contain no
  other layers;
- the config bytes hash to `oci.config.digest`, have the recorded size, and
  exactly satisfy D068's OCI configuration;
- extracting the ordered layers with OCI whiteout semantics produces exactly
  the approved scratch-image filesystem, and the executable bytes at the fixed
  path hash to `executable.sha256`;
- evidence paths are the fixed paths for this release and platform;
- evidence `sha256` and `size` identify the exact committed payload bytes;
- each OCI evidence artifact is in `oci.repository`, and its directly fetched
  manifest has the recorded digest and size, the expected `artifactType`, a
  `subject` descriptor exactly equal to `oci.manifest`, an empty-JSON OCI config
  descriptor, and exactly one layer whose media type, digest, and size equal
  the committed payload's `mediaType`, `sha256`, and `size`;
- SBOM and provenance cross-bindings in sections 6 and 7 hold;
- the conformance summary copied into the candidate exactly matches the
  committed conformance record; and
- an approvable candidate has `conformance.result == "passed"`.

Layer order is significant and duplicate layer digests are not collapsed.
Mutable tags may exist for convenience, but never appear in these identities.

## 4. Approval and approved-index schemas

The approval record is deliberately small. It records a human decision about
one exact candidate; it does not repeat or permit edits to artifact facts.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://stirpi.dev/schemas/registry-egress-proxy-approval-v1.schema.json",
  "title": "Stirpi registry-egress proxy approval version 1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "candidate", "decision", "reviewer", "approvedAt"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "candidate": {
      "type": "object",
      "additionalProperties": false,
      "required": ["path", "sha256"],
      "properties": {
        "path": {
          "type": "string",
          "pattern": "^releases/registry-egress-proxy/(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?/[a-z0-9][a-z0-9._-]{0,31}-[a-z0-9][a-z0-9._-]{0,31}/candidate\\.json$",
          "maxLength": 512
        },
        "sha256": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
      }
    },
    "decision": { "const": "approved" },
    "reviewer": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$"
    },
    "approvedAt": {
      "type": "string",
      "format": "date-time",
      "pattern": "Z$"
    }
  }
}
```

`reviewer` is a repository-governance identity, not a cryptographic principal.
`approvedAt` is informational metadata. The decision's meaning is exactly:

> I approve the candidate release record whose repository path and exact-byte
> SHA-256 are recorded in this approval record.

The human need not type or manually compare subordinate digests. Mechanical
verification must present a successful, independently recomputed candidate
check before the human makes this decision. Version 1 does not require a
signature, transparency log, or external identity provider; protected review
and merge of the Stirpi repository are the approval trust boundary.

The approved-release index is the only registry of usable proxy releases:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://stirpi.dev/schemas/registry-egress-proxy-approved-index-v1.schema.json",
  "title": "Stirpi registry-egress proxy approved-release index version 1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "releases"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "releases": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "releaseVersion",
          "platform",
          "artifactContract",
          "ociRepository",
          "manifestDigest",
          "candidate",
          "approval"
        ],
        "properties": {
          "releaseVersion": {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
          },
          "platform": {
            "type": "object",
            "additionalProperties": false,
            "required": ["os", "architecture"],
            "properties": {
              "os": { "type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,31}$" },
              "architecture": { "type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,31}$" }
            }
          },
          "artifactContract": { "const": "stirpi.registry-egress-proxy-artifact/1" },
          "ociRepository": {
            "type": "string",
            "pattern": "^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$",
            "maxLength": 255
          },
          "manifestDigest": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
          "candidate": { "$ref": "#/$defs/fileIdentity" },
          "approval": { "$ref": "#/$defs/fileIdentity" }
        }
      }
    }
  },
  "$defs": {
    "fileIdentity": {
      "type": "object",
      "additionalProperties": false,
      "required": ["path", "sha256"],
      "properties": {
        "path": {
          "type": "string",
          "pattern": "^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$",
          "maxLength": 512
        },
        "sha256": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
      }
    }
  }
}
```

Index entries are sorted lexicographically by
`(artifactContract, ociRepository, manifestDigest, platform.os,
platform.architecture)`. That tuple and each candidate or approval path must be
unique. Each path must be the fixed path implied by the entry's release and
platform. Index values must exactly equal the corresponding candidate and
approval contents. Removing an entry revokes it for new live runs under later
runtime revisions, but does not rewrite prior run provenance.

## 5. Conformance evidence schema

Conformance is a Stirpi-specific result because it tests D068 semantics rather
than a generic ecosystem standard. Its strict schema is:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://stirpi.dev/schemas/registry-egress-proxy-conformance-v1.schema.json",
  "title": "Stirpi registry-egress proxy conformance result version 1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "suite",
    "subject",
    "contracts",
    "execution",
    "result",
    "summary",
    "startedAt",
    "finishedAt"
  ],
  "properties": {
    "schemaVersion": { "const": 1 },
    "suite": {
      "type": "object",
      "additionalProperties": false,
      "required": ["version", "source", "definition"],
      "properties": {
        "version": { "type": "integer", "minimum": 1, "maximum": 9007199254740991 },
        "source": {
          "type": "object",
          "additionalProperties": false,
          "required": ["repository", "commit"],
          "properties": {
            "repository": { "type": "string", "pattern": "^https://[^?#]+(?:\\?[^#]*)?$", "maxLength": 2048 },
            "commit": {
              "oneOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["algorithm", "value"],
                  "properties": {
                    "algorithm": { "const": "sha1" },
                    "value": { "type": "string", "pattern": "^[0-9a-f]{40}$" }
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["algorithm", "value"],
                  "properties": {
                    "algorithm": { "const": "sha256" },
                    "value": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
                  }
                }
              ]
            }
          }
        },
        "definition": { "$ref": "#/$defs/repositoryFile" }
      }
    },
    "subject": {
      "type": "object",
      "additionalProperties": false,
      "required": ["ociRepository", "manifestDigest", "platform"],
      "properties": {
        "ociRepository": {
          "type": "string",
          "pattern": "^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$",
          "maxLength": 255
        },
        "manifestDigest": { "$ref": "#/$defs/sha256" },
        "platform": { "$ref": "#/$defs/platform" }
      }
    },
    "contracts": {
      "type": "object",
      "additionalProperties": false,
      "required": ["artifact", "protocol", "policySchema", "resolverPolicy", "addressPolicy"],
      "properties": {
        "artifact": { "const": "stirpi.registry-egress-proxy-artifact/1" },
        "protocol": { "const": "stirpi.connect-only/1" },
        "policySchema": { "const": "stirpi.registry-egress-policy/1" },
        "resolverPolicy": { "const": "stirpi.resolve-once/1" },
        "addressPolicy": { "const": "stirpi.public-address/1" }
      }
    },
    "execution": {
      "type": "object",
      "additionalProperties": false,
      "required": ["definition", "runnerImage", "platform", "argv"],
      "properties": {
        "definition": { "$ref": "#/$defs/repositoryFile" },
        "runnerImage": {
          "type": "object",
          "additionalProperties": false,
          "required": ["reference", "manifestDigest"],
          "properties": {
            "reference": {
              "type": "string",
              "pattern": "^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$",
              "maxLength": 327
            },
            "manifestDigest": { "$ref": "#/$defs/sha256" }
          }
        },
        "platform": { "$ref": "#/$defs/platform" },
        "argv": {
          "type": "array",
          "minItems": 1,
          "maxItems": 32,
          "items": { "type": "string", "minLength": 1, "maxLength": 1024 }
        }
      }
    },
    "result": { "enum": ["passed", "failed", "error"] },
    "summary": {
      "type": "object",
      "additionalProperties": false,
      "required": ["total", "passed", "failed", "errored"],
      "properties": {
        "total": { "type": "integer", "minimum": 1, "maximum": 100000 },
        "passed": { "type": "integer", "minimum": 0, "maximum": 100000 },
        "failed": { "type": "integer", "minimum": 0, "maximum": 100000 },
        "errored": { "type": "integer", "minimum": 0, "maximum": 100000 }
      }
    },
    "startedAt": { "type": "string", "format": "date-time", "pattern": "Z$" },
    "finishedAt": { "type": "string", "format": "date-time", "pattern": "Z$" }
  },
  "$defs": {
    "sha256": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
    "platform": {
      "type": "object",
      "additionalProperties": false,
      "required": ["os", "architecture"],
      "properties": {
        "os": { "type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,31}$" },
        "architecture": { "type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,31}$" }
      }
    },
    "repositoryFile": {
      "type": "object",
      "additionalProperties": false,
      "required": ["path", "sha256"],
      "properties": {
        "path": {
          "type": "string",
          "pattern": "^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$",
          "maxLength": 512
        },
        "sha256": { "$ref": "#/$defs/sha256" }
      }
    }
  }
}
```

The suite definition identifies the test inventory and pass policy. The
execution definition identifies the fixed harness invocation and isolation
contract. Both are exact committed files with SHA-256 identities; the runner
image is a digest-pinned execution environment. Semantic checks require:

- `summary.total == summary.passed + summary.failed + summary.errored`;
- `result == "passed"` exactly when every test passed;
- `result == "failed"` when at least one test completed negatively;
- `result == "error"` when infrastructure prevented a valid test result;
- subject, platform, and all contract identities equal the candidate;
- suite fields equal the candidate's copied suite identity; and
- conformance executes the exact platform manifest, never a tag or OCI index.

`startedAt` and `finishedAt` describe the observation. They do not participate
in the suite, execution, proxy artifact, or result semantics. The exact record
hash nevertheless covers them so alteration remains detectable.

## 6. SBOM contract

The sole required SBOM format is CycloneDX 1.6 JSON, validated against the
official `bom-1.6.schema.json`. Version 1.6 is sufficient for a single static Go
executable, permits SHA-256 file/component identities without SPDX 2.x's
mandatory SHA-1 file checksum, and has broad existing tooling support. A later
CycloneDX version is not accepted as 1.6 merely because it is additive.

The SBOM must contain:

- `bomFormat: "CycloneDX"`, `specVersion: "1.6"`, and `version: 1`;
- no `serialNumber` or timestamp, avoiding random and clock-dependent identity;
- `metadata.lifecycles: [{"phase":"post-build"}]`;
- `metadata.tools.components` identifying each generator by name, exact version,
  and SHA-256 of its executable bytes;
- one `metadata.component` of type `container`, with the release name/version,
  a deterministic `bom-ref`, SHA-256 equal to the hex part of the exact platform
  manifest digest, and a distribution external reference equal to the OCI
  digest reference;
- a type `file` component for every regular file in the scratch image, including
  `/stirpi-registry-egress-proxy`, with a deterministic `bom-ref`, container
  absolute path as its name, and SHA-256 of its exact bytes;
- components for the main Go module and every statically linked third-party Go
  module discovered in the executable, each with exact module version and purl
  when representable;
- a dependency graph from the container to shipped files and from the executable
  to its linked modules; and
- a composition asserting `aggregate: "complete"` for the container inventory.

Arrays with no semantic order are emitted in lexicographic `bom-ref` order.
All hashes are independently recomputed from the final image, not copied from
the build log. The root manifest hash and executable component hash must equal
the candidate's OCI and executable identities. A missing discovered file or
linked third-party module is a verification failure.

The exact SBOM bytes are both committed as `sbom.cdx.json` and published in the
same OCI repository as one OCI 1.1 image-manifest artifact whose `subject` is
the exact proxy platform manifest. The candidate pins the committed bytes and
the artifact manifest digest. The committed copy is authoritative for Stirpi
preflight and historical evidence; publication is an independently fetchable
mirror, not an authority override.

## 7. Build-provenance contract

The sole provenance format is an in-toto Statement v1 with SLSA Provenance v1:

```text
_type         = https://in-toto.io/Statement/v1
predicateType = https://slsa.dev/provenance/v1
```

The statement is plain JSON, not a DSSE envelope, because this contract does
not require cryptographic signing. It must satisfy the SLSA v1 provenance
schema and this stricter profile:

- `subject` contains exactly one resource: its `name` is the candidate OCI
  repository and its sole digest is `sha256`, equal to the hex part of the
  candidate platform-manifest digest;
- `predicate.buildDefinition.buildType` is
  `https://stirpi.dev/build-types/registry-egress-proxy/v1`;
- `externalParameters` has a closed shape containing the exact source
  repository and Git OID, build-definition path and SHA-256, release version,
  target OS/architecture, and fixed build arguments;
- `internalParameters` has a closed shape containing the builder/toolchain OCI
  digest reference, resolved platform-manifest digest, and platform;
- `resolvedDependencies` contains the source Git revision, exact build
  definition, builder image, and every other downloaded build material by
  immutable digest, with no mutable-only material;
- `runDetails.builder.id` is
  `https://stirpi.dev/builders/registry-egress-proxy/v1`;
- `runDetails.metadata` records `invocationId`, `startedOn`, and `finishedOn` as
  informational build-observation metadata; and
- `runDetails.byproducts` identifies any retained build log or intermediate
  evidence by digest, but may be empty and is never artifact authority.

The build-type definition committed at the candidate's `buildDefinition.path`
normatively fixes the exact external/internal parameter object shapes, build
arguments, environment, output selection, and OCI assembly procedure. The
candidate and provenance values for source, definition, builder image, target,
and manifest subject must be equal. Provenance records how the artifact was
built; version 1 makes no bit-for-bit reproducible-build claim.

The exact statement bytes are committed as `provenance.intoto.json` and
published beside the SBOM as an OCI 1.1 image-manifest artifact with the exact
proxy manifest as `subject`. The candidate records exact payload bytes and the
artifact-manifest digest. No release asset, mutable tag, DSSE wrapper, Sigstore
bundle, or transparency service is required.

## 8. OCI publication model

OCI publication uses the OCI Image and Distribution Specifications 1.1. Each
SBOM or provenance attachment is an OCI image manifest with:

- `schemaVersion: 2`;
- media type `application/vnd.oci.image.manifest.v1+json`;
- the candidate's required `artifactType`;
- the standard two-byte empty JSON (`{}`) config with media type
  `application/vnd.oci.empty.v1+json`;
- exactly one layer containing the exact committed document bytes and their
  required media type; and
- a `subject` descriptor byte-for-byte equivalent in media type, digest, and
  size to the proxy platform-manifest descriptor.

The publisher may use the OCI 1.1 Referrers API or its standardized fallback
tag to make attachments discoverable. Discovery is never trusted: preflight
fetches the attachment manifest directly by the digest recorded in the
candidate, then verifies its subject and payload. This works with GHCR's OCI
image support and does not depend on a mutable referrers listing remaining
unchanged.

Candidate, approval, index, and conformance records are repository governance
objects and are not also published as OCI artifacts. Release assets would add
a third storage mechanism without strengthening identity, so version 1 omits
them.

## 9. Profile authority and preflight chain

D068 already decides that the verification profile pins the proxy manifest,
platform, and contract identities, and that a release record is not a second
artifact selector. This proposal preserves that boundary. Profiles do not add
candidate, approval, or index paths.

For the runtime revision containing the exact profile, preflight performs this
closed chain before using the proxy:

1. Parse and hash `releases/registry-egress-proxy/index.json` from that same
   runtime revision; reject malformed, unsorted, duplicate, or unknown data.
2. Select exactly one index entry matching the profile's artifact contract,
   OCI repository and platform-manifest digest, OS, and architecture. Zero or
   multiple matches fail closed.
3. Read the indexed candidate and approval files without following symlinks;
   hash their exact bytes and require equality with both index hashes.
4. Validate both schemas and fixed paths. Require the approval's candidate path
   and hash to equal the indexed candidate, and `decision == "approved"`.
5. Independently validate every candidate cross-field rule. In particular,
   require all profile contract and platform identities to match.
6. Fetch or inspect the proxy manifest by digest, never tag; verify its bytes,
   size, config descriptor, ordered layer descriptors, platform, and D068 OCI
   configuration against the candidate.
7. Extract the image with OCI semantics and independently hash the fixed
   executable and complete scratch filesystem.
8. Read, exact-byte hash, and validate the committed CycloneDX SBOM. Verify its
   root manifest, complete file inventory, executable, and linked-module
   bindings.
9. Read, exact-byte hash, and validate the committed in-toto/SLSA statement.
   Verify its subject, source, build definition, builder image, parameters,
   target, and resulting manifest against the candidate.
10. Directly fetch each OCI evidence artifact by recorded manifest digest.
    Verify manifest bytes, subject, artifact type, empty config, and sole payload
    against the committed SBOM or provenance bytes. A referrers query is not
    required for trust.
11. Read, exact-byte hash, and validate conformance evidence. Require the suite,
    execution environment, manifest, platform, contracts, summary, and passed
    result to match the candidate.
12. Record the profile, index, candidate, approval, OCI, executable, SBOM,
    provenance, and conformance identities in run evidence before launch.

Every mismatch, missing file, unavailable required registry object, schema
error, ambiguous lookup, unsupported algorithm/version/media type, or failed
conformance result prevents live use. There is no fallback to a tag, another
platform, locally cached bytes with a different digest, reconstruction,
republishing, or a merely similar release.

## 10. Replay and historical availability

The pinned Stirpi runtime revision preserves the index, candidate, approval,
SBOM, provenance, and conformance bytes. A live run records their exact paths
and SHA-256 values plus all configured and resolved OCI descriptors and the
preflight outcome. Registry attachments are useful independent copies, but
mutable discovery results and tags are never retained as authority.

Replay consumes the recorded identities, committed evidence, and recorded
verification/preparation outcomes. It validates hashes and cross-bindings. It
must not contact Git hosts or registries, discover referrers, pull an image,
extract an image, rebuild or republish the proxy, rerun conformance, launch
Docker, resolve DNS, or repeat verification. Registry deletion therefore does
not erase the meaning of a historical run.

The repository does not need to vendor OCI blobs merely for provenance. If the
exact image or attachment later disappears, a new live run fails because its
required immutable object is unavailable; replay of an already recorded run
continues to use its recorded outcomes. Restoration, if ever authorized, must
publish preserved exact bytes with the same digests and is outside this
contract. Rebuilding from source is never restoration evidence.

## 11. First-release workflow

The first release follows this sequence and stops on any failed check:

1. **Human:** review and commit proxy source, build-type definition, exact build
   recipe, and conformance suite.
2. **Mechanical:** resolve the pinned builder image for the target platform;
   build once with the fixed parameters; retain source, build, builder, and
   material identities.
3. **Mechanical:** assemble and inspect the OCI platform image; publish it;
   record the immutable manifest, config, ordered layers, and extracted
   executable SHA-256.
4. **Mechanical:** generate the final-image CycloneDX 1.6 SBOM, validate it,
   commit its intended exact bytes, and publish those same bytes as a
   subject-bound OCI artifact.
5. **Mechanical:** generate the in-toto/SLSA v1 provenance statement, validate
   it, commit its intended exact bytes, and publish those same bytes as a
   subject-bound OCI artifact.
6. **Mechanical:** run the committed conformance suite in its digest-pinned
   environment against the exact platform manifest and generate the strict
   conformance record.
7. **Mechanical:** generate `candidate.json` from independently read artifact
   and evidence bytes; do not copy unverified console text as identity.
8. **Independent mechanical verification:** run the complete preflight chain
   through the candidate stage and produce a bounded review report. The
   verifier must not share the candidate generator's trusted observations.
9. **Human:** review the source/build changes and successful report, then make
   the single decision “I approve candidate release record SHA-256 X.” Create
   `approval.json` naming X and the reviewer identity.
10. **Mechanical, under normal repository review:** hash `approval.json`, add
    exactly one entry to `index.json`, verify the complete chain again, and
    commit/merge candidate, evidence, approval, and index together.
11. **Mechanical:** only a profile whose already-authoritative manifest,
    platform, and contracts select that exact index entry may pass live
    preflight and use the release.

Steps 1 and 9 are human-owned. The merge policy enforcing those reviews is
also human-owned. Artifact production, digest collection, schema validation,
cross-binding, publication, conformance execution, record generation, and
preflight are mechanical.

## 12. Exact proposed human-owned decisions

The following text is proposed for later human acceptance and addition after
D068. It is not accepted or added by this task.

### D069 — Proxy releases use immutable, standard supply-chain evidence

Status: proposed

Each approved D068 proxy release has one strict factual candidate record per
platform manifest. The record binds the release version, reviewed source
commit, exact build definition, digest-pinned builder image, target platform,
D068 contract identities, OCI repository and manifest/config/ordered-layer
digests, executable SHA-256, CycloneDX 1.6 JSON SBOM, in-toto Statement v1 with
SLSA Provenance v1, and exact-manifest conformance result. Unknown fields and
unsupported versions are rejected.

Candidate, SBOM, provenance, and conformance bytes are committed under the
versioned `releases/registry-egress-proxy/` hierarchy and identified by SHA-256
of their exact committed bytes without canonical reserialization. The SBOM and
provenance bytes are additionally published as digest-addressed OCI 1.1 image
manifest artifacts whose subject is the exact proxy platform manifest. Their
recorded artifact-manifest digests, not mutable tags or discovery results,
identify the published copies. Version 1 does not require signing,
transparency-log availability, release assets, or a reproducible-build claim.

Conformance records bind the suite source, version and exact definition, fixed
execution definition and runner image, target manifest and platform, D068
contract identities, and result. Timestamps are informational observation
metadata and do not define artifact, suite, execution, or result identity.

### D070 — Proxy approval is a separate exact-candidate decision

Status: proposed

A D068 proxy candidate becomes approved only through a separate immutable
approval record whose decision means “I approve candidate release record
SHA-256 X.” Approval never mutates the candidate or its artifact identities and
does not require a human to transcribe subordinate generated digests. Before
approval, independent mechanical verification must validate the candidate and
all source, build, OCI, executable, SBOM, provenance, and passing conformance
cross-bindings.

The approved-release index in the pinned Stirpi runtime revision identifies
usable releases and pins the exact-byte SHA-256 and path of both candidate and
approval records. The approval pins the candidate in turn. Repository review
and merge are the version-1 human trust boundary; cryptographic signing is not
required.

Consistent with D068, the trusted verification profile remains authoritative
for the immutable proxy manifest, explicit platform, and contract identities;
the release record is not a second artifact selector. Preflight looks up one
matching approved index entry in the same pinned Stirpi revision, validates the
complete exact-byte and artifact chain, and fails closed on absence, ambiguity,
unavailability, or mismatch. Replay validates recorded identities and outcomes
without rebuilding, republishing, fetching, or rerunning the proxy or its
evidence.

## 13. Standards references

- [CycloneDX 1.6 JSON schema](https://cyclonedx.org/schema/bom-1.6.schema.json)
- [CycloneDX specification overview](https://cyclonedx.org/specification/overview/)
- [SLSA Provenance v1](https://slsa.dev/provenance/v1)
- [in-toto Attestation Framework](https://github.com/in-toto/attestation/tree/main/spec)
- [OCI Image Specification 1.1](https://specs.opencontainers.org/image-spec/?v=v1.1.1)
- [OCI Distribution Specification 1.1](https://specs.opencontainers.org/distribution-spec/?v=v1.1.1)
- [GitHub Container Registry OCI support](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
