// Inspect plugin observations in the real (default) database. Read-only.
import { openDatabase } from "../../src/memory/db.ts";

const { db } = openDatabase(); // resolves the same default path as server + plugin
const rows = db
  .query(
    "SELECT kind, tool, status, capture_complete, redaction_status, session_id, captured_at FROM plugin_observations ORDER BY captured_at DESC LIMIT 12",
  )
  .all() as Record<string, unknown>[];
const count = (db.query("SELECT COUNT(*) c FROM plugin_observations").get() as { c: number }).c;
console.log("total observations:", count);
for (const r of rows) {
  console.log(
    `[${(r.captured_at as string)?.slice(11, 19)}] ${r.kind} tool=${r.tool} status=${r.status} complete=${r.capture_complete} redacted=${r.redaction_status} session=${r.session_id}`,
  );
}
try { db.close(); } catch {}
