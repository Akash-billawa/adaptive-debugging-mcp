/**
 * Structured next-action decision (engine, pure logic).
 *
 * After each meaningful outcome, produces ONE recommendation with: why now, the
 * supporting evidence, unresolved uncertainty, the parent/hypothesis, expected
 * observation, risk/cost considerations, and what would change the decision.
 * When a budget is reached, produces a resumable handoff report — the
 * investigation and its records persist; nothing is falsely resolved.
 */
import type { Experiment, Hypothesis, Incident, ResearchReference, Strategy, ValidationRun, Evidence } from "../types.ts";
import type { BudgetConfig, BudgetUsage } from "./budgets.ts";
import { assessExhaustion, type ExhaustionAssessment } from "./exhaustion.ts";
import { rankRefinementCandidates, untestedLiveHypotheses, type RankedCandidate } from "./ranking.ts";

export type NextActionKind =
  | "continue_exploring"
  | "try_untested_experiment"
  | "research_uncertainty"
  | "refine_failed_experiment"
  | "develop_new_strategy"
  | "request_missing_info_or_approval"
  | "stop_budget_reached"
  | "verify_candidate"
  | "resolve_incident"
  | "resume_interrupted";

export interface NextAction {
  recommended_action: NextActionKind;
  why_now: string;
  supporting_evidence: string[];
  unresolved_uncertainty: string;
  parent_experiment_id: string | null;
  hypothesis_id: string | null;
  expected_observation: string | null;
  risk_considerations: string;
  cost_considerations: string;
  what_would_change: string[];
}

export interface HandoffReport {
  prior_findings: { family: string; attempts: { label: string | null; title: string; outcome: string; established: string }[] }[];
  remaining_hypotheses: { hypothesis_id: string; statement: string; status: string }[];
  untested_directions: string[];
  best_supported_next_option: string;
  resumption: string;
}

export interface NextActionReport {
  incident_id: string;
  exhaustion: ExhaustionAssessment;
  budget: { config: BudgetConfig; usage: BudgetUsage; warnings: string[]; note: string };
  next_action: NextAction;
  candidates: RankedCandidate[];
  rerun_candidates: RankedCandidate[];
  untested_hypotheses: { hypothesis_id: string; statement: string; status: string }[];
  handoff: HandoffReport | null;
}

export interface NextActionInput {
  incident: Incident;
  experiments: Experiment[];
  hypotheses: Hypothesis[];
  strategies: Strategy[];
  validations: ValidationRun[];
  research: ResearchReference[];
  evidence: Evidence[];
  usage: BudgetUsage;
  budgetConfig: BudgetConfig;
  budgetWarnings?: string[];
  nowMs?: number;
}

