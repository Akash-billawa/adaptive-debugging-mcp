/**
 * Regression: debug_hypothesis_manage argument contract.
 *
 * Driven through the actual MCP tool interface (buildCatalog.call), not the
 * store, so the published input schema, the handler, the arg extraction and the
 * error mapping are all exercised the way a real client is.
 *
 * Background (incident: agents sending `hypothesis` / `testable_claim`):
 * the canonical field has always been `statement` — matching the store method,
 * the `Hypothesis` type and the `hypotheses.statement` column. The published
 * schema marked only `op` + `incident_id` as required, so `statement`'s
 * requiredness was invisible until runtime and agents guessed semantically
 * plausible names. The contract now (a) documents per-op required fields in the
 * tool description, (b) accepts the two attested aliases for backward
 * compatibility while preferring the canonical name, and (c) discloses when an
 * alias supplied the text.
 */
import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tempDbPath, openStore, closeStore } from "./helpers.ts";
import { buildCatalog, ALL_TOOLS } from "../../src/server/catalog.ts";

const paths: string[] = [];
function ctx() {
  const p = tempDbPath();
  paths.push(p);
  const store = openStore(p);
  return {
    store,
    catalog: buildCatalog({ store, dbPath: p, log: () => {} }),
    cleanup: () => closeStore(store),
  };
}
afterAll(() => {
  for (const p of paths) {
    for (const s of ["", "-wal", "-shm"]) {
      try { rmSync(p + s, { force: true }); } catch {}
    }
  }
});

async function call(catalog: any, name: string, args: Record<string, unknown>) {
  try {
    const res = await catalog.call(name, args);
    return { isError: res.isError === true, structured: res.structuredContent as any };
  } catch (e: any) {
    return { isError: true, category: e.category ?? "INTERNAL_ERROR", message: e.message as string };
  }
}

async function incidentId(catalog: any): Promise<string> {
  const start = await call(catalog, "debug_case_start", {
    project: { display_name: "HypContract", project_id: "prj_hyp" },
    title: "hypothesis contract regression",
    initial_symptom: "synthetic",
    actor: "agent",
  });
  expect(start.isError).toBe(false);
  return start.structured.incident_id as string;
}

// --- 1. Canonical name still works and is the preferred path ------------------
test("create_hypothesis with canonical `statement` succeeds and records the claim verbatim", async () => {
  const { catalog, store, cleanup } = ctx();
  const incId = await incidentId(catalog);
  const claim = "The request body is undefined because the body parser is not mounted";
  const res = await call(catalog, "debug_hypothesis_manage", {
    op: "create_hypothesis",
    incident_id: incId,
    statement: claim,
    rationale: "the 500 points at parse() on undefined",
    actor: "agent",
  });
  expect(res.isError).toBe(false);
  expect(res.structured.ok).toBe(true);
  expect(typeof res.structured.hypothesis_id).toBe("string");
  // No shim disclosure on the canonical path.
  expect(res.structured.statement_normalized_from).toBeUndefined();
  // The testable claim is preserved verbatim in the store.
  const stored = store.getHypothesis(res.structured.hypothesis_id);
  expect(stored?.statement).toBe(claim);
  expect(stored?.status).toBe("proposed");
  cleanup();
});

// --- 2. The exact failure that was reported: aliases instead of `statement` ---
test("create_hypothesis accepts the attested aliases `hypothesis` and `testable_claim`, disclosing the normalization", async () => {
  const { catalog, store, cleanup } = ctx();
  const incId = await incidentId(catalog);

  const viaHypothesis = await call(catalog, "debug_hypothesis_manage", {
    op: "create_hypothesis",
    incident_id: incId,
    hypothesis: "Cache TTL expiry races with token refresh",
    rationale: "errors cluster exactly at the refresh boundary",
    actor: "agent",
  });
  expect(viaHypothesis.isError).toBe(false);
  expect(viaHypothesis.structured.ok).toBe(true);
  expect(viaHypothesis.structured.statement_normalized_from).toBe("hypothesis");
  expect(store.getHypothesis(viaHypothesis.structured.hypothesis_id)?.statement).toBe(
    "Cache TTL expiry races with token refresh",
  );

  const viaClaim = await call(catalog, "debug_hypothesis_manage", {
    op: "create_hypothesis",
    incident_id: incId,
    testable_claim: "Retrying the same request twice doubles the failure rate",
    rationale: "two observed samples both failed on retry",
    actor: "agent",
  });
  expect(viaClaim.isError).toBe(false);
  expect(viaClaim.structured.statement_normalized_from).toBe("testable_claim");
  expect(store.getHypothesis(viaClaim.structured.hypothesis_id)?.statement).toBe(
    "Retrying the same request twice doubles the failure rate",
  );
  cleanup();
});

