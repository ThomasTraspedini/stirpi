# Docker acquisition supplement

**Status: source acquisition evidence, not freeze or operational schema-3
verification.** Recorded 2026-09-16 for the P3.c Docker locator correction;
the acquired values were subsequently inserted into the still-unfrozen
trusted-local contract.

The prior `defaultLocalTools()` locator was canonicalized from
`/usr/local/bin/docker` to
`/Applications/OrbStack.app/Contents/MacOS/xbin/docker-tools`. That canonical
target is not a directly invocable Docker locator in this environment: the
OrbStack multiplexer requires operational argv0 `docker`.

The operational locator is `/usr/local/bin/docker`. It is an absolute symlink
to `/Applications/OrbStack.app/Contents/MacOS/xbin/docker`, whose canonical
byte target is the differently named
`/Applications/OrbStack.app/Contents/MacOS/xbin/docker-tools`. The acquired
SHA-256 is computed with `readFileSync` on the operational symlink and therefore
authenticates that target's bytes:

```text
locator: /usr/local/bin/docker
sha256: 9a12c3a0fdc02ce3d6040042e1b8ed257d35dba7f007f76d967995b79b82f903
```

Using that same operational locator, with no pull or container operation,
`docker image inspect
sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94`
observed:

```text
image ID: sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94
platform: linux/arm64
```

This supplements the historical observed environment. Subsequent controlled
insertion pins this Docker byte hash and `linux/arm64` alongside the other
acquired closure-v1 values, without changing the operational locator into the
canonical byte-target path. The contract is still unfrozen and the dedicated
schema-3 preflight has not been run.
