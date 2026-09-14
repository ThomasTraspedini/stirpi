# Trusted verification profiles and dependency authority

Status: design proposal; not accepted or implemented

This document proposes the smallest reusable authority boundary for executing
candidate verification. It does not alter D056-D059, any frozen D032 input, or
the historical S003/T003 preregistrations.

The design has four independent identities:

1. the public evaluator says what must pass;
2. a trusted verification profile says how allowed candidate checks execute;
3. a dependency bundle identifies the dependencies supplied to one execution;
4. each recorded operation identifies the candidate workspace it observed.

None of these identities substitutes for another.

## 1. Recommended profile schema

A profile is a strict UTF-8 JSON document committed in the Stirpi repository
under `verification-profiles/`. It is configuration owned by the trusted
runtime, not a file accepted from the target repository, executor, CLI, or
environment.

The following is the version-1 shape. Values containing angle brackets are
descriptive placeholders, so this example is intentionally not runnable.

```json
{
  "schemaVersion": 1,
  "id": "node-postgres-linux-arm64",
  "version": 1,
  "platform": {
    "os": "linux",
    "architecture": "arm64"
  },
  "images": {
    "verifier": {
      "reference": "registry.example.invalid/stirpi/node-verifier@sha256:<64-lowercase-hex>"
    },
    "dependencyPreparation": {
      "reference": "registry.example.invalid/stirpi/npm-preparer@sha256:<64-lowercase-hex>"
    },
    "postgres": {
      "reference": "docker.io/library/postgres@sha256:<64-lowercase-hex>"
    }
  },
  "dependencies": {
    "kind": "node-modules",
    "inputs": {
      "manifest": "package.json",
      "lockfile": "package-lock.json"
    },
    "installPolicy": {
      "id": "npm-ci-ignore-scripts-v1",
      "executable": "/usr/local/bin/npm",
      "argv": ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      "lifecycleScripts": "deny",
      "network": {
        "mode": "registry-only",
        "origins": ["https://registry.npmjs.org"]
      }
    },
    "limits": {
      "wallTimeMs": 300000,
      "cpu": 2,
      "memoryBytes": 1073741824,
      "pids": 256,
      "fileDescriptors": 1024,
      "outputBytesPerStream": 1048576
    },
    "isolation": {
      "readOnlyRootFilesystem": true,
      "preparerUser": "65532:65532",
      "dropCapabilities": "all",
      "noNewPrivileges": true,
      "dockerSocket": "absent",
      "hostFilesystem": "absent",
      "candidateRuntimeSecrets": "absent",
      "environment": "fixed-dependency-preparation-v1",
      "writablePaths": ["/output", "/tmp"]
    },
    "bundle": {
      "exportPath": "node_modules",
      "targetPath": "/workspace/node_modules",
      "delivery": "read-only-mount"
    }
  },
  "toolchain": [
    {
      "id": "node",
      "imageRole": "verifier",
      "executable": "/usr/local/bin/node",
      "versionArgv": ["--version"],
      "expectedStdout": "<exact-node-version>"
    },
    {
      "id": "npm",
      "imageRole": "verifier",
      "executable": "/usr/local/bin/npm",
      "versionArgv": ["--version"],
      "expectedStdout": "<exact-npm-version>"
    },
    {
      "id": "git",
      "imageRole": "verifier",
      "executable": "/usr/bin/git",
      "versionArgv": ["--version"],
      "expectedStdout": "<exact-git-version>"
    },
    {
      "id": "npm-preparer",
      "imageRole": "dependencyPreparation",
      "executable": "/usr/local/bin/npm",
      "versionArgv": ["--version"],
      "expectedStdout": "<exact-npm-version>"
    },
    {
      "id": "postgres",
      "imageRole": "postgres",
      "executable": "/usr/local/bin/postgres",
      "versionArgv": ["--version"],
      "expectedStdout": "<exact-postgres-version>"
    }
  ],
  "operations": [
    {
      "id": "node.npm-test.postgres-v1",
      "publicInvocation": {
        "executable": "npm",
        "argv": ["test"],
        "workingDirectory": "candidate"
      },
      "executable": "/usr/local/bin/npm",
      "argv": ["test"],
      "cwd": "/workspace",
      "workspaceView": "sanitized-git-worktree-v1",
      "dependencyBundle": "required",
      "database": "required",
      "limits": {
        "wallTimeMs": 300000,
        "cpu": 2,
        "memoryBytes": 1073741824,
        "pids": 256,
        "fileDescriptors": 1024,
        "outputBytesPerStream": 1048576
      }
    },
    {
      "id": "node.npm-typecheck-v1",
      "publicInvocation": {
        "executable": "npm",
        "argv": ["run", "typecheck"],
        "workingDirectory": "candidate"
      },
      "executable": "/usr/local/bin/npm",
      "argv": ["run", "typecheck"],
      "cwd": "/workspace",
      "workspaceView": "sanitized-git-worktree-v1",
      "dependencyBundle": "required",
      "database": "none",
      "limits": {
        "wallTimeMs": 300000,
        "cpu": 2,
        "memoryBytes": 1073741824,
        "pids": 256,
        "fileDescriptors": 1024,
        "outputBytesPerStream": 1048576
      }
    },
    {
      "id": "git.diff-check-v1",
      "publicInvocation": {
        "executable": "git",
        "argv": ["diff", "--check"],
        "workingDirectory": "candidate"
      },
      "executable": "/usr/bin/git",
      "argv": ["diff", "--check"],
      "cwd": "/workspace",
      "workspaceView": "sanitized-git-worktree-v1",
      "dependencyBundle": "none",
      "database": "none",
      "limits": {
        "wallTimeMs": 30000,
        "cpu": 1,
        "memoryBytes": 268435456,
        "pids": 64,
        "fileDescriptors": 256,
        "outputBytesPerStream": 1048576
      }
    }
  ],
  "database": {
    "engine": "postgresql",
    "bootstrapPolicy": "disposable-schema-owner-v1",
    "extensions": ["btree_gist"],
    "transport": "unix-socket-only",
    "socketPath": "/var/run/postgresql",
    "candidateRole": {
      "superuser": false,
      "createDatabase": false,
      "createRole": false,
      "inherit": false
    },
    "limits": {
      "bootstrapWallTimeMs": 60000,
      "cpu": 1,
      "memoryBytes": 536870912,
      "pids": 128,
      "fileDescriptors": 512,
      "outputBytesPerStream": 1048576
    }
  },
  "workspace": {
    "maxFiles": 10000,
    "maxBytes": 268435456,
    "rejectSpecialFiles": true,
    "rejectEscapingSymlinks": true,
    "acceptCandidateNodeModules": false
  },
  "isolation": {
    "network": "none",
    "readOnlyRootFilesystem": true,
    "candidateUser": "65532:65532",
    "dropCapabilities": "all",
    "noNewPrivileges": true,
    "dockerSocket": "absent",
    "hostFilesystem": "absent",
    "privateStirpiState": "absent",
    "privateEvaluatorMaterial": "absent",
    "environment": "fixed-minimal-v1",
    "writablePaths": ["/workspace", "/tmp"]
  }
}
```

