import { createHash } from "node:crypto";
// Adapter-owned representation of M2 v1; no provider dependency in Stirpi core.
const string = { type: "string" };
const text = { type: "string", minLength: 1 };
const literal = (value) => ({ type: typeof value, const: value });
const array = (items, minItems = 0) => ({ type: "array", items, minItems });
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const priority = nullable({ type: "integer" });
const actionSchemas = {
  CONTINUE: object({ type: literal("CONTINUE") }),
  FORK: object({
    type: literal("FORK"),
    alternatives: array(
      object({
        name: text,
        assumption: text,
        rationale: text,
        objective: nullable(text),
        priority,
      }),
      2,
    ),
  }),
  SPAWN: object({
    type: literal("SPAWN"),
    work: array(object({ name: text, objective: text, priority }), 1),
  }),
  COMPLETE: object({ type: literal("COMPLETE"), result: string }),
  BLOCK: object({
    type: literal("BLOCK"),
    reason: object({ code: text, message: text }),
  }),
};
const allActions = Object.keys(actionSchemas);
const commitSchema = object({ type: literal("COMMIT"), message: text });

const baseInstructions = `You are executing one assigned Stirpi work invocation.
The user/problem task is supplied separately, unchanged. Use only this invocation's
local context and assigned repository. Do not inspect other workspaces, host
configuration, credentials, sessions, or external repositories. Do not use network
tools to obtain additional task context. Follow assigned repository governance.
Do not create commits, branches or worktrees, change refs, or manage Git history.
You may inspect local files, Git history and diffs, edit files, and run local tests.
Request coherent commits only via effects: [{"type":"COMMIT","message":"Describe change"}].
Effects run after your response. Multiple requests are allowed, but each commits
the then-current whole workspace; separate edits across CONTINUE invocations to
produce separate commits. No commit is required when no changes need publishing.
Return the native structured response, with version 1, action, effects, and text.`;
const actionInstructions = {
  CONTINUE:
    "CONTINUE retains this workspace including uncommitted edits for another invocation.",
  FORK: "FORK (main work only) creates at least two descendant lineages, each with exactly one new assumption. The parent becomes BRANCHED; siblings need not converge.",
  SPAWN:
    "SPAWN decomposes required work inside this lineage; parent waits and receives its own child outcomes. Child artifacts are not automatically merged.",
  COMPLETE:
    "COMPLETE requests public evaluation; only evaluation success completes work.",
  BLOCK:
    "BLOCK reports inability to proceed, with a structured reason; it is not falsification.",
};

export function responseContract(context = {}) {
  const actions = context.control?.actions ?? allActions;
  const verificationIds = context.verification?.available ?? [];
  const verifySchema = verificationIds.length
    ? object({
        type: literal("VERIFY"),
        id: { anyOf: verificationIds.map(literal) },
      })
    : undefined;
  const schema = object({
    version: literal(1),
    action: { anyOf: actions.map((name) => actionSchemas[name]) },
    effects: array({
      anyOf: verifySchema ? [commitSchema, verifySchema] : [commitSchema],
    }),
    text: string,
  });
  const instructions = [
    baseInstructions,
    ...actions.map((name) => actionInstructions[name]),
    ...(actions.some((name) => ["FORK", "SPAWN", "COMPLETE"].includes(name))
      ? [
          "Any available artifact-inheriting or completion action requires committed state: request COMMIT effects first if needed. Never silently discard edits.",
        ]
      : []),
    ...(verificationIds.length
      ? [
          `With CONTINUE only, you may request one trusted verification by ID via {"type":"VERIFY","id":<ID>}. Available IDs: ${JSON.stringify(verificationIds)}. You cannot supply commands, arguments, directories, environment, timeouts, network or policy. Results appear in a later invocation's verification.latest. VERIFY does not authorize completion.`,
        ]
      : []),
    "Respect supplied control restrictions. Use null for absent optional objective/priority fields in the schema.",
    "No prior model session is authoritative: continuity is supplied by Stirpi context, workspace, canonical artifacts and recorded outcomes. Do not resume other sessions.",
  ].join("\n");
  return { schema, instructions, verificationIds };
}

// Only the closed schema subset above is supported, not arbitrary JSON Schema.
export function conforms(value, schema) {
  if (schema.anyOf) return schema.anyOf.some((s) => conforms(value, s));
  if ("const" in schema && value !== schema.const) return false;
  switch (schema.type) {
    case "null":
      return value === null;
    case "string":
      return (
        typeof value === "string" &&
        (!schema.minLength || value.trim().length >= schema.minLength)
      );
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "array":
      return (
        Array.isArray(value) &&
        value.length >= schema.minItems &&
        value.every((v) => conforms(v, schema.items))
      );
    case "object":
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).every((k) => Object.hasOwn(schema.properties, k)) &&
        schema.required.every(
          (k) =>
            Object.hasOwn(value, k) && conforms(value[k], schema.properties[k]),
        )
      );
    default:
      return false;
  }
}

export function responseFrom(raw, contract = responseContract()) {
  const value = JSON.parse(raw);
  if (!conforms(value, contract.schema))
    throw new Error("INVALID_AGENT_RESPONSE");
  const verifies = value.effects.filter((effect) => effect.type === "VERIFY");
  if (
    verifies.length > 1 ||
    (verifies.length && value.action.type !== "CONTINUE")
  )
    throw new Error("INVALID_AGENT_RESPONSE");
  // Native strict schemas require all properties. Null means an omitted optional
  // M2 field; no action is inferred, repaired, or selected by the adapter.
  const entries = value.action.alternatives ?? value.action.work ?? [];
  for (const entry of entries) {
    for (const key of ["objective", "priority"])
      if (entry[key] === null) delete entry[key];
  }
  return value;
}

