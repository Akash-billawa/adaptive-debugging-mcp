import { describe, it, expect } from "bun:test";
import { evaluateSources } from "../../src/research/evaluator.ts";
import type { Incident } from "../../src/types.ts";
import type { CandidateSourceInput, ResearchEnvironment } from "../../src/research/types.ts";

describe("research evaluator", () => {
  const dummyIncident: Incident = {
    incident_id: "inc_eval1",
    project_id: "proj_1",
    title: "Pragma wal_checkpoint fails with SQLITE_BUSY",
    initial_symptom: "Checkpoint failed: SQLITE_BUSY: database is locked during concurrent write",
    status: "investigating",
    reproduction_status: "reproduced",
    acceptance_criteria: "Checkpoint returns 0 busy frames",
    first_observed_at: "2026-10-24T12:00:00Z",
    severity: "high",
    resolution_experiment_id: null,
    resolved_at: null,
    summary_current: null,
    created_at: "2026-10-24T12:00:00Z",
    updated_at: "2026-10-24T12:00:00Z",
  };

  const env: ResearchEnvironment = {
    runtime_name: "sqlite",
    runtime_version: "3.45.0",
  };

  it("ranks official documentation higher than secondary forum posts", () => {
    const sources: CandidateSourceInput[] = [
      {
        source_title: "Random Blog Post",
        source_type: "community",
        excerpt: "I had SQLITE_BUSY during checkpoint and just restarted the server.",
        claims: ["Restart server to clear locks"],
      },
      {
        source_title: "SQLite Official Documentation: WAL Mode",
        source_type: "official_docs",
        excerpt: "WAL mode allows concurrent readers and writers. SQLITE_BUSY occurs if a reader holds an active transaction during checkpoint.",
        claimed_version: "3.45.0",
        claims: ["Active reader blocks TRUNCATE checkpoint with SQLITE_BUSY"],
      },
    ];

    const result = evaluateSources(sources, dummyIncident, env);

    expect(result.evaluations.length).toBe(2);
    expect(result.ranked_order[0]).toBe("SQLite Official Documentation: WAL Mode");

    const officialEval = result.evaluations.find(
      (e) => e.source_title === "SQLite Official Documentation: WAL Mode",
    );
    expect(officialEval).toBeDefined();
    expect(officialEval!.overall_quality).toBeGreaterThan(0.7);
    expect(officialEval!.verdict).toBe("highly_relevant");
  });

  it("penalizes major version mismatches", () => {
    const sources: CandidateSourceInput[] = [
      {
        source_title: "Ancient SQLite 2.x Guide",
        source_type: "official_docs",
        excerpt: "Checkpoint locks database completely.",
        claimed_version: "2.8.0",
        claims: ["Checkpoint locks whole database"],
      },
    ];

    const result = evaluateSources(sources, dummyIncident, env);
    const evalResult = result.evaluations[0];
    expect(evalResult.version_match_score).toBe(0.2);
    expect(evalResult.reasons.some((r) => r.includes("Major version mismatch"))).toBe(true);
  });

  it("detects contradictions between competing sources", () => {
    const sources: CandidateSourceInput[] = [
      {
        source_title: "Doc A: Migration Guide",
        source_type: "official_docs",
        excerpt: "PRAGMA journal_mode=WAL is deprecated in our fork.",
        claims: ["WAL mode is deprecated"],
      },
      {
        source_title: "Doc B: Best Practices",
        source_type: "official_docs",
        excerpt: "PRAGMA journal_mode=WAL is supported and recommended for all high-concurrency workloads.",
        claims: ["WAL mode is supported and recommended"],
      },
    ];

    const result = evaluateSources(sources, dummyIncident, env);
    expect(result.detected_conflicts.length).toBeGreaterThan(0);
    expect(result.detected_conflicts[0]).toContain("Potential contradiction");
    expect(result.detected_conflicts[0]).toContain("Doc A: Migration Guide");
    expect(result.detected_conflicts[0]).toContain("Doc B: Best Practices");
  });
});
