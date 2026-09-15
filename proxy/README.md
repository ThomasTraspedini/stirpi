# Registry-egress proxy release inputs

D072 [BuildIdentityV1](../docs/verification/proxy-build-identity-v1.md) identifies
immutable pre-build inputs. The final OCI manifest is a separate output and
provenance subject. No release records exist yet.

## Offline pre-build validation

The source tooling uses the existing `tsx` development loader; production
TypeScript modules are compiled under `dist/proxy-release/` by `npm run build`.
Supply the closed D072 identity document in `authority.json`, an available
reviewed source commit, and independently obtained builder platform-manifest
and config blobs named by their SHA-256 hex in `oci-blobs/`:

```sh
node --import tsx scripts/proxy-release.mjs validate-build \
  --root /absolute/source-repository \
  --input /absolute/authority.json \
  --oci-dir /absolute/oci-blobs \
  --context /absolute/new-clean-context
```

The validator checks the repository URL, full commit and object algorithm,
exact regular-file definition blob, fixed build semantics, builder digest and
actual config platform. It creates the previously nonexistent context entirely
from that commit's blobs and executable bits. Working-tree changes, untracked
files, checkout filters, and Git archive substitutions cannot enter the context.
Links and submodules fail closed. It performs no registry fetch or Docker work.

The returned document and digest must independently agree with the Go tool:

```sh
cd proxy
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go run ./cmd/build-identity < /absolute/authority.json
```

Compare `canonicalHex`, `preimageHex`, and `buildIdentity` to the Node derivation.
All three normative vectors and the shared negative matrix live in
`test/fixtures/build-identity-v1/`; each implementation has its own parser,
serializer, and SHA-256 computation.

## Build and retained evidence

Only after validation, use the returned immutable values and fresh context:

```sh
docker build --platform <validated platform> --target final \
  --build-arg BUILDER_IMAGE=<validated digest reference> \
  --build-arg BUILD_IDENTITY=<derived BuildIdentityV1> \
  -f /absolute/new-clean-context/proxy/Dockerfile /absolute/new-clean-context
```

The source definition and Dockerfile must be reviewed and committed before
validation. The final stage is explicitly named `final`. Builds keep the ELF
symbol table (`-w`, without `-s`), allowing offline verification to locate and
read the actual Go `main.buildIdentity` string through its ELF symbol and string
header. A copied flag or an arbitrary digest elsewhere in the binary is not
accepted as the embedded value. Candidate code is never executed by the verifier.

The release build retains independently inspected OCI manifest/config/layer and
executable identities. The script's SBOM and attachment helpers retain their
standard formats. Provenance uses SLSA v1 with the Stirpi `/v2` build type, exact
pre-build fields, and the derived `arguments.BUILD_IDENTITY`. Its sole subject
remains the final OCI platform manifest. Candidate records require schema 2.

`verify-candidate --root <repository> --candidate <candidate.json> --oci-dir
<local blobs and rootfs> --readiness <retained readiness.json>` reads evidence
strictly, reconstructs candidate and provenance identities independently, reads
the executable value, and cross-binds retained readiness. Readiness must come
from the independently observed exact artifact launch; this offline check does
not replace D068 runtime challenge, topology, and launched-container attestation.
The command does not generate candidates, approvals, index entries, or publish
artifacts. Conformance suite/execution and runtime work remain separate.
