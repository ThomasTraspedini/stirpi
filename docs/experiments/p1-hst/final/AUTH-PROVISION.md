# Explicit auth provision — prepared for review

Date: 2026-09-17. Baseline HEAD P is
`a954f87c26f91d78d195571bee8f76b0b5a8efc2`. The uncommitted delta adds only
`--auth-file /Users/thomastraspedini/.codex/auth.json` to the shared executor,
updates its exact document assertion and regression checks, and documents the
provision. H/S/T share the same executor. R5, the frozen contract, public inputs,
model, effort and timeout are unchanged.

## Credential boundary and F1

The selected file is the existing login outside both the repository and solver
workspace. Metadata-only checks (`lstatSync`, `accessSync(R_OK)`) observed a
regular file, no symlink, mode `0600`, owner UID 501 equal to the current UID,
and read access. No credential content was read, printed, hashed or copied;
no login, credential change or temporary auth symlink was performed here.

The previous non-model probe attested ChatGPT authentication and backend
reachability. This is inherited context, not a fresh attestation of this file's
contents, current live session or quota, or actual model availability.
Metadata alone cannot establish authentication type.
Only the existing ChatGPT login compatible with F1 is authorized; if that
provenance cannot be confirmed before execution, stop.

The unchanged R5 adapter already accepts this trailing option. At a separately
authorized invocation it creates isolated temporary HOME/CODEX_HOME/TMPDIR and
links the selected file as `CODEX_HOME/auth.json`; the CLI may use and refresh
that login. Personal configuration is ignored and API-key/provider/proxy
environment variables are stripped. No billed API key or fallback is introduced.
The document controller checks the exact locator without accessing the login.

F1 remains €0 incremental spending using included ChatGPT quota only. Before any
attempt, separately authorized non-model checks must establish authentication
and observable limits. Exhausted quota, payment requirements or unavailable
gpt-6-astra require a stop without fallback or retry to bypass F1. Missing
monetary telemetry remains `costo monetario non disponibile`.

## Verification provenance

One full test suite was executed before edits from the normal operational
checkout `/Users/thomastraspedini/stirpi`, with exact HEAD P, clean tracked state
and existing local dependencies:

```sh
/opt/homebrew/Cellar/node@24/24.20.0/bin/node --import tsx --test test/*.test.ts
```

Exit 0: 428 tests, 427 pass, 0 fail, 1 skip (independent Go golden check: no local
Go toolchain). Log: `/private/tmp/stirpi-P-a954f87-full-suite.log`, SHA-256
`1fdcb8453dba77ecae8135c644cf8fa849ef8bf8c31524c83fe4cea33acdbcf0`.
Node v24.20.0 SHA-256:
`c8eedc7651a438fb7d2ceb36fd70032676c855586a36c950ba5a662f0b7853bd`.
Unchanged package-lock SHA-256:
`f523bc605d316656599883cb4b6e40545353d713b6c4cc321f023eb3c68951e3`.
This supersedes the incomplete dependency-less P clone suite as baseline suite
evidence; it establishes no live authentication or operational preflight claim.

After edits, focused verification passed:

- `node --import tsx --test test/p3-final-preregistrations.test.ts`: 2 pass,
  including rejection of absent, incomplete, relative, replaced or duplicate
  auth selection and extra key arguments. Log:
  `/private/tmp/stirpi-auth-provision-focused.log`, SHA-256
  `56291892552bb7c7d1070bb1f21aa8edd2cd6d60de5ed90309afdfa8de9eb8be`.
- `node node_modules/typescript/bin/tsc --noEmit`: exit 0.
- `node --import tsx scripts/p3/check-final-preregistrations.mts`:
  `final-document-integrity-pass`, no launch or operational verification claim.
- `git diff --check`: exit 0.

All Node commands above used the exact Node executable shown for the full suite.
Verified delta SHA-256 identities:

| Input                                       | SHA-256                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| executor-common.json                        | `0614ef9a7daaa857bd46dc9299b31da0866467d878bebec1a29f816b1a1ddc34` |
| scripts/p3/check-final-preregistrations.mts | `3ea6eb6a2554de7197919a5748da8ff699c81f852e37ed1ff19b8e2e0c015755` |
| test/p3-final-preregistrations.test.ts      | `0e05ba1db5f2c66e17dbe189cc4f27202d889a567cafe7e41d02b6b77774e63e` |

The full-suite result applies to committed P; focused checks cover the changed
executor/controller/tests. No second full suite was run. Historical R5 preflight
remains evidence of its recorded inputs, not of this new auth selection.

Review of this uncommitted delta and a separately authorized subsequent input
commit remain required before launch forms can consume it. The controller's
`UNRESOLVED-P` denotes that future input commit. No commit, push, real preflight,
live auth/backend probe, model or experiment run was performed. Stop for review.
