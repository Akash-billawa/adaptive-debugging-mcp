import type { Tool } from "../context.ts";
import { str, objSchema, optStr, reqStr, num } from "../context.ts";
import { computeBudgetUsage, evaluateNewExperimentBudget } from "../../engine/budgets.ts";
import { decideNextAction } from "../../engine/next-action.ts";
import { appendTimelineEvent } from "../../memory/audit.ts";

/**
 * debug_next_experiment_prepare: the structured next-action decision.
 *
 * A planning aid (never executes anything): assesses exhaustion of the
 * currently tracked search space, reports budget usage, ranks refinement
 * candidates with explained heuristics (not probabilities), and recommends ONE
 * next action with its supporting evidence, unresolved uncertainty, expected
 * observation, risk/cost considerations, and what would change the decision.
 * When a hard budget is reached it returns a durable, resumable handoff report
 * and records it in the incident's timeline.
 */
export const nextActionTools: Tool[] = [
  {
    def: {
      name: "debug_next_experiment_prepare",
      description:
        "After any meaningful outcome: assess whether the tracked search space is exhausted (exploring / refinement_required / research_required / budget_exhausted / blocked / resolved), " +
        "report budget usage, rank which failed attempt is worth refining (explained heuristic factors — not probabilities), and recommend ONE next action. " +
        "On budget exhaustion, returns a resumable handoff report (prior findings, remaining hypotheses, untested directions, best-supported next option). " +
        "Planning aid only: NEVER executes commands, edits files, installs packages, or applies changes.",
      inputSchema: objSchema(
        "Decide the next investigation action",
        {
          incident_id: str("Incident id"),
          target_question: str("Optional uncertainty to focus the recommendation on"),
          candidate_limit: num("Max ranked refinement candidates to return", { default: 3 }),
          actor: str("Actor", { enum: ["user", "agent", "plugin", "external_tool", "import"], default: "agent" }),
        },
        ["incident_id"],
      ),
    },
    handle(ctx, args) {
      const incidentId = reqStr(args, "incident_id");
      const actor = optStr(args, "actor") ?? "agent";
      const candidateLimit = Math.max(1, Math.min(10, Number(args.candidate_limit ?? 3)));

      const inc = ctx.store.getIncidentOrFail(incidentId);
      const experiments = ctx.store.allExperiments(incidentId);
      const hypotheses = ctx.store.listHypotheses(incidentId);
      const strategies = ctx.store.listStrategies(incidentId);
      const validations = ctx.store.listValidations(incidentId);
      const research = ctx.store.listResearch(incidentId);
      const evidence = ctx.store.listEvidence({ incident_id: incidentId });

      const budgetConfig = ctx.store.resolveBudgetConfig(inc.project_id, incidentId);
      const usage = computeBudgetUsage(experiments, inc);
      const probe = evaluateNewExperimentBudget(budgetConfig, usage, {
        node_kind: "experiment",
        parent_experiment_id: null,
        parent_family_root_id: null,
        new_variant_depth: 0,
        risk_level: "low",
      });

      const report = decideNextAction(
        {
          incident: inc,
          experiments,
          hypotheses,
          strategies,
          validations,
          research,
          evidence,
          usage,
          budgetConfig,
          budgetWarnings: probe.warnings,
        },
        candidateLimit,
      );

      if (report.handoff) {
        appendTimelineEvent(ctx.store.db, {
          incident_id: incidentId,
          event_type: "investigation.handoff",
          actor: actor as any,
          summary: `Handoff recorded — budget reached: ${report.next_action.why_now.slice(0, 140)}`,
          details: { handoff: report.handoff, exhaustion_state: report.exhaustion.state },
        });
      }

      return {
        ok: true,
        ...report,
        target_question: optStr(args, "target_question") ?? null,
        boundary:
          "Planning aid only: this tool never executes commands or applies changes; execute the chosen action only within granted permissions, and record the actual result.",
      };
    },
  },
];