Version 1 is deliberately closed:

- unknown or duplicate fields are errors;
- `schemaVersion` and `version` are positive integers;
- `id` and operation IDs use the existing stable safe-ID grammar;
- paths in dependency inputs are normalized repository-relative paths and may
  not escape the candidate root or resolve through symlinks;
- executables and working directories are absolute container paths;
- each toolchain expectation names the image role in which it is probed;
- argv is an array of literal strings, never a command string or shell input;
- image references are fully qualified digest references;
- each `publicInvocation` tuple is unique, as is each operation ID;
- all limits are positive safe integers and omission is forbidden;
- `database` and `images.postgres` are either both absent when no operation
  needs a database, or both present when at least one does;
- version 1 supports one root npm manifest and lockfile, rejects npm workspaces
  and local, Git, or non-authorized URL dependencies, and denies lifecycle
  scripts. Supporting those forms requires a later reviewed policy version.

`fixed-minimal-v1` supplies only fixed `PATH`, `HOME`, `TMPDIR`, `LANG`, `TZ`,
and `CI` values defined by the runtime contract. A database operation additionally
receives one ephemeral `DATABASE_URL`. No profile field, CLI option, evaluator,
target file, or executor message can add environment entries.

`fixed-dependency-preparation-v1` similarly ignores host, target `.npmrc`, and
user package-manager configuration. It supplies fixed locale, home, cache, and
temporary paths. Registry routing comes only from the install policy and trusted
egress boundary; any retrieval credential is delivered ephemerally by that
boundary rather than inherited from the candidate or host environment.

