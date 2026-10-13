/**
 * Candidate ranking (engine, pure logic).
 *
 * Ranks previous attempts by *refinement potential* — never by recency, never
 * randomly. Scores are explainable heuristics, NOT calibrated probabilities of
 * success: every factor is reported with its weight and the evidence behind it.
 * Interrupted/inconclusive attempts are kept in a separate re-run bucket; they
 * are never silently treated as failures.
 */
import type { Experiment, Hypothesis, ResearchReference, Evidence } from "../types.ts";
import { detectDuplicateWarnings, type DupStore } from "../retrieval/duplicates.ts";
import { LIVE_HYPOTHESIS_STATUSES } from "./exhaustion.ts";

export interface RankedFactor {
  factor: string;
  weight: number;
  detail: string;
}

export interface RankedCandidate {
  experiment_id: string;
  label: string | null;
  title: string;
  outcome_status: string;
  execution_status: string;
  score: number;
  score_note: string; // always: heuristic, not a probability
  factors: RankedFactor[];
  cautions: string[];
  suggested_focus: string | null;
  hypothesis_id: string | null;
  family_root_id: string | null;
}

export interface RankingInput {
  experiments: Experiment[]; // all nodes (families computed from parents)
  hypotheses: Hypothesis[];
  research: ResearchReference[];
  evidence: Evidence[];
  dismissed_family_ids: Set<string>;
}

const RISK_BONUS: Record<string, number> = { low: 4, medium: 2, high: 0, unknown: 0 };

function familyRootOf(exp: Experiment, byId: Map<string, Experiment>): string | null {
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

/** Rank failed/partial attempts worth refining, plus the separate re-run bucket. */
export function rankRefinementCandidates(input: RankingInput, limit = 3): { candidates: RankedCandidate[]; rerun_candidates: RankedCandidate[] } {
  const { experiments, hypotheses, research, evidence, dismissed_family_ids } = input;
  const byId = new Map(experiments.map((e) => [e.experiment_id, e]));
  const liveHypIds = new Set(hypotheses.filter((h) => LIVE_HYPOTHESIS_STATUSES.has(h.status)).map((h) => h.hypothesis_id));
  const researchByExperiment = new Set(research.map((r) => r.experiment_id).filter(Boolean) as string[]);
  const researchByHypothesis = new Set(research.map((r) => r.hypothesis_id).filter(Boolean) as string[]);
  const evidenceByExperiment = new Set(evidence.map((e) => e.experiment_id).filter(Boolean) as string[]);
  const dupStore: DupStore = { allExperiments: (id: string) => experiments.filter((e) => e.incident_id === id) };

  const refineable = experiments.filter(
    (e) => e.node_kind !== "strategy" && (e.outcome_status === "failed" || e.outcome_status === "partial"),
  );
  const rerunnable = experiments.filter(
    (e) => e.node_kind !== "strategy" && (e.execution_status === "interrupted" || e.outcome_status === "inconclusive"),
  );

  const score = (e: Experiment): RankedCandidate => {
    const factors: RankedFactor[] = [];
    if (e.outcome_status === "partial") {
      factors.push({ factor: "partial_improvement", weight: 30, detail: `Observed: ${e.actual_observation ?? e.interpretation ?? "partial improvement"} — part of the failure condition improved.` });
    }
    if (e.environment_delta) {
      factors.push({ factor: "environment_changed", weight: 15, detail: `Environment delta recorded (${e.environment_delta}) — the failure may not reproduce under current conditions.` });
    }
    if (e.failure_reason) factors.push({ factor: "informative_failure", weight: 10, detail: `The failure established something: ${e.failure_reason}` });
    if (e.interpretation) factors.push({ factor: "interpreted_outcome", weight: 5, detail: `Interpretation on record: ${e.interpretation}` });
    if (e.hypothesis_id && liveHypIds.has(e.hypothesis_id)) {
      factors.push({ factor: "live_hypothesis", weight: 10, detail: "The hypothesis it tested is still live (not rejected)." });
    }
    if (researchByExperiment.has(e.experiment_id) || (e.hypothesis_id && researchByHypothesis.has(e.hypothesis_id))) {
      factors.push({ factor: "research_linked", weight: 6, detail: "Research findings are linked to this attempt or its hypothesis." });
    }
    if (evidenceByExperiment.has(e.experiment_id)) {
      factors.push({ factor: "evidence_backed", weight: 5, detail: "Direct observations are attached, so the outcome is well-supported." });
    }
    const riskBonus = RISK_BONUS[e.risk_level] ?? 0;
    if (riskBonus > 0) factors.push({ factor: "low_risk", weight: riskBonus, detail: `Risk level '${e.risk_level}' — a refinement is cheap to try.` });

    // Duplication proximity: candidates highly similar to other failures are less informative
    const dups = detectDuplicateWarnings(dupStore, e);
    const dupPenalty = Math.min(12, dups.length * 6);
    if (dupPenalty > 0) {
      factors.push({ factor: "duplicate_proximity", weight: -dupPenalty, detail: `Similar to ${dups.length} other recorded attempt(s) (${dups.map((d) => d.label ?? d.experiment_id).slice(0, 3).join(", ")}); refining it may repeat known ground.` });
    }

    const cautions: string[] = [];
    const familyRoot = familyRootOf(e, byId);
    if (familyRoot && dismissed_family_ids.has(familyRoot)) {
      cautions.push("Its strategy family was explicitly dismissed — revisiting requires a recorded reason (changed conditions or new evidence).");
    }
    if (dups.length > 0) {
      cautions.push("A justified retry needs a stated changed condition or new evidence; the duplicate warning is advisory, not a prohibition.");
    }

    const suggested = e.failure_reason ?? e.actual_observation ?? e.interpretation ?? null;
    const total = factors.reduce((s, f) => s + f.weight, 0);
    return {
      experiment_id: e.experiment_id,
      label: e.display_label,
      title: e.title,
      outcome_status: e.outcome_status,
      execution_status: e.execution_status,
      score: total,
      score_note: "Heuristic refinement-potential score (explainable factors, not a probability of success).",
      factors,
      cautions,
      suggested_focus: suggested ? `The recorded outcome suggests focusing the variation on: ${suggested}` : null,
      hypothesis_id: e.hypothesis_id,
      family_root_id: familyRoot,
    };
  };

  const candidates = refineable
    .map(score)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));

  const rerun = rerunnable.map(score).sort((a, b) => b.score - a.score);

  return { candidates, rerun_candidates: rerun };
}

/** Untested live hypotheses that still offer meaningful experiments. */
export function untestedLiveHypotheses(hypotheses: Hypothesis[], experiments: Experiment[]): Hypothesis[] {
  const tested = new Set(experiments.map((e) => e.hypothesis_id).filter(Boolean) as string[]);
  return hypotheses.filter((h) => LIVE_HYPOTHESIS_STATUSES.has(h.status) && !tested.has(h.hypothesis_id));
}
