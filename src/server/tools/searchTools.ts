import type { Tool, ToolContext } from "../context.ts";
import { str, objSchema, optStr, optBool, arr } from "../context.ts";
import { buildFtsQuery, searchHistory } from "../../retrieval/search.ts";

export const searchTools: Tool[] = [
  {
    def: {
      name: "debug_history_search",
      description:
        "Search prior incidents and attempts (fingerprints + full text) BEFORE proposing a new experiment. " +
        "Returns failed and inconclusive attempts too, with reasons for each match. Distinguishes 'no match' from 'history unavailable'.",
      inputSchema: objSchema(
        "Search debugging history",
        {
          query: str("Error text, symptom, component, command, or keywords (free text)"),
          fingerprints: arr("Exact fingerprint values", str("fingerprint")),
          project_id: str("Restrict to this project"),
          include_cross_project: { type: "boolean", description: "Include other projects (default false)", default: false },
          limit: { type: "number", description: "Max results", default: 10 },
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
        outcome_overview: h.attempts.reduce<Record<string, number>>((acc, a) => { acc[a.outcome_status] = (acc[a.outcome_status] ?? 0) + 1; return acc; }, {}),
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
];
