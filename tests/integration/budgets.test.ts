import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tempDbPath, openStore, closeStore } from "./helpers.ts";
import type { Store } from "../../src/memory/store.ts";
import { McpError } from "../../src/errors.ts";
import { listTimeline } from "../../src/memory/audit.ts";
import { buildCatalog } from "../../src/server/catalog.ts";

const paths: string[] = [];
afterAll(() => {
  for (const p of paths) for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s, { force: true }); } catch { /* ignore */ } }
});

function newStore(): Store {
  return openStore(":memory:");
}
function seedIncident(store: Store, projectId = "prj_b") {
  return store.createIncident({
    project: { display_name: "BudgetApp", project_id: projectId },
    title: "t",
    initial_symptom: "s",
    actor: "agent",
  }).incident;
}
function exp(store: Store, incidentId: string, over: Record<string, unknown> = {}) {
  return store.createExperiment({
    incident_id: incidentId,
    node_kind: (over.node_kind as string) ?? "experiment",
    title: (over.title as string) ?? "attempt",
    parent_experiment_id: (over.parent_experiment_id as string) ?? null,
    hypothesis_id: (over.hypothesis_id as string) ?? null,
    reason_for_difference: (over.reason_for_difference as string) ?? null,
    expected_observation: "o",
    risk_level: (over.risk_level as string) ?? "low",
    actor: "agent",
  });
}

async function callTool(s: Store, name: string, args: Record<string, unknown>) {
  const catalog = buildCatalog({ store: s, dbPath: ":memory:", log: () => {} });
  try {
    const res = await catalog.call(name, args);
    return { isError: false, structured: res.structuredContent as any };
  } catch (e: any) {
    return { isError: true, category: (e?.category ?? "INTERNAL_ERROR") as string, structured: { ok: false, error: { category: e?.category, message: e?.message, details: e?.details } } };
  }
}

test("family budget enforced at creation; near-limit warning; override raises it", () => {
  const store = newStore();
  const inc = seedIncident(store);
  const strat = exp(store, inc.incident_id, { node_kind: "strategy", title: "family A" }).experiment;
  const r1 = exp(store, inc.incident_id, { parent_experiment_id: strat.experiment_id, title: "A1" });
  const r2 = exp(store, inc.incident_id, { parent_experiment_id: strat.experiment_id, title: "A2" });
  expect(r1.budgetWarnings.length).toBe(0);
  expect(r2.budgetWarnings.length).toBe(0); // family at 1/3 — no warning yet
  const r3 = exp(store, inc.incident_id, { parent_experiment_id: strat.experiment_id, title: "A3" });
  // Creating the 3rd attempt (family count already 2/3) warned:
  expect(r3.budgetWarnings.some((w) => w.includes("approaching family budget"))).toBe(true);
  expect(r3.experiment.outcome_status).toBe("pending");
  // 4th attempt in the same family -> hard LIMIT_EXCEEDED with machine-readable details
  let err: McpError | null = null;
  try {
    exp(store, inc.incident_id, { parent_experiment_id: strat.experiment_id, title: "A4" });
  } catch (e) {
    err = e as McpError;
  }
  expect(err).not.toBeNull();
  expect((err as McpError)!.category).toBe("LIMIT_EXCEEDED");
  expect((err as McpError)!.message).toContain("family budget");
  expect((err as McpError)!.details).toMatchObject({ limit_name: "max_experiments_per_family", limit: 3, current: 3 });
  // Raising the per-incident budget resumes the investigation (recorded)
  store.setBudgetConfig({ scope: "incident", project_id: inc.project_id, incident_id: inc.incident_id, config: { max_experiments_per_family: 5 }, actor: "user", rationale: "user raised family budget" });
  const r4 = exp(store, inc.incident_id, { parent_experiment_id: strat.experiment_id, title: "A4" });
  expect(r4.experiment.display_label).toBe("A4");
  // The change is in the audit timeline
  expect(listTimeline(store.db, inc.incident_id).some((e) => e.event_type === "budget.updated")).toBe(true);
});

