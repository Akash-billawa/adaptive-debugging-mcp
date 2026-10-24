import { describe, it, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tempDbPath, openStore, closeStore } from "../integration/helpers.ts";
import {
  indexIncidentEmbedding,
  indexExperimentEmbedding,
  searchSemantic,
  syncAllEmbeddings,
} from "../../src/retrieval/semantic.ts";

const paths: string[] = [];
function createTestStore() {
  const p = tempDbPath();
  paths.push(p);
  const store = openStore(p);
  return { store, cleanup: () => closeStore(store) };
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

describe("semantic embedding retrieval", () => {
  it("indexes incident and finds it via dense similarity search", () => {
    const { store, cleanup } = createTestStore();

    const { incident } = store.createIncident({
      project: { display_name: "SemanticTest" },
      title: "Concurrent database write deadlock",
      initial_symptom: "SQLiteError: database is locked when running worker thread",
      actor: "agent",
    });

    // Embedding should be automatically created or indexable
    indexIncidentEmbedding(store, incident);

    const hits = searchSemantic(store, "database lock concurrency error", {
      minSimilarity: 0.3,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].entity_id).toBe(incident.incident_id);
    expect(hits[0].similarity).toBeGreaterThan(0.4);

    cleanup();
  });

  it("syncAllEmbeddings: indexes any unindexed records in batch", () => {
    const { store, cleanup } = createTestStore();

    // Create incident and experiment
    const { incident } = store.createIncident({
      project: { display_name: "SyncTest" },
      title: "Out of memory crash",
      initial_symptom: "Process killed: OOM killer triggered",
      actor: "agent",
    });

    store.createExperiment({
      incident_id: incident.incident_id,
      title: "Reduce heap limit",
      proposed_change: "--max-old-space-size=512",
      expected_observation: "Memory stays bounded",
      node_kind: "experiment",
      actor: "agent",
    });

    // Clear embeddings table
    store.db.run("DELETE FROM embeddings");

    const syncRes = syncAllEmbeddings(store);
    expect(syncRes.indexed_incidents).toBe(1);
    expect(syncRes.indexed_experiments).toBe(1);
    expect(syncRes.total_embeddings).toBe(2);

    cleanup();
  });
});
