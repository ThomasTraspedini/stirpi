#!/usr/bin/env node
/** Build the deliberately redacted, offline-only P6 replay package. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PINS = {
  H: {
    runId: "16b62f83-1139-484c-84d7-a7162ed2bf5b",
    sourceBase: "bd9ae09ac74374199c48d22ec36c739600cfee59",
    candidateRef: "4c68b6f10b5cdb8bca9a8c120423e1839f83d54f",
    manifest:
      "7b4635b38d9d83057f0d8d9de7ba2a42593285af42075bd7a50639f5c5c85c69",
    entries: 73,
  },
  S: {
    runId: "1cf938be-3672-4876-8e1e-b9e5d5e7e17f",
    sourceBase: "bd9ae09ac74374199c48d22ec36c739600cfee59",
    candidateRef: "a836a4a8b2392928da406738c0a912dcad0e5528",
    manifest:
      "75b3d50ea85923e84065bc3740e1857cab2e59ca5df89106908cada5ce5bfd7a",
    entries: 72,
  },
  T: {
    runId: "73446a9e-8edc-44ba-8ad2-3780d0b6d2d8",
    sourceBase: "bd9ae09ac74374199c48d22ec36c739600cfee59",
    candidateRef: "76bb8923481e89d338e907169a9c4470a80ceb69",
    manifest:
      "180e05e717894b960db8fd170d56e282a102de279b800c27cb613d84f5b56da1",
    entries: 72,
  },
};
const CONDITIONS = Object.keys(PINS);
const FILES = [
  "result.json",
  "metadata.json",
  "preflight.json",
  "preparation.json",
  "task.txt",
  "invocations.jsonl",
  "state.json",
  "runtime-evaluations.json",
  "operational.jsonl",
];
const RUNTIME = "b8cab81b0889d912c48b11bcf1c3eeec6f3c77d9";
const INPUT = "2be4aedc12176639b31cef6360e88cc13cd7857d";
const BUILDER = { path: "scripts/p6/build-public-replay.mjs", version: 2 };
const TRANSFORMATIONS = [
  "portable replacement of host and temporary locators",
  "redaction of solver text, completion results, and raw stdout/stderr",
  "invocation records reduced to replay-required public fields",
  "deterministic redacted prompts with recomputed prompt identities",
];
const EXCLUSIONS = [
  "SQLite",
  "Git artifacts",
  "candidate source",
  "raw operator logs",
  "auth material",
  "private evaluation",
];
const REPLAY_COMMAND =
  "node dist/cli/index.js experiment replay docs/experiments/p1-hst/replay/<H|S|T>";
const REPLAY_STDOUT = "Experiment replay verified without external execution";
const SECRET_KEYS = new Set([
  "stdout",
  "stderr",
  "text",
  "result",
  "objective",
]);
const SHA = (value) => createHash("sha256").update(value).digest("hex");
const localPrettier = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/.bin/prettier",
);
const usage = () => {
  throw new Error(
    "Usage: node scripts/p6/build-public-replay.mjs build --source <P4-C01> --output <replay-dir> [--replace] | verify --package <replay-dir> --cli <absolute-dist-cli>",
  );
};
const [command, ...args] = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const source = value("--source");
const output = value("--output");
const packagePath = value("--package");
const cli = value("--cli");
const replace = args.includes("--replace");
const allowed =
  command === "build"
    ? ["--source", source, "--output", output, "--replace"]
    : command === "verify"
      ? ["--package", packagePath, "--cli", cli]
      : [];
if (!allowed.length || args.some((arg) => !allowed.includes(arg))) usage();
const root = source ? resolve(source) : undefined;
const destination = output ? resolve(output) : undefined;
const contained = (base, candidate) =>
  candidate === base || candidate.startsWith(`${base}${sep}`);
const regular = (path) => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`Expected regular file: ${path}`);
};
const assertNoSymlink = (path) => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Symlink rejected: ${path}`);
  if (stat.isDirectory())
    for (const entry of readdirSync(path)) assertNoSymlink(join(path, entry));
};
const strictJson = (bytes, label) => {
  // JSON.parse silently accepts duplicate keys. Reject them before parsing; this
  // scanner tracks object nesting and treats a quoted token before ':' as a key.
  const keys = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let token = "";
  let expectingKey = false;
  for (let i = 0; i < bytes.length; i += 1) {
    const char = bytes[i];
    if (inString) {
      // Keep the raw JSON string body intact. JSON.parse below must receive
      // escapes (including Unicode surrogate pairs) to compare decoded keys.
      if (escaped) {
        token += char;
        escaped = false;
      } else if (char === "\\") {
        token += char;
        escaped = true;
      } else if (char === '"') {
        inString = false;
        let next = i + 1;
        while (/\s/.test(bytes[next] ?? "")) next += 1;
        if (expectingKey && bytes[next] === ":") {
          const decoded = JSON.parse(`"${token}"`);
          if (keys[depth].has(decoded))
            throw new Error(`Duplicate JSON key in ${label}: ${decoded}`);
          keys[depth].add(decoded);
        }
      } else token += char;
      continue;
    }
    if (char === '"') {
      inString = true;
      token = "";
      continue;
    }
    if (char === "{") {
      depth += 1;
      keys[depth] = new Set();
      expectingKey = true;
      continue;
    }
    if (char === "}") {
      keys.pop();
      depth -= 1;
      expectingKey = false;
      continue;
    }
    if (char === ",") {
      expectingKey = true;
      continue;
    }
    if (!/\s/.test(char)) expectingKey = false;
  }
  return JSON.parse(bytes);
};
const json = (path) => {
  regular(path);
  return strictJson(readFileSync(path, "utf8"), path);
};
const lines = (path) =>
  readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line, index) => strictJson(line, `${path}:${index + 1}`));
const portable = (text) =>
  text
    .replaceAll("/Users/thomastraspedini", "<HOST_HOME>")
    .replaceAll("/private/tmp", "<PRIVATE_TMP>")
    .replaceAll("/private/var", "<PRIVATE_VAR>")
    .replaceAll(".codex/auth.json", "<AUTH_LOCATOR>")
    .replace(/thomastraspedini/gi, "public");
const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const formatJson = (value) => {
  if (!existsSync(localPrettier))
    throw new Error(
      `Local Prettier is required and was not found: ${localPrettier}`,
    );
  return execFileSync(localPrettier, ["--parser", "json"], {
    encoding: "utf8",
    input: value,
  });
};
const marker = (condition, value) =>
  `[REDACTED ${condition} ${SHA(value).slice(0, 16)}]`;

function verifyBundle(bundle, expectedManifestSha256) {
  assertNoSymlink(bundle);
  const manifestPath = join(bundle, "bundle-sha256.json");
  const manifestBytes = readFileSync(manifestPath);
  const manifestSha256 = SHA(manifestBytes);
  if (manifestSha256 !== expectedManifestSha256)
    throw new Error(`Source manifest pin mismatch: ${bundle}`);
  const manifest = strictJson(manifestBytes.toString("utf8"), manifestPath);
  if (
    !manifest ||
    Array.isArray(manifest) ||
    Object.keys(manifest).some(
      (key) => typeof key !== "string" || !/^[^/].*$/.test(key),
    )
  )
    throw new Error(`Invalid source manifest: ${manifestPath}`);
  for (const [file, expected] of Object.entries(manifest)) {
    const target = resolve(bundle, file);
    if (!contained(bundle, target))
      throw new Error(`Manifest escapes source bundle: ${file}`);
    regular(target);
    if (SHA(readFileSync(target)) !== expected)
      throw new Error(`Source manifest mismatch: ${file}`);
  }
  return { sha256: manifestSha256, files: Object.keys(manifest).length };
}

function redact(value, condition, path = []) {
  if (typeof value === "string") {
    const key = path.at(-1);
    if (
      key === "text" &&
      path.at(-2) === "governance" &&
      path.at(-3) === "input"
    )
      return portable(value);
    if (SECRET_KEYS.has(key) && key !== "objective")
      return marker(condition, value);
    if (key === "objective" && value.length > 1000)
      return marker(condition, value);
    return portable(value);
  }
  if (Array.isArray(value))
    return value.map((item, index) =>
      redact(item, condition, [...path, index]),
    );
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "diagnosticEnvironment")
        .map(([key, item]) => [key, redact(item, condition, [...path, key])]),
    );
  }
  return value;
}

function patchHashes(value, changes) {
  if (typeof value === "string") return changes.get(value) ?? value;
  if (Array.isArray(value))
    return value.map((item) => patchHashes(item, changes));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        patchHashes(item, changes),
      ]),
    );
  return value;
}

function repairTrustedLocal(value) {
  if (Array.isArray(value)) {
    value.forEach(repairTrustedLocal);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) repairTrustedLocal(child);
  const trusted = value.trustedLocal;
  if (!trusted?.contents || !trusted?.inputs || !value.preregistration) return;
  const contract = JSON.parse(trusted.contents);
  for (const [name, input] of Object.entries(trusted.inputs)) {
    if (!input?.contents || typeof input.contents !== "string") continue;
    input.sha256 = SHA(input.contents);
    if (contract.inputs?.[name]) contract.inputs[name].sha256 = input.sha256;
  }
  trusted.contract = contract;
  trusted.contents = `${JSON.stringify(contract, null, 2)}\n`;
  trusted.contractSha256 = SHA(trusted.contents);
  const registration = value.preregistration;
  registration.document.trustedLocalContract.sha256 = trusted.contractSha256;
  registration.contents = `${JSON.stringify(registration.document, null, 2)}\n`;
  registration.sha256 = SHA(registration.contents);
}

function buildCondition(condition, stage) {
  const bundle = resolve(root, `attempt-01-${condition}`);
  if (!contained(root, bundle) || !existsSync(bundle))
    throw new Error(`Missing condition bundle ${condition}`);
  const sourceManifest = verifyBundle(bundle, PINS[condition].manifest);
  const sourceFiles = Object.fromEntries(
    FILES.map((file) => [file, readFileSync(join(bundle, file), "utf8")]),
  );
  const sourceResult = strictJson(
    sourceFiles["result.json"],
    `${bundle}/result.json`,
  );
  const pin = PINS[condition];
  const artifacts = sourceResult.artifacts;
  const matching = Array.isArray(artifacts)
    ? artifacts.filter(
        (entry) => entry?.workId === "w1" && entry?.lineageId === "l1",
      )
    : [];
  const artifact = matching.length === 1 ? matching[0]?.artifact : undefined;
  if (
    sourceResult.condition !== condition ||
    sourceResult.runId !== pin.runId ||
    sourceResult.sourceCommit !== pin.sourceBase ||
    sourceManifest.sha256 !== pin.manifest ||
    !artifact ||
    artifact.base !== pin.sourceBase ||
    artifact.ref !== pin.candidateRef
  )
    throw new Error(`Condition/run/ref identity rejected for ${condition}`);

  const transformed = {};
  for (const [file, contents] of Object.entries(sourceFiles)) {
    if (file === "task.txt") transformed[file] = portable(contents);
    else if (file.endsWith(".jsonl"))
      transformed[file] = `${lines(join(bundle, file))
        .map((entry) => JSON.stringify(redact(entry, condition)))
        .join("\n")}\n`;
    else
      transformed[file] =
        `${JSON.stringify(redact(strictJson(contents, `${bundle}/${file}`), condition), null, 2)}\n`;
  }
  for (const file of FILES.filter((name) => name.endsWith(".json")))
    transformed[file] = formatJson(transformed[file]);
  for (const file of FILES.filter((name) => name.endsWith(".json"))) {
    const parsed = JSON.parse(transformed[file]);
    repairTrustedLocal(parsed);
    transformed[file] = formatJson(`${JSON.stringify(parsed, null, 2)}\n`);
  }
  const changes = new Map();
  for (const file of FILES)
    changes.set(SHA(sourceFiles[file]), SHA(transformed[file]));
  for (const file of FILES.filter((name) => name !== "task.txt")) {
    const parsed = file.endsWith(".jsonl")
      ? transformed[file].trimEnd().split("\n").map(JSON.parse)
      : JSON.parse(transformed[file]);
    const patched = patchHashes(parsed, changes);
    transformed[file] = file.endsWith(".jsonl")
      ? `${patched.map((entry) => JSON.stringify(entry)).join("\n")}\n`
      : formatJson(`${JSON.stringify(patched, null, 2)}\n`);
  }
  // Prompt records must retain the public governance bytes, while their prompt is a deterministic redaction.
  const invocationRows = transformed["invocations.jsonl"]
    .trimEnd()
    .split("\n")
    .map(JSON.parse);
  const publicInvocationRows = [];
  for (const row of invocationRows) {
    if (row.type === "started") {
      row.prompt = `[PUBLIC REDACTED PROMPT ${condition} invocation ${row.index}]\n${row.input.governance.text}`;
      row.promptSha256 = SHA(row.prompt);
      publicInvocationRows.push({
        type: "started",
        index: row.index,
        workId: row.workId,
        lineageId: row.lineageId,
        input: { governance: row.input.governance },
        governanceSha256: row.governanceSha256,
        promptSha256: row.promptSha256,
        prompt: row.prompt,
      });
    }
    if (row.type === "process" && row.effectivePromptIdentity) {
      row.effectivePromptIdentity.promptSha256 = SHA(
        `[PUBLIC REDACTED PROMPT ${condition} invocation ${row.index}]\n${invocationRows.find((item) => item.type === "started" && item.index === row.index)?.input.governance.text}`,
      );
      publicInvocationRows.push({
        type: "process",
        index: row.index,
        effectivePromptIdentity: row.effectivePromptIdentity,
      });
    }
    if (row.type === "returned")
      publicInvocationRows.push({ type: "returned", index: row.index });
  }
  transformed["invocations.jsonl"] =
    `${publicInvocationRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const out = join(stage, condition);
  mkdirSync(out, { recursive: true });
  for (const file of FILES) writeFileSync(join(out, file), transformed[file]);
  return {
    condition,
    runId: sourceResult.runId,
    sourceBase: pin.sourceBase,
    candidateRef: pin.candidateRef,
    sourceBundleManifestSha256: sourceManifest.sha256,
    sourceBundleManifestEntries: sourceManifest.files,
  };
}

function replaceRecoverably(stage, destination) {
  if (!existsSync(destination)) return renameSync(stage, destination);
  if (!replace)
    throw new Error(
      `Output already exists: ${destination}; use --replace for recoverable replacement`,
    );
  assertNoSymlink(destination);
  const backup = `${destination}.p6-backup-${process.pid}`;
  if (existsSync(backup))
    throw new Error(`Backup path already exists: ${backup}`);
  renameSync(destination, backup);
  try {
    renameSync(stage, destination);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(destination) && existsSync(backup))
      renameSync(backup, destination);
    throw error;
  }
}

function build() {
  if (!source || !output) usage();
  mkdirSync(dirname(destination), { recursive: true });
  const stage = mkdtempSync(join(dirname(destination), ".p6-replay-"));
  try {
    const conditions = CONDITIONS.map((condition) =>
      buildCondition(condition, stage),
    );
    const publicFiles = [];
    for (const condition of CONDITIONS)
      for (const file of FILES) {
        const path = `${condition}/${file}`;
        const bytes = readFileSync(join(stage, path));
        publicFiles.push({ path, sha256: SHA(bytes), size: bytes.length });
      }
    const manifest = {
      schema: "p1-hst-public-replay-package-v2",
      builder: { path: "scripts/p6/build-public-replay.mjs", version: 2 },
      runtime: RUNTIME,
      input: INPUT,
      conditions,
      files: publicFiles,
      transformations: TRANSFORMATIONS,
      exclusions: EXCLUSIONS,
      replay: REPLAY_COMMAND,
      verification: "not-yet-verified",
    };
    writeJson(join(stage, "manifest.json"), manifest);
    writeFileSync(
      join(stage, "README.md"),
      `# Redacted H/S/T offline replay package\n\nThis derived package preserves enough recorded state to verify replay offline. It is not original evidence. The command reconstructs recorded redacted transitions; it does not run a model, evaluator, tests, Docker, network, Git, or candidate code. It does not establish semantic correctness or reproduce solver responses. A new execution requires the separately documented prerequisites and resources.\n\nThe package is built as \`not-yet-verified\`. A verifier must check every manifest hash and run all three replays before it writes a \`replay-verified\` attestation:\n\n\`node scripts/p6/build-public-replay.mjs verify --package \"$PWD/docs/experiments/p1-hst/replay\" --cli \"$PWD/dist/cli/index.js\"\n\nSee [REPLAY.md](../REPLAY.md) and [manifest.json](manifest.json).\n`,
    );
    replaceRecoverably(stage, destination);
    console.log(JSON.stringify({ output: destination, conditions }, null, 2));
  } catch (error) {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

const assertKeys = (value, expected, label) => {
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error(`Expected object: ${label}`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    throw new Error(`Closed fields rejected: ${label}`);
};

const equalJson = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Fixed value rejected: ${label}`);
};
const expectedDistributedFiles = () => [
  "manifest.json",
  "README.md",
  ...CONDITIONS.flatMap((condition) =>
    FILES.map((file) => `${condition}/${file}`),
  ),
];
const inventory = (base, relative = "") => {
  const directory = join(base, relative);
  const entries = readdirSync(directory, { withFileTypes: true });
  const found = { files: [], directories: [] };
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    const target = join(base, path);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Symlink rejected: ${path}`);
    if (stat.isDirectory()) {
      found.directories.push(path);
      const nested = inventory(base, path);
      found.files.push(...nested.files);
      found.directories.push(...nested.directories);
    } else if (stat.isFile()) found.files.push(path);
    else throw new Error(`Non-regular package entry rejected: ${path}`);
  }
  return found;
};
const assertPackageInventory = (packageDir) => {
  const expected = expectedDistributedFiles().sort();
  const inventoryResult = inventory(packageDir);
  const found = inventoryResult.files.sort();
  const directories = inventoryResult.directories.sort();
  if (
    found.length !== expected.length ||
    found.some((path, index) => path !== expected[index])
  )
    throw new Error("Package inventory rejected");
  if (
    directories.length !== CONDITIONS.length ||
    directories.some((path, index) => path !== CONDITIONS[index])
  )
    throw new Error("Package directory inventory rejected");
  for (const path of found) {
    if (
      !/^(?:README\.md|manifest\.json|[HST]\/[a-z0-9-]+\.(?:json|jsonl|txt))$/.test(
        path,
      )
    )
      throw new Error(`Non-canonical package path rejected: ${path}`);
  }
  return found;
};
const assertNoDisclosure = (packageDir, paths) => {
  const forbidden =
    /\/Users\/|\/private\/(?:tmp|var)|auth\.json|CODEX_HOME|thomastraspedini/i;
  for (const path of paths)
    if (forbidden.test(readFileSync(join(packageDir, path))))
      throw new Error(`Package disclosure rejected: ${path}`);
};
const assertVerification = (verification) => {
  if (verification === "not-yet-verified") return;
  assertKeys(
    verification,
    ["status", "node", "cli", "outcomes"],
    "verification",
  );
  if (
    verification.status !== "replay-verified" ||
    typeof verification.node !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(verification.node) ||
    !Array.isArray(verification.outcomes) ||
    verification.outcomes.length !== CONDITIONS.length
  )
    throw new Error("Verification rejected");
  assertKeys(verification.cli, ["entrypoint", "sha256"], "verification.cli");
  if (
    verification.cli.entrypoint !== "external absolute CLI argument" ||
    !/^[a-f0-9]{64}$/.test(verification.cli.sha256)
  )
    throw new Error("Verification CLI rejected");
  for (let index = 0; index < CONDITIONS.length; index += 1) {
    const outcome = verification.outcomes[index];
    assertKeys(
      outcome,
      ["condition", "exitCode", "stdout"],
      "verification.outcomes[]",
    );
    if (
      outcome.condition !== CONDITIONS[index] ||
      outcome.exitCode !== 0 ||
      outcome.stdout !== REPLAY_STDOUT
    )
      throw new Error(`Verification outcome rejected: ${CONDITIONS[index]}`);
  }
};

function verifyPackage() {
  if (!packagePath || !cli || !isAbsolute(cli)) usage();
  const packageDir = resolve(packagePath);
  const cliPath = resolve(cli);
  if (!existsSync(cliPath) || !lstatSync(cliPath).isFile())
    throw new Error(`CLI must be an existing regular file: ${cliPath}`);
  assertNoSymlink(packageDir);
  const distributedFiles = assertPackageInventory(packageDir);
  assertNoDisclosure(packageDir, distributedFiles);
  const manifestPath = join(packageDir, "manifest.json");
  const manifest = json(manifestPath);
  assertKeys(
    manifest,
    [
      "schema",
      "builder",
      "runtime",
      "input",
      "conditions",
      "files",
      "transformations",
      "exclusions",
      "replay",
      "verification",
    ],
    "manifest",
  );
  if (manifest.schema !== "p1-hst-public-replay-package-v2")
    throw new Error("Package schema rejected");
  equalJson(manifest.builder, BUILDER, "builder");
  if (
    manifest.runtime !== RUNTIME ||
    manifest.input !== INPUT ||
    manifest.replay !== REPLAY_COMMAND
  )
    throw new Error("Package fixed identity rejected");
  equalJson(manifest.transformations, TRANSFORMATIONS, "transformations");
  equalJson(manifest.exclusions, EXCLUSIONS, "exclusions");
  assertVerification(manifest.verification);
  const expectedFiles = CONDITIONS.flatMap((condition) =>
    FILES.map((file) => `${condition}/${file}`),
  );
  if (manifest.files.length !== expectedFiles.length)
    throw new Error("Package file count rejected");
  const seen = new Set();
  for (const entry of manifest.files) {
    assertKeys(entry, ["path", "sha256", "size"], "manifest.files[]");
    if (
      !expectedFiles.includes(entry.path) ||
      seen.has(entry.path) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    )
      throw new Error(`Package file entry rejected: ${entry.path}`);
    seen.add(entry.path);
    const path = resolve(packageDir, entry.path);
    if (!contained(packageDir, path))
      throw new Error(`Package path escapes: ${entry.path}`);
    regular(path);
    const bytes = readFileSync(path);
    if (bytes.length !== entry.size || SHA(bytes) !== entry.sha256)
      throw new Error(`Package hash mismatch: ${entry.path}`);
    if (entry.path.endsWith(".json")) json(path);
    if (entry.path.endsWith(".jsonl")) lines(path);
  }
  if (seen.size !== expectedFiles.length)
    throw new Error("Package file set rejected");
  if (
    !Array.isArray(manifest.conditions) ||
    manifest.conditions.length !== CONDITIONS.length
  )
    throw new Error("Conditions rejected");
  for (let index = 0; index < CONDITIONS.length; index += 1) {
    const condition = manifest.conditions[index];
    assertKeys(
      condition,
      [
        "condition",
        "runId",
        "sourceBase",
        "candidateRef",
        "sourceBundleManifestSha256",
        "sourceBundleManifestEntries",
      ],
      "manifest.conditions[]",
    );
    const pin = PINS[CONDITIONS[index]];
    if (
      condition.condition !== CONDITIONS[index] ||
      condition.runId !== pin.runId ||
      condition.sourceBase !== pin.sourceBase ||
      condition.candidateRef !== pin.candidateRef ||
      condition.sourceBundleManifestSha256 !== pin.manifest ||
      condition.sourceBundleManifestEntries !== pin.entries
    )
      throw new Error(`Condition pin rejected: ${condition.condition}`);
  }
  const outcomes = [];
  for (const condition of CONDITIONS) {
    const result = execFileSync(
      process.execPath,
      [cliPath, "experiment", "replay", join(packageDir, condition)],
      { encoding: "utf8" },
    );
    const expected = `${REPLAY_STDOUT}\n`;
    if (result !== expected)
      throw new Error(`Replay stdout rejected: ${condition}`);
    outcomes.push({ condition, exitCode: 0, stdout: REPLAY_STDOUT });
  }
  manifest.verification = {
    status: "replay-verified",
    node: process.version,
    cli: {
      entrypoint: "external absolute CLI argument",
      sha256: SHA(readFileSync(cliPath)),
    },
    outcomes,
  };
  writeJson(manifestPath, manifest);
  console.log(
    JSON.stringify(
      { package: packageDir, verification: manifest.verification },
      null,
      2,
    ),
  );
}

if (command === "build") build();
else if (command === "verify") verifyPackage();
else usage();