test("project default applies to new incidents; incident override wins", () => {
  const store = newStore();
  store.setBudgetConfig({ scope: "project", project_id: "prj_b", incident_id: null, config: { max_experiments_per_family: 2 }, actor: "user", rationale: "tighter default" });
  const inc = seedIncident(store);
  const strat = exp(store, inc.incident_id, { node_kind: "strategy", title: "A" }).experiment;
  exp(store, inc.incident_id, { parent_experiment_id: strat.experiment_id, title: "A1" });
  exp(store, inc.incident_id, { parent_experiment_id: strat.experiment_id, title: "A2" });
  expect(() => exp(store, inc.incident_id, { parent_experiment_id: strat.experiment_id, title: "A3" })).toThrow();
  // Effective config snapshots the incident's budget at creation (audit trail)
  const snap = listTimeline(store.db, inc.incident_id).find((e) => e.event_type === "budget.snapshot");
  expect(snap).toBeDefined();
  const snapConfig = JSON.parse(snap!.details as string).budget as Record<string, unknown>;
  expect(snapConfig.max_experiments_per_family).toBe(2); // project default captured
  // Per-incident override beats the project default
  store.setBudgetConfig({ scope: "incident", project_id: inc.project_id, incident_id: inc.incident_id, config: { max_experiments_per_family: 4 }, actor: "user" });
  exp(store, inc.incident_id, { parent_experiment_id: strat.experiment_id, title: "A3" });
  // Clearing the override falls back to the project default again
  store.clearIncidentBudgetOverride(inc.incident_id, "user", "restore default");
  expect(() => exp(store, inc.incident_id, { parent_experiment_id: strat.experiment_id, title: "A4" })).toThrow();
  expect(store.resolveBudgetConfig(inc.project_id, inc.incident_id).max_experiments_per_family).toBe(2);
});

test("variant budgets: per-parent limit and refinement depth are enforced", () => {
  const store = newStore();
  const inc = seedIncident(store);
  store.setBudgetConfig({ scope: "incident", project_id: inc.project_id, incident_id: inc.incident_id, config: { max_experiments_per_family: 20 }, actor: "agent", rationale: "depth test needs family room" });
  const parent = exp(store, inc.incident_id, { title: "P" }).experiment;
  const variants: string[] = [];
  for (const t of ["v1", "v2", "v3"]) {
    const r = exp(store, inc.incident_id, { node_kind: "variant", parent_experiment_id: parent.experiment_id, title: t, reason_for_difference: "changed condition " + t });
    variants.push(r.experiment.experiment_id);
  }
  // 4th variant under the same parent -> max_variants_per_parent
  let err: McpError | null = null;
  try { exp(store, inc.incident_id, { node_kind: "variant", parent_experiment_id: parent.experiment_id, title: "v4", reason_for_difference: "x" }); } catch (e) { err = e as McpError; }
  expect(err?.category).toBe("LIMIT_EXCEEDED");
  expect(err?.details).toMatchObject({ limit_name: "max_variants_per_parent" });

  // Deeper refinement chain from v3: level 2, level 3 ok; a 4th level is blocked
  const c2 = exp(store, inc.incident_id, { node_kind: "variant", parent_experiment_id: variants[2], title: "chain2", reason_for_difference: "level 2" }).experiment;
  const c3 = exp(store, inc.incident_id, { node_kind: "variant", parent_experiment_id: c2.experiment_id, title: "chain3", reason_for_difference: "level 3" }).experiment;
  expect(c3.display_label).toBeTruthy();
  let depthErr: McpError | null = null;
  try { exp(store, inc.incident_id, { node_kind: "variant", parent_experiment_id: c3.experiment_id, title: "chain4", reason_for_difference: "level 4" }); } catch (e) { depthErr = e as McpError; }
  expect(depthErr?.details).toMatchObject({ limit_name: "max_refinement_depth" });
});

test("total investigation budget enforced across families", () => {
  const store = newStore();
  const inc = seedIncident(store);
  store.setBudgetConfig({ scope: "incident", project_id: inc.project_id, incident_id: inc.incident_id, config: { max_total_experiments: 3 }, actor: "agent" });
  exp(store, inc.incident_id, { title: "r1" });
  exp(store, inc.incident_id, { title: "r2" });
  exp(store, inc.incident_id, { title: "r3" });
  let err: McpError | null = null;
  try { exp(store, inc.incident_id, { title: "r4" }); } catch (e) { err = e as McpError; }
  expect(err?.details).toMatchObject({ limit_name: "max_total_experiments", current: 3 });
});

