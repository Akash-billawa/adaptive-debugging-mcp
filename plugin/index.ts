/**
 * Adaptive Debugging — OpenCode observation plugin (V1 + V2 compatible).
 *
 * Observation-only. Captures what OpenCode actually exposes through its plugin
 * hooks (tool executions, session errors), redacts secrets, deduplicates by
 * event key, and never blocks the user's workflow. It does NOT execute anything,
 * does NOT claim to see activity outside OpenCode's hook boundary, and does NOT
 * guess incident correlation — uncorrelated events are stored unassociated and
 * can be associated later.
 *
 * The plugin writes to the same SQLite database as the MCP server (shared Store
 * and the same default DB path resolution). Set ADAPTIVE_DEBUG_DB_PATH globally
 * to pin one location for both processes.
 *
 * V2 uses `Plugin.define` + `ctx.tool.hook(...)` + `ctx.event.subscribe()`.
 * V1 uses the `server()` hook map. Both are exported from one entrypoint per the
 * OpenCode migration guide. Hook payloads are version-sensitive; this plugin
 * reads them defensively and marks incomplete captures as incomplete rather
 * than inventing data.
 */
import { Plugin } from "@opencode/plugin";
import { openDatabase } from "../src/memory/db.ts";
import { Store } from "../src/memory/store.ts";

const LOG_PREFIX = "[adaptive-debug-plugin]";
function log(msg: string): void {
  process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
}

