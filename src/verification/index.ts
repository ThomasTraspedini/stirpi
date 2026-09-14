import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { Reason } from "../domain/index.js";

export interface VerificationLimits {
  timeoutMs: number;
  cpu?: number;
  memoryBytes: number;
  pids: number;
  fileDescriptors: number;
  outputBytes?: number;
}
export interface VerificationSpec {
  id: string;
  executable: string;
  argv: string[];
  cwd: "/workspace";
  image: string;
  limits: VerificationLimits;
  /** A disposable Unix-socket PostgreSQL lease is supplied to the verifier. */
  database?: "required";
}
export class VerificationRegistry {
  private readonly entries = new Map<string, VerificationSpec>();
  constructor(entries: readonly VerificationSpec[]) {
    for (const entry of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry.id))
        throw new Error("Verification IDs must be stable safe identifiers");
      if (this.entries.has(entry.id))
        throw new Error(`Duplicate verification ID: ${entry.id}`);
      if (
        !entry.image.includes("@sha256:") ||
        !/^.+@sha256:[a-f0-9]{64}$/.test(entry.image)
      )
        throw new Error("Verifier image must be digest pinned");
      if (
        !entry.executable ||
        !entry.executable.startsWith("/") ||
        entry.argv.some((x) => typeof x !== "string")
      )
        throw new Error(
          "Verification executable and argv must be registry-owned",
        );
      if (
        entry.cwd !== "/workspace" ||
        !Number.isSafeInteger(entry.limits.timeoutMs) ||
        entry.limits.timeoutMs < 1 ||
        (entry.limits.outputBytes !== undefined &&
          (!Number.isSafeInteger(entry.limits.outputBytes) ||
            entry.limits.outputBytes < 1))
      )
        throw new Error("Invalid fixed verifier policy");
      this.entries.set(entry.id, structuredClone(entry));
    }
  }
  get(id: string): VerificationSpec | undefined {
    const item = this.entries.get(id);
    return item && structuredClone(item);
  }
  ids(): string[] {
    return [...this.entries.keys()];
  }
}

export interface SnapshotEntry {
  path: string;
  type: "file" | "directory";
  mode: number;
  digest?: string;
  bytes?: number;
}
export interface WorkspaceSnapshot {
  root: string;
  digest: string;
  entries: SnapshotEntry[];
  files: number;
  bytes: number;
}
export interface VerificationEvidence {
  id: string;
  attempt: number;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}
export interface VerificationOperation {
  request: { id: string; workId: string; workspaceDigest: string };
  outcome:
    | { ok: true; evidence: VerificationEvidence }
    | { ok: false; reason: Reason };
}
export interface VerifierAdapter {
  execute(spec: VerificationSpec, snapshot: WorkspaceSnapshot): VerifierResult;
}
export interface VerifierResult {
  exitCode: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  failure?: string;
  /** Trusted cleanup stages that did not complete, retained separately from execution failure. */
  cleanupFailures?: string[];
}
export interface VerificationExecutor {
  available(): string[];
  perform(id: string, workId: string, workspace: string): VerificationOperation;
}