test("LIMIT_EXCEEDED surfaces as a machine-readable MCP error category", async () => {
  const store = newStore();
  const inc = seedIncident(store);
  store.setBudgetConfig({ scope: "incident", project_id: inc.project_id, incident_id: inc.incident_id, config: { max_total_experiments: 1 }, actor: "agent" });
  const okRes = await callTool(store, "debug_attempt_create", { incident_id: inc.incident_id, node_kind: "experiment", title: "one", expected_observation: "o", risk_level: "low", actor: "agent" });
  expect(okRes.isError).toBe(false);
  expect(okRes.structured.budget_warnings).toEqual([]);
  const badRes = await callTool(store, "debug_attempt_create", { incident_id: inc.incident_id, node_kind: "experiment", title: "two", expected_observation: "o", risk_level: "low", actor: "agent" });
  expect(badRes.isError).toBe(true);
  expect(badRes.category).toBe("LIMIT_EXCEEDED");
  expect((badRes.structured.error.details as any).limit_name).toBe("max_total_experiments");
  // No partially created experiment: the blocked create rolled back cleanly
  expect(store.allExperiments(inc.incident_id).length).toBe(1);
});

test("budget tools round-trip: get shows config, usage, and next-experiment probe", async () => {
  const store = newStore();
  const inc = seedIncident(store);
  const catalog = buildCatalog({ store, dbPath: ":memory:", log: () => {} });
  const res = await catalog.call("debug_budget_manage", { op: "get", incident_id: inc.incident_id });
  const data = res.structuredContent as any;
  expect(data.ok).toBe(true);
  expect(data.config.max_total_experiments).toBe(25);
  expect(data.usage.total_experiments).toBe(0);
  expect(data.next_experiment_blocked).toBeNull();
  expect(data.note).toContain("NOT enforced");
  const setRes = await catalog.call("debug_budget_manage", { op: "set_incident_override", incident_id: inc.incident_id, config: { max_total_experiments: 2 }, rationale: "test", actor: "user" });
  expect((setRes.structuredContent as any).config.max_total_experiments).toBe(2);
  const get2 = (await catalog.call("debug_budget_manage", { op: "get", incident_id: inc.incident_id })).structuredContent as any;
  expect(get2.usage.total_experiments).toBe(0);
  expect(get2.next_experiment_blocked).toBeNull(); // 0 < 2, next experiment allowed
  const bad = await callTool(store, "debug_budget_manage", { op: "set_incident_override", incident_id: inc.incident_id, config: { max_total_experiments: 0 }, actor: "user" });
  expect(bad.isError).toBe(true); // invalid patch rejected
});

test("migration v2 -> v3 is additive and preserves records across restarts", () => {
  const p = tempDbPath(); paths.push(p);
  let incidentId = "";
  // Phase 1: create v2-era state (records present, no budgets table)
  {
    const store = openStore(p);
    const inc = seedIncident(store, "prj_m");
    incidentId = inc.incident_id;
    exp(store, incidentId, { title: "legacy attempt" });
    store.db.run("DROP TABLE budgets"); // simulate pre-v3 database
    store.db.query("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version','2')").run();
    closeStore(store);
  }
  // Phase 2: reopen -> v3 migration must apply and preserve everything
  {
    const store = openStore(p);
    const inc = store.getIncidentOrFail(incidentId);
    expect(inc.title).toBe("t");
    expect(store.allExperiments(incidentId).length).toBe(1);
    const hasBudgets = store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='budgets'").get();
    expect(!!hasBudgets).toBe(true);
    expect(Number((store.db.query("SELECT value FROM meta WHERE key='schema_version'").get() as any).value)).toBeGreaterThanOrEqual(3);
    // Budget rows now persist across restarts
    store.setBudgetConfig({ scope: "project", project_id: "prj_m", incident_id: null, config: { max_total_experiments: 10 }, actor: "user" });
    closeStore(store);
  }
  // Phase 3: another restart -> no re-migration, budget row survives, records intact
  {
    const store = openStore(p);
    expect(Number((store.db.query("SELECT value FROM meta WHERE key='schema_version'").get() as any).value)).toBeGreaterThanOrEqual(3);
    expect(store.getProjectBudgetDefault("prj_m").max_total_experiments).toBe(10);
    expect(store.allExperiments(incidentId).length).toBe(1);
    closeStore(store);
  }
});
