import type { Tool, ToolContext } from "../context.ts";
import { str, objSchema, optStr, reqStr, ValidationArg } from "../context.ts";
import { validationError } from "../../errors.ts";
import { isOneOf, HYPOTHESIS_STATUS, STRATEGY_STATUS } from "../../vocab.ts";

/**
 * debug_hypothesis_manage: create hypotheses, create strategies, and update the
 * status of either. A hypothesis remains an explanation, never a fact; rejection
 * requires a rationale and can be reopened later.
 *
 * The canonical field carrying a hypothesis is `statement` (matching the store,
 * the `Hypothesis` type and the `hypotheses.statement` column). Two alternative
 * names are accepted for backward compatibility because live agents have been
 * observed sending them: `hypothesis` and `testable_claim`. The canonical name
 * always wins when present, and the response discloses which name supplied the
 * text so the compatibility shim is never silent.
 */
const HYPOTHESIS_STATEMENT_KEYS = ["statement", "hypothesis", "testable_claim"] as const;
export const planTools: Tool[] = [
  {
    def: {
      name: "debug_hypothesis_manage",
      description:
        "Create a hypothesis, create a strategy, or update either's status. Required before experiments that test a specific claim. " +
        "Per-op required fields — create_hypothesis: statement (the testable claim) + rationale; " +
        "create_strategy: title + description + reason_for_selection; " +
        "update_hypothesis_status / update_strategy_status: id + status + rationale.",
      inputSchema: objSchema(
        "Manage hypotheses and strategies",
        {
          op: str("create_hypothesis | create_strategy | update_hypothesis_status | update_strategy_status", {
            enum: ["create_hypothesis", "create_strategy", "update_hypothesis_status", "update_strategy_status"],
          }),
          incident_id: str("Incident id"),
          // create_hypothesis
          statement: str(
            "Required for op=create_hypothesis: the concise testable claim to evaluate. " +
              "Canonical name is 'statement'; the aliases 'hypothesis' and 'testable_claim' are accepted for compatibility.",
          ),
          rationale: str(
            "Required for op=create_hypothesis and for both update ops: why the hypothesis is plausible, or the reason for the status change.",
          ),
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
        const statementFrom = HYPOTHESIS_STATEMENT_KEYS.find(
          (k) => typeof args[k] === "string" && (args[k] as string).length > 0,
        );
        if (!statementFrom) {
          throw new ValidationArg(
            "statement is required for op=create_hypothesis (the testable claim itself; " +
              "the aliases 'hypothesis' and 'testable_claim' are also accepted) and must be a non-empty string",
          );
        }
        const statement = args[statementFrom] as string;
        const rationale = reqStr(args, "rationale");
        const hyp = ctx.store.createHypothesis({ incident_id, statement, rationale, confidence_note: optStr(args, "confidence_note"), parent_hypothesis_id: optStr(args, "parent_hypothesis_id"), actor });
        return {
          ok: true,
          hypothesis_id: hyp.hypothesis_id,
          status: hyp.status,
          // Disclose the compatibility shim so alias use is visible, not silent.
          ...(statementFrom === "statement" ? {} : { statement_normalized_from: statementFrom }),
        };
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