`sanitized-git-worktree-v1` is an isolated input view assembled from the
authoritative artifact base plus the candidate snapshot. Its `.git` metadata is
new trusted metadata with no remotes, hooks, alternates, external filters,
credentials, or host paths; candidate `.git` content is never copied. This lets
an allowed Git inspection retain worktree semantics without exposing the host
repository. The verifier may mutate only this disposable view.

The exact profile identity is:

```text
profileIdentity = (id, version, sha256(exact profile bytes))
```

The ID and version are readable compatibility labels. The SHA-256 is the exact
authority. An `(id, version)` pair must never be reused for different bytes.

## 2. Trust and authority model

Authority flows only from committed, pinned trusted inputs:

```text
preregistration -> pinned runtime commit -> profile path + exact hash
                                      profile -> images, policies, operations
candidate artifact -> manifest/lock digests -> dependency-bundle identity
public evaluator -> required public checks -> allowed profile operations
executor -> verification ID only -> allowed profile operation
```

The profile owns image selection, dependency preparation, toolchain expectations,
operation commands, database prerequisites, resource limits, and isolation. The
target repository owns candidate source and dependency declarations but does not
own their execution policy. The executor can select only a published operation
ID. The evaluator can select only an exact predeclared public invocation. Neither
can supply command fragments, cwd, environment, network, database setup, or
limits.

Profiles live in the pinned Stirpi runtime tree rather than the target repository,
preserving D013. A profile is changed by committing a new version and new bytes;
there is no mutable machine-level default and no host-tool discovery fallback.

All command-style public checks are conservatively classified as capable of
executing candidate code. They use the isolated verifier even if a particular
command, such as `git diff --check`, appears non-executing. Version 1 has no
general host-command classification mechanism. The host may perform typed,
audited byte copying, hashing, artifact lookup, evidence writing, and container
orchestration. Verification and public-evaluation paths do not run a host
subprocess with the candidate workspace as cwd or input. In particular,
trusted-host `npm` and `node` execution against a candidate is forbidden after
adoption. This does not change Stirpi-controlled Git artifact operations under
D034; those are a separate typed effect boundary and are not evaluator checks.

## 3. Dependency-bundle lifecycle

### Identity

For every candidate snapshot needing dependencies, the runtime hashes the exact
regular-file bytes of `package.json` and `package-lock.json`. It constructs this
key before consulting a cache:

```text
DependencyBundleKeyV1 = {
  schemaVersion: 1,
  kind: "node-modules",
  manifest: { path, sha256 },
  lockfile: { path, sha256 },
  preparationImage: {
    requestedDigest,
    resolvedPlatformManifestDigest
  },
  platform: { os, architecture },
  installPolicySha256
}

bundleKeySha256 = SHA256(canonical DependencyBundleKeyV1 bytes)
```

`installPolicySha256` covers the complete install-policy object, including the
absolute executable, argv, lifecycle-script rule, registry origins, and network
mode. Canonical key encoding is versioned, sorted-key UTF-8 JSON with no
insignificant whitespace. Golden vectors must freeze that encoding before
implementation.

The produced identity is:

```text
DependencyBundleIdentityV1 = {
  key,
  keySha256,
  treeSha256,
  fileCount,
  byteCount
}
```

`treeSha256` is computed from a versioned canonical tree manifest sorted by
slash-normalized path. Each entry includes type, permission bits, size and file
content digest, or a validated relative symlink target. Times, uid/gid and host
filesystem ordering are excluded. Devices, sockets, FIFOs, absolute symlinks,
escaping symlinks and paths outside `node_modules` are rejected.

### Creation and use

1. The trusted runtime reads only the declared manifest and lockfile from the
   bounded candidate snapshot and computes the key.
