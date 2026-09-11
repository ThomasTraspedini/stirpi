import { DatabaseSync } from "node:sqlite";
import type { State } from "../domain/index.js";
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, objective TEXT NOT NULL, public_criteria TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, reason TEXT, config TEXT NOT NULL, scenario TEXT NOT NULL, resources TEXT NOT NULL, next_queue INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS evaluator_payloads(run_id TEXT PRIMARY KEY REFERENCES runs(id), payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS lineages(id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), parent_lineage_id TEXT, status TEXT NOT NULL, priority INTEGER NOT NULL, reason TEXT, data TEXT NOT NULL, PRIMARY KEY(run_id,id));
 CREATE TABLE IF NOT EXISTS assumptions(run_id TEXT NOT NULL, lineage_id TEXT NOT NULL, assumption TEXT NOT NULL, rationale TEXT NOT NULL, PRIMARY KEY(run_id,lineage_id), FOREIGN KEY(run_id,lineage_id) REFERENCES lineages(run_id,id));
 CREATE TABLE IF NOT EXISTS work_units(id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), lineage_id TEXT NOT NULL, parent_work_id TEXT, status TEXT NOT NULL, priority INTEGER NOT NULL, resources TEXT NOT NULL, reason TEXT, data TEXT NOT NULL, PRIMARY KEY(run_id,id), FOREIGN KEY(run_id,lineage_id) REFERENCES lineages(run_id,id));
 CREATE TABLE IF NOT EXISTS artifact_operations(run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,seq));
 CREATE TABLE IF NOT EXISTS events(run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, type TEXT NOT NULL, subject TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,seq));
 CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;
 CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;`);
  }
  save(state: State): void {
    const { runId: id, taskId } = state;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { hiddenEvaluation, ...publicScenario } = state.scenario;
      const task = this.db
        .prepare("SELECT * FROM tasks WHERE id=?")
        .get(taskId);
      if (
        task &&
        (task.objective !== state.scenario.objective ||
          task.public_criteria !==
            JSON.stringify(state.scenario.publicEvaluation))
      )
        throw new Error(`Task definition mismatch: ${taskId}`);
      if (!task)
        this.db
          .prepare("INSERT INTO tasks VALUES(?,?,?)")
          .run(
            taskId,
            state.scenario.objective,
            JSON.stringify(state.scenario.publicEvaluation),
          );
      this.db
        .prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)")
        .run(
          id,
          taskId,
          state.status,
          JSON.stringify(state.reason),
          JSON.stringify(state.config),
          JSON.stringify(publicScenario),
          JSON.stringify(state.resources),
          state.nextQueue,
        );
      this.db
        .prepare("INSERT INTO evaluator_payloads VALUES(?,?)")
        .run(id, JSON.stringify(hiddenEvaluation));
      for (const l of state.lineages) {
        this.db
          .prepare("INSERT INTO lineages VALUES(?,?,?,?,?,?,?)")
          .run(
            l.id,
            id,
            l.parentId,
            l.status,
            l.priority,
            JSON.stringify(l.reason),
            JSON.stringify(l),
          );
        if (l.assumption !== null)
          this.db
            .prepare("INSERT INTO assumptions VALUES(?,?,?,?)")
            .run(id, l.id, l.assumption, l.rationale!);
      }
      for (const w of state.work)
        this.db
          .prepare("INSERT INTO work_units VALUES(?,?,?,?,?,?,?,?,?)")
          .run(
            w.id,
            id,
            w.lineageId,
            w.parentId,
            w.status,
            w.priority,
            JSON.stringify(w.resources),
            JSON.stringify(w.reason),
            JSON.stringify(w),
          );
      for (const [seq, operation] of (state.artifactOperations ?? []).entries())
        this.db
          .prepare("INSERT INTO artifact_operations VALUES(?,?,?)")
          .run(id, seq, JSON.stringify(operation));
      for (const e of state.events)
        this.db
          .prepare("INSERT INTO events VALUES(?,?,?,?,?)")
          .run(id, e.seq, e.type, e.subject, JSON.stringify(e.data));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  load(id: string): State {
    const r = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    if (!r) throw new Error(`Unknown run: ${id}`);
    const parse = (x: unknown) => JSON.parse(String(x));
    const operations = this.db
      .prepare(
        "SELECT data FROM artifact_operations WHERE run_id=? ORDER BY seq",
      )
      .all(id)
      .map((r) => parse(r.data));
    return {
      ...(operations.length ? { artifactOperations: operations } : {}),
      runId: String(r.id),
      taskId: String(r.task_id),
      status: r.status as State["status"],
      reason: parse(r.reason),
      config: parse(r.config),
      scenario: {
        ...parse(r.scenario),
        hiddenEvaluation: parse(
          this.db
            .prepare("SELECT payload FROM evaluator_payloads WHERE run_id=?")
            .get(id)!.payload,
        ),
      },
      resources: parse(r.resources),
      nextQueue: Number(r.next_queue),
      lineages: this.db
        .prepare("SELECT data FROM lineages WHERE run_id=? ORDER BY rowid")
        .all(id)
        .map((r) => parse(r.data)),
      work: this.db
        .prepare("SELECT data FROM work_units WHERE run_id=? ORDER BY rowid")
        .all(id)
        .map((r) => parse(r.data)),
      events: this.db
        .prepare("SELECT * FROM events WHERE run_id=? ORDER BY seq")
        .all(id)
        .map((e) => ({
          seq: Number(e.seq),
          type: String(e.type),
          subject: String(e.subject),
          data: parse(e.data),
        })),
    };
  }
  close(): void {
    this.db.close();
  }
}
export function jsonl(state: State): string {
  return state.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
