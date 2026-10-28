import { test, expect } from "bun:test";
import { openStore, closeStore } from "./helpers.ts";
import { buildCatalog } from "../../src/server/catalog.ts";
import type { Store } from "../../src/memory/store.ts";

function setup() {
  const store = openStore(":memory:");
  const catalog = buildCatalog({ store, dbPath: ":memory:", log: () => {} });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await catalog.call(name, args);
    return res.structuredContent as any;
  };
  return { store, call };
}

test("debug_attempt_create rejects nonexistent or cross-incident hypothesis, strategy, and inspired_by ids", async () => {
  const { store, call } = setup();
  const inc1 = (await call("debug_case_start", {
    project: { display_name: "App1", repository_uri: "git@example.com:o/a1.git" },
    title: "bug 1", initial_symptom: "symptom 1",
  })).incident_id;

  const inc2 = (await call("debug_case_start", {
    project: { display_name: "App2", repository_uri: "git@example.com:o/a2.git" },
    title: "bug 2", initial_symptom: "symptom 2",
  })).incident_id;

  const hyp2 = (await call("debug_hypothesis_manage", {
    op: "create_hypothesis", incident_id: inc2, statement: "claim 2", rationale: "r",
  })).hypothesis_id;

  const strat2 = (await call("debug_attempt_create", {
    incident_id: inc2, node_kind: "strategy", title: "strat 2", expected_observation: "o",
  })).experiment_id;

  const exp2 = (await call("debug_attempt_create", {
    incident_id: inc2, node_kind: "experiment", parent_experiment_id: strat2, title: "exp 2",
    proposed_change: "p", expected_observation: "o",
  })).experiment_id;

  // 1. Nonexistent IDs
  expect(call("debug_attempt_create", {
    incident_id: inc1, node_kind: "experiment", title: "try", expected_observation: "o",
    hypothesis_id: "hyp_nonexistent_123",
  })).rejects.toThrow();

  expect(call("debug_attempt_create", {
    incident_id: inc1, node_kind: "experiment", title: "try", expected_observation: "o",
    strategy_id: "str_nonexistent_123",
  })).rejects.toThrow();

  expect(call("debug_attempt_create", {
    incident_id: inc1, node_kind: "experiment", title: "try", expected_observation: "o",
    inspired_by_experiment_id: "exp_nonexistent_123",
  })).rejects.toThrow();

  // 2. Cross-incident IDs (valid in inc2, but passed to inc1)
  expect(call("debug_attempt_create", {
    incident_id: inc1, node_kind: "experiment", title: "try", expected_observation: "o",
    hypothesis_id: hyp2,
  })).rejects.toThrow();

  expect(call("debug_attempt_create", {
    incident_id: inc1, node_kind: "experiment", title: "try", expected_observation: "o",
    strategy_id: strat2,
  })).rejects.toThrow();

  expect(call("debug_attempt_create", {
    incident_id: inc1, node_kind: "experiment", title: "try", expected_observation: "o",
    inspired_by_experiment_id: exp2,
  })).rejects.toThrow();

  closeStore(store);
});

test("tree topology rejects strategy under experiment and unreasoned experiment under failed parent", async () => {
  const { store, call } = setup();
  const inc = (await call("debug_case_start", {
    project: { display_name: "App", repository_uri: "git@example.com:o/a.git" },
    title: "bug", initial_symptom: "symptom",
  })).incident_id;

  const strat = (await call("debug_attempt_create", {
    incident_id: inc, node_kind: "strategy", title: "Strategy A", expected_observation: "o",
  })).experiment_id;

  const a1 = (await call("debug_attempt_create", {
    incident_id: inc, node_kind: "experiment", parent_experiment_id: strat, title: "A1",
    proposed_change: "fix", expected_observation: "o",
  })).experiment_id;

  // A strategy under an experiment is rejected
  expect(call("debug_attempt_create", {
    incident_id: inc, node_kind: "strategy", parent_experiment_id: a1, title: "Invalid child strategy",
    expected_observation: "o",
  })).rejects.toThrow();

  // Fail A1
  await call("debug_attempt_update", {
    attempt_id: a1, actor: "agent", execution_status: "completed", outcome_status: "failed",
    actual_observation: "failed", failure_reason: "bad fix",
  });

  // Attempting to create an experiment under failed parent without reason_for_difference is rejected
  expect(call("debug_attempt_create", {
    incident_id: inc, node_kind: "experiment", parent_experiment_id: a1, title: "A1A without reason",
    proposed_change: "fix2", expected_observation: "o",
  })).rejects.toThrow();

  // Providing reason_for_difference succeeds
  const a1a = await call("debug_attempt_create", {
    incident_id: inc, node_kind: "variant", parent_experiment_id: a1, title: "A1A",
    proposed_change: "fix2", reason_for_difference: "switched approach", expected_observation: "o",
  });
  expect(a1a.ok).toBe(true);

  closeStore(store);
});

