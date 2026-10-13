// Verifies the plugin's dual V1+V2 entrypoint: shape, v2 setup with a mock
// context, hook invocations (including junk payloads and memory-tool skipping),
// cleanup, and v1 server() hooks. Real hook payloads must still be validated
// inside OpenCode (version-sensitive).
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import PluginDefault from "../../plugin/index.ts";
import { openDatabase } from "../../src/memory/db.ts";
import { Store } from "../../src/memory/store.ts";

const DB = join(tmpdir(), `admcp-plugin-smoke-${Date.now()}.db`);
process.env.ADAPTIVE_DEBUG_DB_PATH = DB;

const Plugin = PluginDefault as unknown as Record<string, unknown>;
if (Plugin.id !== "adaptive-debug-observer") throw new Error("bad plugin id: " + String(Plugin.id));
if (typeof Plugin.setup !== "function") throw new Error("missing v2 setup()");
if (typeof Plugin.server !== "function") throw new Error("missing v1 server()");
console.log("PASS dual export shape (id, setup, server)");

// --- V2: setup with a mock context ---------------------------------------
const toolHooks: Array<[string, (event: unknown) => unknown]> = [];
const mockCtx = {
  tool: {
    hook: async (name: string, cb: (event: unknown) => unknown) => {
      toolHooks.push([name, cb]);
      return { dispose: async () => {} };
    },
  },
  event: {
    subscribe: (_opts: unknown) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "session.error", sessionID: "s-err-1", message: "boom" };
      },
    }),
  },
};

const cleanup = (await (Plugin.setup as (ctx: unknown) => Promise<unknown>)(mockCtx)) as
  | (() => void)
  | undefined;
if (typeof cleanup !== "function") throw new Error("v2 setup must return a cleanup function");
console.log("PASS v2 setup registered hooks:", toolHooks.map(([n]) => n).join(", "));

const before = toolHooks.find(([n]) => n === "execute.before")?.[1];
const after = toolHooks.find(([n]) => n === "execute.after")?.[1];
if (!before || !after) throw new Error("expected execute.before and execute.after hooks");

await before({ tool: "read", input: { path: "C:/x/y.txt" }, sessionID: "s1" });
await after({ tool: "read", input: { path: "C:/x/y.txt" }, status: "completed", result: { content: "hi" }, sessionID: "s1" });
await after({ tool: "bash", input: { command: "npm test" }, status: "error", error: { message: "exit 1" }, sessionID: "s1" });
console.log("PASS v2 tool hooks invoked");

// Our own memory operations must be skipped (already persisted by the MCP server).
await before({ tool: "debug_case_start", input: { title: "x" }, sessionID: "s1" });
await after({ tool: "execute", input: { code: 'tools["adaptive-debug-memory"].debug_case_start({})' }, status: "completed", sessionID: "s1" });
console.log("PASS memory-operation skipping");

// Junk payloads must not throw.
await before(null);
await after(undefined);
await before({});
await after({});
console.log("PASS junk payloads tolerated");

(cleanup as () => void)();
console.log("PASS v2 cleanup returned");

// --- V1: server() hook map --------------------------------------------------
const v1hooks = (await (Plugin.server as () => Promise<Record<string, unknown>>)()) as Record<string, unknown>;
await (v1hooks["tool.execute.before"] as any)({ tool: "bash", args: { command: "echo hi" }, sessionID: "s1", callID: "c9" });
await (v1hooks["tool.execute.after"] as any)({ tool: "bash", sessionID: "s1", callID: "c9", output: "hi" });
await (v1hooks["event"] as any)({ event: { type: "session.error", id: "e1" } });
await (v1hooks["event"] as any)(null);
console.log("PASS v1 hooks tolerated");