2. A verified content-addressed-store hit is reused only after its tree digest
   and provenance match the complete key.
3. On a miss, the runtime starts the digest-pinned dependency-preparation image
   with a read-only root, fixed uid, bounded writable scratch space, dropped
   capabilities, no Docker socket, and only the two input files mounted read-only.
4. The container receives only registry retrieval access enforced by a trusted
   egress boundary. Ordinary Docker bridge access is not sufficient evidence of
   `registry-only`. Registry credentials, if ever required, are retrieval-only,
   ephemeral trusted inputs and are neither candidate secrets nor evidence.
5. It executes exactly the profile's absolute executable and argv without a
   shell. `--ignore-scripts` prevents target or package lifecycle code from
   running during preparation.
6. The runtime validates and hashes only the exported `node_modules` tree, records
   the resolved image and package-manager observations, and atomically seals the
   result in Stirpi-owned storage inaccessible to candidates.
7. Verification revalidates the stored digest, then mounts the bundle read-only
   at `/workspace/node_modules`. Candidate `node_modules` is always excluded.
8. A changed manifest or lockfile creates a different key and bundle. It can
   never silently reuse the starting bundle or the executor workspace's modules.

If the isolated install process exits normally with a candidate-caused error,
the verification attempt records a bounded negative preparation result. Failure
to create the boundary, enforce egress, retrieve an allowed object, validate the
cache, or seal/attach a bundle is an operational infrastructure failure. Evidence
keeps this phase distinction.

If rebuilding one key produces a different canonical tree digest, the cache
entry is quarantined and the operation fails as nondeterministic infrastructure;
the newer tree must not overwrite the older identity.

## 4. Image pinning rules

Every image reference must be a fully qualified OCI repository plus lowercase
`sha256` digest. Tags, implicit registries, implicit namespaces, local image
names, and host-default platform selection are rejected. An OCI index digest is
allowed only with the profile's exact OS and architecture; preflight must resolve
and record the selected child manifest.

Preflight records separately for each role:

- the exact requested reference and digest;
- the resolved index digest, when applicable;
- the resolved platform-manifest digest;
- the image-config digest and runtime image ID;
- observed OS, architecture, and rootfs diff IDs.

The requested digest remains the configured authority. The resolved fields prove
what the local runtime actually launched. A platform mismatch, missing digest,
different resolved manifest, or inability to inspect identity fails preflight.
No tag-to-digest resolution is permitted during a run.

## 5. Database prerequisite authority

The profile is the only authority for the PostgreSQL image, extension list,
bootstrap policy, transport, and candidate role properties. Candidate SQL may
create ordinary objects allowed by its lease, but cannot choose bootstrap SQL,
request an extension, or acquire administrator privileges.

`disposable-schema-owner-v1` means:

1. start the pinned PostgreSQL image without network;
2. create a fresh administrator-owned database;
3. install exactly the sorted profile extension list as administrator;
4. create a fresh `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT` login;
5. grant that role connect/temp rights and ownership of one writable schema,
   without database-level create authority;
6. install a fail-closed HBA policy authorizing only the administrator and that
   role over the shared Unix socket;
7. prove final-server readiness, exact HBA state, extension presence, role
   attributes, and authenticated lease connectivity before candidate execution;
8. mount the socket read-only into the verifier and inject only the ephemeral
   lease URL;
9. terminate sessions, drop the database and role, remove the sidecar and
   volumes, and record every cleanup outcome.

Administrator credentials never enter the verifier. Lease credentials are
redacted before output persistence and are not part of replay evidence. Missing
authorized extensions fail preflight or trusted bootstrap; candidate code is
never used to repair prerequisites.

## 6. Evaluator/profile separation

Evaluator semantics consist of public criteria, named checks, their order, and
`all_checks_pass`. A profile contains no completion policy, booking-specific
criterion, hidden oracle, expected output, or hint about which checks should
pass. It merely exposes allowed operations.

For compatibility, each operation may declare one exact `publicInvocation`
selector. The resolver matches the evaluator's executable, argv, and normalized
candidate working directory byte-for-byte. The selector is not executed. A
missing or ambiguous match fails preflight.

