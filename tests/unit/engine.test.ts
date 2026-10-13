import { test, expect } from "bun:test";
import type { Experiment, Hypothesis, Incident, Strategy, ValidationRun } from "../../src/types.ts";
import {
  DEFAULT_BUDGET_CONFIG,
  mergeBudgetConfig,
  validateBudgetConfigPatch,
  computeBudgetUsage,
  evaluateNewExperimentBudget,
  familyRootOf,
  variantDepthOf,
  type BudgetConfig,
} from "../../src/engine/budgets.ts";
import { assessExhaustion, LIVE_HYPOTHESIS_STATUSES } from "../../src/engine/exhaustion.ts";
import { rankRefinementCandidates, untestedLiveHypotheses } from "../../src/engine/ranking.ts";

let seq = 0;
const NOW = new Date("2026-10-13T12:00:00.000Z").getTime();

function makeIncident(over: Partial<Incident> = {}): Incident {
  return {
    incident_id: "inc_test", project_id: "prj_test", title: "t", initial_symptom: "s",
    first_observed_at: "2026-10-12T00:00:00.000Z", created_at: "2026-10-13T10:00:00.000Z", updated_at: "2026-10-13T10:00:00.000Z",
    status: "open", severity: null, reproduction_status: "unknown", resolution_experiment_id: null, resolved_at: null,
    summary_current: null, acceptance_criteria: null, ...over,
  };
}
function makeExp(over: Partial<Experiment> = {}): Experiment {
  const id = over.experiment_id ?? `exp_${++seq}`;
  return {
    experiment_id: id, incident_id: "inc_test", strategy_id: null, hypothesis_id: null,
    parent_experiment_id: null, inspired_by_experiment_id: null, display_label: id, node_kind: "experiment",
    title: `exp ${id}`, proposed_change: "do x", reason_for_difference: null, expected_observation: "obs", preconditions: null,
    environment_id: null, risk_level: "low", estimated_cost: null, execution_status: "completed", outcome_status: "pending",
    actual_observation: null, interpretation: null, failure_reason: null, environment_delta: null, display_order: seq,
    started_at: null, completed_at: null, created_at: "2026-10-13T10:00:00.000Z", updated_at: "2026-10-13T10:00:00.000Z",
    created_by: "agent", approval_record_id: null, ...over,
  };
}
function makeHyp(over: Partial<Hypothesis> = {}): Hypothesis {
  const id = over.hypothesis_id ?? `hyp_${++seq}`;
  return {
    hypothesis_id: id, incident_id: "inc_test", parent_hypothesis_id: null,
    statement: `hypothesis ${id}`, rationale: "r", status: "proposed", confidence_note: null,
    created_at: "2026-10-13T10:00:00.000Z", updated_at: "2026-10-13T10:00:00.000Z", ...over,
  };
}
function makeStrategyRow(over: Partial<Strategy> = {}): Strategy {
  const id = over.strategy_id ?? `str_${++seq}`;
  return {
    strategy_id: id, incident_id: "inc_test", hypothesis_id: null, parent_strategy_id: null,
    title: `strategy ${id}`, description: "d", reason_for_selection: "r", status: "active",
    created_at: "2026-10-13T10:00:00.000Z", updated_at: "2026-10-13T10:00:00.000Z", ...over,
  };
}
function makeUsage(experiments: Experiment[], incident = makeIncident()) {
  return computeBudgetUsage(experiments, incident, NOW);
}
function assess(
  experiments: Experiment[],
  over: {
    incident?: Incident; hypotheses?: Hypothesis[]; strategies?: Strategy[]; validations?: ValidationRun[];
    config?: Partial<BudgetConfig>;
  } = {},
) {
  const incident = over.incident ?? makeIncident();
  const config = { ...DEFAULT_BUDGET_CONFIG, ...over.config };
  return assessExhaustion({
    incident,
    experiments,
    hypotheses: over.hypotheses ?? [],
    strategies: over.strategies ?? [],
    validations: over.validations ?? [],
    usage: makeUsage(experiments, incident),
    budgetConfig: config,
    nowMs: NOW,
  });
}

// --- budgets ------------------------------------------------------------------

