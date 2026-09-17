import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  checkFinalPreregistrations,
  R5,
  CONTRACT_SHA256,
} from "../scripts/p3/check-final-preregistrations.mts";

test("final controller verifies R5 documents without claiming launch or operational verification", () => {
  assert.deepEqual(checkFinalPreregistrations(), {
    status: "final-document-integrity-pass",
    runtimeCommit: R5,
    contractSha256: CONTRACT_SHA256,
    conditions: ["H", "S", "T"],
    preregistrationCommit: "UNRESOLVED-P",
    launchAuthorized: false,
    operationalR5Verified: false,
  });
});

test("final controller fails closed on pilot, executor, contract and public input drift", () => {
  const root = mkdtempSync(join(tmpdir(), "stirpi-final-documents-"));
  try {
    cpSync(resolve("docs"), join(root, "docs"), { recursive: true });
    const check = () => checkFinalPreregistrations(resolve("."), root);
    check();
    for (const file of ["H.json", "S.json", "T.json", "executor-common.json"]) {
      const path = join(root, "docs/experiments/p1-hst/final", file);
      const bytes = readFileSync(path, "utf8");
      const original = JSON.parse(bytes) as Record<string, unknown>;
      for (const key of Object.keys(original)) {
        for (const mutation of ["missing", "changed", "duplicate"]) {
          const altered = { ...original };
          if (mutation === "missing") delete altered[key];
          else altered[key] = "unauthorized";
          writeFileSync(
            path,
            mutation === "duplicate"
              ? bytes.replace(`"${key}":`, `"${key}":null,"${key}":`)
              : JSON.stringify(altered),
          );
          assert.throws(check, `${file}: ${mutation} ${key}`);
          writeFileSync(path, bytes);
        }
      }
      writeFileSync(
        path,
        JSON.stringify({ ...original, preregistrationCommit: R5 }),
      );
      assert.throws(check);
      writeFileSync(path, bytes);
      if (file !== "executor-common.json") {
        const pin = original.trustedLocalContract as Record<string, unknown>;
        for (const key of Object.keys(pin)) {
          writeFileSync(
            path,
            JSON.stringify({
              ...original,
              trustedLocalContract: { ...pin, [key]: "unauthorized" },
            }),
          );
          assert.throws(check);
          writeFileSync(path, bytes);
        }
      }
    }
    for (const file of [
      "p1-hst/trusted-local-contract.json",
      "p1-hst/solver-governance.txt",
      "d032-counterfactual/manifest.json",
      "d032-counterfactual/task.txt",
      "d032/public-evaluator-v2.json",
    ]) {
      const path = join(root, "docs/experiments", file);
      const bytes = readFileSync(path);
      writeFileSync(path, Buffer.concat([bytes, Buffer.from(" ")]));
      assert.throws(check, file);
      writeFileSync(path, bytes);
    }
    check();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
