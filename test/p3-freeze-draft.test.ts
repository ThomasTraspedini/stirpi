import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { checkFreezeDrafts } from "../scripts/p3/check-freeze-drafts.mts";
import { sha256 } from "../src/experiments/inputs.js";

const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8"));
function paths(
  object: Record<string, unknown>,
  prefix: string[] = [],
): string[][] {
  return Object.entries(object).flatMap(([key, value]) => {
    const path = [...prefix, key];
    return [
      path,
      ...(value && typeof value === "object" && !Array.isArray(value)
        ? paths(value as Record<string, unknown>, path)
        : []),
    ];
  });
}
function parent(object: Record<string, unknown>, path: string[]) {
  let value = object;
  for (const key of path.slice(0, -1))
    value = value[key] as Record<string, unknown>;
  return value;
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "stirpi-p3-drafts-"));
  for (const path of ["d032", "d032-counterfactual", "p1-hst"])
    cpSync(
      resolve("docs/experiments", path),
      join(directory, "docs/experiments", path),
      { recursive: true },
    );
  const root = join(directory, "docs/experiments/p1-hst/draft");
  return {
    root,
    close() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("P3 freeze controller checks complete common documents and reports acquired unfrozen pins without obsolete CLI blocker", () => {
  assert.deepEqual(checkFreezeDrafts(), {
    status: "draft-common-parts-pass",
    pinState: "acquired-unfrozen-not-schema3-preflight-verified",
    conditions: ["H", "S", "T"],
    freezeBlockedBy: [
      "runtime-commit",
      "schema-3-operational-preflight",
      "F1-financial-gate",
      "authentication-and-backend-availability",
    ],
  });
});
test("controller rejects every missing field, unknown field and duplicate key, including nested identities", () => {
  const f = fixture();
  try {
    for (const file of [
      "H.draft.json",
      "S.draft.json",
      "T.draft.json",
      "executor-common.draft.json",
      "observed-environment.draft.json",
      "../trusted-local-contract.json",
    ]) {
      const path = resolve(f.root, file),
        bytes = readFileSync(path, "utf8"),
        original = read(path);
      for (const keys of paths(original)) {
        const altered = structuredClone(original);
        delete parent(altered, keys)[keys.at(-1)!];
        writeFileSync(path, JSON.stringify(altered));
        assert.throws(
          () => checkFreezeDrafts(f.root),
          `${file}: missing ${keys.join(".")}`,
        );
        writeFileSync(path, bytes);
      }
      for (const keys of [
        [],
        ...paths(original).filter((keys) => {
          const value = parent(original, keys)[keys.at(-1)!];
          return value && typeof value === "object" && !Array.isArray(value);
        }),
      ]) {
        const altered = structuredClone(original),
          target = keys.length
            ? (parent(altered, keys)[keys.at(-1)!] as Record<string, unknown>)
            : altered;
        target.extra = "not-authority";
        writeFileSync(path, JSON.stringify(altered));
        assert.throws(() => checkFreezeDrafts(f.root));
        writeFileSync(path, bytes);
      }
      const key = Object.keys(original)[0]!;
      writeFileSync(
        path,
        bytes.replace(`"${key}":`, `"${key}":null,"${key}":`),
      );
      assert.throws(() => checkFreezeDrafts(f.root), /duplicate/);
      writeFileSync(path, bytes);
    }
  } finally {
    f.close();
  }
});
test("controller rejects drift even when pilot contract hashes are updated consistently", () => {
  const f = fixture();
  try {
    const path = resolve(f.root, "../trusted-local-contract.json"),
      bytes = readFileSync(path, "utf8"),
      original = read(path);
    for (const [keys, value] of [
      [["toolchain", "node", "version"], "different"],
      [["toolchain", "npm", "treeSha256"], "0".repeat(64)],
      [["baseline", "packageSha256"], "0".repeat(64)],
      [["executor", "executableVersion"], "different"],
      [["inputs", "manifest", "sha256"], "0".repeat(64)],
      [["preparation", "postgres", "imageId"], "sha256:" + "0".repeat(64)],
      [["source", "commit"], "0".repeat(40)],
      [["id"], "different"],
    ] as [string[], unknown][]) {
      const altered = structuredClone(original);
      parent(altered, keys)[keys.at(-1)!] = value;
      const text = JSON.stringify(altered);
      writeFileSync(path, text);
      for (const condition of ["H", "S", "T"]) {
        const pilotPath = join(f.root, `${condition}.draft.json`),
          pilot = read(pilotPath);
        (pilot.trustedLocalContract as Record<string, unknown>).sha256 =
          sha256(text);
        writeFileSync(pilotPath, JSON.stringify(pilot));
      }
      assert.throws(() => checkFreezeDrafts(f.root));
      writeFileSync(path, bytes);
    }
  } finally {
    f.close();
  }
});
