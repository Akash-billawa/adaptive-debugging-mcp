import type { Tool } from "../context.ts";
import { str, objSchema, optStr, reqStr, arr, ValidationArg, optArr } from "../context.ts";
import { validationError } from "../../errors.ts";
import { compareCandidatesEngine, type NormalizedCandidateInput } from "../../engine/compare.ts";

/**
 * debug_candidate_compare: Standalone experiment and candidate comparison matrix.
 *
 * Compares proposed experiments against prior attempts and against each other
 * before execution (Tool Catalogue §6.3). Evaluates shared vs diverging
 * hypotheses, changed variables, supporting/contradicting prior evidence,
 * reversibility, risk, duplicate proximity warnings, and provides an explainable
 * heuristic ranking.
 */
export const compareTools: Tool[] = [
  {
    def: {
      name: "debug_candidate_compare",
      description:
        "Compare 2 or more proposed experiments or candidate branches against prior attempts and each other before execution. " +
        "Highlights shared assumptions, changed variables, overlapping steps, supporting vs contradicting prior evidence, " +
        "expected information gain, reversibility, risk, and near-duplicate warnings. " +
        "Provides a pairwise comparison matrix and an explainable heuristic ranking (never false probabilities). " +
        "Planning aid only: does not execute commands or edit files.",
      inputSchema: objSchema(
        "Compare multiple candidate experiments before execution",
        {
          incident_id: str("Incident id"),
          candidate_experiment_ids: arr(
            "Array of existing experiment IDs in this incident to compare",
            str("experiment_id"),
          ),
          proposed_candidates: arr(
            "Array of proposed candidate objects not yet created in the database",
            {
              type: "object",
              description: "Proposed candidate experiment definition",
              properties: {
                title: str("Short description of the candidate"),
                proposed_change: str("Exact diagnostic action, change, or test to run"),
                rationale: str("Why this approach is plausible"),
                expected_observation: str("Expected evidence or observation"),
                risk_level: str("low|medium|high|unknown", { default: "medium" }),
                hypothesis_id: str("Hypothesis id this candidate evaluates"),
                parent_experiment_id: str("Parent experiment/variant id if refining an earlier attempt"),
              },
              required: ["title", "proposed_change", "rationale"],
            },
          ),
        },
        ["incident_id"],
      ),
    },
    handle(ctx, args) {
      const incidentId = reqStr(args, "incident_id");
      const inc = ctx.store.getIncidentOrFail(incidentId);

      const candidateExpIds = (optArr(args, "candidate_experiment_ids") as string[]).filter(
        (id) => typeof id === "string" && id.length > 0,
      );
      const proposedCandidates = (optArr(args, "proposed_candidates") as Array<Record<string, unknown>>).filter(
        (c) => typeof c === "object" && c !== null,
      );

      const allExperiments = ctx.store.allExperiments(incidentId);
      const expById = new Map(allExperiments.map((e) => [e.experiment_id, e]));

      const normalizedCandidates: NormalizedCandidateInput[] = [];

      // 1. Resolve existing experiments
      for (const expId of candidateExpIds) {
        const exp = expById.get(expId);
        if (!exp) {
          throw validationError(`candidate_experiment_id '${expId}' does not belong to incident '${incidentId}'`);
        }
        normalizedCandidates.push({
          candidate_id: exp.experiment_id,
          title: exp.title,
          proposed_change: exp.proposed_change ?? exp.title,
          rationale: exp.reason_for_difference ?? exp.title,
          expected_observation: exp.expected_observation,
          risk_level: exp.risk_level ?? "unknown",
          hypothesis_id: exp.hypothesis_id,
          parent_experiment_id: exp.parent_experiment_id,
          is_existing_experiment: true,
          existing_experiment: exp,
        });
      }

      // 2. Resolve proposed candidates
      let propIndex = 1;
      for (const p of proposedCandidates) {
        const title = typeof p.title === "string" && p.title.trim().length > 0 ? p.title.trim() : `Proposal ${propIndex}`;
        const proposedChange = typeof p.proposed_change === "string" ? p.proposed_change.trim() : "";
        const rationale = typeof p.rationale === "string" ? p.rationale.trim() : "";

        if (!proposedChange) {
          throw new ValidationArg(`proposed_candidates[${propIndex - 1}].proposed_change is required`);
        }
        if (!rationale) {
          throw new ValidationArg(`proposed_candidates[${propIndex - 1}].rationale is required`);
        }

        const candId = `prop_${propIndex}`;
        propIndex++;

        normalizedCandidates.push({
          candidate_id: candId,
          title,
          proposed_change: proposedChange,
          rationale,
          expected_observation: typeof p.expected_observation === "string" ? p.expected_observation : null,
          risk_level: typeof p.risk_level === "string" ? p.risk_level : "medium",
          hypothesis_id: typeof p.hypothesis_id === "string" ? p.hypothesis_id : null,
          parent_experiment_id: typeof p.parent_experiment_id === "string" ? p.parent_experiment_id : null,
          is_existing_experiment: false,
        });
      }

      if (normalizedCandidates.length < 2) {
        throw new ValidationArg(
          "At least 2 candidates (via candidate_experiment_ids and/or proposed_candidates) are required for comparison",
        );
      }

      const hypotheses = ctx.store.listHypotheses(incidentId);
      const research = ctx.store.listResearch(incidentId);
      const evidence = ctx.store.listEvidence({ incident_id: incidentId });

      const report = compareCandidatesEngine({
        incident: inc,
        candidates: normalizedCandidates,
        experiments: allExperiments,
        hypotheses,
        research,
        evidence,
      });

      return {
        ok: true,
        ...report,
      };
    },
  },
];
