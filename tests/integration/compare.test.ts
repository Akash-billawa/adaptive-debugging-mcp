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

test("debug_candidate_compare: validates inputs and requires at least 2 candidates", async () => {
  const { catalog, cleanup } = ctx();

  const start = await call(catalog, "debug_case_start", {
    project: { display_name: "CompareApp" },
    title: "Test Case",
    initial_symptom: "App error",
    actor: "agent",
  });
  const incId = start.structured.incident_id;

  // 1 candidate only -> validation error
  const res1 = await call(catalog, "debug_candidate_compare", {
    incident_id: incId,
    proposed_candidates: [
      { title: "One", proposed_change: "Change 1", rationale: "Rationale 1" },
    ],
  });
  expect(res1.isError).toBe(true);

  // Missing required proposed_change
  const res2 = await call(catalog, "debug_candidate_compare", {
    incident_id: incId,
    proposed_candidates: [
      { title: "One", proposed_change: "Change 1", rationale: "Rationale 1" },
      { title: "Two", rationale: "Rationale 2" },
    ],
  });
  expect(res2.isError).toBe(true);

  cleanup();
});

test("debug_candidate_compare: compares existing experiments and proposed candidates", async () => {
  const { catalog, cleanup } = ctx();

  const start = await call(catalog, "debug_case_start", {
    project: { display_name: "CompareApp" },
    title: "Database Deadlock",
    initial_symptom: "Deadlock detected during transaction commit",
    actor: "agent",
  });
  const incId = start.structured.incident_id;

  // Create hypothesis
  const hyp = await call(catalog, "debug_hypothesis_manage", {
    incident_id: incId,
    op: "create_hypothesis",
    statement: "Table lock order is inverted in user update service",
    rationale: "Deadlock log shows resource cycle",
    actor: "agent",
  });
  const hypId = hyp.structured.hypothesis_id;

  // Create existing experiment
  const exp1 = await call(catalog, "debug_attempt_create", {
    incident_id: incId,
    node_kind: "experiment",
    title: "Sort table update operations by ID",
    proposed_change: "Apply primary key sorting before batch update",
    expected_observation: "No cycle in locks",
    hypothesis_id: hypId,
    risk_level: "low",
    actor: "agent",
  });
  const expId1 = exp1.structured.experiment_id;

  // Compare existing experiment with a proposed alternative
  const compareRes = await call(catalog, "debug_candidate_compare", {
    incident_id: incId,
    candidate_experiment_ids: [expId1],
    proposed_candidates: [
      {
        title: "Lower transaction isolation level to Read Committed",
        proposed_change: "Change session isolation from Serializable to Read Committed",
        rationale: "Reduces lock retention time",
        expected_observation: "Fewer deadlock retries",
        risk_level: "medium",
        hypothesis_id: hypId,
      },
    ],
  });

  expect(compareRes.isError).toBe(false);
  const data = compareRes.structured;
  expect(data.ok).toBe(true);
  expect(data.candidates_evaluated).toBe(2);
  expect(data.pairwise_comparisons.length).toBe(1);
  expect(data.pairwise_comparisons[0].shared_aspects.some((s: string) => s.includes("identical hypothesis"))).toBe(true);
  expect(data.recommended_order.length).toBe(2);

  cleanup();
});
