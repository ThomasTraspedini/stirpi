import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  parseAuthorityJson,
  closedAuthorityObject,
} from "../../src/authority/json.js";
import {
  parseTrustedLocalContract,
  parseLocalFilePin,
} from "../../src/experiments/trusted-local-contract.js";
import { sha256 } from "../../src/experiments/inputs.js";

export function checkFreezeDrafts(
  root = resolve("docs/experiments/p1-hst/draft"),
) {
  const read = (file: string) =>
    parseAuthorityJson(readFileSync(resolve(root, file)));
  const contractBytes = readFileSync(
    resolve(root, "../trusted-local-contract.json"),
  );
  const contract = parseTrustedLocalContract(contractBytes, true);
  assert.equal(contract.status, "frozen");
  assert.equal(contract.id, "p1-hst-common-001");
  assert.equal(contract.testcase, "booking-invariants-d032-counterfactual-001");
  assert.deepEqual(contract.source, {
    repository: "ThomasTraspedini/booking-invariants",
    commit: "bd9ae09ac74374199c48d22ec36c739600cfee59",
  });
  assert.deepEqual(contract.baseline, {
    scope: "baseline-only",
    packageSha256:
      "56fa8c5e289563a9cbbfa1e184cc255369e2bfb8c4105ed3273d53a64946dbcc",
    lockfileSha256:
      "bde87452d6e18fcedfbb025e7214296de5183689ed8d6fddcc47c74d8b7d45d6",
  });
  assert.deepEqual(contract.executor, {
    adapter: "codex",
    executableVersion: "0.154.0-alpha.6.2",
    executableSha256:
      "a1d2f191e70023ed7afd619bc70530f26067a085926e03bae50cf5c0f8298bcf",
    model: "gpt-6-astra",
    effort: "medium",
    adapterPath: "adapters/codex/adapter.mjs",
    timeoutMs: 900000,
  });
  assert.deepEqual(contract.toolchain, {
    platform: "darwin",
    architecture: "arm64",
    node: {
      version: "v24.20.0",
      sha256:
        "c8eedc7651a438fb7d2ceb36fd70032676c855586a36c950ba5a662f0b7853bd",
    },
    npm: {
      version: "11.19.0",
      treeSha256:
        "c066785d7fb176d15e3bb415bb5f6b972c820bac3628c98394b5aaad5974ed1f",
    },
    compiler: {
      treeSha256:
        "64fe5260c74da919d44661f4835c7745f23595d71627f77246f9f44a4def202d",
    },
    typeRoots: {
      treeSha256:
        "2e430908e676f78c504e3f7371c1cf12a4cd7a1e2ebf1a3328643193a2686e5b",
    },
    git: {
      sha256:
        "179301dcb41ea78accc3fa0048a7e6f6710d891945a751a34addd622020c1818",
    },
    docker: {
      sha256:
        "9a12c3a0fdc02ce3d6040042e1b8ed257d35dba7f007f76d967995b79b82f903",
    },
    shell: {
      locator: "/bin/sh",
      sha256:
        "ad5c194b05f83bc5e793c1cd67b148a4b680467b5a5730ab1a31fe4e6460ee9f",
    },
  });
  assert.deepEqual(contract.preparation.postgres, {
    kind: "local-image-id",
    imageId:
      "sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94",
    platform: "linux/arm64",
    prerequisites: ["btree_gist"],
    pull: "never",
    transport: "loopback",
    state: "disposable",
  });
  const expectedInputs = {
    manifest: {
      path: "docs/experiments/d032-counterfactual/manifest.json",
      sha256: "",
    },
    task: {
      path: "docs/experiments/d032-counterfactual/task.txt",
      sha256:
        "9e2da44c2441e43cb9fe394ecf12bb20953c39861df2ecdfb10ec4a48b1f76f1",
    },
    evaluator: {
      path: "docs/experiments/d032/public-evaluator-v2.json",
      sha256:
        "9215c50aa69af9218b3530f22959552cbd41e75c43eb71260b9a732cad950bc1",
    },
    governance: {
      path: "docs/experiments/p1-hst/solver-governance.txt",
      sha256:
        "3d772fc6c57042b73933523bf5583a05c5371a981f93cd8cd56e187db85f2f75",
    },
  };
  const publicRoot = resolve(root, "../../../..");
  // Manifest SHA is fixed below, not derived from an altered candidate.
  expectedInputs.manifest.sha256 =
    "dddfc7d31c29ad1e246fbdf5143d2d8cad62c74bdda17bf8d709af088c348938";
  assert.deepEqual(contract.inputs, expectedInputs);
  for (const pin of Object.values(contract.inputs))
    assert.equal(
      sha256(readFileSync(resolve(publicRoot, pin.path))),
      pin.sha256,
    );
  let common: unknown;
  for (const condition of ["H", "S", "T"]) {
    const p = closedAuthorityObject(
      read(`${condition}.draft.json`),
      [
        "schemaVersion",
        "id",
        "class",
        "testcase",
        "condition",
        "stirpiCommit",
        "trustedLocalContract",
        "hiddenEvaluationDuringRun",
      ],
      "draft pilot",
    );
    assert.equal(p.schemaVersion, 3);
    assert.equal(p.class, "pilot");
    assert.equal(p.id, `p1-hst-${condition}-draft-001`);
    assert.equal(p.condition, condition);
    assert.equal(p.testcase, contract.testcase);
    assert.equal(p.stirpiCommit, "UNRESOLVED-RUNTIME-COMMIT");
    assert.equal(p.hiddenEvaluationDuringRun, false);
    const pin = closedAuthorityObject(
      p.trustedLocalContract,
      ["id", "version", "path", "sha256"],
      "contract pin",
    );
    parseLocalFilePin({ path: pin.path, sha256: pin.sha256 });
    assert.deepEqual(pin, {
      id: contract.id,
      version: contract.version,
      path: "docs/experiments/p1-hst/trusted-local-contract.json",
      sha256: sha256(contractBytes),
    });
    const projection = { ...p };
    delete projection.id;
    delete projection.condition;
    if (common === undefined) common = projection;
    else assert.deepEqual(projection, common);
  }
  assert.deepEqual(read("executor-common.draft.json"), {
    id: "p1-hst-codex-common-draft",
    executable: "/opt/homebrew/Cellar/node@24/24.20.0/bin/node",
    args: [
      "R:adapters/codex/adapter.mjs",
      "--codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "--model",
      "gpt-6-astra",
      "--effort",
      "medium",
      "--timeout-ms",
      "900000",
    ],
  });
  assert.deepEqual(
    read("observed-environment.draft.json"),
    JSON.parse(OBSERVED),
  );
  return {
    status: "draft-common-parts-pass",
    pinState: "freeze-delta-prepared-not-final-runtime-verified",
    conditions: ["H", "S", "T"],
    freezeBlockedBy: [
      "runtime-commit",
      "schema-3-operational-preflight",
      "F1-financial-gate",
      "authentication-and-backend-availability",
    ],
  };
}
const OBSERVED = `{
  "status": "observed-preflight-evidence-not-runtime-pin",
  "sourceCommit": "bd9ae09ac74374199c48d22ec36c739600cfee59",
  "taskSha256": "9e2da44c2441e43cb9fe394ecf12bb20953c39861df2ecdfb10ec4a48b1f76f1",
  "publicEvaluatorSha256": "9215c50aa69af9218b3530f22959552cbd41e75c43eb71260b9a732cad950bc1",
  "node": "v24.20.0",
  "npm": "11.19.0",
  "packageSha256": "56fa8c5e289563a9cbbfa1e184cc255369e2bfb8c4105ed3273d53a64946dbcc",
  "lockfileSha256": "bde87452d6e18fcedfbb025e7214296de5183689ed8d6fddcc47c74d8b7d45d6",
  "postgres": {
    "requestedReference": "postgres:16",
    "observedRuntimeImageId": "sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94",
    "immutablePin": false
  },
  "runtimeEnforcement": {
    "source": "src/experiments/preparation.ts",
    "enforces": [
      "allowlisted public checks",
      "per-workspace package and lockfile stability after preparation",
      "observed Docker image ID in run evidence"
    ],
    "doesNotEnforce": [
      "preflight package SHA-256",
      "preflight lockfile SHA-256",
      "Node or npm version",
      "postgres:16 image ID before launch"
    ]
  }
}`;
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  console.log(JSON.stringify(checkFreezeDrafts()));