test("budget defaults and merge", () => {
  expect(DEFAULT_BUDGET_CONFIG.max_experiments_per_family).toBe(3);
  expect(DEFAULT_BUDGET_CONFIG.max_variants_per_parent).toBe(3);
  expect(DEFAULT_BUDGET_CONFIG.max_total_experiments).toBe(25);
  expect(DEFAULT_BUDGET_CONFIG.max_refinement_depth).toBe(3);
  const merged = mergeBudgetConfig(DEFAULT_BUDGET_CONFIG, { max_total_experiments: 50 });
  expect(merged.max_total_experiments).toBe(50);
  expect(merged.max_experiments_per_family).toBe(3); // untouched keys keep defaults
  expect(mergeBudgetConfig(DEFAULT_BUDGET_CONFIG, null)).toEqual(DEFAULT_BUDGET_CONFIG);
});

test("budget config validation rejects bad patches", () => {
  expect(validateBudgetConfigPatch({ max_total_experiments: 0 })).toContain("max_total_experiments");
  expect(validateBudgetConfigPatch({ max_experiments_per_family: 1.5 })).toContain("integer");
  expect(validateBudgetConfigPatch({ max_risk_without_approval: "extreme" } as any)).toContain("max_risk_without_approval");
  expect(validateBudgetConfigPatch({ max_duration_hours: -1 })).toContain("max_duration_hours");
  expect(validateBudgetConfigPatch({ max_total_experiments: 40, max_duration_hours: null })).toBeNull();
});

test("usage: families, variants-per-parent, totals; strategies never count as attempts", () => {
  const stratA = makeExp({ experiment_id: "A", node_kind: "strategy" });
  const a1 = makeExp({ experiment_id: "A1", parent_experiment_id: "A" });
  const a1a = makeExp({ experiment_id: "A1A", node_kind: "variant", parent_experiment_id: "A1" });
  const a1b = makeExp({ experiment_id: "A1B", node_kind: "variant", parent_experiment_id: "A1" });
  const rootB = makeExp({ experiment_id: "B", node_kind: "experiment" });
  const usage = makeUsage([stratA, a1, a1a, a1b, rootB]);
  expect(usage.total_experiments).toBe(4); // strategy node excluded
  expect(usage.families.length).toBe(2);
  const famA = usage.families.find((f) => f.root_id === "A")!;
  expect(famA.attempts).toBe(3);
  expect(usage.variants_per_parent["A1"]).toBe(2);
});

test("familyRootOf and variantDepthOf walk the tree correctly", () => {
  const byId = new Map<string, Experiment>();
  const stratA = makeExp({ experiment_id: "A", node_kind: "strategy" });
  const a1 = makeExp({ experiment_id: "A1", parent_experiment_id: "A" });
  const a1a = makeExp({ experiment_id: "A1A", node_kind: "variant", parent_experiment_id: "A1" });
  const a1aa = makeExp({ experiment_id: "A1AA", node_kind: "variant", parent_experiment_id: "A1A" });
  for (const e of [stratA, a1, a1a, a1aa]) byId.set(e.experiment_id, e);
  expect(familyRootOf(a1aa, byId)!.experiment_id).toBe("A");
  expect(variantDepthOf(a1aa, byId)).toBe(2); // A1A -> A1AA (A1 is an experiment, not a variant)
  expect(variantDepthOf(a1, byId)).toBe(0);
});