const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((k) => value?.[k] !== undefined).map((k) => [k, value[k]]),
  );
const reason = (value) =>
  value == null ? value : pick(value, ["code", "message"]);
const artifact = (value) =>
  value == null ? value : pick(value, ["ref", "base"]);
export function invocationFrom(raw) {
  const input = JSON.parse(raw);
  if (input?.version !== 1) throw new Error("UNSUPPORTED_PROTOCOL_VERSION");
  const c = input.context;
  if (
    !c ||
    typeof c.work?.objective !== "string" ||
    !Array.isArray(c.dna) ||
    !c.dna.every((s) => typeof s === "string") ||
    !Array.isArray(c.results) ||
    !conforms(c.publicEvaluation?.description, string) ||
    !conforms(c.publicEvaluation?.criteria, array(string))
  )
    throw new Error("INVALID_INPUT");
  const workspace = c.work.artifact?.worktree;
  if (typeof workspace !== "string" || !workspace || c.work.artifact.cleaned)
    throw new Error("WORKSPACE_REQUIRED");
  if (c.task !== undefined && typeof c.task !== "string")
    throw new Error("INVALID_INPUT");
  let governance;
  if (c.governance !== undefined) {
    const g = c.governance;
    if (
      !g ||
      typeof g !== "object" ||
      Array.isArray(g) ||
      Object.keys(g).length !== 2 ||
      typeof g.text !== "string" ||
      !/^[a-f0-9]{64}$/.test(g.sha256) ||
      createHash("sha256").update(g.text).digest("hex") !== g.sha256
    )
      throw new Error("INVALID_INPUT");
    governance = { text: g.text, sha256: g.sha256 };
  }
  let verification;
  if (c.verification !== undefined) {
    const id = (value) =>
      typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
    const available = c.verification?.available;
    const latest = c.verification?.latest;
    const evidence = (value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      id(value.id) &&
      available.includes(value.id) &&
      Number.isSafeInteger(value.attempt) &&
      value.attempt > 0 &&
      typeof value.passed === "boolean" &&
      (value.exitCode === null || Number.isSafeInteger(value.exitCode)) &&
      typeof value.stdout === "string" &&
      typeof value.stderr === "string" &&
      typeof value.stdoutTruncated === "boolean" &&
      typeof value.stderrTruncated === "boolean" &&
      Number.isSafeInteger(value.durationMs) &&
      value.durationMs >= 0;
    if (
      !c.verification ||
      typeof c.verification !== "object" ||
      Array.isArray(c.verification) ||
      Object.keys(c.verification).some(
        (key) => !["available", "latest"].includes(key),
      ) ||
      !Array.isArray(available) ||
      !available.every(id) ||
      new Set(available).size !== available.length ||
      !Array.isArray(latest) ||
      !latest.every(evidence)
    )
      throw new Error("INVALID_INPUT");
    verification = {
      available: [...available],
      latest: latest.map((value) =>
        pick(value, [
          "id",
          "attempt",
          "passed",
          "exitCode",
          "stdout",
          "stderr",
          "stdoutTruncated",
          "stderrTruncated",
          "durationMs",
        ]),
      ),
    };
  }
  const context = {
    work: pick(c.work, [
      "id",
      "name",
      "parentId",
      "objective",
      "cursor",
      "result",
    ]),
    dna: c.dna,
    workspace,
    artifact: artifact(c.work.artifact),
    publicEvaluation: pick(c.publicEvaluation, ["description", "criteria"]),
    results: c.results.map((r) => ({
      ...pick(r, ["name", "status", "result", "artifacts"]),
      reason: reason(r.reason),
      artifact: artifact(r.artifact),
    })),
    ...(verification ? { verification } : {}),
    ...(governance ? { governance } : {}),
  };
  if (c.control !== undefined) {
    if (
      c.control?.version !== 1 ||
      !Array.isArray(c.control.actions) ||
      c.control.actions.length === 0 ||
      new Set(c.control.actions).size !== c.control.actions.length ||
      !c.control.actions.every((a) =>
        ["CONTINUE", "FORK", "SPAWN", "COMPLETE", "BLOCK"].includes(a),
      )
    )
      throw new Error("INVALID_INPUT");
    context.control = {
      ...pick(c.control, ["version", "actions", "effects", "policy"]),
      semantics: pick(c.control.semantics, c.control.actions),
    };
  }
  // Do not allow objects hidden inside fields intended to carry scalar text.
  const scalarTree = (v) =>
    v === undefined ||
    v === null ||
    typeof v === "string" ||
    Number.isSafeInteger(v);
  const fields = [
    context.work,
    context.artifact,
    ...context.results.flatMap((r) => [
      pick(r, ["name", "status", "result"]),
      r.reason,
      r.artifact,
    ]),
    context.control?.semantics,
    pick(context.control, ["effects", "policy"]),
  ];
  if (
    fields.some((o) => o && Object.values(o).some((v) => !scalarTree(v))) ||
    context.results.some(
      (r) => r.artifacts !== undefined && !conforms(r.artifacts, array(string)),
    )
  )
    throw new Error("INVALID_INPUT");
  return { task: c.task ?? c.work.objective, context, workspace };
}

export function promptFrom(invocation) {
  const { context, task } = invocation;
  const contract = responseContract(context);
  const prompt =
    contract.instructions +
    (context.governance
      ? "\n\nCommon solver governance:\n" + context.governance.text
      : "") +
    "\n\nLineage-local context (JSON):\n" +
    JSON.stringify(context);
  return { contract, prompt, task };
}
