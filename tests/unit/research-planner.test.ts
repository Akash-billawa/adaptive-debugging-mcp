import { describe, it, expect } from "bun:test";
import { planResearch } from "../../src/research/planner.ts";
import type { Incident, Hypothesis, Experiment } from "../../src/types.ts";
import type { ResearchEnvironment } from "../../src/research/types.ts";

describe("research planner", () => {
  const dummyIncident: Incident = {
    incident_id: "inc_test123",
    project_id: "proj_1",
    title: "Database connection failed with SQLiteError",
    initial_symptom: "Unhandled SQLiteError: database is locked when running migrations",
    status: "investigating",
    reproduction_status: "reproduced",
    acceptance_criteria: "Migration script completes with exit code 0",
    first_observed_at: "2026-10-24T12:00:00Z",
    severity: "high",
    resolution_experiment_id: null,
    resolved_at: null,
    summary_current: null,
    created_at: "2026-10-24T12:00:00Z",
    updated_at: "2026-10-24T12:00:00Z",
  };

  it("extracts error tokens and creates error_signature research questions", () => {
    const plan = planResearch(dummyIncident, [], []);

    expect(plan.incident_id).toBe("inc_test123");
    expect(plan.questions.length).toBeGreaterThan(0);

    const errQ = plan.questions.find((q) => q.query_type === "error_signature");
    expect(errQ).toBeDefined();
    expect(errQ!.target_entity).toBe("SQLiteError");
    expect(errQ!.recommended_source).toBe("official_docs");
    expect(plan.recommended_sources).toContain("official_docs");
  });

  it("decomposes live hypotheses into targeted research questions", () => {
    const hypotheses = [
      {
        hypothesis_id: "hyp_1",
        incident_id: "inc_test123",
        statement: "WAL mode is not configured, causing concurrency locks",
        status: "proposed",
        rationale: "Default journal mode is DELETE",
        created_at: "2026-10-24T12:00:00Z",
        updated_at: "2026-10-24T12:00:00Z",
      },
    ] as unknown as Hypothesis[];

    const plan = planResearch(dummyIncident, hypotheses, []);
    expect(plan.unresolved_hypotheses_count).toBe(1);

    const hypQ = plan.questions.find((q) => q.query_type === "compatibility_constraint");
    expect(hypQ).toBeDefined();
    expect(hypQ!.target_entity).toBe("hyp_1");
    expect(hypQ!.priority).toBe("high");
  });

  it("adds version check question when runtime environment is specified", () => {
    const env: ResearchEnvironment = {
      runtime_name: "bun",
      runtime_version: "1.3.0",
    };

    const plan = planResearch(dummyIncident, [], [], env);
    const verQ = plan.questions.find((q) => q.query_type === "version_check");
    expect(verQ).toBeDefined();
    expect(verQ!.target_entity).toBe("bun@1.3.0");
    expect(verQ!.recommended_source).toBe("changelog");
  });

  it("adds recent regression question when 2+ attempts failed", () => {
    const attempts = [
      {
        experiment_id: "exp_1",
        incident_id: "inc_test123",
        parent_experiment_id: null,
        display_label: "A1",
        node_kind: "experiment",
        title: "Retry with timeout",
        execution_status: "completed",
        outcome_status: "failed",
        created_at: "2026-10-24T12:05:00Z",
        updated_at: "2026-10-24T12:06:00Z",
      },
      {
        experiment_id: "exp_2",
        incident_id: "inc_test123",
        parent_experiment_id: "exp_1",
        display_label: "A1A",
        node_kind: "variant",
        title: "Retry with busy handler",
        execution_status: "completed",
        outcome_status: "failed",
        created_at: "2026-10-24T12:07:00Z",
        updated_at: "2026-10-24T12:08:00Z",
      },
    ] as unknown as Experiment[];

    const plan = planResearch(dummyIncident, [], attempts);
    const regQ = plan.questions.find((q) => q.query_type === "recent_regression");
    expect(regQ).toBeDefined();
    expect(regQ!.priority).toBe("high");
    expect(regQ!.rationale).toContain("2 fix attempts failed");
  });
});
