import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAuthorityJson } from "../../src/authority/json.js";
import { parseTrustedLocalContract } from "../../src/experiments/trusted-local-contract.js";
import { sha256 } from "../../src/experiments/inputs.js";

export const R5 = "b8cab81b0889d912c48b11bcf1c3eeec6f3c77d9";
export const CONTRACT_SHA256 =
  "207d4917ae5f4a3b708562f60c0a8193931d466b56399dd0d18ff570c176ec5e";
const contractPath = "docs/experiments/p1-hst/trusted-local-contract.json";

// Document integrity only: no tool execution, live gate assessment or launch.
export function checkFinalPreregistrations(
  repository = resolve("."),
  documentRoot = repository,
) {
  const read = (path: string) => readFileSync(resolve(documentRoot, path));
  const committed = (path: string) =>
    execFileSync(
      "git",
      ["--no-replace-objects", "-C", repository, "show", `${R5}:${path}`],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  const bytes = read(contractPath);
  assert.equal(sha256(bytes), CONTRACT_SHA256);
  assert.ok(bytes.equals(committed(contractPath)), "contract differs from R5");
  const contract = parseTrustedLocalContract(bytes, true);
  assert.equal(contract.status, "frozen");
  for (const pin of Object.values(contract.inputs)) {
    const input = read(pin.path);
    assert.equal(sha256(input), pin.sha256);
    assert.ok(input.equals(committed(pin.path)), `${pin.path} differs from R5`);
  }
  for (const condition of ["H", "S", "T"]) {
    assert.deepEqual(
      parseAuthorityJson(
        read(`docs/experiments/p1-hst/final/${condition}.json`),
      ),
      {
        schemaVersion: 3,
        id: `p1-hst-${condition}-001`,
        class: "pilot",
        testcase: contract.testcase,
        condition,
        stirpiCommit: R5,
        trustedLocalContract: {
          id: contract.id,
          version: contract.version,
          path: contractPath,
          sha256: CONTRACT_SHA256,
        },
        hiddenEvaluationDuringRun: false,
      },
    );
  }
  assert.deepEqual(
    parseAuthorityJson(
      read("docs/experiments/p1-hst/final/executor-common.json"),
    ),
    {
      id: "p1-hst-codex-common",
      executable: "/opt/homebrew/Cellar/node@24/24.20.0/bin/node",
      args: [
        "R:" + contract.executor.adapterPath,
        "--codex",
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "--model",
        contract.executor.model,
        "--effort",
        contract.executor.effort,
        "--timeout-ms",
        String(contract.executor.timeoutMs),
      ],
    },
  );
  return {
    status: "final-document-integrity-pass",
    runtimeCommit: R5,
    contractSha256: CONTRACT_SHA256,
    conditions: ["H", "S", "T"],
    preregistrationCommit: "UNRESOLVED-P",
    launchAuthorized: false,
    operationalR5Verified: false,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  console.log(JSON.stringify(checkFinalPreregistrations()));