Accordingly, `docs/experiments/d032/public-evaluator-v2.json` can remain exactly
unchanged:

| Existing public check | Resolved profile operation |
| --- | --- |
| `npm test` | `node.npm-test.postgres-v1` |
| `npm run typecheck` | `node.npm-typecheck-v1` |
| `git diff --check` | `git.diff-check-v1` |

The evaluator's check IDs remain the IDs in evaluation results. Evidence also
records the resolved operation ID and profile identity. Each isolated ordinary
result is translated into the existing `CheckResult` shape; the evaluator still
runs all checks and applies `all_checks_pass`. Infrastructure failures retain
their operational meaning. Hidden and retrospective evaluation are unaffected.

Executor-requested VERIFY calls the same operation service directly by stable
profile operation ID. This creates no second registry and no looser execution
path.

## 7. Preregistration fields for future pilots

Future preregistrations use a new document schema while schema-less historical
documents remain version 1 evidence. The minimal addition is:

```json
{
  "schemaVersion": 2,
  "verificationProfile": {
    "id": "node-postgres-linux-arm64",
    "version": 1,
    "path": "verification-profiles/node-postgres-linux-arm64-v1.json",
    "sha256": "<64-lowercase-hex>"
  }
}
```

These fields are added alongside the existing pilot fields. `path` is a
normalized repository-root-relative path inside the exact `stirpiCommit`, not
relative to the preregistration-containing commit. ID and version must equal the
parsed file. The hash covers the exact committed bytes.

Schema 2 retains the existing run, invocation, and no-progress budgets, but it
rejects `limits.maxEvaluatorWallTimeMs`: candidate verification wall-time and
output limits now come from each pinned profile operation. Keeping both fields
would create two competing authorities. Historical schema-1 documents retain
their original interpretation.

The runtime commit alone is not an adequate experimental identity because it may
contain several profiles. The combination of `stirpiCommit` and profile `path`
is sufficient to locate the file; the profile SHA-256 is the explicit experimental
identity and detects wrong bytes. A separate profile commit field would duplicate
`stirpiCommit` and is unnecessary while profiles are required to live in that
tree.

Image pins and policy fields are not duplicated into the preregistration because
the profile hash already commits to them. Bundle content digest is an observed
output, not a preregistered choice: its complete recipe is fixed by the profile
plus candidate manifest/lock bytes, and its actual digest is recorded. A future
experiment may additionally pin an expected bundle digest, but that is not
required by this minimal schema.

S003/T003 remain schema-1 historical preflight failures. No historical document,
commit, or frozen D032 file is amended. S004/T004 and later may opt into schema 2
only after the decisions at the end of this document are accepted and the runtime
support exists.

## 8. Preflight checks

Schema-2 preflight completes before output-directory creation, executor launch,
or candidate execution. Its authority and policy validation completes before it
performs any dependency retrieval. Preflight must:

1. complete the existing preregistration and pinned-runtime identity checks;
2. resolve the profile path inside the clean pinned runtime checkout, reject
   traversal/symlinks, hash exact bytes, and verify ID/version/schema;
3. strictly validate every field, enum, path, operation, selector and limit;
4. verify every image is digest-pinned and resolve the declared platform identity;
5. prove that the local container runtime can enforce every declared isolation,
   resource, mount, and registry-egress property;
6. probe toolchain versions inside the relevant pinned images, never through
   host tools;
7. validate the starting manifest/lock format, authorized dependency origins,
   integrity metadata, and unsupported npm features, then prepare or validate
   the starting dependency bundle;
8. resolve every command-style public evaluator check to exactly one operation
   and verify its database/dependency requirements are configured;
9. probe database image capabilities and authorized extensions through trusted
   bootstrap logic without exposing a lease to candidate code;
10. prove the effective run configuration has no host candidate-command path and
    no CLI/environment override of profile authority.

Any failure is preflight provenance, not an experimental result. There is no
fallback to host Node/npm/Git, mutable image tags, candidate modules, broader
network, or a nearby profile.

## 9. Replay provenance

Run evidence preserves:

