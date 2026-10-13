import type { Tool, ToolContext } from "../context.ts";
import { str, objSchema, optStr, reqStr } from "../context.ts";
import { validationError } from "../../errors.ts";
import { isOneOf, HYPOTHESIS_STATUS, STRATEGY_STATUS } from "../../vocab.ts";

/**
 * debug_hypothesis_manage: create hypotheses, create strategies, and update the
 * status of either. A hypothesis remains an explanation, never a fact; rejection
 * requires a rationale and can be reopened later.
 */
export const planTools: Tool[] = [
  {
    def: {
      name: "debug_hypothesis_manage",
      description:
        "Create a hypothesis, create a strategy, or update either's status. Required before experiments that test a specific claim.",
      inputSchema: objSchema(
        "Manage hypotheses and strategies",
        {
          op: str("create_hypothesis | create_strategy | update_hypothesis_status | update_strategy_status", {
            enum: ["create_hypothesis", "create_strategy", "update_hypothesis_status", "update_strategy_status"],
          }),
          incident_id: str("Incident id"),
          // create_hypothesis
          statement: str("Concise claim to evaluate (hypothesis)"),
          rationale: str("Why it is plausible (hypothesis) OR reason for status change"),
          confidence_note: str("Uncertainty note; avoid false precision"),
          parent_hypothesis_id: str("Derived hypothesis parent"),
          // create_strategy
          title: str("Strategy title"),
          description: str("What the strategy explores"),
          reason_for_selection: str("Evidence-based reason to pursue"),
          hypothesis_id: str("Hypothesis this strategy/experiment targets"),
          parent_strategy_id: str("Parent strategy"),
          // update
          status: str("Target status", { enum: [...HYPOTHESIS_STATUS, ...STRATEGY_STATUS] }),
          session_id: str("Session id if known"),
          id: str("hypothesis_id or strategy_id for update ops"),
          actor: str("Actor", { enum: ["user", "agent", "plugin", "external_tool", "import"], default: "agent" }),
        },
        ["op", "incident_id"],
      ),
    },
    handle(ctx, args) {
      const op = reqStr(args, "op");
      const incident_id = reqStr(args, "incident_id");
      const actor = optStr(args, "actor") ?? "agent";

      if (op === "create_hypothesis") {
        const statement = reqStr(args, "statement");
        const rationale = reqStr(args, "rationale");
        const hyp = ctx.store.createHypothesis({ incident_id, statement, rationale, confidence_note: optStr(args, "confidence_note"), parent_hypothesis_id: optStr(args, "parent_hypothesis_id"), actor });
        return { ok: true, hypothesis_id: hyp.hypothesis_id, status: hyp.status };
      }
      if (op === "create_strategy") {
        const title = reqStr(args, "title");
        const description = reqStr(args, "description");
        const reason_for_selection = reqStr(args, "reason_for_selection");
        const st = ctx.store.createStrategy({ incident_id, title, description, reason_for_selection, hypothesis_id: optStr(args, "hypothesis_id"), parent_strategy_id: optStr(args, "parent_strategy_id"), actor });
        return { ok: true, strategy_id: st.strategy_id, status: st.status };
      }
      if (op === "update_hypothesis_status") {
        const id = reqStr(args, "id");
        const status = reqStr(args, "status");
        const rationale = reqStr(args, "rationale");
        const hyp = ctx.store.updateHypothesisStatus(id, status, rationale, actor);
        return { ok: true, hypothesis_id: id, status: hyp.status };
      }
      if (op === "update_strategy_status") {
        const id = reqStr(args, "id");
        const status = reqStr(args, "status");
        const rationale = reqStr(args, "rationale");
        if (!isOneOf(STRATEGY_STATUS, status)) throw validationError(`invalid strategy status: ${status}`);
        ctx.store.db.query("UPDATE strategies SET status = ?, updated_at = ? WHERE strategy_id = ?").run(status, new Date().toISOString(), id);
        return { ok: true, strategy_id: id, status };
      }
      throw validationError(`unknown op: ${op}`);
    },
  },
];
