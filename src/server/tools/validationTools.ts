import type { Tool, ToolContext } from "../context.ts";
import { str, objSchema, optStr, reqStr, optArr, arr } from "../context.ts";
import { validationError } from "../../errors.ts";
import { isOneOf, VALIDATION_RESULT } from "../../vocab.ts";

const RESULT_ENUM = [...VALIDATION_RESULT];
const CRITERION_STATUSES = ["passed", "failed", "skipped", "not_evaluable"] as const;

export const validationTools: Tool[] = [
  {
    def: {
      name: "debug_validation_record",
      description:
        "Record a validation run against the ORIGINAL failure condition. Only when required acceptance criteria pass " +
        "with recorded evidence is the experiment marked verified. A successful unrelated command is never a verified fix.",
      inputSchema: objSchema(
        "Record a validation run",
        {
          incident_id: str("Incident id"),
          experiment_id: str("Candidate-fix experiment id"),
          validation_plan: str("Reproduction/regression criteria used"),
          criteria_results: arr("Per-criteria results", objSchema("criterion", {
            criteria: str("Description of the criterion"),
            status: str("pass|failed|skipped|not_evaluable", { enum: CRITERION_STATUSES }),
            note: str("Optional note"),
          }, ["criteria", "status"])),
          execution_result: str("Overall validation execution", { enum: RESULT_ENUM }),
          evidence_ids: arr("Supporting evidence ids", str("evidence id")),
          verified_by: str("Who verified", { enum: ["user", "agent", "plugin", "external_tool"], default: "agent" }),
          validated_environment_id: str("Environment id where validated"),
          limitations: str("What this validation did NOT prove"),
          reproduced_before: { type: "boolean", description: "Was the original failure reproduced before the candidate fix?" },
        },
        ["incident_id", "experiment_id", "validation_plan", "criteria_results", "execution_result"],
      ),
    },
    handle(ctx, args) {
      const criteria_results = optArr(args, "criteria_results") as { criteria: string; status: string; note?: string }[];
      if (criteria_results.length === 0) throw validationError("criteria_results must contain at least one criterion");
      for (const c of criteria_results) {
        if (!isOneOf(CRITERION_STATUSES, c.status)) throw validationError(`invalid criterion status: ${c.status}`);
      }
      const execution_result = reqStr(args, "execution_result");
      if (!isOneOf(VALIDATION_RESULT, execution_result)) throw validationError(`invalid execution_result: ${execution_result}`);

      const reb = args.reproduced_before;
      const { validation, decision } = ctx.store.recordValidation({
        incident_id: reqStr(args, "incident_id"),
        experiment_id: reqStr(args, "experiment_id"),
        validation_plan: reqStr(args, "validation_plan"),
        criteria_results,
        execution_result,
        evidence_ids: optArr(args, "evidence_ids").map(String),
        verified_by: optStr(args, "verified_by") ?? "agent",
        validated_environment_id: optStr(args, "validated_environment_id"),
        limitations: optStr(args, "limitations"),
        reproduced_before: typeof reb === "boolean" ? (reb ? 1 : 0) : undefined,
      });

      return {
        ok: true,
        validation_id: validation.validation_run_id,
        decision,
        verified: decision === "verified",
        critique: validation.decision_rationale,
        criteria_results,
        remaining_caveats: validation.limitations ?? null,
        next_step: decision === "verified"
          ? "Call debug_case_status_update with status='resolved' and verification_id."
          : "Do NOT mark resolved. Continue investigating or gather better evidence.",
        warnings: decision !== "verified" ? ["not_verified"] : [],
      };
    },
  },
];
