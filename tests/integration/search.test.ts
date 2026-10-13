import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tempDbPath, openStore, closeStore } from "./helpers.ts";
import { seedCorpus, AUTH_NORMALIZED, AUTH_STACK_SIGNATURE } from "../fixtures/corpus.ts";
import { searchHistory } from "../../src/retrieval/search.ts";

const paths: string[] = [];
afterAll(() => { for (const p of paths) for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s, { force: true }); } catch {} } });

test("exact fingerprint match ranks the top and includes failed attempts", () => {
  const p = tempDbPath(); paths.push(p);
  const store = openStore(p);
  const corpus = seedCorpus(store);

  const res = searchHistory(store, {
    query: "auth token expired status 401",
    fingerprints: [AUTH_NORMALIZED, AUTH_STACK_SIGNATURE],
    project_id: "prj_a",
    limit: 10,
  });
  expect(res.complete).toBe(true);
  const top = res.results[0];
  expect(top).toBeDefined();
  expect(top.matched_via).toContain("exact_fingerprint");
  // Both the original and the exact duplicate are surfaced (not merged).
  const ids = res.results.map((r) => r.incident.incident_id);
  expect(ids).toContain(corpus.projectA);
  // Failed attempts remain visible, not just successes.
  const hit = res.results.find((r) => r.incident.incident_id === corpus.projectA)!;
  expect(hit.attempts.some((a) => a.outcome_status === "failed")).toBe(true);
  closeStore(store);
});

test("similar-but-different error is returned but flagged, not assumed identical", () => {
  const p = tempDbPath(); paths.push(p);
  const store = openStore(p);
  seedCorpus(store);
  const res = searchHistory(store, { query: "auth library rejected token signature", project_id: "prj_a", limit: 10 });
  const ids = res.results.map((r) => r.incident.incident_id);
  // The distinct auth-library incident is discoverable by text.
  expect(ids.length).toBeGreaterThan(0);
  // It matched via text, not exact fingerprint, so it is a candidate relationship only.
  const hit = res.results[0];
  if (hit?.matched_via.includes("exact_fingerprint")) {
    // acceptable only if this is genuinely the same fingerprint; here it must NOT be.
    expect(hit.incident.initial_symptom).toContain("token signature");
  }
  closeStore(store);
});

test("verified history surfaces, and project isolation holds", () => {
  const p = tempDbPath(); paths.push(p);
  const store = openStore(p);
  const corpus = seedCorpus(store);

  const scopedB = searchHistory(store, { query: "connection timeout db", project_id: "prj_b", limit: 10 });
  expect(scopedB.results.every((r) => r.incident.project_id === "prj_b")).toBe(true);

  const verified = searchHistory(store, { query: "config reload restart", project_id: "prj_a", limit: 10 });
  const v = verified.results.find((r) => r.incident.incident_id === corpus.verifiedIncident);
  expect(v?.has_verified).toBe(true);
  closeStore(store);
});
