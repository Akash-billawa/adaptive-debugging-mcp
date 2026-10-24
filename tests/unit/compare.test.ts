import { test, expect } from "bun:test";
import { compareCandidatesEngine, type NormalizedCandidateInput } from "../../src/engine/compare.ts";
import type { Incident, Experiment, Hypothesis, ResearchReference, Evidence } from "../../src/types.ts";

function createMockIncident(): Incident {
  return {
    incident_id: "inc_test1",
    project_id: "prj_test1",
    title: "Connection pool exhaustion",
    initial_symptom: "Timeout waiting for available connection",
    first_observed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "open",
    severity: "high",
    reproduction_status: "reproduced",
    resolution_experiment_id: null,
    resolved_at: null,
    summary_current: null,
    acceptance_criteria: "Under 100 concurrent requests, zero connection timeouts",
  };
}

test("compareCandidatesEngine: compares 2 distinct candidate proposals with explainable factors", () => {
  const incident = createMockIncident();
  const hyp1: Hypothesis = {
    hypothesis_id: "hyp_1",
    incident_id: incident.incident_id,
    parent_hypothesis_id: null,
    statement: "Pool size is too small for concurrent burst load",
    rationale: "Default pool size is 5",
    status: "proposed",
    confidence_note: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const hyp2: Hypothesis = {
    hypothesis_id: "hyp_2",
    incident_id: incident.incident_id,
    parent_hypothesis_id: null,
    statement: "Transactions fail to release connections on error",
    rationale: "Error handlers lack finally { conn.release() }",
    status: "proposed",
    confidence_note: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const candidates: NormalizedCandidateInput[] = [
    {
      candidate_id: "cand_1",
      title: "Increase pool size to 25",
      proposed_change: "Set maxPoolSize: 25 in database configuration",
      rationale: "Accommodates burst traffic without code edits",
      expected_observation: "No timeout errors during 50-request burst",
      risk_level: "low",
      hypothesis_id: "hyp_1",
      parent_experiment_id: null,
      is_existing_experiment: false,
    },
    {
      candidate_id: "cand_2",
      title: "Add try/finally connection release",
      proposed_change: "Wrap query execution in try/finally block with conn.release()",
      rationale: "Prevents leaking connections on unhandled promise rejections",
      expected_observation: "Active connection count drops to zero after burst",
      risk_level: "medium",
      hypothesis_id: "hyp_2",
      parent_experiment_id: null,
      is_existing_experiment: false,
    },
  ];

  const report = compareCandidatesEngine({
    incident,
    candidates,
    experiments: [],
    hypotheses: [hyp1, hyp2],
    research: [],
    evidence: [],
  });

  expect(report.candidates_evaluated).toBe(2);
  expect(report.candidates.length).toBe(2);
  expect(report.pairwise_comparisons.length).toBe(1);

  const pair = report.pairwise_comparisons[0];
  expect(pair.pair).toEqual(["cand_1", "cand_2"]);
  expect(pair.diverging_aspects.some((d) => d.includes("Target distinct hypotheses"))).toBe(true);
  expect(pair.diverging_aspects.some((d) => d.includes("Risk differential"))).toBe(true);

  // Both should have scores
  expect(report.candidates[0].heuristic_score).toBeGreaterThan(0);
  expect(report.candidates[1].heuristic_score).toBeGreaterThan(0);
  expect(report.recommended_order.length).toBe(2);
  expect(report.overall_rationale.length).toBeGreaterThan(10);
});

test("compareCandidatesEngine: detects duplicate/equivalence warnings against prior failed attempts", () => {
  const incident = createMockIncident();
  const priorExp: Experiment = {
    experiment_id: "exp_prior_failed",
    incident_id: incident.incident_id,
    strategy_id: null,
    hypothesis_id: "hyp_1",
    parent_experiment_id: null,
    inspired_by_experiment_id: null,
    display_label: "A1",
    node_kind: "experiment",
    title: "Increase pool size to 20",
    proposed_change: "Set maxPoolSize: 20 in database configuration",
    reason_for_difference: null,
    expected_observation: "No timeouts",
    preconditions: null,
    environment_id: null,
    risk_level: "low",
    estimated_cost: null,
    execution_status: "completed",
    outcome_status: "failed",
    actual_observation: "Timeouts still occurred under load",
    interpretation: "Pool size alone does not fix leak",
    failure_reason: "Still timed out",
    environment_delta: null,
    display_order: 1,
    started_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "agent",
    approval_record_id: null,
  };

  const candidates: NormalizedCandidateInput[] = [
    {
      candidate_id: "cand_retry",
      title: "Increase pool size to 25",
      proposed_change: "Set maxPoolSize: 25 in database configuration",
      rationale: "Maybe 20 wasn't enough",
      expected_observation: "Zero timeouts",
      risk_level: "low",
      hypothesis_id: "hyp_1",
      parent_experiment_id: null,
      is_existing_experiment: false,
    },
    {
      candidate_id: "cand_code_fix",
      title: "Fix connection leak in error handler",
      proposed_change: "Ensure connection is returned to pool in finally block",
      rationale: "Root cause is connection leak, not pool exhaustion",
      expected_observation: "Connections released promptly",
      risk_level: "medium",
      hypothesis_id: "hyp_2",
      parent_experiment_id: null,
      is_existing_experiment: false,
    },
  ];

  const report = compareCandidatesEngine({
    incident,
    candidates,
    experiments: [priorExp],
    hypotheses: [],
    research: [],
    evidence: [],
  });

  const retryCand = report.candidates.find((c) => c.candidate_id === "cand_retry")!;
  expect(retryCand.duplicate_warnings.length).toBeGreaterThan(0);
  expect(retryCand.cautions.some((c) => c.includes("Near-duplicate warning"))).toBe(true);

  // The code fix candidate should outrank the retry candidate due to duplicate penalty
  expect(report.recommended_order[0]).toBe("cand_code_fix");
});