let store: Store | null = null;
function getStore(): Store | null {
  if (store) return store;
  try {
    const { db } = openDatabase(process.env.ADAPTIVE_DEBUG_DB_PATH);
    store = new Store(db);
    return store;
  } catch (e) {
    log(`storage unavailable; observations will be skipped: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function safeStringify(value: unknown, maxLen = 2048): string {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > maxLen ? s.slice(0, maxLen) + "...[truncated]" : s;
  } catch {
    return "[unserializable]";
  }
}

function record(kind: string, eventKey: string, fields: {
  sessionId?: string | null;
  tool?: string | null;
  argsSummary?: string | null;
  outputSummary?: string | null;
  status?: string | null;
  captureComplete?: boolean;
}): void {
  // Fire-and-forget: persistence failures never break the host workflow.
  try {
    const s = getStore();
    if (!s) return;
    const res = s.recordObservation({
      event_key: eventKey,
      kind,
      session_id: fields.sessionId ?? null,
      tool: fields.tool ?? null,
      args_summary: fields.argsSummary ?? null,
      output_summary: fields.outputSummary ?? null,
      status: fields.status ?? null,
      capture_complete: fields.captureComplete ?? true,
    });
    if (!res.duplicate) log(`recorded ${kind}${fields.tool ? ` (${fields.tool})` : ""}`);
  } catch (e) {
    log(`failed to record ${kind}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Our own memory operations are already persisted by the MCP server — skip them. */
function isMemoryOperation(tool: unknown, argsText: string | null): boolean {
  const t = typeof tool === "string" ? tool : "";
  if (t.startsWith("debug_")) return true;
  if (t.includes("adaptive_debug_memory") || t.includes("adaptive-debug-memory")) return true;
  if (argsText && /adaptive[-_]debug[-_]memory/.test(argsText)) return true;
  if (argsText && /\bdebug_(case|attempt|evidence|history|tree|validation|hypothesis|research|timeline|data_export|server_health)\b/.test(argsText)) return true;
  return false;
}

// --- before/after correlation + idempotency -------------------------------
// The v2 tool hooks do not document a call id, so we correlate before/after by
// (tool, args) and reuse the generated id, which also dedups hook retries.
const pendingCalls = new Map<string, string>();
const MAX_TRACKED_CALLS = 2000;

function callKey(tool: string, argsText: string | null): string {
  return `${tool}::${(argsText ?? "").slice(0, 256)}`;
}
function newCallId(): string {
  return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function trackedCallId(tool: string, argsText: string | null): string {
  const k = callKey(tool, argsText);
  let id = pendingCalls.get(k);
  if (!id) {
    id = newCallId();
    if (pendingCalls.size > MAX_TRACKED_CALLS) pendingCalls.clear();
    pendingCalls.set(k, id);
  }
  return id;
}

function sessionIdOf(event: any): string | null {
  return event?.sessionID ?? event?.session_id ?? event?.session ?? null;
}

// --- Session-level failure events -------------------------------------------
// OpenCode v2.0.27 delivers events wrapped in an envelope:
//   {id, created, type, durable:{...}, location:{...}, data:{...}}
// and for the failure signals it ACTUALLY publishes, the session id is nested
// at `data.sessionID` - there is no top-level sessionID.
//
// `session.error` is present in the host's event registry but is NOT published
// for provider/transport failures. A live session against a local 401 responder
// delivered 68 events containing session.execution.failed and session.step.failed
// and zero session.error. Watching only "session.error" therefore never fired in
// practice, so the event path was dead code. We keep session.error in the set
// (harmless, and forward-compatible) and add the two events that do fire.
const FAILURE_EVENT_TYPES = new Set<string>([
  "session.error",
  "session.execution.failed",
  "session.step.failed",
]);

/** Session id from a v2 event envelope: `data.sessionID`, with safe fallbacks. */
function eventSessionId(e: any): string | null {
  return e?.data?.sessionID ?? e?.sessionID ?? e?.session_id ?? e?.session ?? null;
}

/** True when the event type is a session-level failure we persist. */
function isFailureEvent(type: unknown): type is string {
  return typeof type === "string" && FAILURE_EVENT_TYPES.has(type);
}

// --- V2 definition ----------------------------------------------------------
const definition = Plugin.define({
  id: "adaptive-debug-observer",
  async setup(ctx: any) {
    log("loaded (observation-only, v2)");

    await ctx.tool.hook("execute.before", (event: any) => {
      try {
        const tool = event?.tool ?? null;
        const argsText = event?.input == null ? null : safeStringify(event.input, 1024);
        if (isMemoryOperation(tool, argsText)) return;
        const cid = trackedCallId(String(tool ?? "?"), argsText);
        record("tool.execute.before", `before:${cid}`, {
          sessionId: sessionIdOf(event),
          tool: typeof tool === "string" ? tool : null,
          argsSummary: argsText,
          captureComplete: true,
        });
      } catch (e) {
        log(`before-hook error (ignored): ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    await ctx.tool.hook("execute.after", (event: any) => {
      try {
        const tool = event?.tool ?? null;
        const argsText = event?.input == null ? null : safeStringify(event.input, 1024);
        if (isMemoryOperation(tool, argsText)) return;
        const status = typeof event?.status === "string" ? event.status : null;
        const resultText =
          status === "error"
            ? event?.error == null ? null : safeStringify(event.error, 4096)
            : event?.result == null ? null : safeStringify(event.result, 4096);
        const cid = trackedCallId(String(tool ?? "?"), argsText);
        record("tool.execute.after", `after:${cid}`, {
          sessionId: sessionIdOf(event),
          tool: typeof tool === "string" ? tool : null,
          argsSummary: argsText,
          outputSummary: resultText,
          status,
          captureComplete: status !== null,
        });
      } catch (e) {
        log(`after-hook error (ignored): ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    // Session-level signals arrive on the public event stream.
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          const type = (ev as any)?.type;
          if (isFailureEvent(type)) {
            const e = ev as any;
            const sessionId = eventSessionId(e);
            record(type, `${type}:${e?.id ?? sessionId ?? newCallId()}`, {
              sessionId,
              outputSummary: safeStringify(e, 2048),
              captureComplete: true,
            });
          }
          // Other lifecycle events are intentionally not persisted (low value, high noise).
        }
      } catch (e) {
        log(`event stream ended: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();

    return () => controller.abort();
  },
});

// --- V1 hook map (defensive payload handling) -------------------------------
function pick(input: any, output: any, ...keys: string[]): unknown {
  for (const k of keys) {
    if (input && input[k] !== undefined && input[k] !== null) return input[k];
    if (output && output[k] !== undefined && output[k] !== null) return output[k];
  }
  return undefined;
}

const v1Server = async () => {
  log("loaded (observation-only, v1)");
  return {
    "tool.execute.before": async (input: any, output?: any) => {
      try {
        const tool = pick(input, output, "tool", "toolName");
        const args = pick(input, output, "args", "parameters", "arguments");
        const argsText = args === undefined || args === null ? null : safeStringify(args, 1024);
        if (isMemoryOperation(tool, argsText)) return;
        const callId = pick(input, output, "callID", "call_id", "id") as string | undefined;
        const key = `before:${callId ?? `v1:${tool}:${argsText}:${Date.now()}`}`;
        record("tool.execute.before", key, {
          sessionId: (pick(input, output, "sessionID", "session_id", "session") as string | undefined) ?? null,
          tool: typeof tool === "string" ? tool : null,
          argsSummary: argsText,
          captureComplete: !!callId,
        });
      } catch (e) {
        log(`before-hook error (ignored): ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    "tool.execute.after": async (input: any, output?: any) => {
      try {
        const tool = pick(input, output, "tool", "toolName");
        const args = pick(input, output, "args", "parameters", "arguments");
        const argsText = args === undefined || args === null ? null : safeStringify(args, 1024);
        if (isMemoryOperation(tool, argsText)) return;
        const result = pick(input, output, "output", "result", "content");
        const outText = result === undefined || result === null ? null : safeStringify(result, 4096);
        const callId = pick(input, output, "callID", "call_id", "id") as string | undefined;
        const key = `after:${callId ?? `v1:${tool}:${argsText}:${Date.now()}`}`;
        record("tool.execute.after", key, {
          sessionId: (pick(input, output, "sessionID", "session_id", "session") as string | undefined) ?? null,
          tool: typeof tool === "string" ? tool : null,
          argsSummary: argsText,
          outputSummary: outText,
          captureComplete: result !== undefined,
        });
      } catch (e) {
        log(`after-hook error (ignored): ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    event: async (payload: any) => {
      try {
        const ev = payload?.event ?? payload;
        const type = ev?.type;
        if (isFailureEvent(type)) {
          const sessionId = eventSessionId(ev);
          record(type, `${type}:${ev?.id ?? sessionId ?? Date.now()}`, {
            sessionId,
            outputSummary: safeStringify(ev, 2048),
            captureComplete: !!ev,
          });
        }
      } catch (e) {
        log(`event-hook error (ignored): ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
};

// Dual V1+V2 entrypoint: V2 reads `id` + `setup()`, V1 calls `server()`.
export default {
  ...definition,
  server: v1Server,
};
