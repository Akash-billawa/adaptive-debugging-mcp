import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tempDbPath, openStore, closeStore } from "./helpers.ts";
import { buildCatalog } from "../../src/server/catalog.ts";
import { readSchemaVersion } from "../../src/memory/schema.ts";

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

test("migration v4: creates embeddings table and advances schema version to 4", () => {
  const { store, cleanup } = ctx();
  const v = readSchemaVersion(store.db);
  expect(v).toBe(4);

  // Check table exists
  const table = store.db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'")
    .get() as { name: string } | null;
  expect(table?.name).toBe("embeddings");

  cleanup();
});

test("hybrid search: retrieves past cases via semantic similarity when vocabulary varies", async () => {
  const { catalog, cleanup } = ctx();

  // Create incident about network socket disconnect
  const start = await call(catalog, "debug_case_start", {
    project: { display_name: "NetworkService" },
    title: "Socket connection aborted unexpectedly",
    initial_symptom: "TCP socket closed with ECONNRESET during stream transfer",
    actor: "agent",
  });
  const incId = start.structured.incident_id;

  // Search with paraphrased vocabulary: "network stream connection dropped"
  const searchRes = await call(catalog, "debug_history_search", {
    query: "network stream connection dropped",
    semantic: true,
  });

  expect(searchRes.isError).toBe(false);
  expect(searchRes.structured.match_count).toBeGreaterThan(0);

  const hit = searchRes.structured.results.find((r: any) => r.incident_id === incId);
  expect(hit).toBeDefined();
  expect(hit.matched_via).toContain("semantic_similarity");
  expect(hit.explanation).toContain("semantic vector similarity");

  cleanup();
});

test("debug_semantic_index: synchronizes embeddings and reports accurate statistics", async () => {
  const { catalog, cleanup } = ctx();

  await call(catalog, "debug_case_start", {
    project: { display_name: "IndexService" },
    title: "Test indexing incident",
    initial_symptom: "Test symptom",
    actor: "agent",
  });

  const indexRes = await call(catalog, "debug_semantic_index", { reindex_all: true });
  expect(indexRes.isError).toBe(false);
  expect(indexRes.structured.ok).toBe(true);
  expect(indexRes.structured.stats.total_embeddings).toBeGreaterThan(0);
  expect(indexRes.structured.stats.dimension).toBe(256);

  cleanup();
});
