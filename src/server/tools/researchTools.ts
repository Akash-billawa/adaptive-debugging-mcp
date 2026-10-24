import type { Tool } from "../context.ts";
import { str, num, bool, arr, objSchema, optStr, reqStr, optBool, optArr } from "../context.ts";
import { validationError } from "../../errors.ts";
import { isOneOf, RESEARCH_TYPES } from "../../vocab.ts";
import { planResearch } from "../../research/planner.ts";
import { analyzeCodebase } from "../../research/codebase.ts";
import { evaluateSources } from "../../research/evaluator.ts";
import type { CandidateSourceInput, CodebaseAnalysisType, ResearchEnvironment } from "../../research/types.ts";

const ANALYSIS_TYPES: CodebaseAnalysisType[] = [
  "manifest_versions",
  "git_log",
  "git_blame",
  "git_diff",
  "file_snippet",
];

export const researchTools: Tool[] = [
  {
    def: {
      name: "debug_research_plan",
      description:
        "Formulate a focused research plan for an incident. Decomposes error tokens, unresolved hypotheses, " +
        "and failed attempts into concrete, prioritized research questions and recommends authoritative source types. " +
        "Read-only planning aid.",
      inputSchema: objSchema(
        "Plan technical research questions",
        {
          incident_id: str("Incident id"),
        },
        ["incident_id"],
      ),
    },
    handle(ctx, args) {
      const incidentId = reqStr(args, "incident_id");
      const incident = ctx.store.getIncidentOrFail(incidentId);
      const hypotheses = ctx.store.listHypotheses(incidentId);
      const attempts = ctx.store.allExperiments(incidentId);

      const envRow = ctx.store.db
        .query(
          "SELECT * FROM environments WHERE experiment_id IN (SELECT experiment_id FROM experiments WHERE incident_id = ?) OR experiment_id IS NULL ORDER BY captured_at DESC LIMIT 1",
        )
        .get(incidentId) as any;

      const env: ResearchEnvironment | null = envRow
        ? {
            ...envRow,
            packages: typeof envRow.packages === "string" ? JSON.parse(envRow.packages) : envRow.packages,
            env_vars: typeof envRow.env_vars === "string" ? JSON.parse(envRow.env_vars) : envRow.env_vars,
            metadata: typeof envRow.metadata === "string" ? JSON.parse(envRow.metadata) : envRow.metadata,
          }
        : null;

      const plan = planResearch(incident, hypotheses, attempts, env);
      return { ok: true, plan };
    },
  },

  {
    def: {
      name: "debug_codebase_analyze",
      description:
        "Inspect the local repository (git commit history, git blame, git diffs, package manifests, or file snippets) " +
        "safely in a read-only manner. Automatically redacts secrets, flags content as untrusted data, and optionally " +
        "records the finding directly into research_references.",
      inputSchema: objSchema(
        "Analyze codebase or git history",
        {
          incident_id: str("Incident id"),
          analysis_type: str("Analysis type", { enum: ANALYSIS_TYPES }),
          repo_path: str("Optional repository root directory (defaults to current working directory)"),
          target_file: str("Relative file path for git_blame, git_log, or file_snippet"),
          line_start: num("Starting line number (1-based)"),
          line_end: num("Ending line number (1-based)"),
          max_results: num("Max results for git_log (default 10)"),
          revision: str("Git revision for diff (default 'HEAD')"),
          auto_record: bool("If true, automatically stores this finding as a research_reference in the database"),
          claim_supported_or_challenged: str("Required if auto_record=true: what this analysis established"),
          hypothesis_id: str("Optional hypothesis id to link when auto_record=true"),
          experiment_id: str("Optional experiment id to link when auto_record=true"),
        },
        ["incident_id", "analysis_type"],
      ),
    },
    handle(ctx, args) {
      const incidentId = reqStr(args, "incident_id");
      ctx.store.getIncidentOrFail(incidentId);

      const analysisType = reqStr(args, "analysis_type") as CodebaseAnalysisType;
      if (!isOneOf(ANALYSIS_TYPES, analysisType)) {
        throw validationError(`invalid analysis_type: ${analysisType}`);
      }

      const finding = analyzeCodebase({
        repo_path: optStr(args, "repo_path"),
        analysis_type: analysisType,
        target_file: optStr(args, "target_file"),
        line_start: typeof args.line_start === "number" ? args.line_start : undefined,
        line_end: typeof args.line_end === "number" ? args.line_end : undefined,
        max_results: typeof args.max_results === "number" ? args.max_results : undefined,
        revision: optStr(args, "revision"),
      });

      const autoRecord = optBool(args, "auto_record", false);
      let researchReferenceId: string | undefined;

      if (autoRecord) {
        const claim = optStr(args, "claim_supported_or_challenged");
        if (!claim) {
          throw validationError("claim_supported_or_challenged is required when auto_record is true");
        }

        const sourceType =
          analysisType === "manifest_versions" || analysisType === "git_diff"
            ? "changelog"
            : "source_code";

        const ref = ctx.store.recordResearch({
          incident_id: incidentId,
          source_type: sourceType,
          relevant_summary: finding.summary,
          claim_supported_or_challenged: claim,
          experiment_id: optStr(args, "experiment_id"),
          hypothesis_id: optStr(args, "hypothesis_id"),
          source_uri: finding.target_path ?? "local_codebase",
          source_title: `Codebase analysis (${analysisType})`,
          reliability_note: "Primary local repository observation (untrusted data)",
          actor: "agent",
        });
        researchReferenceId = ref.research_reference_id;
      }

      return {
        ok: true,
        finding,
        research_reference_id: researchReferenceId,
        warnings: finding.secrets_redacted ? ["secrets_redacted_from_codebase_output"] : [],
      };
    },
  },

  {
    def: {
      name: "debug_research_evaluate",
      description:
        "Evaluate and rank candidate research sources against an incident and runtime environment. " +
        "Scores authority, version alignment, and symptom match, flags contradictions between sources, " +
        "and enforces untrusted-data safety boundaries.",
      inputSchema: objSchema(
        "Evaluate candidate research sources",
        {
          incident_id: str("Incident id"),
          sources: arr(
            "Array of candidate sources to evaluate",
            objSchema(
              "Candidate source",
              {
                source_title: str("Source title or repository name"),
                source_type: str("Source category", { enum: [...RESEARCH_TYPES] }),
                excerpt: str("Relevant excerpt or finding summary"),
                source_uri: str("Optional URL or reference"),
                claimed_version: str("Version mentioned by source"),
                claims: arr("Specific claims made by the source", str("claim")),
                reliability_note: str("Optional notes on credibility"),
              },
              ["source_title", "source_type", "excerpt"],
            ),
          ),
        },
        ["incident_id", "sources"],
      ),
    },
    handle(ctx, args) {
      const incidentId = reqStr(args, "incident_id");
      const incident = ctx.store.getIncidentOrFail(incidentId);

      const rawSources = optArr(args, "sources");
      if (rawSources.length === 0) {
        throw validationError("sources must contain at least one candidate source to evaluate");
      }

      const sources: CandidateSourceInput[] = [];
      for (const item of rawSources) {
        const s = item as Record<string, unknown>;
        const title = typeof s.source_title === "string" ? s.source_title : "untitled";
        const stype = (typeof s.source_type === "string" ? s.source_type : "community") as any;
        if (!isOneOf(RESEARCH_TYPES, stype)) {
          throw validationError(`invalid source_type: ${stype} in source '${title}'`);
        }
        const excerpt = typeof s.excerpt === "string" ? s.excerpt : "";
        const claims = Array.isArray(s.claims) ? s.claims.map(String) : [];

        sources.push({
          source_title: title,
          source_type: stype,
          excerpt,
          source_uri: optStr(s, "source_uri"),
          claimed_version: optStr(s, "claimed_version"),
          claims,
          reliability_note: optStr(s, "reliability_note"),
        });
      }

      const envRow = ctx.store.db
        .query(
          "SELECT * FROM environments WHERE experiment_id IN (SELECT experiment_id FROM experiments WHERE incident_id = ?) OR experiment_id IS NULL ORDER BY captured_at DESC LIMIT 1",
        )
        .get(incidentId) as any;

      const env: ResearchEnvironment | null = envRow
        ? {
            ...envRow,
            packages: typeof envRow.packages === "string" ? JSON.parse(envRow.packages) : envRow.packages,
            env_vars: typeof envRow.env_vars === "string" ? JSON.parse(envRow.env_vars) : envRow.env_vars,
            metadata: typeof envRow.metadata === "string" ? JSON.parse(envRow.metadata) : envRow.metadata,
          }
        : null;

      const result = evaluateSources(sources, incident, env);
      return {
        ok: true,
        evaluations: result.evaluations,
        ranked_order: result.ranked_order,
        detected_conflicts: result.detected_conflicts,
        warnings: result.detected_conflicts.length > 0 ? ["conflicting_sources_detected"] : [],
      };
    },
  },
];
