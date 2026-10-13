/**
 * Exhaustion detection (engine, pure logic over store data).
 *
 * Computes whether the *currently tracked search space* is exhausted — never
 * the conceivable solution space. The states integrate with the existing
 * incident lifecycle (they are computed assessments, not new status fields):
 * they explain why the investigation can continue, should research/refine,
 * or must stop, and what would change the assessment.
 *
 * Honesty rules encoded here:
 * - Pending/running work means NOT exhausted (its branch stays open).
 * - Interrupted/inconclusive work is never silently classified as failed; it
 *   blocks exhaustion and demands completion first.
 * - A verified candidate demands verification/resolution bookkeeping, not more
 *   exploration.
 * - search_space_exhausted is only ever "the defined, tracked paths within
 *   configured limits"; new hypotheses or evidence always reopen the search.
 */
import type { Experiment, Hypothesis, Incident, Strategy, ValidationRun } from "../types.ts";
import type { BudgetUsage, BudgetConfig } from "./budgets.ts";
import { evaluateNewExperimentBudget } from "./budgets.ts";

export type ExhaustionState =
  | "resolved"
  | "exploring"
  | "refinement_required"
  | "research_required"
  | "budget_exhausted"
  | "blocked";

export interface ExhaustionAssessment {
  state: ExhaustionState;
  search_space_exhausted: boolean;
  reasons: string[];
  evidence_refs: string[];
  what_would_change: string[];
  pending_work: string[]; // experiment ids that are pending/running/interrupted/inconclusive
  dismissed_families: Set<string>; // family root ids explicitly dismissed
}

export const LIVE_HYPOTHESIS_STATUSES = new Set(["proposed", "supported", "weakened", "unresolved", "reopened"]);
const DISMISSED_STRATEGY_STATUSES = new Set(["abandoned", "exhausted_for_now"]);

export interface ExhaustionInput {
  incident: Incident;
  experiments: Experiment[]; // all nodes of the incident (incl. strategy nodes)
  hypotheses: Hypothesis[];
  strategies: Strategy[]; // strategies-table rows (dismissal records with rationale)
  validations: ValidationRun[];
  usage: BudgetUsage;
  budgetConfig: BudgetConfig;
  nowMs?: number;
}

/** Family root id for an experiment within the given set. */
function familyRootId(exp: Experiment, byId: Map<string, Experiment>): string {
  let cursor = exp;
  const seen = new Set<string>();
  while (cursor.parent_experiment_id) {
    if (seen.has(cursor.experiment_id)) return cursor.experiment_id;
    seen.add(cursor.experiment_id);
    const parent = byId.get(cursor.parent_experiment_id);
    if (!parent) return cursor.experiment_id;
    cursor = parent;
  }
  return cursor.experiment_id;
}