- exact profile bytes, path, ID, version, SHA-256, and pinned runtime commit;
- requested and resolved image identities for all three roles;
- every dependency bundle key, key hash, tree digest, bounds, toolchain
  observations, preparation outcome, and non-secret provenance;
- operation ID, operation ordinal/attempt, public check ID when applicable,
  candidate workspace digest, bundle identity or `none`, database policy ID or
  `none`, bounded outputs, truncation, timing, exit/signal, result classification,
  and cleanup outcomes;
- the existing evaluator aggregate and individual verification outcomes.

Replay reads the recorded profile bytes and evidence, checks their hashes and
cross-references, supplies recorded verification/evaluation observations to the
semantic engine, and compares the reproduced state/events. It must not inspect
the current profile path, pull or inspect images, consult the bundle store,
rebuild dependencies, start containers, create database leases, or execute any
verification command. The bundle may have been garbage-collected without making
replay invalid.

## 10. Minimal implementation components

After approval, implementation should be limited to these cohesive components:

1. strict profile types, parser, validator, byte hasher, and operation registry;
2. schema-2 preregistration loading from the pinned runtime checkout;
3. OCI image/platform identity preflight and evidence adapter;
4. dependency-key encoder, canonical tree hasher, isolated preparer, and sealed
   content-addressed bundle store;
5. sanitized workspace/Git-view assembler that never copies candidate `.git`;
6. profile-driven verifier adapter and profile-driven PostgreSQL lease provider,
   replacing hard-coded image, extension, and operation values;
7. one verification service shared by executor VERIFY and public evaluation;
8. exact public-invocation resolver and existing-`CheckResult` translator;
9. evidence persistence and effect-free replay validation for profiles, bundles,
   images, and operations;
10. removal or schema-2 gating of `TrustedPreparation` and host
    `CommandChecksEvaluator` candidate execution.

No scheduler, evaluator semantics, hidden evaluation, executor protocol major
version, target-repository metadata, or future experiment feature is needed.

## 11. Deterministic test plan

Implementation acceptance should use deterministic fixtures and injected process,
image, network, clock, and storage adapters:

1. golden profile-byte and bundle-key/tree-digest vectors;
2. strict parser matrices for duplicate/unknown fields, unsafe paths, shell-like
   commands, missing limits, bad IDs, and tag-only or platform-mismatched images;
3. preregistration tests proving path-plus-hash resolution occurs in
   `stirpiCommit`, with traversal, wrong checkout, dirty checkout, ID/version and
   byte mismatches failing before output or executor invocation;
4. bundle-key tests varying one manifest byte, lockfile byte, preparation image
   digest, platform, architecture, and install-policy byte independently;
5. preparer command/mount/environment tests proving exact argv, no shell,
   scripts denied, only declared inputs visible, registry-only egress, no runtime
   secrets, and only `node_modules` exported;
6. bundle-store tests for verified reuse, corrupt content, unsafe entries,
   interrupted atomic publication, key collisions, and divergent rebuild
   quarantine;
7. workspace tests proving candidate `.git` and `node_modules` are excluded,
   sanitized Git diff semantics are retained, symlinks cannot escape, and
   verifier mutations do not alter the authoritative workspace or sealed bundle;
8. operation tests for fixed commands, fixed environment, per-operation bounds,
   no network, database/no-database attachment, output redaction/truncation, and
   cleanup after pass, fail, signal, launch error, and cancellation;
9. database transcript tests proving extension setup precedes the lease,
   administrator ownership, exact non-superuser attributes/HBA/socket policy,
   authenticated probes, credential non-persistence, session termination, and
   teardown failure reporting;
10. an unchanged D032 public-evaluator-v2 fixture proving exact resolution,
    check IDs/order/all-checks behavior, ordinary negative results, and operational
    failure separation;
11. shared-service tests proving public evaluation and VERIFY select identical
    specs and that executor-supplied argv/env/cwd/network/limits are rejected;
12. host-process spies proving schema-2 verification and evaluation paths never
    invoke host npm/node/git with candidate input or cwd and never accept
    candidate `node_modules`, without changing D034 artifact Git operations;