// --- 3. Canonical name wins over aliases when several are supplied ------------
test("when both `statement` and an alias are supplied, the canonical `statement` wins", async () => {
  const { catalog, store, cleanup } = ctx();
  const incId = await incidentId(catalog);
  const res = await call(catalog, "debug_hypothesis_manage", {
    op: "create_hypothesis",
    incident_id: incId,
    statement: "CANONICAL: the migration ran before the index existed",
    hypothesis: "ALIAS-VALUE: must not be stored",
    testable_claim: "ALIAS-VALUE-2: must not be stored either",
    rationale: "schema order says the index is created after the migration",
    actor: "agent",
  });
  expect(res.isError).toBe(false);
  expect(res.structured.statement_normalized_from).toBeUndefined();
  expect(store.getHypothesis(res.structured.hypothesis_id)?.statement).toBe(
    "CANONICAL: the migration ran before the index existed",
  );
  cleanup();
});

// --- 4. Missing-field errors --------------------------------------------------
test("create_hypothesis without any statement/alias returns a self-describing VALIDATION_ERROR", async () => {
  const { catalog, cleanup } = ctx();
  const incId = await incidentId(catalog);
  const res = await call(catalog, "debug_hypothesis_manage", {
    op: "create_hypothesis",
    incident_id: incId,
    rationale: "rationale alone is not enough",
    actor: "agent",
  });
  expect(res.isError).toBe(true);
  expect(res.category).toBe("VALIDATION_ERROR");
  // The message must name the canonical field and the accepted aliases so an
  // agent can self-correct from the error alone.
  expect(res.message).toContain("statement");
  expect(res.message).toContain("testable_claim");
  expect(res.message).toContain("hypothesis");
  cleanup();
});

test("empty-string statement (and empty aliases) is rejected, not silently accepted", async () => {
  const { catalog, cleanup } = ctx();
  const incId = await incidentId(catalog);
  const res = await call(catalog, "debug_hypothesis_manage", {
    op: "create_hypothesis",
    incident_id: incId,
    statement: "",
    hypothesis: "",
    testable_claim: "",
    rationale: "r",
    actor: "agent",
  });
  expect(res.isError).toBe(true);
  expect(res.category).toBe("VALIDATION_ERROR");
  cleanup();
});

test("missing rationale still fails even when a statement alias is accepted", async () => {
  const { catalog, cleanup } = ctx();
  const incId = await incidentId(catalog);
  const res = await call(catalog, "debug_hypothesis_manage", {
    op: "create_hypothesis",
    incident_id: incId,
    testable_claim: "a claim without a rationale",
    actor: "agent",
  });
  expect(res.isError).toBe(true);
  expect(res.category).toBe("VALIDATION_ERROR");
  expect(res.message).toContain("rationale");
  cleanup();
});

// --- 5. The published schema reflects the contract ----------------------------
test("the published input schema documents per-op required fields and the aliases", () => {
  const def = ALL_TOOLS.find((t) => t.def.name === "debug_hypothesis_manage")?.def;
  expect(def).not.toBeUndefined();
  expect(def!.description).toContain("create_hypothesis: statement");
  const schema = def!.inputSchema as any;
  expect(schema.required).toEqual(["op", "incident_id"]);
  expect(schema.properties.statement.description).toContain("testable claim");
  expect(schema.properties.statement.description).toContain("testable_claim");
  expect(schema.properties.rationale.description).toContain("Required for op=create_hypothesis");
});

// --- 6. The other ops are unaffected by the shim ------------------------------
test("update_hypothesis_status still requires id + status + rationale and ignores the aliases", async () => {
  const { catalog, cleanup } = ctx();
  const incId = await incidentId(catalog);
  const created = await call(catalog, "debug_hypothesis_manage", {
    op: "create_hypothesis",
    incident_id: incId,
    statement: "original claim",
    rationale: "r",
    actor: "agent",
  });
  expect(created.isError).toBe(false);
  const updated = await call(catalog, "debug_hypothesis_manage", {
    op: "update_hypothesis_status",
    incident_id: incId,
    id: created.structured.hypothesis_id,
    status: "supported",
    rationale: "evidence backs it",
    actor: "agent",
  });
  expect(updated.isError).toBe(false);
  expect(updated.structured.status).toBe("supported");
  // Aliases must not leak into update semantics.
  const badUpdate = await call(catalog, "debug_hypothesis_manage", {
    op: "update_hypothesis_status",
    incident_id: incId,
    hypothesis: "not a valid update field",
    status: "rejected",
    rationale: "r",
    actor: "agent",
  });
  expect(badUpdate.isError).toBe(true);
  expect(badUpdate.category).toBe("VALIDATION_ERROR");
  cleanup();
});
