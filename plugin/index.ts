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
let currentDbPath: string | undefined = undefined;

function getStore(): Store | null {
  const targetPath = process.env.ADAPTIVE_DEBUG_DB_PATH;
  if (store && currentDbPath === targetPath) return store;
  if (store) {
    try { store.db.close(); } catch {}
    store = null;
  }
  try {
    const { db } = openDatabase(targetPath);
    store = new Store(db);
    currentDbPath = targetPath;
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

let activeIncidentId: string | null = null;
let activeExperimentId: string | null = null;

export function setActiveIncident(incidentId: string | null, experimentId?: string | null): void {
  activeIncidentId = incidentId;
  activeExperimentId = experimentId ?? null;
}

export function getActiveIncident(): { incidentId: string | null; experimentId: string | null } {
  return { incidentId: activeIncidentId, experimentId: activeExperimentId };
}

export function associateObservation(
  observationId: string,
  incidentId: string,
  experimentId?: string | null,
): void {
  const s = getStore();
  if (!s) return;
  s.associateObservation(observationId, incidentId, experimentId);
}

function record(kind: string, eventKey: string, fields: {
  sessionId?: string | null;
  tool?: string | null;
  argsSummary?: string | null;
  outputSummary?: string | null;
  status?: string | null;
  captureComplete?: boolean;
  incidentId?: string | null;
  experimentId?: string | null;
}): { observation_id: string; duplicate: boolean } | null {
  // Fire-and-forget: persistence failures never break the host workflow.
  try {
    const s = getStore();
    if (!s) return null;

    let incId = fields.incidentId ?? activeIncidentId;
    let expId = fields.experimentId ?? activeExperimentId;
    if (!incId) {
      try {
        const row = s.db
          .query(
            "SELECT incident_id FROM incidents WHERE status NOT IN ('resolved', 'dormant') ORDER BY updated_at DESC LIMIT 1",
          )
          .get() as { incident_id: string } | null;
        if (row) incId = row.incident_id;
      } catch {
        // Safe fallback: leave unassociated
      }
    }

    const res = s.recordObservation({
      event_key: eventKey,
      kind,
      session_id: fields.sessionId ?? null,
      tool: fields.tool ?? null,
      args_summary: fields.argsSummary ?? null,
      output_summary: fields.outputSummary ?? null,
      status: fields.status ?? null,
      incident_id: incId ?? null,
      experiment_id: expId ?? null,
      capture_complete: fields.captureComplete ?? true,
    });
    if (!res.duplicate) log(`recorded ${kind}${fields.tool ? ` (${fields.tool})` : ""}`);
    return res;
  } catch (e) {
    log(`failed to record ${kind}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
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
// Correlate before/after by (tool, args) using a FIFO queue so repeated executions
// (e.g. repeated test runs) receive unique call IDs and are never dropped as duplicates.
interface PendingCall {
  id: string;
  timestamp: number;
}
const pendingCalls = new Map<string, PendingCall[]>();
const MAX_TRACKED_CALLS = 2000;
const CALL_TTL_MS = 5 * 60 * 1000; // 5 minutes

function callKey(tool: string, argsText: string | null): string {
  return `${tool}::${(argsText ?? "").slice(0, 256)}`;
}

function newCallId(): string {
  return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function prunePendingCalls(): void {
  const now = Date.now();
  for (const [k, calls] of pendingCalls.entries()) {
    const fresh = calls.filter((c) => now - c.timestamp < CALL_TTL_MS);
    if (fresh.length === 0) {
      pendingCalls.delete(k);
    } else {
      pendingCalls.set(k, fresh);
    }
  }
}

function pushCallId(tool: string, argsText: string | null, explicitId?: string | null): string {
  if (explicitId) return explicitId;
  const k = callKey(tool, argsText);
  const id = newCallId();
  if (pendingCalls.size > MAX_TRACKED_CALLS) {
    prunePendingCalls();
    if (pendingCalls.size > MAX_TRACKED_CALLS) pendingCalls.clear();
  }
  const queue = pendingCalls.get(k) ?? [];
  queue.push({ id, timestamp: Date.now() });
  pendingCalls.set(k, queue);
  return id;
}

function popCallId(tool: string, argsText: string | null, explicitId?: string | null): string {
  if (explicitId) return explicitId;
  const k = callKey(tool, argsText);
  const queue = pendingCalls.get(k);
  if (!queue || queue.length === 0) {
    return newCallId();
  }
  const item = queue.shift()!;
  if (queue.length === 0) {
    pendingCalls.delete(k);
  }
  return item.id;
}

function sessionIdOf(event: any): string | null {
  return event?.sessionID ?? event?.session_id ?? event?.session ?? null;
}

// --- Session-level failure events -------------------------------------------
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
        const explicitId = event?.callID ?? event?.call_id ?? event?.id ?? event?.toolCallId ?? null;
        const cid = pushCallId(String(tool ?? "?"), argsText, explicitId);
        record("tool.execute.before", `before:${cid}`, {
          sessionId: sessionIdOf(event),
          tool: typeof tool === "string" ? tool : null,
          argsSummary: argsText,
          captureComplete: true,
          incidentId: event?.incidentId ?? event?.incident_id ?? null,
          experimentId: event?.experimentId ?? event?.experiment_id ?? null,
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
        const explicitId = event?.callID ?? event?.call_id ?? event?.id ?? event?.toolCallId ?? null;
        const cid = popCallId(String(tool ?? "?"), argsText, explicitId);
        record("tool.execute.after", `after:${cid}`, {
          sessionId: sessionIdOf(event),
          tool: typeof tool === "string" ? tool : null,
          argsSummary: argsText,
          outputSummary: resultText,
          status,
          captureComplete: status !== null,
          incidentId: event?.incidentId ?? event?.incident_id ?? null,
          experimentId: event?.experimentId ?? event?.experiment_id ?? null,
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
        const cid = pushCallId(String(tool ?? "?"), argsText, callId ?? null);
        const key = `before:${cid}`;
        record("tool.execute.before", key, {
          sessionId: (pick(input, output, "sessionID", "session_id", "session") as string | undefined) ?? null,
          tool: typeof tool === "string" ? tool : null,
          argsSummary: argsText,
          captureComplete: !!callId,
          incidentId: (pick(input, output, "incidentId", "incident_id") as string | undefined) ?? null,
          experimentId: (pick(input, output, "experimentId", "experiment_id") as string | undefined) ?? null,
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
        const cid = popCallId(String(tool ?? "?"), argsText, callId ?? null);
        const key = `after:${cid}`;
        record("tool.execute.after", key, {
          sessionId: (pick(input, output, "sessionID", "session_id", "session") as string | undefined) ?? null,
          tool: typeof tool === "string" ? tool : null,
          argsSummary: argsText,
          outputSummary: outText,
          captureComplete: result !== undefined,
          incidentId: (pick(input, output, "incidentId", "incident_id") as string | undefined) ?? null,
          experimentId: (pick(input, output, "experimentId", "experiment_id") as string | undefined) ?? null,
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
            incidentId: (pick(ev, null, "incidentId", "incident_id") as string | undefined) ?? null,
            experimentId: (pick(ev, null, "experimentId", "experiment_id") as string | undefined) ?? null,
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
  associateObservation,
  setActiveIncident,
  getActiveIncident,
};
