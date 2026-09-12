import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const nativeTypes = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error",
]);
const itemKinds = {
  command_execution: "command",
  file_change: "file",
  mcp_tool_call: "tool",
  web_search: "tool",
  agent_message: "agent",
  reasoning: "reasoning",
  todo_list: "item",
};
// Public exec --json fields only. No app-server or internal protocol events.
// https://learn.chatgpt.com/docs/non-interactive-mode
export class CodexEvents {
  decoder = new StringDecoder("utf8");
  pending = "";
  dropping = false;
  eventTypes = {};
  usage = null;
  threadHash;
  turn = 0;
  turnOpen = false;
  durations = new Map();
  started = new Map();
  constructor(emit, limit = 1024 * 1024) {
    this.emit = emit;
    this.limit = limit;
  }
  write(chunk) {
    this.consume(this.decoder.write(chunk));
  }
  consume(text) {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (!this.dropping) {
        this.pending += parts[i];
        if (Buffer.byteLength(this.pending) > this.limit) {
          this.pending = "";
          this.dropping = true;
          this.emit({ kind: "diagnostic" });
        }
      }
      if (i < parts.length - 1) {
        if (!this.dropping) this.line();
        this.dropping = false;
      }
    }
  }
  end() {
    this.consume(this.decoder.end());
    if (!this.dropping) this.line();
    this.pending = "";
  }
  line() {
    const line = this.pending;
    this.pending = "";
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.emit({ kind: "diagnostic" });
      return;
    }
    this.map(event);
  }
  map(event) {
    if (!event || !nativeTypes.has(event.type)) {
      this.emit({ kind: "diagnostic" });
      return;
    }
    this.eventTypes[event.type] = (this.eventTypes[event.type] ?? 0) + 1;
    const metadata = {};
    if (event.type === "thread.started" && typeof event.thread_id === "string")
      this.threadHash = hash(event.thread_id);
    if (this.threadHash) metadata.threadHash = this.threadHash;
    // exec JSONL does not promise a provider turn ID. This local ordinal scopes
    // lifecycle events only and is never represented as a native provider ID.
    if (event.type === "turn.started" && !this.turnOpen) {
      this.turn++;
      this.turnOpen = true;
    }
    if (event.type === "turn.completed" || event.type === "turn.failed")
      this.turnOpen = false;
    const turnScope = hash(`${this.threadHash ?? "thread"}:${this.turn}`);
    if (event.type.startsWith("thread."))
      this.emit({
        kind: "thread",
        scope: this.threadHash,
        status: "started",
        metadata,
      });
    else if (event.type.startsWith("turn.")) {
      this.emit({
        kind: "turn",
        scope: turnScope,
        status: event.type.split(".")[1],
        metadata,
      });
      if (event.type === "turn.completed" && event.usage) {
        const usage = {};
        for (const [native, generic] of Object.entries({
          input_tokens: "inputTokens",
          cached_input_tokens: "cachedInputTokens",
          output_tokens: "outputTokens",
          reasoning_output_tokens: "reasoningOutputTokens",
        })) {
          const value = event.usage[native];
          if (Number.isSafeInteger(value) && value >= 0) usage[generic] = value;
        }
        this.usage = Object.fromEntries(
          Object.entries(event.usage).filter(
            ([key, value]) =>
              [
                "input_tokens",
                "cached_input_tokens",
                "output_tokens",
                "reasoning_output_tokens",
              ].includes(key) &&
              Number.isSafeInteger(value) &&
              value >= 0,
          ),
        );
        if (Object.keys(usage).length)
          this.emit({ kind: "usage", scope: turnScope, metadata: usage });
      }
    } else if (event.type.startsWith("item.")) {
      const item = event.item;
      if (!item || typeof item.id !== "string") {
        this.emit({ kind: "diagnostic" });
        return;
      }
      metadata.itemHash = hash(item.id);
      const scope = hash(`${turnScope}:${item.id}`);
      const kind = itemKinds[item.type] ?? "item";
      // Updated text/output alone is activity, not a new state transition.
      let status = event.type.split(".")[1];
      if (
        status === "updated" &&
        ["in_progress", "completed", "failed"].includes(item.status)
      )
        status = item.status === "in_progress" ? "started" : item.status;
      if (status === "started" && !this.started.has(scope))
        this.started.set(scope, Date.now());
      if (status === "completed" && this.started.has(scope)) {
        if (!this.durations.has(scope))
          this.durations.set(scope, Date.now() - this.started.get(scope));
        metadata.durationMs = this.durations.get(scope);
      }
      if (typeof item.command === "string")
        metadata.commandHash = hash(item.command.trim().replace(/\r\n/g, "\n"));
      if (typeof item.server === "string" && typeof item.tool === "string")
        metadata.toolHash = hash(JSON.stringify([item.server, item.tool]));
      if (Number.isSafeInteger(item.exit_code))
        metadata.exitCode = item.exit_code;
      const output = item.aggregated_output ?? item.text;
      if (typeof output === "string") {
        metadata.bytes = Buffer.byteLength(output);
        metadata.outputHash = hash(output);
      }
      if (Array.isArray(item.changes)) {
        metadata.files = item.changes.length;
        // A notification fingerprint, never an authoritative filesystem digest.
        metadata.fileChangesHash = hash(
          JSON.stringify(
            item.changes.map((c) => ({
              path: typeof c?.path === "string" ? c.path : null,
              kind: ["add", "delete", "update"].includes(c?.kind)
                ? c.kind
                : null,
            })),
          ),
        );
      }
      this.emit({ kind, scope, status, metadata });
    } else this.emit({ kind: "diagnostic", metadata });
  }
}