test("budget enforcement: hard limits and warnings", () => {
  const cfg = DEFAULT_BUDGET_CONFIG;
  // total
  const many = Array.from({ length: 25 }, (_, i) => makeExp({ experiment_id: `e${i}` }));
  const totalBlocked = evaluateNewExperimentBudget(cfg, makeUsage(many), {
    node_kind: "experiment", parent_experiment_id: null, parent_family_root_id: null, new_variant_depth: 0, risk_level: "low",
  });
  expect(totalBlocked.blocked?.limit_name).toBe("max_total_experiments");
  // near-limit warning
  const twenty = many.slice(0, 20);
  const warn = evaluateNewExperimentBudget(cfg, makeUsage(twenty), {
    node_kind: "experiment", parent_experiment_id: null, parent_family_root_id: null, new_variant_depth: 0, risk_level: "low",
  });
  expect(warn.blocked).toBeNull();
  expect(warn.warnings.some((w) => w.includes("approaching total"))).toBe(true);
  // family limit
  const stratA = makeExp({ experiment_id: "A", node_kind: "strategy" });
  const fam = [stratA, ...[1, 2, 3].map((i) => makeExp({ experiment_id: `A${i}`, parent_experiment_id: "A" }))];
  const famBlocked = evaluateNewExperimentBudget(cfg, makeUsage(fam), {
    node_kind: "experiment", parent_experiment_id: "A", parent_family_root_id: "A", new_variant_depth: 0, risk_level: "low",
  });
  expect(famBlocked.blocked?.limit_name).toBe("max_experiments_per_family");
  // variants per parent (family limit raised so only the per-parent rule can fire)
  const parent = makeExp({ experiment_id: "P" });
  const threeVariants = [parent, ...[1, 2, 3].map((i) => makeExp({ experiment_id: `P${i}`, node_kind: "variant", parent_experiment_id: "P" }))];
  const varBlocked = evaluateNewExperimentBudget({ ...cfg, max_experiments_per_family: 10 }, makeUsage(threeVariants), {
    node_kind: "variant", parent_experiment_id: "P", parent_family_root_id: "P", new_variant_depth: 1, risk_level: "low",
  });
  expect(varBlocked.blocked?.limit_name).toBe("max_variants_per_parent");
  // refinement depth: new variant at depth 4 (> 3)
  const deep = evaluateNewExperimentBudget({ ...cfg, max_experiments_per_family: 10, max_variants_per_parent: 10 }, makeUsage(threeVariants), {
    node_kind: "variant", parent_experiment_id: "P", parent_family_root_id: "P", new_variant_depth: 4, risk_level: "low",
  });
  expect(deep.blocked?.limit_name).toBe("max_refinement_depth");
  // duration
  const durCfg = { ...DEFAULT_BUDGET_CONFIG, max_duration_hours: 1 };
  const oldIncident = makeIncident({ created_at: "2026-10-13T06:00:00.000Z" });
  const durBlocked = evaluateNewExperimentBudget(durCfg, computeBudgetUsage([makeExp()], oldIncident, NOW), {
    node_kind: "experiment", parent_experiment_id: null, parent_family_root_id: null, new_variant_depth: 0, risk_level: "low",
  });
  expect(durBlocked.blocked?.limit_name).toBe("max_duration_hours");
  // risk ceiling is a warning, not a block
  const risky = evaluateNewExperimentBudget(cfg, makeUsage([makeExp()]), {
    node_kind: "experiment", parent_experiment_id: null, parent_family_root_id: null, new_variant_depth: 0, risk_level: "high",
  });
  expect(risky.blocked).toBeNull();
  expect(risky.warnings.some((w) => w.includes("risk level 'high' exceeds"))).toBe(true);
  // strategies never consume budgets
  const stratNode = evaluateNewExperimentBudget(cfg, makeUsage(many), {
    node_kind: "strategy", parent_experiment_id: null, parent_family_root_id: null, new_variant_depth: 0, risk_level: "low",
  });
  expect(stratNode.blocked).toBeNull();
});

// --- exhaustion ------------------------------------------------------------------

test("exhaustion: resolved incident", () => {
  const a = assess([makeExp({ outcome_status: "verified" })], { incident: makeIncident({ status: "resolved" }) });
  expect(a.state).toBe("resolved");
});

test("exhaustion: budget_exhausted when a hard limit is reached", () => {
  const many = Array.from({ length: 25 }, (_, i) => makeExp({ experiment_id: `e${i}` }));
  const a = assess(many);
  expect(a.state).toBe("budget_exhausted");
  expect(a.search_space_exhausted).toBe(false); // limits are provisional, not impossibility
  expect(a.what_would_change.some((w) => w.includes("Raise the budget"))).toBe(true);
});

test("exhaustion: candidate outcome routes to verification, not exhaustion", () => {
  const a = assess([makeExp({ outcome_status: "candidate" }), makeExp({ outcome_status: "failed" })]);
  expect(a.state).toBe("exploring");
  expect(a.reasons[0]).toContain("candidate solution");
});

