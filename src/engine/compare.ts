/**
 * Candidate comparison engine (pure logic).
 *
 * Compares proposed experiments against prior attempts and against each
 * other before execution, per Tool Catalogue §6.3.
 *
 * Evaluates:
 * - Shared vs diverging hypotheses & assumptions
 * - Changed variables and action overlap
 * - Supporting vs contradicting prior evidence
 * - Expected information gain / diagnostic value
 * - Risk, cost, reversibility, and budget impact
 * - Near-duplicate / equivalence warnings against prior failures
 * - Qualitative ranking with explainable heuristic factors (never false probabilities)
 */

import type { Experiment, Hypothesis, ResearchReference, Evidence, Incident } from "../types.ts";
import { detectDuplicateWarnings, type DupStore } from "../retrieval/duplicates.ts";
import { LIVE_HYPOTHESIS_STATUSES } from "./exhaustion.ts";

export interface NormalizedCandidateInput {
  candidate_id: string;
  title: string;
  proposed_change: string;
  rationale: string;
  expected_observation: string | null;
  risk_level: string;
  hypothesis_id: string | null;
  parent_experiment_id: string | null;
  is_existing_experiment: boolean;
  existing_experiment?: Experiment;
}

export interface CandidateComparisonEntry {
  candidate_id: string;
  label: string | null;
  title: string;
  proposed_change: string;
  rationale: string;
  expected_observation: string | null;
  risk_level: string;
  reversibility: "high" | "moderate" | "low";
  hypothesis: {
    hypothesis_id: string | null;
    statement: string | null;
    status: string | null;
    is_live: boolean;
  };
  parent: {
    parent_id: string | null;
    parent_label: string | null;
    parent_outcome: string | null;
  };
  evidence_summary: {
    supporting_count: number;
    supporting_evidence_ids: string[];
    contradicting_prior_failures: Array<{ experiment_id: string; label: string | null; summary: string }>;
  };
  duplicate_warnings: Array<{
    experiment_id: string;
    label: string | null;
    similarity: number;
    match: string;
    note: string;
  }>;
  heuristic_score: number;
  score_factors: Array<{ factor: string; weight: number; detail: string }>;
  cautions: string[];
}

export interface PairwiseComparison {
  pair: [string, string]; // [candidate_a_id, candidate_b_id]
  shared_aspects: string[];
  diverging_aspects: string[];
  action_overlap_pct: number;
  tradeoff_summary: string;
}

export interface CandidateComparisonReport {
  incident_id: string;
  candidates_evaluated: number;
  candidates: CandidateComparisonEntry[];
  pairwise_comparisons: PairwiseComparison[];
  recommended_order: string[];
  overall_rationale: string;
  planning_note: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "and", "or", "if", "is", "it", "for",
  "with", "run", "check", "add", "try", "use", "make", "set", "get", "fix",
]);

