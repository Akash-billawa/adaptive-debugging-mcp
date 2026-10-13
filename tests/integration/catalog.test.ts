import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tempDbPath, openStore, closeStore } from "./helpers.ts";
import { buildCatalog, ALL_TOOLS } from "../../src/server/catalog.ts";

const paths: string[] = [];
function ctx() {
  const p = tempDbPath();
  paths.push(p);
  const store = openStore(p);
  return { store, catalog: buildCatalog({ store, dbPath: p, log: () => {} }), cleanup: () => closeStore(store) };
}
afterAll(() => {
  for (const p of paths) for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s, { force: true }); } catch {} }
});

async function call(catalog: any, name: string, args: Record<string, unknown>) {
  try {
    const res = await catalog.call(name, args);
    return { isError: res.isError, structured: res.structuredContent };
  } catch (e: any) {
    return { isError: true, category: e.category, message: e.message, structured: e };
  }
}

test("all expected tools are registered", () => {
  const names = ALL_TOOLS.map((t) => t.def.name).sort();
  expect(names).toContain("debug_case_start");
  expect(names).toContain("debug_tree_read");
  expect(names).toContain("debug_validation_record");
  expect(names.length).toBeGreaterThanOrEqual(15);
});

test("unknown tool returns NOT_FOUND error", async () => {
  const { catalog, cleanup } = ctx();
  const r = await call(catalog, "debug_does_not_exist", {});
  expect(r.isError).toBe(true);
  cleanup();
});

test("idempotency: same idempotency_key returns the same record", async () => {
  const { store, catalog, cleanup } = ctx();
  const args = { project: { display_name: "IdemApp" }, title: "t", initial_symptom: "s", idempotency_key: "key-123", actor: "agent" };
  const r1 = await call(catalog, "debug_case_start", args);
  const before = store.db.query("SELECT COUNT(*) c FROM incidents").get() as { c: number };
  const r2 = await call(catalog, "debug_case_start", args);
  const after = store.db.query("SELECT COUNT(*) c FROM incidents").get() as { c: number };
  expect(r1.structured.incident_id).toBe(r2.structured.incident_id);
  expect(after.c).toBe(before.c); // no duplicate incident
  void store;
  cleanup();
});

test("terminal outcome requires justification or attached evidence", async () => {
  const { catalog, cleanup } = ctx();
  const start = await call(catalog, "debug_case_start", { project: { display_name: "Just" }, title: "t", initial_symptom: "s", actor: "agent" });
  const incId = start.structured.incident_id;
  const att = await call(catalog, "debug_attempt_create", { incident_id: incId, node_kind: "experiment", title: "e", proposed_change: "p", expected_observation: "o", actor: "agent" });
  const attId = att.structured.experiment_id;

  // No evidence, no justification -> rejected
  const bad = await call(catalog, "debug_attempt_update", { attempt_id: attId, outcome_status: "failed", actor: "agent" });
  expect(bad.isError).toBe(true);

  // Attach evidence only (no text) -> allowed
  await call(catalog, "debug_evidence_record", { project_id: start.structured.project_id, incident_id: incId, experiment_id: attId, evidence_type: "stderr", content: "boom stack trace", capture_source: "agent" });
  const okUpdate = await call(catalog, "debug_attempt_update", { attempt_id: attId, outcome_status: "failed", actor: "agent" });
  expect(okUpdate.isError).toBe(false);
  expect(okUpdate.structured.outcome_status).toBe("failed");
  cleanup();
});

test("invalid enum inputs yield validation errors", async () => {
  const { catalog, cleanup } = ctx();
  const start = await call(catalog, "debug_case_start", { project: { display_name: "Enum" }, title: "t", initial_symptom: "s", reproduction_status: "not_a_value", actor: "agent" });
  expect(start.isError).toBe(true);
  cleanup();
});