test("exhaustion: pending, running, interrupted, and inconclusive work blocks exhaustion", () => {
  const cases: Partial<Experiment>[] = [
    { outcome_status: "pending", execution_status: "not_started" },
    { execution_status: "running" },
    { execution_status: "interrupted" },
    { outcome_status: "inconclusive" },
  ];
  for (const c of cases) {
    const a = assess([makeExp({ outcome_status: "failed" }), makeExp(c)]);
    expect(a.state).toBe("exploring");
    expect(a.pending_work.length).toBe(1); // only the open attempt; the failed one never counts
  }
});

test("exhaustion: all-blocked paths yield blocked state with reasons", () => {
  const a = assess([
    makeExp({ outcome_status: "blocked", failure_reason: "needs credentials" }),
    makeExp({ outcome_status: "failed" }),
  ]);
  expect(a.state).toBe("blocked");
  expect(a.reasons.some((r) => r.includes("needs credentials"))).toBe(true);
});

test("exhaustion: untested live hypotheses keep the search space open", () => {
  const a = assess([makeExp({ outcome_status: "failed", hypothesis_id: "hyp_1" })], {
    hypotheses: [makeHyp({ hypothesis_id: "hyp_1", status: "supported" }), makeHyp({ hypothesis_id: "hyp_2", status: "proposed" })],
  });
  expect(a.state).toBe("exploring");
  expect(a.reasons[0]).toContain("live hypothesis");
});

test("exhaustion: partial signals route to refinement_required", () => {
  const a = assess([
    makeExp({ outcome_status: "failed" }),
    makeExp({ outcome_status: "partial", actual_observation: "error moved from parse to render" }),
  ]);
  expect(a.state).toBe("refinement_required");
  expect(a.reasons.some((r) => r.includes("error moved"))).toBe(true);
});

test("exhaustion: family with budget room + live tested hypothesis stays exploring", () => {
  const a = assess([
    makeExp({ experiment_id: "A", node_kind: "strategy" }),
    makeExp({ experiment_id: "A1", parent_experiment_id: "A", outcome_status: "failed", hypothesis_id: "hyp_1" }),
  ], { hypotheses: [makeHyp({ hypothesis_id: "hyp_1" })] });
  expect(a.state).toBe("exploring");
});

test("exhaustion: research_required; tracked-space exhaustion only with full dismissal", () => {
  // All attempts failed, no partial signals, no untested hypotheses, family at budget.
  const stratA = makeExp({ experiment_id: "A", node_kind: "strategy" });
  const fam = [1, 2, 3].map((i) => makeExp({ experiment_id: `A${i}`, parent_experiment_id: "A", outcome_status: "failed", hypothesis_id: "hyp_1" }));
  const hypotheses = [makeHyp({ hypothesis_id: "hyp_1", status: "proposed" })];
  const a = assess([stratA, ...fam], { hypotheses });
  expect(a.state).toBe("research_required");
  expect(a.search_space_exhausted).toBe(false); // a live (tested) hypothesis remains
  // Same tree with the hypothesis rejected and the strategy dismissed -> tracked space exhausted
  const b = assess([stratA, ...fam], {
    hypotheses: [makeHyp({ hypothesis_id: "hyp_1", status: "rejected" })],
    strategies: [makeStrategyRow({ strategy_id: "str_row", status: "abandoned" })],
  });
  expect(b.state).toBe("research_required");
  expect(b.search_space_exhausted).toBe(true);
  expect(b.reasons.some((r) => r.includes("NOT a claim that every conceivable solution"))).toBe(true);
  // New evidence/hypothesis reopens: add a fresh proposed hypothesis -> exploring again
  const c = assess([stratA, ...fam], {
    hypotheses: [makeHyp({ hypothesis_id: "hyp_1", status: "rejected" }), makeHyp({ hypothesis_id: "hyp_new", status: "proposed" })],
  });
  expect(c.state).toBe("exploring");
});

test("live hypothesis statuses include weakened and reopened", () => {
  expect(LIVE_HYPOTHESIS_STATUSES.has("weakened")).toBe(true);
  expect(LIVE_HYPOTHESIS_STATUSES.has("reopened")).toBe(true);
  expect(LIVE_HYPOTHESIS_STATUSES.has("rejected")).toBe(false);
});

// --- ranking ------------------------------------------------------------------