13. replay fixtures whose external adapters throw if called, proving replay needs
    no bundle, image, container, database, network, candidate repository, or
    current profile file while detecting every evidence/hash mismatch;
14. compatibility tests loading S003/T003 unchanged and preserving their
    historical failed-preflight meaning.

One local hostile integration smoke may be run at the implementation milestone
using already-present pinned images and a deny-by-default egress fixture. It is
not a pilot, must use no private material, and is not part of this design task.

## 12. Proposed human-owned decisions

The following is exact candidate text for `docs/DECISIONS.md` after human
approval. It is intentionally not added there by this proposal.

### D060 — Trusted verification profiles own candidate execution policy

Status: proposed

Candidate-executing verification is authorized only by a trusted, versioned
verification profile committed in the pinned Stirpi runtime revision.

The profile owns verifier and supporting image identities, platform, toolchain
expectations, dependency policy, stable operation IDs, fixed executable and argv,
database prerequisites, isolation, and resource/output limits.

Executors may request only a stable operation ID. Evaluators may select only an
operation already authorized by the profile. Neither may supply or override
command, argv, cwd, environment, network, database setup, images, or limits.

Profiles and their operational state remain outside target repositories.

### D061 — Candidate dependencies come only from isolated immutable bundles

Status: proposed

Candidate verification must not trust dependency directories from an executor
workspace or execute candidate-controlled package-manager operations on the
trusted host.

Dependencies are prepared in a dedicated isolated, digest-pinned preparation
environment under an exact trusted install and registry-access policy. The
preparer receives no candidate runtime secrets and exports a bounded immutable
bundle identified by its dependency inputs, preparation image, platform,
architecture, install policy, and canonical content digest.

The verifier receives only a disposable copy or read-only source of a
hash-verified bundle. Bundle provenance and identity are retained as verification
evidence.

### D062 — Verification image and platform identities are explicit

Status: proposed

Every container image used for candidate verification, dependency preparation,
or verification database service must be configured by immutable OCI digest
together with an explicit platform and architecture.

Mutable tags, implicit local images, implicit registries, and host-default
platform selection are not verification authority.

Evidence preserves both the configured digest identity and the actual resolved
platform manifest and image identities used by the container runtime.

### D063 — Database prerequisites are trusted profile authority

Status: proposed

Database image, extensions, bootstrap policy, transport, and candidate-role
properties used by verification are authorized by the trusted verification
profile, not by candidate code.

Trusted infrastructure installs and validates authorized prerequisites before
exposing a disposable non-superuser lease. Candidate code receives neither
administrator credentials nor authority to broaden those prerequisites.

This decision refines the authority source for the disposable and scoped access
required by D059 without changing D059's lease or cleanup semantics.

### D064 — Evaluator meaning is separate from verification environment

Status: proposed

A public evaluator defines solver-visible criteria, required checks, and the
policy that determines whether they pass. A trusted verification profile defines
the environment and fixed operations in which candidate-executing checks run.

Resolving an evaluator check through a profile must not add task-specific hints,
hidden material, expected outcomes, or change the evaluator's completion policy.

All command-style public checks are treated as candidate-executing and use the
isolated verifier. The trusted host may perform only separately typed operations
whose contract cannot execute candidate-controlled code; there is no fallback
from isolated verification to host command execution.

### D065 — Future preregistrations pin exact verification profiles

Status: proposed

A preregistration that uses trusted verification records the profile's stable ID,
version, repository-relative path in the pinned Stirpi runtime commit, and SHA-256
of its exact bytes.

The pinned runtime commit and path locate the profile; the profile SHA-256 is its
explicit experimental identity. Image identities referenced by the profile are
immutable, and actual resolved image identities are retained in run evidence.

Historical preregistrations are not retroactively amended. A failed historical
preflight remains historical provenance.

### D066 — Verification replay consumes identity-bound recorded outcomes

Status: proposed

Replay preserves and validates verification profile identity, dependency-bundle
identity and provenance, configured and resolved image identities, candidate
workspace identity, and verification outcomes.

Replay supplies those recorded outcomes at the verification effect boundary. It
must not rebuild dependencies, consult a live bundle cache or registry, resolve
or launch images, create database leases, or execute candidate verification.