function tokenize(text: string): Set<string> {
  const words = (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

const RISK_BONUS: Record<string, number> = { low: 5, medium: 2, high: 0, unknown: 1 };

function estimateReversibility(riskLevel: string, proposedChange: string): "high" | "moderate" | "low" {
  const lower = proposedChange.toLowerCase();
  if (lower.includes("delete") || lower.includes("drop") || lower.includes("purge") || riskLevel === "high") {
    return "low";
  }
  if (lower.includes("modify") || lower.includes("replace") || lower.includes("upgrade") || riskLevel === "medium") {
    return "moderate";
  }
  return "high";
}

export function compareCandidatesEngine(params: {
  incident: Incident;
  candidates: NormalizedCandidateInput[];
  experiments: Experiment[];
  hypotheses: Hypothesis[];
  research: ResearchReference[];
  evidence: Evidence[];
}): CandidateComparisonReport {
  const { incident, candidates, experiments, hypotheses, research, evidence } = params;

  const hypMap = new Map(hypotheses.map((h) => [h.hypothesis_id, h]));
  const expMap = new Map(experiments.map((e) => [e.experiment_id, e]));
  const dupStore: DupStore = {
    allExperiments: (incId: string) => experiments.filter((e) => e.incident_id === incId),
  };

  const researchByHypothesis = new Set(research.map((r) => r.hypothesis_id).filter(Boolean) as string[]);
  const researchByExperiment = new Set(research.map((r) => r.experiment_id).filter(Boolean) as string[]);

  // 1. Analyze each candidate
  const entries: CandidateComparisonEntry[] = candidates.map((cand) => {
    const factors: Array<{ factor: string; weight: number; detail: string }> = [];
    const cautions: string[] = [];

    // Hypothesis resolution
    const hyp = cand.hypothesis_id ? hypMap.get(cand.hypothesis_id) : undefined;
    const isLiveHyp = hyp ? LIVE_HYPOTHESIS_STATUSES.has(hyp.status) : false;

    if (hyp) {
      if (isLiveHyp) {
        factors.push({
          factor: "live_hypothesis",
          weight: 12,
          detail: `Tests live hypothesis: "${hyp.statement.slice(0, 80)}" (${hyp.status}).`,
        });
      } else {
        cautions.push(`Associated hypothesis status is '${hyp.status}', which is not currently active.`);
      }
    } else {
      cautions.push("Candidate has no explicitly associated hypothesis.");
    }

    // Parent resolution
    const parent = cand.parent_experiment_id ? expMap.get(cand.parent_experiment_id) : undefined;

    // Risk and reversibility
    const riskBonus = RISK_BONUS[cand.risk_level] ?? 1;
    if (riskBonus > 0) {
      factors.push({
        factor: "risk_tolerance",
        weight: riskBonus,
        detail: `Risk level is '${cand.risk_level}' (+${riskBonus}).`,
      });
    }
    const reversibility = estimateReversibility(cand.risk_level, cand.proposed_change);

    // Prior evidence & research support
    const supportingEv = evidence.filter((ev) => {
      if (cand.parent_experiment_id && ev.experiment_id === cand.parent_experiment_id) return true;
      if (cand.hypothesis_id && ev.hypothesis_id === cand.hypothesis_id) return true;
      return false;
    });

    if (supportingEv.length > 0) {
      factors.push({
        factor: "evidence_supported",
        weight: Math.min(10, supportingEv.length * 3),
        detail: `${supportingEv.length} prior evidence record(s) link to this hypothesis or parent branch.`,
      });
    }

    if (
      (cand.hypothesis_id && researchByHypothesis.has(cand.hypothesis_id)) ||
      (cand.parent_experiment_id && researchByExperiment.has(cand.parent_experiment_id))
    ) {
      factors.push({
        factor: "research_backing",
        weight: 6,
        detail: "External or technical research findings are on record for this direction.",
      });
    }

    // Contradicting prior failures under same hypothesis
    const contradictingFailures = cand.hypothesis_id
      ? experiments.filter(
          (e) =>
            e.hypothesis_id === cand.hypothesis_id &&
            e.experiment_id !== cand.candidate_id &&
            e.outcome_status === "failed",
        )
      : [];

    if (contradictingFailures.length > 0) {
      cautions.push(
        `${contradictingFailures.length} prior attempt(s) under this hypothesis failed (${contradictingFailures
          .map((f) => f.display_label ?? f.experiment_id)
          .join(", ")}). A new variant requires an explicit difference.`,
      );
    }

    // Synthetic Experiment to run duplicate detection
    const syntheticExp: Experiment = cand.is_existing_experiment && cand.existing_experiment
      ? cand.existing_experiment
      : {
          experiment_id: cand.candidate_id,
          incident_id: incident.incident_id,
          strategy_id: null,
          hypothesis_id: cand.hypothesis_id,
          parent_experiment_id: cand.parent_experiment_id,
          inspired_by_experiment_id: null,
          display_label: null,
          node_kind: "experiment",
          title: cand.title,
          proposed_change: cand.proposed_change,
          reason_for_difference: null,
          expected_observation: cand.expected_observation,
          preconditions: null,
          environment_id: null,
          risk_level: cand.risk_level,
          estimated_cost: null,
          execution_status: "not_started",
          outcome_status: "pending",
          actual_observation: null,
          interpretation: null,
          failure_reason: null,
          environment_delta: null,
          display_order: 0,
          started_at: null,
          completed_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          created_by: "agent",
          approval_record_id: null,
        };

    const rawWarnings = detectDuplicateWarnings(dupStore, syntheticExp);
    const duplicateWarnings = rawWarnings.map((w) => ({
      experiment_id: w.experiment_id,
      label: w.label,
      similarity: w.similarity,
      match: w.match,
      note: w.note,
    }));

    if (duplicateWarnings.length > 0) {
      const penalty = Math.min(15, duplicateWarnings.length * 6);
      factors.push({
        factor: "duplicate_proximity_penalty",
        weight: -penalty,
        detail: `Close overlap with ${duplicateWarnings.length} earlier attempt(s). Risk of uninformative retry.`,
      });
      cautions.push(
        `Near-duplicate warning: overlaps with ${duplicateWarnings.map((d) => d.label ?? d.experiment_id).join(", ")}.`,
      );
    }

    const baseScore = 20;
    const totalScore = baseScore + factors.reduce((sum, f) => sum + f.weight, 0);

    return {
      candidate_id: cand.candidate_id,
      label: cand.is_existing_experiment ? cand.existing_experiment?.display_label ?? null : null,
      title: cand.title,
      proposed_change: cand.proposed_change,
      rationale: cand.rationale,
      expected_observation: cand.expected_observation,
      risk_level: cand.risk_level,
      reversibility,
      hypothesis: {
        hypothesis_id: cand.hypothesis_id,
        statement: hyp?.statement ?? null,
        status: hyp?.status ?? null,
        is_live: isLiveHyp,
      },
      parent: {
        parent_id: cand.parent_experiment_id,
        parent_label: parent?.display_label ?? null,
        parent_outcome: parent?.outcome_status ?? null,
      },
      evidence_summary: {
        supporting_count: supportingEv.length,
        supporting_evidence_ids: supportingEv.map((ev) => ev.evidence_id),
        contradicting_prior_failures: contradictingFailures.map((f) => ({
          experiment_id: f.experiment_id,
          label: f.display_label,
          summary: f.failure_reason ?? f.title,
        })),
      },
      duplicate_warnings: duplicateWarnings,
      heuristic_score: totalScore,
      score_factors: factors,
      cautions,
    };
  });

  // 2. Pairwise comparisons across candidates
  const pairwiseComparisons: PairwiseComparison[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];

      const shared: string[] = [];
      const diverging: string[] = [];

      if (a.hypothesis.hypothesis_id && a.hypothesis.hypothesis_id === b.hypothesis.hypothesis_id) {
        shared.push(`Target identical hypothesis: "${a.hypothesis.statement?.slice(0, 60)}..."`);
      } else {
        diverging.push(
          `Target distinct hypotheses: A tests "${a.hypothesis.statement?.slice(0, 40) ?? "none"}" vs B tests "${b.hypothesis.statement?.slice(0, 40) ?? "none"}"`,
        );
      }

      if (a.parent.parent_id && a.parent.parent_id === b.parent.parent_id) {
        shared.push(`Shared parent branch (${a.parent.parent_label ?? a.parent.parent_id})`);
      } else if (a.parent.parent_id || b.parent.parent_id) {
        diverging.push(`Differing branches/origins`);
      }

      if (a.risk_level === b.risk_level) {
        shared.push(`Equal risk level (${a.risk_level})`);
      } else {
        diverging.push(`Risk differential: Candidate A is ${a.risk_level} vs Candidate B is ${b.risk_level}`);
      }

      if (a.reversibility !== b.reversibility) {
        diverging.push(`Reversibility: Candidate A is ${a.reversibility} vs Candidate B is ${b.reversibility}`);
      }

      const tokensA = tokenize([a.title, a.proposed_change, a.rationale].join(" "));
      const tokensB = tokenize([b.title, b.proposed_change, b.rationale].join(" "));
      const sim = jaccardSimilarity(tokensA, tokensB);
      const overlapPct = Math.round(sim * 100);

      let tradeoff = "";
      if (a.heuristic_score > b.heuristic_score) {
        tradeoff = `Candidate ${a.candidate_id} ranks higher (+${a.heuristic_score - b.heuristic_score} pts) due to ${a.score_factors.map((f) => f.factor).join(", ")}.`;
      } else if (b.heuristic_score > a.heuristic_score) {
        tradeoff = `Candidate ${b.candidate_id} ranks higher (+${b.heuristic_score - a.heuristic_score} pts) due to ${b.score_factors.map((f) => f.factor).join(", ")}.`;
      } else {
        tradeoff = `Both candidates have equal heuristic support (${a.heuristic_score} pts).`;
      }

      pairwiseComparisons.push({
        pair: [a.candidate_id, b.candidate_id],
        shared_aspects: shared,
        diverging_aspects: diverging,
        action_overlap_pct: overlapPct,
        tradeoff_summary: tradeoff,
      });
    }
  }

  // 3. Recommended order & overall rationale
  const sorted = [...entries].sort((x, y) => y.heuristic_score - x.heuristic_score);
  const recommendedOrder = sorted.map((e) => e.candidate_id);

  const top = sorted[0];
  const overallRationale = top
    ? `Candidate '${top.title}' (${top.candidate_id}) is recommended first (score ${top.heuristic_score}). Key factors: ${top.score_factors
        .map((f) => `${f.factor} (${f.weight > 0 ? "+" : ""}${f.weight})`)
        .join(", ")}.${top.cautions.length > 0 ? ` Note cautions: ${top.cautions.join("; ")}` : ""}`
    : "No candidates to rank.";

  return {
    incident_id: incident.incident_id,
    candidates_evaluated: entries.length,
    candidates: entries,
    pairwise_comparisons: pairwiseComparisons,
    recommended_order: recommendedOrder,
    overall_rationale: overallRationale,
    planning_note:
      "Comparison matrix and heuristic ranking are planning aids only. They do NOT represent true probabilities of success. The host agent and user retain final execution and permission approval.",
  };
}
