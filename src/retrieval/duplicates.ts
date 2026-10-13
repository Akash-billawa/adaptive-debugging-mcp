import type { Experiment } from "../types.ts";

/** Minimal structural view of the Store needed for duplicate detection. */
export interface DupStore {
  allExperiments(incidentId: string): Experiment[];
}

export interface DuplicateWarning {
  experiment_id: string;
  label: string | null;
  outcome_status: string;
  similarity: number;
  match: "exact_action" | "high_overlap";
  note: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "and", "or", "if", "is", "it", "for",
  "with", "run", "check", "add", "try", "use", "make", "set", "get", "fix",
]);

function tokens(text: string): Set<string> {
  const words = (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function normalizedAction(text: string): string {
  return (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

const THRESHOLD = 0.6;

/**
 * Heuristic equivalent-attempt detection. Compares the candidate against other
 * experiments in the same incident using the diagnostic action + hypothesis.
 * A flagged duplicate is a warning, not a hard block: a retry may be justified by
 * new evidence or a changed environment, which the caller must state explicitly.
 */
export function detectDuplicateWarnings(store: DupStore, candidate: Experiment): DuplicateWarning[] {
  const others = store.allExperiments(candidate.incident_id).filter((e) => e.experiment_id !== candidate.experiment_id);
  const warnings: DuplicateWarning[] = [];
  const candTokens = tokens(
    [candidate.title, candidate.proposed_change ?? "", candidate.reason_for_difference ?? ""].join(" "),
  );
  const candAction = normalizedAction(candidate.proposed_change ?? candidate.title);

  for (const e of others) {
    const eTokens = tokens([e.title, e.proposed_change ?? "", e.reason_for_difference ?? ""].join(" "));
    const eAction = normalizedAction(e.proposed_change ?? e.title);
    const sim = jaccard(candTokens, eTokens);
    const sameHypothesis =
      candidate.hypothesis_id && e.hypothesis_id && candidate.hypothesis_id === e.hypothesis_id;

    if (candAction && candAction === eAction) {
      warnings.push({
        experiment_id: e.experiment_id,
        label: e.display_label,
        outcome_status: e.outcome_status,
        similarity: 1,
        match: "exact_action",
        note: `Identical diagnostic action to ${e.display_label ?? e.experiment_id} (outcome: ${e.outcome_status}). Justify with changed conditions or new evidence, or choose a materially different experiment.`,
      });
    } else if (sim >= THRESHOLD && (sameHypothesis || sim >= 0.75)) {
      warnings.push({
        experiment_id: e.experiment_id,
        label: e.display_label,
        outcome_status: e.outcome_status,
        similarity: Number(sim.toFixed(2)),
        match: "high_overlap",
        note: `High overlap (~${sim.toFixed(2)}) with ${e.display_label ?? e.experiment_id} (outcome: ${e.outcome_status})${sameHypothesis ? " under the same hypothesis" : ""}. Confirm this tests a meaningfully different assumption.`,
      });
    }
  }
  return warnings;
}