function rankFixture() {
  const stratA = makeExp({ experiment_id: "A", node_kind: "strategy" });
  const bare = makeExp({ experiment_id: "A1", parent_experiment_id: "A", outcome_status: "failed" });
  const informative = makeExp({ experiment_id: "A2", parent_experiment_id: "A", outcome_status: "failed", failure_reason: "proved config file is read before env vars" });
  const partial = makeExp({ experiment_id: "A3", parent_experiment_id: "A", outcome_status: "partial", actual_observation: "crash now only under load" });
  const interrupted = makeExp({ experiment_id: "A4", parent_experiment_id: "A", execution_status: "interrupted", outcome_status: "pending" });
  return { stratA, bare, informative, partial, interrupted };
}

test("ranking: partial and informative failures outrank bare failures; recency is not a factor", () => {
  const { stratA, bare, informative, partial, interrupted } = rankFixture();
  const { candidates, rerun_candidates } = rankRefinementCandidates({
    experiments: [stratA, bare, informative, partial, interrupted],
    hypotheses: [], research: [], evidence: [],
    dismissed_family_ids: new Set(),
  });
  expect(candidates.length).toBe(3);
  expect(candidates[0].experiment_id).toBe("A3"); // partial first
  expect(candidates[1].experiment_id).toBe("A2"); // informative second
  expect(candidates[2].experiment_id).toBe("A1"); // bare last
  expect(candidates[0].factors.some((f) => f.factor === "partial_improvement")).toBe(true);
  expect(candidates.every((c) => c.score_note.includes("not a probability"))).toBe(true);
  // Interrupted work is never ranked as a failed refinement; it lands in the re-run bucket
  expect(rerun_candidates.map((c) => c.experiment_id)).toContain("A4");
  expect(candidates.map((c) => c.experiment_id)).not.toContain("A4");
});

test("ranking: duplicate proximity penalizes; dismissed families caution", () => {
  const stratA = makeExp({ experiment_id: "A", node_kind: "strategy" });
  const e1 = makeExp({ experiment_id: "A1", parent_experiment_id: "A", outcome_status: "failed", title: "Increase token TTL to 1h", proposed_change: "set TTL=3600" });
  const e2 = makeExp({ experiment_id: "A2", parent_experiment_id: "A", outcome_status: "failed", title: "Increase token TTL to 1h", proposed_change: "set TTL=3600" });
  const { candidates } = rankRefinementCandidates({
    experiments: [stratA, e1, e2], hypotheses: [], research: [], evidence: [],
    dismissed_family_ids: new Set(["A"]),
  });
  expect(candidates.length).toBe(2);
  for (const c of candidates) {
    expect(c.factors.some((f) => f.factor === "duplicate_proximity")).toBe(true);
    expect(c.cautions.some((x) => x.includes("explicitly dismissed"))).toBe(true);
  }
});

test("ranking: live-hypothesis, research, and evidence factors register", () => {
  const e = makeExp({ experiment_id: "E1", outcome_status: "failed", hypothesis_id: "hyp_1" });
  const { candidates } = rankRefinementCandidates({
    experiments: [e],
    hypotheses: [makeHyp({ hypothesis_id: "hyp_1", status: "supported" })],
    research: [{ research_reference_id: "res_1", incident_id: "inc_test", experiment_id: "E1", hypothesis_id: null, source_uri: "https://docs.example", source_title: null, source_type: "official_docs", accessed_at: "2026-10-13T10:00:00.000Z", relevant_summary: "s", reliability_note: null, claim_supported_or_challenged: "c", created_at: "2026-10-13T10:00:00.000Z" }],
    evidence: [],
    dismissed_family_ids: new Set(),
  });
  const factorNames = candidates[0].factors.map((f) => f.factor);
  expect(factorNames).toContain("live_hypothesis");
  expect(factorNames).toContain("research_linked");
});

test("untestedLiveHypotheses excludes tested and rejected ones", () => {
  const hyps = [
    makeHyp({ hypothesis_id: "h1", status: "proposed" }),
    makeHyp({ hypothesis_id: "h2", status: "rejected" }),
    makeHyp({ hypothesis_id: "h3", status: "supported" }),
  ];
  const exps = [makeExp({ hypothesis_id: "h3" })];
  const untested = untestedLiveHypotheses(hyps, exps);
  expect(untested.map((h) => h.hypothesis_id)).toEqual(["h1"]);
});
