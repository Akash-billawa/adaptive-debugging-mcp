import type { Tool, ToolContext } from "../context.ts";
import { str, objSchema, optStr, reqStr } from "../context.ts";
import { validationError } from "../../errors.ts";
import { isOneOf, EXECUTION_STATUS, OUTCOME_STATUS } from "../../vocab.ts";

const EXEC_ENUM = [...EXECUTION_STATUS];
const OUTCOME_ENUM = [...OUTCOME_STATUS];

function dupSummary(dups: { experiment_id: string; label: string | null; outcome_status: string; similarity: number; match: string; note: string }[]) {
  return dups.map((d) => ({ experiment_id: d.experiment_id, label: d.label, prior_outcome: d.outcome_status, similarity: d.similarity, match: d.match, note: d.note }));
}

export const attemptTools: Tool[] = [
  {
    def: {
      name: "debug_attempt_create",
      description:
        "Record a strategy, experiment, or variant node in an incident's investigation tree BEFORE running it. " +
        "A variant MUST state what changed and why. Returns duplicate warnings; does NOT execute the experiment. " +
        "Enforces configured exploration budgets: over-limit creation returns LIMIT_EXCEEDED with how to raise the budget or stop with a handoff.",
      inputSchema: objSchema(
        "Create an experiment/strategy/variant node",
        {
          incident_id: str("Incident id"),
          node_kind: str("Node kind", { enum: ["strategy", "experiment", "variant"] }),
          title: str("Short description"),
          parent_experiment_id: str("Parent node (required for a variant)"),
          strategy_id: str("Owning strategy"),
          hypothesis_id: str("Hypothesis this tests"),
          inspired_by_experiment_id: str("Earlier experiment that motivated this"),
          proposed_change: str("Exact diagnostic action / change / test to run"),
          reason_for_difference: str("What materially differs from the parent and why it may matter"),
          expected_observation: str("Evidence expected if the hypothesis is correct"),
          preconditions: str("Conditions required before execution"),
          risk_level: str("low|medium|high|unknown", { default: "unknown" }),
          estimated_cost: str("Rough cost/time estimate"),
          actor: str("Actor", { enum: ["user", "agent", "plugin", "external_tool", "import"], default: "agent" }),
          idempotency_key: str("Retry-safe key"),
        },
        ["incident_id", "node_kind", "title", "expected_observation"],
      ),
    },
    handle(ctx, args) {
      const incident_id = reqStr(args, "incident_id");
      const node_kind = reqStr(args, "node_kind");
      const title = reqStr(args, "title");
      const actor = optStr(args, "actor") ?? "agent";
      if (!isOneOf(["strategy", "experiment", "variant"], node_kind)) throw validationError(`invalid node_kind: ${node_kind}`);

      const { experiment, duplicateWarnings, budgetWarnings } = ctx.store.createExperiment({
        incident_id, node_kind, title,
        parent_experiment_id: optStr(args, "parent_experiment_id"),
        strategy_id: optStr(args, "strategy_id"),
        hypothesis_id: optStr(args, "hypothesis_id"),
        inspired_by_experiment_id: optStr(args, "inspired_by_experiment_id"),
        proposed_change: optStr(args, "proposed_change"),
        reason_for_difference: optStr(args, "reason_for_difference"),
        expected_observation: optStr(args, "expected_observation"),
        preconditions: optStr(args, "preconditions"),
        risk_level: optStr(args, "risk_level") ?? "unknown",
        estimated_cost: optStr(args, "estimated_cost"),
        actor,
        idempotency_key: optStr(args, "idempotency_key"),
      });

      return {
        ok: true,
        created: true,
        experiment_id: experiment.experiment_id,
        parent_experiment_id: experiment.parent_experiment_id,
        display_label: experiment.display_label,
        path: experiment.display_label ?? experiment.experiment_id,
        execution_status: experiment.execution_status,
        outcome_status: experiment.outcome_status,
        duplicate_warnings: dupSummary(duplicateWarnings),
        budget_warnings: budgetWarnings,
        note: "Planned only — not executed. Record the actual result with debug_attempt_update + debug_evidence_record.",
        warnings: [...(duplicateWarnings.length ? ["near_duplicate_candidate"] : []), ...budgetWarnings],
      };
    },
  },

  {
    def: {
      name: "debug_attempt_update",
      description:
        "Update a planned experiment's execution/outcome AFTER acting on it, preserving an audit trail. " +
        "Requires a justification (or attached evidence) for a non-pending outcome. Outcome 'verified' is NOT set here — use debug_validation_record.",
      inputSchema: objSchema(
        "Update an attempt",
        {
          attempt_id: str("Experiment id"),
          execution_status: str("Execution lifecycle", { enum: EXEC_ENUM }),
          outcome_status: str("Outcome status", { enum: OUTCOME_ENUM }),
          actual_observation: str("What actually happened (observed)"),
          interpretation: str("Agent interpretation of the observation (kept separate from the observation)"),
          failure_reason: str("Why it failed"),
          environment_delta: str("How the environment changed since planning"),
          environment_id: str("Environment snapshot id"),
          started_at: str("ISO"), completed_at: str("ISO"),
          approval_record_id: str("Approval reference for risky actions"),
          actor: str("Actor", { enum: ["user", "agent", "plugin", "external_tool", "import"], default: "agent" }),
        },
        ["attempt_id", "actor"],
      ),
    },
    handle(ctx, args) {
      const attempt_id = reqStr(args, "attempt_id");
      const actor = reqStr(args, "actor");
      const outcome_status = optStr(args, "outcome_status");
      if (outcome_status && outcome_status === "verified")
        throw validationError("outcome 'verified' cannot be set via attempt_update; use debug_validation_record after acceptance criteria pass");
      if (outcome_status && !isOneOf(OUTCOME_STATUS, outcome_status)) throw validationError(`invalid outcome_status: ${outcome_status}`);
      const execution_status = optStr(args, "execution_status");
      if (execution_status && !isOneOf(EXECUTION_STATUS, execution_status)) throw validationError(`invalid execution_status: ${execution_status}`);

      const { experiment, previous } = ctx.store.updateExperiment(attempt_id, {
        execution_status,
        outcome_status,
        actual_observation: optStr(args, "actual_observation"),
        interpretation: optStr(args, "interpretation"),
        failure_reason: optStr(args, "failure_reason"),
        environment_delta: optStr(args, "environment_delta"),
        environment_id: optStr(args, "environment_id"),
        started_at: optStr(args, "started_at"),
        completed_at: optStr(args, "completed_at"),
        approval_record_id: optStr(args, "approval_record_id"),
        actor,
      });

      const warnings: string[] = [];
      if (experiment.outcome_status === "candidate") warnings.push("candidate_not_verified_run_validation");
      return {
        ok: true,
        attempt_id,
        display_label: experiment.display_label,
        execution_status: experiment.execution_status,
        outcome_status: experiment.outcome_status,
        previous: { execution_status: previous.execution_status, outcome_status: previous.outcome_status },
        audit_event_id: ctx.store.lastEventIdFor(attempt_id),
        warnings,
      };
    },
  },
];