export function decideNextAction(input: NextActionInput, candidateLimit = 3): NextActionReport {
  const { incident, experiments, hypotheses, validations, research, evidence, usage, budgetConfig } = input;
  const exhaustion = assessExhaustion({
    incident,
    experiments,
    hypotheses,
    strategies: input.strategies,
    validations,
    usage,
    budgetConfig,
    nowMs: input.nowMs,
  });

  const dismissed = new Set(exhaustion.dismissed_families);
  const { candidates, rerun_candidates } = rankRefinementCandidates({ experiments, hypotheses, research, evidence, dismissed_family_ids: dismissed }, candidateLimit);
  const untested = untestedLiveHypotheses(hypotheses, experiments);
  const budgetNote =
    budgetConfig.cost_limit === null
      ? "Cost limits are not enforced: ADIM has no reliable token/monetary accounting, so no figures are invented."
      : "A cost limit is recorded but NOT enforced (no reliable accounting is available in ADIM).";

  const attempts = experiments.filter((e) => e.node_kind !== "strategy");
  const next: NextAction = {
    recommended_action: "continue_exploring",
    why_now: "",
    supporting_evidence: [],
    unresolved_uncertainty: "",
    parent_experiment_id: null,
    hypothesis_id: null,
    expected_observation: null,
    risk_considerations: "",
    cost_considerations: "",
    what_would_change: exhaustion.what_would_change,
  };
  let handoff: HandoffReport | null = null;

  switch (exhaustion.state) {
    case "resolved": {
      next.recommended_action = "continue_exploring";
      next.why_now = "The incident is resolved and verified; no further investigation is required. A new failure report should open or reopen a case.";
      next.unresolved_uncertainty = "Verification was environment- and criteria-scoped; recurrence under other conditions reopens the case.";
      next.risk_considerations = "None — no action recommended.";
      next.cost_considerations = "None.";
      break;
    }
    case "budget_exhausted": {
      next.recommended_action = "stop_budget_reached";
      next.why_now = exhaustion.reasons[0] ?? "A configured hard budget limit has been reached.";
      next.supporting_evidence = [`${usage.total_experiments} recorded experiments across ${usage.families.length} family/families.`];
      next.unresolved_uncertainty = "The tracked search space is NOT proven impossible — the limit is provisional.";
      next.risk_considerations = "Stopping is the safe action; do not force a new experiment past an enforced budget.";
      next.cost_considerations = "No further experiment cost should be spent until the budget is explicitly raised.";
      handoff = buildHandoff(input, exhaustion, candidates, untested);
      break;
    }
    case "blocked": {
      next.recommended_action = "request_missing_info_or_approval";
      next.why_now = "All remaining paths require missing information, permission, tools, or external intervention.";
      next.supporting_evidence = exhaustion.reasons;
      next.unresolved_uncertainty = "What exactly is missing (recorded in the blocked attempts' failure_reason).";
      next.risk_considerations = "Unblocking may require approvals — request them explicitly; do not bypass the permission layer.";
      next.cost_considerations = "No experiment cost until unblocked.";
      break;
    }
    case "refinement_required": {
      const top = candidates[0];
      const needsResearch = !research.some((r) => top?.hypothesis_id === r.hypothesis_id || top?.experiment_id === r.experiment_id);
      next.recommended_action = "refine_failed_experiment";
      next.parent_experiment_id = top?.experiment_id ?? null;
      next.hypothesis_id = top?.hypothesis_id ?? null;
      next.why_now = top
        ? `Approaches within the current strategies failed, but ${top.label ?? top.experiment_id} carries the strongest recorded evidence for a productive variation (score ${top.score}, heuristic).${needsResearch ? " Research the remaining uncertainty BEFORE recording the variation." : ""}`
        : "Approaches failed; no refinement candidate could be scored — research the uncertainty first.";
      next.supporting_evidence = top ? top.factors.map((f) => `${f.factor}: ${f.detail}`) : exhaustion.reasons;
      next.unresolved_uncertainty = top?.suggested_focus ?? "What specifically to change and why it could matter.";
      next.expected_observation = "A materially different test whose result either revives the parent's hypothesis or rejects it.";
      next.risk_considerations = "Prefer low-risk, reversible variations; the variation must record its meaningful difference (reason_for_difference).";
      next.cost_considerations = "One focused variation within the remaining family/variant budgets.";
      break;
    }
    case "research_required": {
      const allRejected = hypotheses.length > 0 && hypotheses.every((h) => h.status === "rejected");
      next.recommended_action = allRejected || untested.length === 0 ? "develop_new_strategy" : "research_uncertainty";
      next.why_now = allRejected
        ? "Every recorded hypothesis is rejected and no refinement signal exists — research (docs/source/changelogs/issues) is required to form a genuinely new hypothesis before another experiment."
        : "The current evidence is insufficient to design a promising next experiment; research the open uncertainty first.";
      next.supporting_evidence = exhaustion.reasons;
      next.unresolved_uncertainty = untested.length > 0 ? `Untested hypotheses exist (${untested.length}) but lack the information needed to design a discriminating experiment.` : "A new explanation is needed.";
      next.risk_considerations = "Research is read-only; record findings with debug_research_record (treated as untrusted data).";
      next.cost_considerations = "Research cost only; no experiment budget is spent.";
      next.what_would_change = [
        ...next.what_would_change,
        "Research that produces a supported new hypothesis moves the state back to exploring (try_untested_experiment).",
      ];
      break;
    }
    case "exploring":
    default: {
      const openWork = attempts.find(
        (e) => e.execution_status === "interrupted" || e.outcome_status === "inconclusive" || e.execution_status === "running" || e.outcome_status === "pending",
      );
      const candidate = attempts.find((e) => e.outcome_status === "candidate");
      const verified = attempts.find((e) => e.outcome_status === "verified");
      if (verified) {
        next.recommended_action = "resolve_incident";
        next.why_now = `Attempt ${verified.display_label ?? verified.experiment_id} passed validation — record the resolution (debug_case_status_update with the validation id) before anything else.`;
        next.parent_experiment_id = verified.experiment_id;
        next.supporting_evidence = ["A verified validation run exists (outcome 'verified' can only be set by debug_validation_record)."];
        next.unresolved_uncertainty = "Applicability beyond the validated environment is not established.";
        next.risk_considerations = "No new risk — bookkeeping only.";
        next.cost_considerations = "None.";
      } else if (candidate) {
        next.recommended_action = "verify_candidate";
        next.parent_experiment_id = candidate.experiment_id;
        next.why_now = `Attempt ${candidate.display_label ?? candidate.experiment_id} is a candidate — re-run the ORIGINAL acceptance criteria (not just a green command) and record with debug_validation_record.`;
        next.supporting_evidence = exhaustion.reasons;
        next.unresolved_uncertainty = "Whether the original failure condition is truly gone.";
        next.expected_observation = "All acceptance criteria pass with recorded evidence; a green command alone proves nothing.";
        next.risk_considerations = "Verification is normally low-risk; regression checks are preferred over destructive probes.";
        next.cost_considerations = "One verification run.";
      } else if (openWork && (openWork.execution_status === "interrupted" || openWork.outcome_status === "inconclusive")) {
        next.recommended_action = "resume_interrupted";
        next.parent_experiment_id = openWork.experiment_id;
        next.why_now = `Attempt ${openWork.display_label ?? openWork.experiment_id} never established an outcome (${openWork.execution_status === "interrupted" ? "interrupted" : "inconclusive"}); complete or honestly close it before judging the branch.`;
        next.supporting_evidence = ["Interrupted/inconclusive work is never silently classified as failed."];
        next.unresolved_uncertainty = "The actual outcome of the open attempt.";
        next.expected_observation = "A recorded observation that resolves the attempt's outcome honestly.";
        next.risk_considerations = openWork.risk_level;
        next.cost_considerations = "Resuming an existing attempt is usually cheaper than a new one.";
      } else if (untested.length > 0) {
        next.recommended_action = "try_untested_experiment";
        next.hypothesis_id = untested[0].hypothesis_id;
        next.why_now = `Live hypothesis "${untested[0].statement}" has no experiment yet; design one that would support or reject it.`;
        next.supporting_evidence = exhaustion.reasons;
        next.unresolved_uncertainty = "Whether this hypothesis explains the failure.";
        next.expected_observation = "An observation that discriminates this hypothesis from the remaining live ones.";
        next.risk_considerations = "Prefer the cheapest discriminating experiment within permissions.";
        next.cost_considerations = "One experiment within family/total budgets.";
      } else if (openWork) {
        next.recommended_action = "continue_exploring";
        next.parent_experiment_id = openWork.experiment_id;
        next.why_now = `Planned work exists (${openWork.display_label ?? openWork.experiment_id}); execute it within permissions, then record the actual outcome.`;
        next.supporting_evidence = exhaustion.reasons;
        next.unresolved_uncertainty = "The attempt's actual result.";
        next.expected_observation = openWork.expected_observation;
        next.risk_considerations = openWork.risk_level;
        next.cost_considerations = openWork.estimated_cost ?? "unknown";
      } else {
        next.recommended_action = "continue_exploring";
        next.why_now = "Meaningful experiments remain available within the tracked search space.";
        next.supporting_evidence = exhaustion.reasons;
        next.unresolved_uncertainty = "Which untested variation carries the most information.";
        next.risk_considerations = "Stay within permissions and the risk ceiling.";
        next.cost_considerations = "Within remaining budgets.";
      }
      break;
    }
  }

  return {
    incident_id: incident.incident_id,
    exhaustion,
    budget: { config: budgetConfig, usage, warnings: input.budgetWarnings ?? [], note: budgetNote },
    next_action: next,
    candidates,
    rerun_candidates,
    untested_hypotheses: untested.map((h) => ({ hypothesis_id: h.hypothesis_id, statement: h.statement, status: h.status })),
    handoff,
  };
}

