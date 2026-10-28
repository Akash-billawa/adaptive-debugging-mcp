import type { Store } from "../memory/store.ts";
import type { Incident } from "../types.ts";
import { searchSemantic } from "./semantic.ts";
import { redact } from "../security/redaction.ts";

/** Build a safe FTS5 MATCH expression from a free-text query (OR of quoted tokens). */
export function buildFtsQuery(query: string): string | null {
  const raw = (query ?? "").replace(/[-./\\]/g, " ").trim();
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
  semantic?: boolean;
  min_similarity?: number;
  active_incident_id?: string | null;
  exclude_incident_id?: string | null;
}

/**
 * Ranked hybrid historical retrieval. Prioritises exact fingerprints, then full-text
 * matches over incident text and experiments, augmented by dense semantic vector similarity.
 * Distinguishes "no match" (complete search, empty results) from "history unavailable" (degraded search).
 */
export function searchHistory(store: Store, input: SearchInput): SearchOutcome {
  const limit = Math.max(1, Math.min(100, Number(input.limit ?? 10)));
  try {
    const reasons = new Map<string, Set<string>>();
    const matchedExps = new Map<string, Set<string>>();
    const similarityScores = new Map<string, number>();

    const excludedIds = new Set<string>();
    if (input.active_incident_id) excludedIds.add(input.active_incident_id);
    if (input.exclude_incident_id) excludedIds.add(input.exclude_incident_id);

    const add = (incId: string, reason: string) => {
      if (excludedIds.has(incId)) return;
      if (!reasons.has(incId)) reasons.set(incId, new Set());
      reasons.get(incId)!.add(reason);
    };

    const pid = typeof input.project_id === "string" && !input.include_cross_project ? input.project_id : null;

    // 1) Exact fingerprints
    for (const fp of input.fingerprints ?? []) {
      const rows = pid
        ? (store.db
            .query("SELECT f.incident_id FROM fingerprints f JOIN incidents i ON i.incident_id = f.incident_id WHERE f.fingerprint_value = ? AND i.project_id = ?")
            .all(fp, pid) as { incident_id: string }[])
        : (store.db
            .query("SELECT incident_id FROM fingerprints WHERE fingerprint_value = ?")
            .all(fp) as { incident_id: string }[]);
      for (const r of rows) add(r.incident_id, "exact_fingerprint");
    }

    // 2) Full-text search (FTS5)
    const fts = buildFtsQuery(input.query ?? "");
    if (fts) {
      const incRows = pid
        ? (store.db
            .query("SELECT incident_id FROM incident_fts WHERE incident_fts MATCH ? AND project_id = ?")
            .all(fts, pid) as { incident_id: string }[])
        : (store.db
            .query("SELECT incident_id FROM incident_fts WHERE incident_fts MATCH ?")
            .all(fts) as { incident_id: string }[]);
      for (const r of incRows) add(r.incident_id, "full_text_incident");

      const expRows = pid
        ? (store.db
            .query("SELECT fts.incident_id, fts.experiment_id FROM experiment_fts fts JOIN incidents i ON i.incident_id = fts.incident_id WHERE experiment_fts MATCH ? AND i.project_id = ?")
            .all(fts, pid) as { incident_id: string; experiment_id: string }[])
        : (store.db
            .query("SELECT incident_id, experiment_id FROM experiment_fts WHERE experiment_fts MATCH ?")
            .all(fts) as { incident_id: string; experiment_id: string }[]);
      for (const r of expRows) {
        add(r.incident_id, "full_text_experiment");
        if (!matchedExps.has(r.incident_id)) matchedExps.set(r.incident_id, new Set());
        matchedExps.get(r.incident_id)!.add(r.experiment_id);
      }
    }

    // 3) Dense semantic vector similarity
    const useSemantic = input.semantic !== false;
    if (useSemantic && input.query && input.query.trim()) {
      try {
        const cleanQuery = redact(input.query).text.replace(/\[REDACTED:[^\]]+\]/g, "").trim();
        if (cleanQuery.length >= 3) {
          const semanticHits = searchSemantic(store, cleanQuery, {
            minSimilarity: input.min_similarity ?? 0.35,
            limit: 30,
            projectId: pid ?? undefined,
          });

        for (const hit of semanticHits) {
          if (hit.entity_type === "incident") {
            add(hit.entity_id, "semantic_similarity");
            const prev = similarityScores.get(hit.entity_id) ?? 0;
            if (hit.similarity > prev) similarityScores.set(hit.entity_id, hit.similarity);
          } else if (hit.entity_type === "experiment") {
            const row = store.db
              .query("SELECT incident_id FROM experiments WHERE experiment_id = ?")
              .get(hit.entity_id) as { incident_id: string } | null;
            if (row) {
              add(row.incident_id, "semantic_similarity");
              const prev = similarityScores.get(row.incident_id) ?? 0;
              if (hit.similarity > prev) similarityScores.set(row.incident_id, hit.similarity);
              if (!matchedExps.has(row.incident_id)) matchedExps.set(row.incident_id, new Set());
              matchedExps.get(row.incident_id)!.add(hit.entity_id);
            }
          }
        }
      }
    } catch {
      // Semantic search failure shouldn't crash baseline search
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

      // Hybrid scoring
      let score = 0;
      const rset = reasons.get(incId)!;
      if (rset.has("exact_fingerprint")) score += 100;
      if (rset.has("full_text_incident")) score += 10;
      score += Math.min(25, (expSet?.size ?? 0) * 5);

      if (rset.has("semantic_similarity")) {
        const sim = similarityScores.get(incId) ?? 0.5;
        score += Math.round(sim * 40); // 0 - 40 points
      }

      if (input.project_id && incident.project_id === input.project_id) score += 5;
      score += hasVerified ? 3 : 0;

      const explanation = buildExplanation(
        rset,
        incident,
        input.project_id,
        similarityScores.get(incId),
      );

      hits.push({
        incident,
        score,
        matched_via: [...rset],
        attempts: attemptRefs,
        has_verified: hasVerified,
        explanation,
      });
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

function buildExplanation(
  reasons: Set<string>,
  incident: Incident,
  projectId?: string | null,
  similarity?: number,
): string {
  const parts: string[] = [];
  if (reasons.has("exact_fingerprint"))
    parts.push("matched a stored error fingerprint (candidate, not proof of identical cause)");
  if (reasons.has("full_text_incident")) parts.push("matched incident symptom/title text");
  if (reasons.has("full_text_experiment")) parts.push("matched text of prior experiments");
  if (reasons.has("semantic_similarity")) {
    const pct = similarity !== undefined ? Math.round(similarity * 100) : 0;
    parts.push(`matched dense semantic vector similarity (${pct}%)`);
  }
  if (projectId && incident.project_id === projectId) parts.push("same project");
  return parts.length ? `Returned because it ${parts.join("; ")}.` : "Returned by search.";
}