test("update_strategy_status rejects unknown id, requires rationale, and records in timeline", async () => {
  const { store, call } = setup();
  const inc = (await call("debug_case_start", {
    project: { display_name: "App", repository_uri: "git@example.com:o/a.git" },
    title: "bug", initial_symptom: "symptom",
  })).incident_id;

  // Unknown id
  expect(call("debug_hypothesis_manage", {
    op: "update_strategy_status", incident_id: inc, id: "str_unknown", status: "abandoned", rationale: "not working",
  })).rejects.toThrow();

  // Create strategy row via create_strategy
  const strat = (await call("debug_hypothesis_manage", {
    op: "create_strategy", incident_id: inc, title: "S1", description: "desc", reason_for_selection: "reason",
  })).strategy_id;

  // Missing rationale
  expect(call("debug_hypothesis_manage", {
    op: "update_strategy_status", incident_id: inc, id: strat, status: "abandoned", rationale: "",
  })).rejects.toThrow();

  // Valid update
  const updated = await call("debug_hypothesis_manage", {
    op: "update_strategy_status", incident_id: inc, id: strat, status: "abandoned", rationale: "approach hit dead end",
  });
  expect(updated.ok).toBe(true);
  expect(updated.status).toBe("abandoned");

  // Verify timeline contains the event with rationale
  const timeline = await call("debug_case_read", { incident_id: inc, sections: ["timeline"] });
  const evt = timeline.timeline.find((e: any) => e.event_type === "strategy.abandoned");
  expect(evt).toBeDefined();
  expect(evt.summary).toContain("approach hit dead end");

  closeStore(store);
});

test("sequential set_incident_override calls merge over each other instead of dropping prior overrides", async () => {
  const { store, call } = setup();
  const inc = (await call("debug_case_start", {
    project: { display_name: "App", repository_uri: "git@example.com:o/a.git" },
    title: "bug", initial_symptom: "symptom",
  })).incident_id;

  // First override: set max_variants_per_parent
  await call("debug_budget_manage", {
    op: "set_incident_override", incident_id: inc, config: { max_variants_per_parent: 1 }, rationale: "test 1",
  });

  // Second override: set max_refinement_depth
  await call("debug_budget_manage", {
    op: "set_incident_override", incident_id: inc, config: { max_refinement_depth: 2 }, rationale: "test 2",
  });

  const bgt = await call("debug_budget_manage", { op: "get", incident_id: inc });
  expect(bgt.config.max_variants_per_parent).toBe(1);
  expect(bgt.config.max_refinement_depth).toBe(2);

  closeStore(store);
});

test("risk_level defaults to low and produces no risk ceiling warning", async () => {
  const { store, call } = setup();
  const inc = (await call("debug_case_start", {
    project: { display_name: "App", repository_uri: "git@example.com:o/a.git" },
    title: "bug", initial_symptom: "symptom",
  })).incident_id;

  const exp = await call("debug_attempt_create", {
    incident_id: inc, node_kind: "experiment", title: "ordinary experiment", proposed_change: "test", expected_observation: "pass",
  });

  expect(exp.ok).toBe(true);
  expect(exp.warnings.some((w: string) => w.includes("risk level"))).toBe(false);
  const read = await call("debug_case_read", { incident_id: inc, sections: ["attempts"] });
  expect(read.attempts[0].risk_level).toBe("low");

  closeStore(store);
});

test("resolved incident recommends stop_resolved; reopened incident does not recommend resolve_incident", async () => {
  const { store, call } = setup();
  const inc = (await call("debug_case_start", {
    project: { display_name: "App", repository_uri: "git@example.com:o/a.git" },
    title: "bug", initial_symptom: "symptom", acceptance_criteria: "runs cleanly",
  })).incident_id;

  const exp = (await call("debug_attempt_create", {
    incident_id: inc, node_kind: "experiment", title: "fix", expected_observation: "clean",
  })).experiment_id;

  const evd = (await call("debug_evidence_record", {
    project_id: "prj_test", incident_id: inc, experiment_id: exp, evidence_type: "stdout",
    content: "clean run observed", capture_source: "agent",
  })).evidence_id;

  const val = (await call("debug_validation_record", {
    incident_id: inc, experiment_id: exp, validation_plan: "run test", execution_result: "passed",
    criteria_results: [{ criteria: "runs cleanly", status: "passed" }], evidence_ids: [evd],
  })).validation_id;

  await call("debug_case_status_update", {
    incident_id: inc, status: "investigating", rationale: "investigating bug",
  });

  await call("debug_case_status_update", {
    incident_id: inc, status: "resolved", verification_id: val, rationale: "fix verified",
  });

  // When resolved, next_action should be stop_resolved (NOT continue_exploring)
  const resolvedNext = await call("debug_next_experiment_prepare", { incident_id: inc });
  expect(resolvedNext.exhaustion.state).toBe("resolved");
  expect(resolvedNext.next_action.recommended_action).toBe("stop_resolved");

  // Reopen the incident
  await call("debug_case_status_update", {
    incident_id: inc, status: "reopened", rationale: "regressed in production",
  });

  // When reopened, next_action must NOT be resolve_incident
  const reopenedNext = await call("debug_next_experiment_prepare", { incident_id: inc });
  expect(reopenedNext.next_action.recommended_action).not.toBe("resolve_incident");

  closeStore(store);
});
