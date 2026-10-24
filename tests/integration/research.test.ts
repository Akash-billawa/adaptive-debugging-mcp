import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import * as path from "node:path";
import { tempDbPath, openStore, closeStore } from "./helpers.ts";
import { buildCatalog } from "../../src/server/catalog.ts";

const paths: string[] = [];
function ctx() {
  const p = tempDbPath();
  paths.push(p);
  const store = openStore(p);
  return { store, catalog: buildCatalog({ store, dbPath: p, log: () => {} }), cleanup: () => closeStore(store) };
}

afterAll(() => {
  for (const p of paths) {
    for (const s of ["", "-wal", "-shm"]) {
      try {
        rmSync(p + s, { force: true });
      } catch {}
    }
  }
});

async function call(catalog: any, name: string, args: Record<string, unknown>) {
  try {
    const res = await catalog.call(name, args);
    return { isError: res.isError, structured: res.structuredContent };
  } catch (e: any) {
    return { isError: true, category: e.category, message: e.message, structured: e };
  }
}

test("debug_research_plan: generates structured questions from incident and hypotheses", async () => {
  const { catalog, cleanup } = ctx();

  const start = await call(catalog, "debug_case_start", {
    project: { display_name: "ResearchApp" },
    title: "Pragma WAL checkpoint failed with SQLITE_BUSY",
    initial_symptom: "Unhandled SQLITE_BUSY error: database locked during migration",
    actor: "agent",
  });
  const incId = start.structured.incident_id;

  // Add a hypothesis
  await call(catalog, "debug_hypothesis_manage", {
    incident_id: incId,
    op: "create",
    statement: "Reader connection holds open lock preventing checkpoint",
    rationale: "Long-running query in background thread",
  });

  const planRes = await call(catalog, "debug_research_plan", { incident_id: incId });
  expect(planRes.isError).toBe(false);
  const plan = planRes.structured.plan;

  expect(plan.incident_id).toBe(incId);
  expect(plan.questions.length).toBeGreaterThan(0);
  expect(plan.recommended_sources.length).toBeGreaterThan(0);
  expect(plan.guidelines.length).toBeGreaterThan(0);

  cleanup();
});

test("debug_codebase_analyze: inspects manifests and records research references", async () => {
  const { catalog, store, cleanup } = ctx();

  const start = await call(catalog, "debug_case_start", {
    project: { display_name: "ResearchApp" },
    title: "Dependency version mismatch",
    initial_symptom: "Cannot find module '@modelcontextprotocol/sdk'",
    actor: "agent",
  });
  const incId = start.structured.incident_id;

  // 1. Analyze manifest versions without auto-record
  const res1 = await call(catalog, "debug_codebase_analyze", {
    incident_id: incId,
    analysis_type: "manifest_versions",
    repo_path: path.resolve(import.meta.dir, "../../"),
  });
  expect(res1.isError).toBe(false);
  expect(res1.structured.finding.analysis_type).toBe("manifest_versions");
  expect(res1.structured.finding.untrusted_data).toBe(true);
  expect(res1.structured.research_reference_id).toBeUndefined();

  // 2. Analyze with auto_record: true
  const res2 = await call(catalog, "debug_codebase_analyze", {
    incident_id: incId,
    analysis_type: "manifest_versions",
    repo_path: path.resolve(import.meta.dir, "../../"),
    auto_record: true,
    claim_supported_or_challenged: "Installed package.json contains root package name and dependencies",
  });
  expect(res2.isError).toBe(false);
  expect(res2.structured.research_reference_id).toBeDefined();

  // Verify it was stored in store.listResearch
  const refs = store.listResearch(incId);
  expect(refs.length).toBe(1);
  expect(refs[0].research_reference_id).toBe(res2.structured.research_reference_id);
  expect(refs[0].claim_supported_or_challenged).toContain("Installed package.json");

  cleanup();
});

test("debug_research_evaluate: evaluates sources and detects contradictions", async () => {
  const { catalog, cleanup } = ctx();

  const start = await call(catalog, "debug_case_start", {
    project: { display_name: "ResearchApp" },
    title: "Protocol version deprecation",
    initial_symptom: "Method 'notifications/initialized' rejected with error 400",
    actor: "agent",
  });
  const incId = start.structured.incident_id;

  const evalRes = await call(catalog, "debug_research_evaluate", {
    incident_id: incId,
    sources: [
      {
        source_title: "MCP Protocol Spec 2024-11-05",
        source_type: "official_docs",
        excerpt: "notifications/initialized is mandatory after initialize response.",
        claims: ["Mandatory notification after initialize"],
        claimed_version: "2024-11-05",
      },
      {
        source_title: "Old Blog Post",
        source_type: "community",
        excerpt: "notifications/initialized is optional and can be omitted.",
        claims: ["Optional notification"],
      },
    ],
  });

  expect(evalRes.isError).toBe(false);
  expect(evalRes.structured.evaluations.length).toBe(2);
  expect(evalRes.structured.ranked_order[0]).toBe("MCP Protocol Spec 2024-11-05");
  expect(evalRes.structured.evaluations[0].authority_score).toBeGreaterThan(0.9);

  cleanup();
});
