import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executableBuildIdentity } from "../src/proxy-release/executable.js";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  deriveBuildIdentity,
  parseBuildIdentity,
} from "../src/proxy-release/build-identity.js";
const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/build-identity-v1/${name}`, import.meta.url),
  );
const golden = JSON.parse(fixture("golden.json").toString()) as {
  fixture: number;
  canonicalBytes: number;
  preimageBytes: number;
  buildIdentity: string;
}[];
for (const vector of golden)
  test(`D072 normative golden ${vector.fixture}: canonical bytes, preimage, and independent SHA-256`, () => {
    const result = parseBuildIdentity(fixture(`golden-${vector.fixture}.json`));
    assert.equal(result.buildIdentity, vector.buildIdentity);
    assert.equal(result.canonicalDocumentBytes.length, vector.canonicalBytes);
    assert.equal(result.preimage.length, vector.preimageBytes);
    assert.deepEqual(
      result.canonicalDocumentBytes,
      fixture(`golden-${vector.fixture}.jcs`),
    );
    assert.deepEqual(
      result.preimage,
      fixture(`golden-${vector.fixture}.preimage`),
    );
    assert.equal(
      result.preimage.subarray(0, 47).toString(),
      "stirpi.registry-egress-proxy.build-identity.v1\0",
    );
    assert.equal(
      `sha256:${execFileSync("shasum", ["-a", "256"], { input: result.preimage }).toString().split(" ")[0]}`,
      vector.buildIdentity,
    );
    assert.equal(
      parseBuildIdentity(
        Buffer.concat([result.canonicalDocumentBytes, Buffer.from("\n\t ")]),
      ).buildIdentity,
      vector.buildIdentity,
    );
    const reordered = Object.fromEntries(
      Object.entries(result.document).reverse(),
    );
    assert.deepEqual(deriveBuildIdentity(reordered).preimage, result.preimage);
  });
const negatives = JSON.parse(fixture("negative.json").toString()) as {
  name: string;
  hex?: string;
  path?: string[];
  value?: unknown;
  remove?: boolean;
}[];
for (const c of negatives)
  test(`D072 rejects ${c.name}`, () => {
    let input: Buffer;
    if (c.hex) input = Buffer.from(c.hex, "hex");
    else {
      const document = JSON.parse(fixture("golden-1.json").toString());
      let object = document;
      for (const key of c.path!.slice(0, -1)) object = object[key];
      if (c.remove) delete object[c.path!.at(-1)!];
      else object[c.path!.at(-1)!] = c.value;
      input = Buffer.from(JSON.stringify(document));
    }
    assert.throws(() => parseBuildIdentity(input));
  });
test("every variable pre-build identity changes the digest; contracts and fixed parameters reject changes", () => {
  const baseline = parseBuildIdentity(fixture("golden-1.json"));
  const mutations = [
    (d: typeof baseline.document) => {
      d.source.repository = "https://github.com/example/other";
    },
    (d: typeof baseline.document) => {
      d.source.commit.value = "d".repeat(40);
    },
    (d: typeof baseline.document) => {
      d.source.commit = { algorithm: "sha256", value: "a".repeat(64) };
    },
    (d: typeof baseline.document) => {
      d.buildDefinition.sha256 = `sha256:${"0".repeat(64)}`;
    },
    (d: typeof baseline.document) => {
      d.builderImage.reference = d.builderImage.reference.replace(
        "proxy-builder",
        "another-builder",
      );
    },
    (d: typeof baseline.document) => {
      d.builderImage.manifestDigest = `sha256:${"0".repeat(64)}`;
      d.builderImage.reference = `ghcr.io/stirpi/proxy-builder@${d.builderImage.manifestDigest}`;
    },
    (d: typeof baseline.document) => {
      d.target.architecture = "amd64";
      d.builderImage.platform.architecture = "amd64";
    },
  ];
  for (const mutate of mutations) {
    const d = structuredClone(baseline.document);
    mutate(d);
    assert.notEqual(
      deriveBuildIdentity(d).buildIdentity,
      baseline.buildIdentity,
    );
  }
});
test("Go CLI independently agrees on all golden bytes when a local toolchain is available", (t) => {
  const go = process.env.STIRPI_TEST_GO ?? "go";
  try {
    execFileSync(go, ["version"], {
      stdio: "pipe",
      env: { ...process.env, GOTOOLCHAIN: "local" },
    });
  } catch {
    t.skip("No local Go toolchain; no installation or download attempted");
    return;
  }
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "stirpi-go-identity-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "main.go");
  writeFileSync(
    source,
    'package main\nimport "fmt"\nvar buildIdentity string\nfunc main() { fmt.Print(buildIdentity) }\n',
  );
  for (const v of golden) {
    const output = JSON.parse(
      execFileSync(go, ["run", "./cmd/build-identity"], {
        cwd: fileURLToPath(new URL("../proxy", import.meta.url)),
        input: fixture(`golden-${v.fixture}.json`),
        env: {
          ...process.env,
          GOTOOLCHAIN: "local",
          GOPROXY: "off",
          GOSUMDB: "off",
        },
      }).toString(),
    );
    const node = parseBuildIdentity(fixture(`golden-${v.fixture}.json`));
    assert.equal(
      output.canonicalHex,
      node.canonicalDocumentBytes.toString("hex"),
    );
    assert.equal(output.preimageHex, node.preimage.toString("hex"));
    assert.equal(output.buildIdentity, node.buildIdentity);
    const executable = join(directory, `golden-${v.fixture}`);
    execFileSync(
      go,
      [
        "build",
        "-trimpath",
        "-buildvcs=false",
        "-ldflags",
        `-w -X main.buildIdentity=${node.buildIdentity}`,
        "-o",
        executable,
        source,
      ],
      {
        env: {
          ...process.env,
          GOTOOLCHAIN: "local",
          GOPROXY: "off",
          GOSUMDB: "off",
          GOOS: "linux",
          GOARCH: node.document.target.architecture,
          CGO_ENABLED: "0",
        },
      },
    );
    assert.equal(
      executableBuildIdentity(readFileSync(executable), node.document.target),
      node.buildIdentity,
    );
  }
});

test("integer JSON spellings retain identical canonical identity", () => {
  const input = fixture("golden-1.json").toString();
  const expected = parseBuildIdentity(input);
  for (const token of ["1.0", "1e0", "1e+0", "10e-1", "0.01e2"])
    assert.deepEqual(
      parseBuildIdentity(
        input.replace('"schemaVersion": 1', '"schemaVersion": ' + token),
      ).preimage,
      expected.preimage,
    );
});
