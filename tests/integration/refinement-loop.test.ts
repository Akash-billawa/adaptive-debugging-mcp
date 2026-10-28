import { test, expect } from "bun:test";
import { openStore } from "./helpers.ts";
import type { Store } from "../../src/memory/store.ts";
import { buildCatalog } from "../../src/server/catalog.ts";

/**
 * The loop the project exists for, under DEFAULT budgets:
 *   A1, A2, A3 attempts fail -> research -> a variant of the best failed attempt (A1A, ...) -> new strategy.
 * Regression guard: the family cap used to count variants, so the first variant was rejected with
 * LIMIT_EXCEEDED while the engine was still recommending refinement.
 */
async function tool(store: Store, name: string, args: Record<string, unknown>) {
  const catalog = buildCatalog({ store, dbPath: ":memory:", log: () => {} });
  const res = await catalog.call(name, args);
  return res.structuredContent as any;
}

async function failedFamily(store: Store) {
  const c = await tool(store, "debug_case_start", {
    project: { display_name: "LoopApp", repository_uri: "git@example.com:o/loop.git" },
    title: "Widget crashes on save",
    initial_symptom: "TypeError: cannot read properties of undefined (reading 'id')",
    error_text: "TypeError: cannot read properties of undefined (reading 'id')\n    at save (/app/widget.ts:42:11)",
    acceptance_criteria: "save() with no owner does not throw",
  });
  const inc = c.incident_id as string;
  const strat = await tool(store, "debug_attempt_create", { incident_id: inc, node_kind: "strategy", title: "Strategy A", expected_observation: "n/a" });
  const attempts: string[] = [];
  const topics = ["guard owner access", "default owner on construct", "wrap save in try catch"];
  for (let i = 0; i < 3; i++) {
    const e = await tool(store, "debug_attempt_create", {
      incident_id: inc, node_kind: "experiment", parent_experiment_id: strat.experiment_id,
      title: `Attempt ${i + 1}`, proposed_change: topics[i] + ` variant ${i}`, expected_observation: "no crash",
    });
    attempts.push(e.experiment_id);
    await tool(store, "debug_attempt_update", {
      attempt_id: e.experiment_id, actor: "agent", execution_status: "completed", outcome_status: "failed",
      actual_observation: "still crashes", failure_reason: `attempt ${i + 1} did not help`,
    });
  }
  return { inc, strat: strat.experiment_id as string, attempts };
}

test("default budgets: 3 failures -> research_required -> research -> refine (variant accepted) ", async () => {
  const store = openStore(":memory:");
  const { inc, attempts } = await failedFamily(store);

  const before = await tool(store, "debug_next_experiment_prepare", { incident_id: inc });
  expect(before.exhaustion.state).toBe("research_required");
  expect(before.next_action.recommended_action).toBe("research_uncertainty");

  await tool(store, "debug_research_record", {
    incident_id: inc, source_type: "official_docs", source_title: "Widget docs",
    relevant_summary: "owner may be undefined for unsaved widgets", claim_supported_or_challenged: "supports: guard was too narrow",
  });

  const after = await tool(store, "debug_next_experiment_prepare", { incident_id: inc });
  expect(after.exhaustion.state).toBe("refinement_required");
  expect(after.next_action.recommended_action).toBe("refine_failed_experiment");
  const parent = after.next_action.parent_experiment_id as string;
  expect(attempts).toContain(parent);

  // The engine's own recommendation must be executable under the default budgets.
  const v = await tool(store, "debug_attempt_create", {
    incident_id: inc, node_kind: "variant", parent_experiment_id: parent, title: "Variant",
    proposed_change: "guard owner AND construct a default owner", reason_for_difference: "research: owner can be undefined for new widgets",
    expected_observation: "no crash",
  });
  expect(v.ok).toBe(true);
  expect(v.display_label).toMatch(/^A[123]A$/);
});

test("default budgets: variants are bounded per parent; a 4th base attempt in the family is still refused", async () => {
  const store = openStore(":memory:");
  const { inc, strat, attempts } = await failedFamily(store);
  for (let i = 0; i < 3; i++) {
    const v = await tool(store, "debug_attempt_create", {
      incident_id: inc, node_kind: "variant", parent_experiment_id: attempts[0], title: `V${i}`,
      proposed_change: `refinement number ${i} using different approach ${i * 7}`, reason_for_difference: `difference ${i}`, expected_observation: "x",
    });
    expect(v.ok).toBe(true);
  }
  const fourthVariant = await tool(store, "debug_attempt_create", {
    incident_id: inc, node_kind: "variant", parent_experiment_id: attempts[0], title: "V4",
    proposed_change: "yet another refinement", reason_for_difference: "d", expected_observation: "x",
  }).catch((e: any) => ({ __err: e }));
  expect((fourthVariant as any).__err?.details?.limit_name).toBe("max_variants_per_parent");
  const fourthBase = await tool(store, "debug_attempt_create", {
    incident_id: inc, node_kind: "experiment", parent_experiment_id: strat, title: "A4", proposed_change: "something else entirely", expected_observation: "x",
  }).catch((e: any) => ({ __err: e }));
  expect((fourthBase as any).__err?.details?.limit_name).toBe("max_experiments_per_family");
});

test("refinement exhausted (variant/depth budget) + research on file -> develop_new_strategy", async () => {
  const store = openStore(":memory:");
  const { inc, attempts } = await failedFamily(store);
  await tool(store, "debug_budget_manage", { op: "set_incident_override", incident_id: inc, config: { max_variants_per_parent: 1, max_refinement_depth: 1 }, rationale: "tight refinement budget for the test" });
  await tool(store, "debug_research_record", { incident_id: inc, source_type: "official_docs", relevant_summary: "docs", claim_supported_or_challenged: "supports" });
  for (const [i, parent] of attempts.entries()) {
    const v = await tool(store, "debug_attempt_create", {
      incident_id: inc, node_kind: "variant", parent_experiment_id: parent, title: `V${i}`,
      proposed_change: `refinement ${i} approach ${i * 13} distinct`, reason_for_difference: "r", expected_observation: "x",
    });
    await tool(store, "debug_attempt_update", { attempt_id: v.experiment_id, actor: "agent", execution_status: "completed", outcome_status: "failed", actual_observation: "o", failure_reason: "f" });
  }
  const r = await tool(store, "debug_next_experiment_prepare", { incident_id: inc });
  expect(r.exhaustion.state).toBe("research_required");
  expect(r.next_action.recommended_action).toBe("develop_new_strategy");
  expect(r.candidates.length).toBe(0); // nothing can be refined within the budget
});
