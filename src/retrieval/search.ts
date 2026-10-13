import type { Store } from "../memory/store.ts";
import type { Incident } from "../types.ts";

/** Build a safe FTS5 MATCH expression from a free-text query (OR of quoted tokens). */
export function buildFtsQuery(query: string): string | null {
  const raw = (query ?? "").trim();
  if (!raw) return null;
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter((t) => t.length >= 2)
    .slice(0, 16)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  if (tokens.length === 0) return null;
  return tokens.join(" OR ");
}

export interface AttemptRef {
  experiment_id: string;
  label: string | null;
  title: string;
  execution_status: string;
  outcome_status: string;
  hypothesis_id: string | null;
  parent_experiment_id: string | null;
}

export interface CaseHit {
  incident: Incident;
  score: number;
  matched_via: string[];
  attempts: AttemptRef[];
  has_verified: boolean;
  explanation: string;
}

export interface SearchOutcome {
  ok: boolean;
  complete: boolean; // false when retrieval was degraded/unavailable
  unavailable_reason?: string;
  results: CaseHit[];
}

export interface SearchInput {
  query?: string;
  fingerprints?: string[];
  project_id?: string | null;
  include_cross_project?: boolean;
  limit?: number;
  include_evidence?: boolean;
}

/**
 * Ranked historical retrieval. Prioritises exact fingerprints, then full-text
 * matches over incident text and experiments. Distinguishes "no match" (complete
 * search, empty results) from "history unavailable" (degraded search).
 */
export function searchHistory(store: Store, input: SearchInput): SearchOutcome {
  const limit = Math.max(1, Math.min(100, Number(input.limit ?? 10)));
  try {
    const reasons = new Map<string, Set<string>>();
    const matchedExps = new Map<string, Set<string>>();
    const add = (incId: string, reason: string) => {
      if (!reasons.has(incId)) reasons.set(incId, new Set());
      reasons.get(incId)!.add(reason);
    };

    // 1) Exact fingerprints
    for (const fp of input.fingerprints ?? []) {
      const rows = store.db
        .query("SELECT incident_id FROM fingerprints WHERE fingerprint_value = ?")
        .all(fp) as { incident_id: string }[];
      for (const r of rows) add(r.incident_id, "exact_fingerprint");
    }

    const fts = buildFtsQuery(input.query ?? "");
    if (fts) {
      const incRows = store.db
        .query("SELECT incident_id FROM incident_fts WHERE incident_fts MATCH ?")
        .all(fts) as { incident_id: string }[];
      for (const r of incRows) add(r.incident_id, "full_text_incident");
      const expRows = store.db
        .query("SELECT incident_id, experiment_id FROM experiment_fts WHERE experiment_fts MATCH ?")
        .all(fts) as { incident_id: string; experiment_id: string }[];
      for (const r of expRows) {
        add(r.incident_id, "full_text_experiment");
        if (!matchedExps.has(r.incident_id)) matchedExps.set(r.incident_id, new Set());
        matchedExps.get(r.incident_id)!.add(r.experiment_id);
      }
    }

    const candidateIds = [...reasons.keys()];
    const hits: CaseHit[] = [];
    for (const incId of candidateIds) {
      const incident = store.db
        .query("SELECT * FROM incidents WHERE incident_id = ?")
        .get(incId) as Incident | null;
      if (!incident) continue;
      if (input.project_id && !input.include_cross_project && incident.project_id !== input.project_id)
        continue;

      const experiments = store.allExperiments(incId);
      const expSet = matchedExps.get(incId);
      let selected = expSet
        ? experiments.filter((e) => expSet.has(e.experiment_id))
        : experiments;
      if (selected.length === 0) selected = experiments.slice(0, 8);
      const attemptRefs: AttemptRef[] = selected
        .slice(0, 12)
        .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
        .map((e) => ({
          experiment_id: e.experiment_id,
          label: e.display_label,
          title: e.title,
          execution_status: e.execution_status,
          outcome_status: e.outcome_status,
          hypothesis_id: e.hypothesis_id,
          parent_experiment_id: e.parent_experiment_id,
        }));

      const hasVerified = store.getVerificationForIncident(incId).length > 0;

      // Scoring
      let score = 0;
      const rset = reasons.get(incId)!;
      if (rset.has("exact_fingerprint")) score += 100;
      if (rset.has("full_text_incident")) score += 10;
      score += Math.min(25, (expSet?.size ?? 0) * 5);
      if (input.project_id && incident.project_id === input.project_id) score += 5;
      score += hasVerified ? 3 : 0;

      const explanation = buildExplanation(rset, incident, input.project_id);
      void experiments;
      hits.push({ incident, score, matched_via: [...rset], attempts: attemptRefs, has_verified: hasVerified, explanation });
    }

    hits.sort((a, b) => b.score - a.score || (a.incident.created_at < b.incident.created_at ? 1 : -1));
    return { ok: true, complete: true, results: hits.slice(0, limit) };
  } catch (e) {
    return {
      ok: false,
      complete: false,
      unavailable_reason: e instanceof Error ? e.message : String(e),
      results: [],
    };
  }
}

function buildExplanation(reasons: Set<string>, incident: Incident, projectId?: string | null): string {
  const parts: string[] = [];
  if (reasons.has("exact_fingerprint")) parts.push("matched a stored error fingerprint (candidate, not proof of identical cause)");
  if (reasons.has("full_text_incident")) parts.push("matched incident symptom/title text");
  if (reasons.has("full_text_experiment")) parts.push("matched text of prior experiments");
  if (projectId && incident.project_id === projectId) parts.push("same project");
  return parts.length ? `Returned because it ${parts.join("; ")}.` : "Returned by search.";
}