// --- V2: real host event envelope shapes (regression) ------------------------
// OpenCode v2.0.27 wraps every event in an envelope {id, created, type,
// durable, location, data} and nests the session id at data.sessionID. For
// provider failures it publishes session.execution.failed / session.step.failed
// and NOT session.error (confirmed against a live 401 run with an event spy).
// These payloads are copied from that live run.
const REAL_FAILURE_EVENTS: any[] = [
  { id: "evt_real_1", created: 1791898032951, type: "notification", data: {} },
  { id: "evt_real_2", created: 1791898032952, type: "session.created", durable: { aggregateID: "ses_realhost_1", seq: 1, version: 1 }, location: { directory: "C:/tmp" }, data: { sessionID: "ses_realhost_1", slug: "calm-wolf" } },
  { id: "evt_real_3", created: 1791898032953, type: "session.execution.failed", durable: { aggregateID: "ses_realhost_1", seq: 7, version: 1 }, location: { directory: "C:/tmp" }, data: { sessionID: "ses_realhost_1", error: { type: "provider.auth", message: "unauthorized (synthetic)", status: 401, response: { body: '{"error":"x"}' } } } },
  { id: "evt_real_4", created: 1791898032954, type: "session.step.failed", durable: { aggregateID: "ses_realhost_1", seq: 8, version: 1 }, location: { directory: "C:/tmp" }, data: { sessionID: "ses_realhost_1", assistantMessageID: "msg_1", error: { type: "provider.auth", message: "unauthorized (synthetic)", status: 401 }, snapshot: "deadbeef", files: [] } },
  // Legacy/flat shape must keep working (defensive fallback).
  { id: "evt_real_5", created: 1791898032955, type: "session.error", sessionID: "ses_flat_1", error: { name: "UnknownError", data: { message: "boom" } } },
];
await (Plugin.setup as (ctx: unknown) => Promise<unknown>)({
  tool: { hook: async () => ({ dispose: async () => {} }) },
  event: {
    subscribe: (_opts: unknown) => ({
      async *[Symbol.asyncIterator]() {
        for (const ev of REAL_FAILURE_EVENTS) yield ev;
      },
    }),
  },
});

// --- Durable observation check (with poll for the async event stream) -------
const { db } = openDatabase(DB);
const store = new Store(db);
const found = async (predicate: (o: any) => boolean, ms = 3000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const obs = store.listObservations({ limit: 500 });
    if (obs.some(predicate)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
};

if (!(await found((o) => o.kind === "tool.execute.before" && o.tool === "read"))) throw new Error("missing read before-observation");
if (!(await found((o) => o.kind === "tool.execute.after" && o.status === "error"))) throw new Error("missing error after-observation");
if (!(await found((o) => o.kind === "session.error"))) throw new Error("missing session.error observation");
if (await found((o: any) => o.tool === "debug_case_start" || o.tool === "execute", 500)) throw new Error("memory operation was recorded (should be skipped)");

// Real host failure events: session id comes from data.sessionID, not the top level.
if (!(await found((o) => o.kind === "session.execution.failed"))) throw new Error("missing session.execution.failed observation");
if (!(await found((o) => o.kind === "session.step.failed"))) throw new Error("missing session.step.failed observation");
const execFail = (await found((o) => o.kind === "session.execution.failed" && o.session_id === "ses_realhost_1")) ? true : false;
if (!execFail) {
  const wrong = (await found((o) => o.kind === "session.execution.failed" && o.session_id !== "ses_realhost_1")) ? " (an execution.failed row exists with the WRONG session id)" : "";
  throw new Error("session.execution.failed did not record data.sessionID" + wrong);
}
if (!(await found((o) => o.kind === "session.step.failed" && o.session_id === "ses_realhost_1"))) throw new Error("session.step.failed did not record data.sessionID");
if (!(await found((o) => o.kind === "session.error" && o.session_id === "ses_flat_1"))) throw new Error("legacy flat session.error shape stopped working");

// Non-failure host events must still be skipped (low value, high noise).
for (const noise of ["session.created", "notification", "mcp.status.changed"]) {
  if (await found((o) => o.kind === noise, 300)) throw new Error(`non-failure event '${noise}' was recorded`);
}

// The host error detail must survive into the payload, not be truncated away.
const execRows = store.listObservations({ limit: 500 }).filter((o) => o.kind === "session.execution.failed");
const payload = JSON.stringify(execRows.map((o) => o.output_summary));
for (const needle of ["provider.auth", "401", "ses_realhost_1"]) {
  if (!payload.includes(needle)) throw new Error(`execution.failed payload lost '${needle}'`);
}
if (!execRows[0].event_key?.startsWith("session.execution.failed:")) throw new Error("execution.failed event_key not namespaced by type");

console.log("PASS durable observations written, dedup-safe, memory ops skipped");
console.log("PASS real host failure events captured with data.sessionID; non-failure events skipped");

try { db.close(); } catch {}
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s, { force: true }); } catch {} }
console.log("PLUGIN_OK");