function buildHandoff(
  input: NextActionInput,
  exhaustion: ExhaustionAssessment,
  candidates: RankedCandidate[],
  untested: Hypothesis[],
): HandoffReport {
  const { experiments, hypotheses, usage } = input;
  const byId = new Map(experiments.map((e) => [e.experiment_id, e]));
  const famRoot = (e: Experiment): string | null => {
    let cursor = e;
    const seen = new Set<string>();
    while (cursor.parent_experiment_id) {
      if (seen.has(cursor.experiment_id)) return cursor.experiment_id;
      seen.add(cursor.experiment_id);
      const parent = byId.get(cursor.parent_experiment_id);
      if (!parent) return cursor.experiment_id;
      cursor = parent;
    }
    return cursor.experiment_id;
  };
  const findings = usage.families.map((f) => ({
    family: f.root_label ?? f.root_id,
    attempts: experiments
      .filter((e) => e.node_kind !== "strategy" && famRoot(e) === f.root_id)
      .map((e) => ({
        label: e.display_label,
        title: e.title,
        outcome: e.outcome_status,
        established: e.failure_reason ?? e.interpretation ?? e.actual_observation ?? "no recorded establishment",
      })),
  }));
  const top = candidates[0];
  return {
    prior_findings: findings,
    remaining_hypotheses: hypotheses
      .filter((h) => !["rejected"].includes(h.status))
      .map((h) => ({ hypothesis_id: h.hypothesis_id, statement: h.statement, status: h.status })),
    untested_directions: [
      ...untested.map((h) => `Untested live hypothesis: "${h.statement}"`),
      ...exhaustion.what_would_change,
    ],
    best_supported_next_option: top
      ? `Refine ${top.label ?? top.experiment_id} (${top.title}); focus: ${top.suggested_focus ?? top.factors.map((f) => f.factor).join(", ")}.`
      : "No refinement candidate is supported by current evidence; research before designing the next experiment.",
    resumption:
      "All records persist. Resume by raising the budget via debug_budget_manage (recorded in the audit trail) or by supplying new evidence/hypotheses; the investigation keeps its tree, evidence, and timeline intact.",
  };
}