export function assessExhaustion(input: ExhaustionInput): ExhaustionAssessment {
  const { incident, experiments, hypotheses, strategies, validations, usage, budgetConfig } = input;
  const byId = new Map(experiments.map((e) => [e.experiment_id, e]));
  const attempts = experiments.filter((e) => e.node_kind !== "strategy");
  const reasons: string[] = [];
  const evidenceRefs: string[] = [];
  const whatWouldChange: string[] = [];

  const pendingWork = attempts
    .filter(
      (e) =>
        e.outcome_status === "pending" ||
        e.outcome_status === "candidate" ||
        e.outcome_status === "inconclusive" ||
        e.execution_status === "interrupted" ||
        e.execution_status === "running",
    )
    .map((e) => e.experiment_id);

  // 1) Resolved (or a verified validation exists and resolution bookkeeping is done)
  const verifiedValidation = validations.find((v) => v.resolution_decision === "verified");
  if (incident.status === "resolved") {
    return {
      state: "resolved",
      search_space_exhausted: true,
      reasons: [`Incident marked resolved${incident.resolution_experiment_id ? ` via ${incident.resolution_experiment_id}` : ""}.`],
      evidence_refs: verifiedValidation ? [verifiedValidation.validation_run_id] : [],
      what_would_change: ["Recurrence or new contradicting evidence reopens the investigation (existing lifecycle: reopened)."],
      pending_work: pendingWork,
      dismissed_families: dismissedFamilyIds(experiments, strategies, byId),
    };
  }

  // 2) Budget exhausted — any hard limit already reached
  const budgetProbe = evaluateNewExperimentBudget(budgetConfig, usage, {
    node_kind: "experiment",
    parent_experiment_id: null,
    parent_family_root_id: null,
    new_variant_depth: 0,
    risk_level: "low",
  });
  if (budgetProbe.blocked) {
    return {
      state: "budget_exhausted",
      search_space_exhausted: false, // limits are provisional, not proof of impossibility
      reasons: [budgetProbe.blocked.message],
      evidence_refs: [],
      what_would_change: [
        "Raise the budget via debug_budget_manage (the change is recorded), or supply new evidence/hypotheses; all records persist for resumption.",
      ],
      pending_work: pendingWork,
      dismissed_families: dismissedFamilyIds(experiments, strategies, byId),
    };
  }

  // 3) A candidate awaiting verification, or a verified experiment before resolution bookkeeping
  const candidate = attempts.find((e) => e.outcome_status === "candidate");
  const verifiedExp = attempts.find((e) => e.outcome_status === "verified");
  if (candidate || verifiedExp) {
    const e = candidate ?? verifiedExp!;
    return {
      state: "exploring",
      search_space_exhausted: false,
      reasons: [
        candidate
          ? `Attempt ${e.display_label ?? e.experiment_id} is a candidate solution — verification against the acceptance criteria is the meaningful next step.`
          : `Attempt ${e.display_label ?? e.experiment_id} passed validation; record the resolution (debug_case_status_update with the validation id) to finish.`,
      ],
      evidence_refs: [e.experiment_id],
      what_would_change: ["A failed validation returns the investigation to exploration/refinement."],
      pending_work: pendingWork,
      dismissed_families: dismissedFamilyIds(experiments, strategies, byId),
    };
  }

  // 4) Pending / running / interrupted / inconclusive work keeps branches open
  const openWork = attempts.filter(
    (e) =>
      e.outcome_status === "pending" ||
      e.outcome_status === "inconclusive" ||
      e.execution_status === "interrupted" ||
      e.execution_status === "running",
  );
  if (openWork.length > 0) {
    const bits = openWork.slice(0, 4).map((e) => {
      if (e.execution_status === "interrupted") return `${e.display_label ?? e.experiment_id} was interrupted — outcome never established`;
      if (e.outcome_status === "inconclusive") return `${e.display_label ?? e.experiment_id} is inconclusive — evidence was insufficient`;
      if (e.execution_status === "running") return `${e.display_label ?? e.experiment_id} is still running`;
      return `${e.display_label ?? e.experiment_id} is planned/pending`;
    });
    return {
      state: "exploring",
      search_space_exhausted: false,
      reasons: [`Open work exists; its branches cannot be judged exhausted.`, ...bits],
      evidence_refs: openWork.map((e) => e.experiment_id),
      what_would_change: ["Complete, interrupt-honestly, or update the open attempts — only then can their branches be assessed."],
      pending_work: pendingWork,
      dismissed_families: dismissedFamilyIds(experiments, strategies, byId),
    };
  }

  // 5) Blocked-only paths
  const blockedAttempts = attempts.filter((e) => e.outcome_status === "blocked");
  if (blockedAttempts.length > 0 && attempts.every((e) => e.outcome_status === "blocked" || e.outcome_status === "failed" || e.outcome_status === "superseded" || e.outcome_status === "not_applicable")) {
    return {
      state: "blocked",
      search_space_exhausted: false,
      reasons: [
        `All recorded attempts are failed or blocked, and the blocked ones require missing information, permission, tools, or external intervention.`,
        ...blockedAttempts.slice(0, 3).map((e) => `${e.display_label ?? e.experiment_id}: ${e.failure_reason ?? e.actual_observation ?? "blocked (no reason recorded)"}`),
      ],
      evidence_refs: blockedAttempts.map((e) => e.experiment_id),
      what_would_change: [
        "Supplying the missing information, permission, or tool unblocks the path; a new hypothesis also reopens the search.",
      ],
      pending_work: pendingWork,
      dismissed_families: dismissedFamilyIds(experiments, strategies, byId),
    };
  }

  // 6) Live hypotheses with no linked experiments → design an experiment
  const liveHypotheses = hypotheses.filter((h) => LIVE_HYPOTHESIS_STATUSES.has(h.status));
  const testedHypothesisIds = new Set(attempts.map((e) => e.hypothesis_id).filter(Boolean) as string[]);
  const untestedLive = liveHypotheses.filter((h) => !testedHypothesisIds.has(h.hypothesis_id));
  if (untestedLive.length > 0) {
    return {
      state: "exploring",
      search_space_exhausted: false,
      reasons: [
        `${untestedLive.length} live hypothesis(es) have no experiment yet — the tracked search space still has untested, meaningful paths.`,
        ...untestedLive.slice(0, 3).map((h) => `Untested: "${h.statement}" (${h.status})`),
      ],
      evidence_refs: untestedLive.map((h) => h.hypothesis_id),
      what_would_change: ["Rejecting or testing these hypotheses changes the assessment."],
      pending_work: pendingWork,
      dismissed_families: dismissedFamilyIds(experiments, strategies, byId),
    };
  }

  // 7) Partial-improvement signals → refinement has an evidence basis
  const partialSignals = attempts.filter((e) => e.outcome_status === "partial" || (e.outcome_status === "failed" && e.environment_delta));
  if (partialSignals.length > 0) {
    return {
      state: "refinement_required",
      search_space_exhausted: false,
      reasons: [
        "Executed approaches within the current strategies have failed, but recorded partial improvements / changed-environment evidence give a concrete basis for a refinement candidate.",
        ...partialSignals.slice(0, 3).map(
          (e) =>
            `${e.display_label ?? e.experiment_id} (${e.outcome_status}): ${e.actual_observation ?? e.interpretation ?? "partial signal"}${e.environment_delta ? ` [environment delta: ${e.environment_delta}]` : ""}`,
        ),
      ],
      evidence_refs: partialSignals.map((e) => e.experiment_id),
      what_would_change: [
        "Ranking selects the best-supported parent; without a new signal, unjustified retries of equivalent attempts are discouraged (duplicate warnings).",
        "New contradicting evidence or a dismissed-strategy dismissal may move this to research_required.",
      ],
      pending_work: pendingWork,
      dismissed_families: dismissedFamilyIds(experiments, strategies, byId),
    };
  }

  // 8) Families with remaining budget and a live tested hypothesis → keep exploring
  const dismissed = dismissedFamilyIds(experiments, strategies, byId);
  const liveIds = new Set(liveHypotheses.map((h) => h.hypothesis_id));
  const openFamilyExists = usage.families.some(
    (f) => !dismissed.has(f.root_id) && f.attempts < budgetConfig.max_experiments_per_family,
  );
  if (openFamilyExists && liveIds.size > 0) {
    return {
      state: "exploring",
      search_space_exhausted: false,
      reasons: [
        "At least one non-dismissed strategy family still has budget room and a live hypothesis to test.",
      ],
      evidence_refs: [...liveIds],
      what_would_change: ["Exhausting family budgets, dismissing strategies, or rejecting all hypotheses moves this toward research_required."],
      pending_work: pendingWork,
      dismissed_families: dismissed,
    };
  }

  // 9) Evidence insufficient to design a promising next experiment
  const hasAnyResearch = input.validations.length >= 0; // placeholder removed below
  reasons.push(
    "Every executed attempt within the tracked strategies failed without partial-improvement signals, and no untested live hypothesis remains.",
  );
  if (liveIds.size === 0 && hypotheses.length > 0) reasons.push("All recorded hypotheses are rejected.");
  const allStrategiesDismissed =
    experiments.filter((e) => e.node_kind === "strategy").length > 0 &&
    experiments.filter((e) => e.node_kind === "strategy").every((e) => dismissed.has(e.experiment_id));
  if (allStrategiesDismissed || liveIds.size === 0) {
    reasons.push(
      "The defined, currently tracked search space is exhausted within its configured limits — this is NOT a claim that every conceivable solution was explored.",
    );
  }
  whatWouldChange.push(
    "Research that produces a new hypothesis, or new evidence, reopens the investigation (lifecycle: reopened).",
    "A previously dismissed strategy can be revisited with a recorded reason (revisits_with_changed_environment).",
  );
  void hasAnyResearch;
  return {
    state: "research_required",
    search_space_exhausted: allStrategiesDismissed || liveIds.size === 0,
    reasons,
    evidence_refs: attempts.filter((e) => e.outcome_status === "failed").map((e) => e.experiment_id),
    what_would_change: whatWouldChange,
    pending_work: pendingWork,
    dismissed_families: dismissed,
  };
}

/** Family root ids that are explicitly dismissed (strategy rows or strategy-tree nodes marked not_applicable with a reason). */
function dismissedFamilyIds(experiments: Experiment[], strategies: Strategy[], byId: Map<string, Experiment>): Set<string> {
  const dismissed = new Set<string>();
  const dismissedStrategyRows = new Set(strategies.filter((s) => DISMISSED_STRATEGY_STATUSES.has(s.status)).map((s) => s.strategy_id));
  for (const e of experiments) {
    // strategy-table dismissal applies to experiments linked to that strategy
    if (e.strategy_id && dismissedStrategyRows.has(e.strategy_id)) dismissed.add(familyRootId(e, byId));
    // a tree strategy node marked not_applicable counts as dismissal when a reason was recorded
    if (e.node_kind === "strategy" && e.outcome_status === "not_applicable" && (e.failure_reason || e.interpretation)) {
      dismissed.add(e.experiment_id);
    }
  }
  return dismissed;
}
