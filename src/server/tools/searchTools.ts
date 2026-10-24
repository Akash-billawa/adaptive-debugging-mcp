import type { Tool, ToolContext } from "../context.ts";
import { str, objSchema, optStr, optBool, arr } from "../context.ts";
import { buildFtsQuery, searchHistory } from "../../retrieval/search.ts";
import { syncAllEmbeddings } from "../../retrieval/semantic.ts";

export const searchTools: Tool[] = [
  {
    def: {
      name: "debug_history_search",
      description:
        "Search prior incidents and attempts using hybrid retrieval (exact fingerprints + FTS5 full-text + dense semantic vector similarity) " +
        "BEFORE proposing a new experiment. Returns failed and inconclusive attempts too, with explainable matched_via signals. " +
        "Distinguishes 'no match' from 'history unavailable'.",
      inputSchema: objSchema(
        "Search debugging history",
        {
          query: str("Error text, symptom, component, command, or keywords (free text)"),
          fingerprints: arr("Exact fingerprint values", str("fingerprint")),
          project_id: str("Restrict to this project"),
          include_cross_project: { type: "boolean", description: "Include other projects (default false)", default: false },
          limit: { type: "number", description: "Max results", default: 10 },
          semantic: { type: "boolean", description: "Enable dense semantic vector similarity (default true)", default: true },
          min_similarity: { type: "number", description: "Minimum cosine similarity threshold (default 0.25)", default: 0.25 },
        },
        [],
      ),
    },
    handle(ctx, args) {
      const query = optStr(args, "query") ?? "";
      const fingerprints = Array.isArray(args.fingerprints) ? (args.fingerprints as unknown[]).map(String) : [];
      const res = searchHistory(ctx.store, {
        query,
        fingerprints,
        project_id: optStr(args, "project_id"),
        include_cross_project: optBool(args, "include_cross_project", false),
        limit: Number(args.limit ?? 10),
        semantic: optBool(args, "semantic", true),
        min_similarity: typeof args.min_similarity === "number" ? args.min_similarity : 0.25,
      });

      if (!res.complete) {
        return {
          ok: false,
          complete: false,
          history_unavailable: true,
          reason: res.unavailable_reason ?? "retrieval degraded",
          results: [],
          warnings: ["history_unavailable_do_not_infer_absence"],
        };
      }

      const results = res.results.map((h) => ({
        incident_id: h.incident.incident_id,
        title: h.incident.title,
        status: h.incident.status,
        reproduction_status: h.incident.reproduction_status,
        outcome_overview: h.attempts.reduce<Record<string, number>>((acc, a) => {
          acc[a.outcome_status] = (acc[a.outcome_status] ?? 0) + 1;
          return acc;
        }, {}),
        score: h.score,
        matched_via: h.matched_via,
        explanation: h.explanation,
        has_verified: h.has_verified,
        attempts: h.attempts.map((a) => ({
          experiment_id: a.experiment_id,
          label: a.label,
          title: a.title,
          execution_status: a.execution_status,
          outcome_status: a.outcome_status,
          hypothesis_id: a.hypothesis_id,
          parent_experiment_id: a.parent_experiment_id,
        })),
      }));

      return {
        ok: true,
        complete: true,
        history_unavailable: false,
        match_count: results.length,
        results,
        no_match_note: results.length === 0 ? "No relevant history found (search completed normally)." : undefined,
        fts_query: buildFtsQuery(query) ?? undefined,
        warnings: [],
      };
    },
  },

  {
    def: {
      name: "debug_semantic_index",
      description:
        "Inspect or synchronize dense vector embeddings for hybrid retrieval. " +
        "Indexes any unindexed incidents and experiments using local deterministic subword feature hashing.",
      inputSchema: objSchema(
        "Synchronize vector embeddings",
        {
          reindex_all: { type: "boolean", description: "Whether to re-embed all records or only new ones (default false)", default: false },
        },
        [],
      ),
    },
    handle(ctx, args) {
      if (optBool(args, "reindex_all", false)) {
        ctx.store.db.run("DELETE FROM embeddings");
      }
      const stats = syncAllEmbeddings(ctx.store);
      return {
        ok: true,
        stats,
        message: `Embeddings synchronized: ${stats.indexed_incidents} incidents and ${stats.indexed_experiments} experiments indexed (total: ${stats.total_embeddings}).`,
      };
    },
  },
];
