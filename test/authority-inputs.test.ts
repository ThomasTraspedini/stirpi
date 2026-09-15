import assert from "node:assert/strict";
import fs, {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAuthorityJson } from "../src/authority/json.js";
import {
  readRepositoryFile,
  repositoryPath,
} from "../src/authority/repository-file.js";

const malformed: (string | Buffer)[] = [
  "\uFEFF{}",
  Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
  Buffer.from([0x22, 0xc0, 0xaf, 0x22]),
  Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22]),
  Buffer.from([0x22, 0xf0, 0x9f, 0x22]),
  '{"a":1,"a":2}',
  '{"nested":{"key":1,"k\\u0065y":2}}',
  '{"__proto__":1,"\\u005f_proto__":2}',
  '"\\ud800"',
  '"\\udfff"',
  '"\\ud800x"',
  '"\ud800"',
  '{"\\ud800":0}',
  "9007199254740992",
  "-9007199254740992",
  "1e400",
  "0.1",
  "1.0000000000000001",
  "9007199254740991.1",
  "1e-400",
  "{}{}",
  "{} false",
  "{}\u00a0",
  "[1,]",
  '{"a":1,}',
  "{a:1}",
  "01",
  "+1",
  '"\\x20"',
  '"a\nb"',
];
test("authority JSON rejects lossy decoding, duplicate decoded keys, unsafe decimals, and trailing data", () => {
  for (const bytes of malformed)
    assert.throws(
      () => parseAuthorityJson(bytes),
      /Authority JSON/,
      String(bytes),
    );
  assert.deepEqual(
    parseAuthorityJson(
      ' {"astral":"\\ud83d\\ude00","é":1,"é":2,"a":[true,false,null,-9007199254740991,1.0,1e2]} \n',
    ),
    {
      astral: "😀",
      é: 1,
      é: 2,
      a: [true, false, null, -9007199254740991, 1, 100],
    },
  );
  const proto = parseAuthorityJson('{"__proto__":{"admin":true}}') as object;
  assert.equal(Object.hasOwn(proto, "__proto__"), true);
  assert.equal(({} as { admin?: boolean }).admin, undefined);
});
test("repository paths reject aliases without rewriting input", () => {
  for (const path of [
    "",
    ".",
    "../p",
    "a/../p",
    "a/./p",
    "/p",
    "a//p",
    "a/",
    "a\\p",
    "C:p",
    "a\0p",
    "a\np",
    "\ud800",
  ])
    assert.throws(() => repositoryPath(path), /noncanonical/);
  assert.equal(
    repositoryPath("verification-profiles/node-v1.json"),
    "verification-profiles/node-v1.json",
  );
});
test("repository reader rejects links at leaf, intermediate, and root components and special files", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "stirpi-authority-"));
  try {
    mkdirSync(join(root, "files"));
    writeFileSync(join(root, "files", "data"), "bytes\n");
    assert.equal(readRepositoryFile(root, "files/data").toString(), "bytes\n");
    symlinkSync("files/data", join(root, "leaf"));
    symlinkSync("files", join(root, "middle"));
    symlinkSync(root, join(root, "root-link"));
    for (const [base, path] of [
      [root, "leaf"],
      [root, "middle/data"],
      [join(root, "root-link"), "files/data"],
      [root, "files"],
    ])
      assert.throws(
        () => readRepositoryFile(base!, path!),
        /symlink|non-regular/,
      );
    execFileSync("mkfifo", [join(root, "fifo")]);
    assert.throws(() => readRepositoryFile(root, "fifo"), /non-regular/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("repository reader detects opened-file substitution even with identical bytes", (t) => {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "stirpi-authority-swap-"),
  );
  const path = join(root, "data");
  writeFileSync(path, "same");
  const original = fs.openSync;
  const mocked = t.mock.method(
    fs,
    "openSync",
    (...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === path) {
        renameSync(path, join(root, "old"));
        writeFileSync(path, "same");
      }
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => readRepositoryFile(root, "data"),
      /opened-file substitution/,
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
test("repository reader detects path and content replacement after opening", (t) => {
  for (const kind of ["leaf", "ancestor", "content"] as const) {
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "stirpi-authority-read-swap-"),
    );
    mkdirSync(join(root, "dir"));
    const path = join(root, "dir", "data");
    writeFileSync(path, "same");
    const original = fs.readFileSync;
    const mocked = t.mock.method(fs, "readFileSync", (fd: number) => {
      if (kind === "leaf") {
        renameSync(path, join(root, "old"));
        writeFileSync(path, "same");
      }
      if (kind === "ancestor") {
        renameSync(join(root, "dir"), join(root, "old"));
        mkdirSync(join(root, "dir"));
        writeFileSync(path, "same");
      }
      if (kind === "content") writeFileSync(path, "changed");
      return original(fd);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => readRepositoryFile(root, "dir/data"),
        /substitution|changed during read/,
      );
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
