import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./inputs.js";
import type { PublicCheck } from "../evaluation/commands.js";

export interface PreparationConfig {
  modules: string[];
  postgres: { image: string; prerequisites: string[] };
}
export interface PreparationEvidence {
  workspace: string;
  packageSha256: string;
  lockfileSha256: string;
  packageIdentity: { name: string; version: string };
  instance: string;
  containerId?: string;
  imageId?: string;
  port?: number;
  steps: { id: string; passed: boolean }[];
}
export type TrustedProcess = (
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
) => string;
export const trustedProcess: TrustedProcess = (
  executable,
  args,
  cwd,
  env,
  input,
) => {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    shell: false,
    timeout: 300000,
    maxBuffer: 4 * 1024 * 1024,
  });
  // Process output may contain connection credentials; never persist it here.
  if (result.error || result.status !== 0)
    throw new Error(
      `Trusted process failed: ${executable} (status ${result.status})`,
    );
  return result.stdout.trim();
};
export const executorEnvironment = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  LANG: "C.UTF-8",
  TZ: "UTC",
  HOME: home,
  TMPDIR: home,
});

// Owned by the outer harness, never deserialized from an executor response.
export class TrustedPreparation {
  readonly records: PreparationEvidence[] = [];
  private readonly assignments = new Map<
    string,
    { url: string; packageHash: string; lockHash: string }
  >();
  private readonly config: PreparationConfig;
  constructor(
    config: PreparationConfig,
    private readonly observe: () => void,
    private readonly run: TrustedProcess = trustedProcess,
  ) {
    this.config = structuredClone(config);
    if (
      !config.modules.every((x) => /^[\w@/.-]+$/.test(x)) ||
      !config.postgres.prerequisites.every((x) => /^[a-z_][a-z0-9_]*$/.test(x))
    )
      throw new Error("Invalid preparation configuration");
  }
  prepare(workspace: string) {
    if (this.assignments.has(workspace)) return;
    const pkg = readFileSync(join(workspace, "package.json"));
    const lock = readFileSync(join(workspace, "package-lock.json"));
    const identity = JSON.parse(pkg.toString());
    const record: PreparationEvidence = {
      workspace,
      packageSha256: sha256(pkg),
      lockfileSha256: sha256(lock),
      packageIdentity: { name: identity.name, version: identity.version },
      instance: `stirpi-${randomUUID()}`,
      steps: [],
    };
    this.records.push(record);
    this.observe();
    const step = (id: string, action: () => string) => {
      try {
        const result = action();
        record.steps.push({ id, passed: true });
        return result;
      } catch {
        record.steps.push({ id, passed: false });
        throw new Error(`Workspace preparation failed: ${id}`);
      } finally {
        this.observe();
      }
    };
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    step("dependencies", () => this.run("npm", ["ci"], workspace, env));
    step("module-resolution", () =>
      this.run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {createRequire} from 'node:module'; const require=createRequire(process.cwd()+'/package.json'); for(const name of ${JSON.stringify(this.config.modules)}) require.resolve(name);`,
        ],
        workspace,
        env,
      ),
    );
    step("typecheck", () =>
      this.run("npm", ["run", "typecheck"], workspace, env),
    );
    const password = randomUUID();
    record.containerId = step("postgres", () =>
      this.run(
        "docker",
        [
          "run",
          "--detach",
          "--name",
          record.instance,
          "--label",
          "stirpi.disposable=true",
          "--publish",
          "127.0.0.1::5432",
          "--env",
          "POSTGRES_PASSWORD",
          "--env",
          "POSTGRES_DB=experiment",
          this.config.postgres.image,
        ],
        workspace,
        { ...env, POSTGRES_PASSWORD: password },
      ),
    );
    const inspection = JSON.parse(
      step("postgres-identity", () =>
        this.run("docker", ["inspect", record.instance], workspace, env),
      ),
    )[0];
    record.imageId = inspection.Image;
    record.port = Number(
      inspection.NetworkSettings.Ports["5432/tcp"][0].HostPort,
    );
    if (
      !Number.isInteger(record.port) ||
      record.port! < 1 ||
      record.port! > 65535
    )
      throw new Error("Invalid allocated PostgreSQL port");
    const url = `postgresql://postgres:${password}@127.0.0.1:${record.port}/experiment`;
    const dbEnv = { ...env, DATABASE_URL: url };
    step("database-connectivity", () =>
      this.run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import pg from 'pg'; let last; for(let i=0;i<60;i++){const c=new pg.Client({connectionString:process.env.DATABASE_URL}); try{await c.connect();await c.query('SELECT 1');await c.end();process.exit(0);}catch(e){last=e;await c.end().catch(()=>{});await new Promise(r=>setTimeout(r,500));}}process.exit(1);`,
        ],
        workspace,
        dbEnv,
      ),
    );
    step("prerequisites", () =>
      this.run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import pg from 'pg';const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();try{for(const extension of ${JSON.stringify(this.config.postgres.prerequisites)}) await c.query('CREATE EXTENSION IF NOT EXISTS "'+extension+'"');}finally{await c.end();}`,
        ],
        workspace,
        dbEnv,
      ),
    );
    this.assignments.set(workspace, {
      url,
      packageHash: record.packageSha256,
      lockHash: record.lockfileSha256,
    });
    this.observe();
  }
  verificationEnvironment(
    workspace: string,
    check: PublicCheck,
    base: NodeJS.ProcessEnv,
  ) {
    if (!(
      (check.executable === "npm" &&
        JSON.stringify(check.args) === '["test"]') ||
      (check.executable === "npm" &&
        JSON.stringify(check.args) === '["run","typecheck"]') ||
      (check.executable === "git" &&
        JSON.stringify(check.args) === '["diff","--check"]')
    ))
      throw new Error("Verification command is not allowlisted");
    const assignment = this.assignments.get(workspace);
    if (!assignment) throw new Error("Workspace has not been prepared");
    // npm scripts are command indirection: reject edits to their manifest/lockfile.
    if (
      sha256(readFileSync(join(workspace, "package.json"))) !==
        assignment.packageHash ||
      sha256(readFileSync(join(workspace, "package-lock.json"))) !==
        assignment.lockHash
    )
      throw new Error("Trusted package identity changed");
    const env = executorEnvironment(base.HOME!);
    if (
      check.executable === "npm" &&
      check.args.length === 1 &&
      check.args[0] === "test"
    )
      env.DATABASE_URL = assignment.url;
    return env;
  }
  cleanup() {
    let failed = false;
    for (const record of this.records) {
      if (!record.steps.some((s) => s.id === "postgres")) continue;
      try {
        this.run(
          "docker",
          ["rm", "--force", "--volumes", record.instance],
          record.workspace,
          { PATH: process.env.PATH, HOME: process.env.HOME },
        );
        record.steps.push({ id: "cleanup", passed: true });
      } catch {
        record.steps.push({ id: "cleanup", passed: false });
        failed = true;
      }
      this.observe();
    }
    this.assignments.clear();
    if (failed) throw new Error("Disposable PostgreSQL cleanup failed");
  }
}
export const bookingPreparation: PreparationConfig = {
  modules: [
    "pg",
    "typescript",
    "@types/pg/package.json",
    "@types/node/package.json",
  ],
  postgres: { image: "postgres:16", prerequisites: ["btree_gist"] },
};