const MAX_FILES = 10_000;
const MAX_BYTES = 256 * 1024 * 1024;
const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
function safeOutput(value: string, limit: number) {
  // ESC/control characters can rewrite terminals. Keep ordinary line structure only.
  const sanitized = value.replace(
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\x1b]/g,
    "",
  );
  return {
    value: sanitized.slice(0, limit),
    truncated: Buffer.byteLength(sanitized) > limit,
  };
}
function redact(value: string) {
  return value.replace(
    /(?:DATABASE_URL\s*[=:]\s*|postgres(?:ql)?:\/\/)[^\s'"`]+/gi,
    "[REDACTED_DATABASE_URL]",
  );
}
/** Creates a non-following, bounded copy. The returned directory is disposable. */
export function snapshotWorkspace(workspace: string): WorkspaceSnapshot {
  const source = resolve(workspace);
  if (!statSync(source).isDirectory())
    throw new Error("Workspace is not a directory");
  const root = mkdtempSync(join(tmpdir(), "stirpi-verify-snapshot-"));
  const entries: SnapshotEntry[] = [];
  let files = 0,
    bytes = 0;
  const copy = (from: string, rel: string) => {
    const normalized = rel.split(sep).join("/");
    if (
      !normalized ||
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      normalized === ".git" ||
      normalized.startsWith(".git/") ||
      normalized === "node_modules" ||
      normalized.startsWith("node_modules/")
    )
      return;
    const info = lstatSync(from);
    if (info.isSymbolicLink())
      throw new Error(`Unsafe symlink in workspace: ${normalized}`);
    if (!info.isFile() && !info.isDirectory()) return; // sockets, devices, FIFOs and other special files
    if (++files > MAX_FILES)
      throw new Error("Snapshot file count limit exceeded");
    const destination = join(root, normalized);
    if (info.isDirectory()) {
      mkdirSync(destination, { recursive: true, mode: info.mode & 0o777 });
      entries.push({
        path: normalized,
        type: "directory",
        mode: info.mode & 0o777,
      });
      for (const child of readdirSync(from))
        copy(join(from, child), join(rel, child));
      return;
    }
    bytes += info.size;
    if (bytes > MAX_BYTES) throw new Error("Snapshot byte limit exceeded");
    const content = readFileSync(from);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, content, { mode: info.mode & 0o777 });
    entries.push({
      path: normalized,
      type: "file",
      mode: info.mode & 0o777,
      bytes: info.size,
      digest: digest(content),
    });
  };
  try {
    for (const child of readdirSync(source)) copy(join(source, child), child);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return {
      root,
      entries,
      files,
      bytes,
      digest: digest(JSON.stringify(entries)),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export const POSTGRES_17_IMAGE =
  "postgres:17@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675";

// The pinned image starts its initialization postmaster with
// `listen_addresses=''`, stops it, then execs the requested postgres command.
// Our final server is explicitly configured with `listen_addresses=*`, so this
// trusted query distinguishes the two server lifecycles without relying on
// socket availability alone.
const POSTGRES_FINAL_SERVER_MARKER = "stirpi-final-postmaster";
const postgresFinalServerReadinessSql = `SELECT CASE WHEN current_setting('listen_addresses') = '*' THEN '${POSTGRES_FINAL_SERVER_MARKER}' ELSE 'stirpi-temporary-postmaster' END;`;

export interface DockerCommandResult {
  status: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}
export type DockerCommandRunner = (
  args: string[],
  input?: string,
  timeoutMs?: number,
) => DockerCommandResult;

/**
 * Trusted diagnostic information for an already-bootstrapped disposable lease.
 * This is never mounted into, or exposed to, verifier execution.
 */
export interface DatabaseLeaseInfo {
  containerId: string;
  containerName: string;
  database: string;
  role: string;
  password: string;
  socketDirectory: "/var/run/postgresql";
}
export interface DockerVerifierOptions {
  /**
   * Runs after the authenticated disposable-role probe and before candidate
   * execution. Returning "stop" deliberately skips candidate execution; the
   * normal trusted cleanup in this adapter's finally block still runs.
   */
  afterDatabaseBootstrap?: (lease: DatabaseLeaseInfo) => void | "stop";
}

function dockerCommand(
  args: string[],
  input?: string,
  timeoutMs?: number,
): DockerCommandResult {
  return spawnSync("docker", args, {
    encoding: "utf8",
    input,
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "" },
  });
}

function sqlIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}
function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export class DockerVerifierAdapter implements VerifierAdapter {
  constructor(
    private readonly command: DockerCommandRunner = dockerCommand,
    private readonly options: DockerVerifierOptions = {},
  ) {}

  execute(spec: VerificationSpec, snapshot: WorkspaceSnapshot): VerifierResult {
    const volume = `stirpi-verify-${randomUUID()}`;
    const dataVolume = `${volume}-pgdata`;
    const socketVolume = `${volume}-pgsocket`;
    const databaseContainer = `${volume}-postgres`;
    const database = `verify_${randomUUID().replaceAll("-", "")}`;
    const role = `verify_${randomUUID().replaceAll("-", "")}`;
    const password =
      randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    let envFile: string | undefined;
    let workspaceVolumeCreated = false;
    let dataVolumeCreated = false;
    let socketVolumeCreated = false;
    let databaseStarted = false;
    let databaseContainerId = "";
    const run = (args: string[], input?: string) =>
      this.command(args, input, spec.limits.timeoutMs);
    const started = Date.now();
    let result: DockerCommandResult | undefined;
    let primary: VerifierResult | undefined;
    const fail = (failure: string, commandResult?: DockerCommandResult) => ({
      exitCode: null,
      stdout: commandResult?.stdout ?? "",
      stderr: commandResult?.stderr ?? "",
      durationMs: Date.now() - started,
      failure,
    });
    const succeeded = (commandResult: DockerCommandResult) =>
      commandResult.status === 0 && !commandResult.error;
    const verifierArgs = (env: string[]) => [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "65532:65532",
      "--pids-limit",
      String(spec.limits.pids),
      "--memory",
      String(spec.limits.memoryBytes),
      "--ulimit",
      `nofile=${spec.limits.fileDescriptors}:${spec.limits.fileDescriptors}`,
      "--mount",
      `type=volume,src=${volume},dst=/workspace`,
      ...env,
      "--workdir",
      spec.cwd,
      spec.image,
    ];
    try {
      result = run(["volume", "create", volume]);
      if (!succeeded(result))
        return (primary = fail("VERIFIER_LAUNCH_FAILED", result));
      workspaceVolumeCreated = true;
      // Docker cp transfers into Docker-managed storage. No host path is mounted into candidate execution.
      result = run([
        "create",
        "--name",
        `${volume}-stage`,
        "--mount",
        `type=volume,src=${volume},dst=/workspace`,
        spec.image,
        "/bin/true",
      ]);
      if (!succeeded(result))
        return (primary = fail("VERIFIER_LAUNCH_FAILED", result));
      result = run(["cp", `${snapshot.root}/.`, `${volume}-stage:/workspace`]);
      if (!succeeded(result))
        return (primary = fail("VERIFIER_SNAPSHOT_TRANSFER_FAILED", result));
      result = run([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "--mount",
        `type=volume,src=${volume},dst=/workspace`,
        spec.image,
        "/bin/sh",
        "-c",
        "chown -R 65532:65532 /workspace",
      ]);
      if (!succeeded(result))
        return (primary = fail("VERIFIER_SNAPSHOT_TRANSFER_FAILED", result));
      if (spec.database === "required") {
        result = run(["volume", "create", dataVolume]);
        if (!succeeded(result))
          return (primary = fail("VERIFIER_DB_LAUNCH_FAILED", result));
        dataVolumeCreated = true;
        result = run(["volume", "create", socketVolume]);
        if (!succeeded(result))
          return (primary = fail("VERIFIER_DB_LAUNCH_FAILED", result));
        socketVolumeCreated = true;
        result = run([
          "run",
          "--rm",
          "--network",
          "none",
          "--user",
          "0:0",
          "--mount",
          `type=volume,src=${socketVolume},dst=/var/run/postgresql`,
          POSTGRES_17_IMAGE,
          "/bin/sh",
          "-c",
          "chown postgres:postgres /var/run/postgresql && chmod 0777 /var/run/postgresql",
        ]);
        if (!succeeded(result))
          return (primary = fail("VERIFIER_DB_BOOTSTRAP_FAILED", result));
        result = run([
          "run",
          "-d",
          "--name",
          databaseContainer,
          "--network",
          "none",
          "--mount",
          `type=volume,src=${dataVolume},dst=/var/lib/postgresql/data`,
          "--mount",
          `type=volume,src=${socketVolume},dst=/var/run/postgresql`,
          "-e",
          "POSTGRES_HOST_AUTH_METHOD=trust",
          POSTGRES_17_IMAGE,
          "-c",
          // Match the image's generated postgresql.conf.  A conflicting
          // command-line value makes every later SIGHUP report a configuration
          // reload error, even when the HBA file itself is valid.
          "listen_addresses=*",
          "-c",
          "unix_socket_directories=/var/run/postgresql",
        ]);
        if (!succeeded(result))
          return (primary = fail("VERIFIER_DB_LAUNCH_FAILED", result));
        databaseStarted = true;
        databaseContainerId = (result.stdout ?? "").trim();
        let ready = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          result = run([
            "exec",
            databaseContainer,
            "psql",
            "-tAc",
            postgresFinalServerReadinessSql,
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-h",
            "/var/run/postgresql",
          ]);
          if (
            succeeded(result) &&
            (result.stdout ?? "").trim() === POSTGRES_FINAL_SERVER_MARKER
          ) {
            ready = true;
            break;
          }
        }
        if (!ready) {
          // Preserve the server lifecycle evidence before normal cleanup removes
          // the container. This makes final-server startup failures explicit.
          const logs = run(["logs", databaseContainer]);
          return (primary = fail("VERIFIER_DB_BOOTSTRAP_FAILED", {
            ...result,
            stdout: [result?.stdout, logs.stdout]
              .filter((value): value is string => !!value)
              .join("\nPostgreSQL logs:\n"),
            stderr: [result?.stderr, logs.stderr]
              .filter((value): value is string => !!value)
              .join("\nPostgreSQL log retrieval:\n"),
          }));
        }
        const setup = [
          `CREATE ROLE ${sqlIdentifier(role)} LOGIN PASSWORD ${sqlLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;`,
          `CREATE DATABASE ${sqlIdentifier(database)} OWNER ${sqlIdentifier(role)};`,
          `\\connect ${sqlIdentifier(database)}`,
          "CREATE EXTENSION btree_gist;",
        ].join("\n");
        const hba = [
          "local all postgres trust",
          `local ${database} ${role} scram-sha-256`,
          "local all all reject",
          "host all all all reject",
          "",
        ].join("\n");
        result = run(
          [
            "exec",
            "-i",
            databaseContainer,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            "postgres",
          ],
          setup,
        );
        if (!succeeded(result))
          return (primary = fail("VERIFIER_DB_BOOTSTRAP_FAILED", result));
        result = run(
          [
            "exec",
            "-i",
            "--user",
            "postgres",
            databaseContainer,
            "/bin/sh",
            "-c",
            'cat > "$PGDATA/pg_hba.conf" && pg_ctl reload',
          ],
          hba,
        );
        if (!succeeded(result))
          return (primary = fail("VERIFIER_DB_BOOTSTRAP_FAILED", result));
        // pg_ctl only confirms that SIGHUP was sent.  Prove the server accepted
        // the file and that the fail-closed rules are exactly the intended ones.
        const hbaValidation = `
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_hba_file_rules) <> 4
    OR EXISTS (SELECT 1 FROM pg_hba_file_rules WHERE error IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM pg_hba_file_rules WHERE line_number = 1 AND type = 'local' AND database = ARRAY['all'] AND user_name = ARRAY['postgres'] AND auth_method = 'trust')
    OR NOT EXISTS (SELECT 1 FROM pg_hba_file_rules WHERE line_number = 2 AND type = 'local' AND database = ARRAY[${sqlLiteral(database)}] AND user_name = ARRAY[${sqlLiteral(role)}] AND auth_method = 'scram-sha-256')
    OR NOT EXISTS (SELECT 1 FROM pg_hba_file_rules WHERE line_number = 3 AND type = 'local' AND database = ARRAY['all'] AND user_name = ARRAY['all'] AND auth_method = 'reject')
    OR NOT EXISTS (SELECT 1 FROM pg_hba_file_rules WHERE line_number = 4 AND type = 'host' AND database = ARRAY['all'] AND user_name = ARRAY['all'] AND address = 'all' AND auth_method = 'reject')
  THEN
    RAISE EXCEPTION 'verifier HBA validation failed';
  END IF;
END $$;
SELECT 1;
`;
        result = run(
          [
            "exec",
            "-i",
            databaseContainer,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            "postgres",
          ],
          hbaValidation,
        );
        if (!succeeded(result))
          return (primary = fail("VERIFIER_DB_BOOTSTRAP_FAILED", result));
        envFile = join(
          mkdtempSync(join(tmpdir(), "stirpi-verify-env-")),
          "database.env",
        );
        writeFileSync(
          envFile,
          `DATABASE_URL=postgresql://${role}:${password}@/${database}?host=%2Fvar%2Frun%2Fpostgresql\n`,
          { mode: 0o600 },
        );
        const dbMount = [
          "--mount",
          `type=volume,src=${socketVolume},dst=/var/run/postgresql,readonly`,
          "--env-file",
          envFile,
        ];
        // pg_isready intentionally does not authenticate, so it cannot prove
        // that the disposable role can use the post-reload HBA policy.
        result = run([
          "exec",
          "-i",
          "-e",
          `PGPASSWORD=${password}`,
          databaseContainer,
          "psql",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          role,
          "-d",
          database,
          "-h",
          "/var/run/postgresql",
          "-c",
          "SELECT 1;",
        ]);
        if (!succeeded(result))
          return (primary = fail("VERIFIER_DB_CONNECTIVITY_FAILED", result));
        if (
          this.options.afterDatabaseBootstrap?.({
            containerId: databaseContainerId,
            containerName: databaseContainer,
            database,
            role,
            password,
            socketDirectory: "/var/run/postgresql",
          }) === "stop"
        ) {
          primary = {
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: Date.now() - started,
          };
          return primary;
        }
        result = run([...verifierArgs(dbMount), spec.executable, ...spec.argv]);
      } else result = run([...verifierArgs([]), spec.executable, ...spec.argv]);
      primary = {
        exitCode: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        durationMs: Date.now() - started,
        ...(result.signal !== undefined ? { signal: result.signal } : {}),
        ...(result.error ? { failure: result.error.message } : {}),
      };
    } finally {
      const cleanup: Array<{
        id: string;
        args: string[];
        input?: string;
        absent?: boolean;
      }> = [
        {
          id: "stage-container-removal",
          args: ["rm", "-f", `${volume}-stage`],
        },
      ];
      if (databaseStarted) {
        cleanup.push({
          id: "database-session-termination",
          args: [
            "exec",
            "-i",
            databaseContainer,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            "postgres",
          ],
          // The verifier `docker run --rm` command has returned before this point,
          // so any matching session is a stale database session, not live candidate work.
          input: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlLiteral(database)} AND pid <> pg_backend_pid();\n`,
        });
        cleanup.push({
          id: "database-drop",
          args: [
            "exec",
            "-i",
            databaseContainer,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            "postgres",
          ],
          input: `DROP DATABASE IF EXISTS ${sqlIdentifier(database)};\n`,
        });
        cleanup.push({
          id: "database-role-drop",
          args: [
            "exec",
            "-i",
            databaseContainer,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            "postgres",
          ],
          input: `DROP ROLE IF EXISTS ${sqlIdentifier(role)};\n`,
        });
        cleanup.push({
          id: "database-container-removal",
          args: ["rm", "-f", databaseContainer],
        });
      }
      if (dataVolumeCreated)
        cleanup.push({
          id: "database-data-volume-removal",
          args: ["volume", "rm", "-f", dataVolume],
        });
      if (socketVolumeCreated)
        cleanup.push({
          id: "database-socket-volume-removal",
          args: ["volume", "rm", "-f", socketVolume],
        });
      if (workspaceVolumeCreated)
        cleanup.push({
          id: "workspace-volume-removal",
          args: ["volume", "rm", "-f", volume],
        });
      cleanup.push({
        id: "final-container-inventory",
        args: [
          "container",
          "ls",
          "-aq",
          "--filter",
          `name=^/${databaseContainer}$`,
        ],
        absent: true,
      });
      cleanup.push({
        id: "final-volume-inventory",
        args: [
          "volume",
          "ls",
          "-q",
          "--filter",
          `name=^${volume}(-pgdata|-pgsocket)?$`,
        ],
        absent: true,
      });
      const cleanupFailures: string[] = [];
      for (const step of cleanup) {
        const cleanupResult = run(step.args, step.input);
        if (
          !succeeded(cleanupResult) ||
          (step.absent && (cleanupResult.stdout ?? "").trim())
        )
          cleanupFailures.push(step.id);
      }
      if (envFile)
        rmSync(join(envFile, ".."), { recursive: true, force: true });
      if (cleanupFailures.length && primary) {
        primary.cleanupFailures = cleanupFailures;
        if (!primary.failure) primary.failure = "VERIFIER_CLEANUP_FAILED";
      }
    }
    return primary ?? fail("VERIFIER_LAUNCH_FAILED", result);
  }
}

export class VerificationRuntime implements VerificationExecutor {
  private readonly attempts = new Map<string, number>();
  constructor(
    readonly registry: VerificationRegistry,
    private readonly adapter: VerifierAdapter = new DockerVerifierAdapter(),
  ) {}
  available(): string[] {
    return this.registry.ids();
  }
  perform(
    id: string,
    workId: string,
    workspace: string,
  ): VerificationOperation {
    const spec = this.registry.get(id);
    if (!spec)
      return {
        request: { id, workId, workspaceDigest: "" },
        outcome: {
          ok: false,
          reason: {
            code: "UNKNOWN_VERIFICATION_ID",
            message: `Unknown verification ID: ${id}`,
          },
        },
      };
    let snapshot: WorkspaceSnapshot | undefined;
    try {
      snapshot = snapshotWorkspace(workspace);
      const request = { id, workId, workspaceDigest: snapshot.digest };
      const result = this.adapter.execute(spec, snapshot);
      if (result.failure || result.signal || result.exitCode === null)
        return {
          request,
          outcome: {
            ok: false,
            reason: {
              code:
                result.failure ??
                (result.signal ? "VERIFIER_SIGNALLED" : "VERIFIER_FAILED"),
              message:
                safeOutput(redact(`${result.stderr}\n${result.stdout}`), 1024)
                  .value || "Verifier infrastructure failed",
            },
          },
        };
      const outputLimit = spec.limits.outputBytes ?? 64 * 1024;
      const stdout = safeOutput(redact(result.stdout), outputLimit);
      const stderr = safeOutput(redact(result.stderr), outputLimit);
      const attempt = (this.attempts.get(`${workId}:${id}`) ?? 0) + 1;
      this.attempts.set(`${workId}:${id}`, attempt);
      return {
        request,
        outcome: {
          ok: true,
          evidence: {
            id,
            attempt,
            passed: result.exitCode === 0,
            exitCode: result.exitCode,
            stdout: stdout.value,
            stderr: stderr.value,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            durationMs: result.durationMs,
          },
        },
      };
    } catch (error) {
      return {
        request: { id, workId, workspaceDigest: snapshot?.digest ?? "" },
        outcome: {
          ok: false,
          reason: {
            code: "VERIFIER_SNAPSHOT_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
    } finally {
      if (snapshot) rmSync(snapshot.root, { recursive: true, force: true });
    }
  }
}
