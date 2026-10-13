import type { Tool, ToolContext } from "../context.ts";
import { str, objSchema, num, optStr, reqStr } from "../context.ts";
import { validationError } from "../../errors.ts";
import { computeBudgetUsage, evaluateNewExperimentBudget, type BudgetConfig } from "../../engine/budgets.ts";

const configProp = {
  type: "object",
  description:
    "Partial budget config; omitted keys keep their layer's values (project defaults merge over built-ins; incident overrides merge over the project default). Cost limits are stored and reported but NOT enforced — ADIM has no reliable token/monetary accounting, so no figures are invented.",
  additionalProperties: false,
  properties: {
    max_experiments_per_family: num("Max attempts per strategy family (default 3)"),
    max_variants_per_parent: num("Max variants beneath one parent experiment (default 3)"),
    max_total_experiments: num("Max recorded experiments per investigation (default 25)"),
    max_refinement_depth: num("Max variant nesting depth (default 3)"),
    max_duration_hours: num("Optional wall-clock budget in hours; null disables the dimension"),
    max_risk_without_approval: str("Risk ceiling above which execution requires explicit approval (advisory: approvals live in the host permission layer)", {
      enum: ["low", "medium", "high", "unknown"],
      default: "medium",
    }),
    cost_limit: {
      type: "object",
      description: "{metric, limit} — accepted and surfaced, NOT enforced (no reliable measurement)",
      properties: { metric: { type: "string" }, limit: { type: "number" } },
      additionalProperties: false,
    },
  },
} as const;

/**
 * debug_budget_manage: view and configure exploration budgets. Budgets bound
 * the *tracked* investigation loop — they never limit the conceivable solution
 * space. Hard limits are enforced at experiment creation (LIMIT_EXCEEDED);
 * raising a budget or adding new evidence resumes the investigation, and all
 * changes are recorded (incident scopes in the audit timeline).
 */
export const budgetTools: Tool[] = [
  {
    def: {
      name: "debug_budget_manage",
      description:
        "View effective exploration budgets and usage, set project defaults or per-incident overrides, or clear an override. " +
        "Enforced at debug_attempt_create: over-limit experiments return LIMIT_EXCEEDED with how to proceed. " +
        "Budgets are provisional limits on tracked exploration — never a claim about what is solvable.",
      inputSchema: objSchema(
        "Manage exploration budgets",
        {
          op: str("Operation", {
            enum: ["get", "set_project_default", "set_incident_override", "clear_incident_override"],
          }),
          incident_id: str("Incident id (required for incident ops; for op=get shows the incident-effective config + usage)"),
          project_id: str("Project id (required for project ops)"),
          config: configProp as unknown as Record<string, unknown>,
          rationale: str("Reason for the change (incident scopes are recorded in the audit timeline)"),
          actor: str("Actor", { enum: ["user", "agent", "plugin", "external_tool", "import"], default: "agent" }),
        },
        ["op"],
      ),
    },
    handle(ctx: ToolContext, args: Record<string, unknown>) {
      const op = reqStr(args, "op");
      const actor = optStr(args, "actor") ?? "agent";
      const config = (args.config ?? null) as Partial<BudgetConfig> | null;
      const rationale = optStr(args, "rationale");

      if (op === "get") {
        const incidentId = optStr(args, "incident_id");
        const projectId = optStr(args, "project_id");
        if (!incidentId && !projectId) throw validationError("op=get requires incident_id or project_id");
        if (incidentId) {
          const inc = ctx.store.getIncidentOrFail(incidentId);
          const budgetConfig = ctx.store.resolveBudgetConfig(inc.project_id, incidentId);
          const usage = computeBudgetUsage(ctx.store.allExperiments(incidentId), inc);
          const probe = evaluateNewExperimentBudget(budgetConfig, usage, {
            node_kind: "experiment",
            parent_experiment_id: null,
            parent_family_root_id: null,
            new_variant_depth: 0,
            risk_level: "low",
          });
          return {
            ok: true,
            scope: "incident",
            incident_id: incidentId,
            config: budgetConfig,
            usage: {
              total_experiments: usage.total_experiments,
              families: usage.families,
              duration_hours: usage.duration_hours === null ? null : Number(usage.duration_hours.toFixed(2)),
            },
            next_experiment_blocked: probe.blocked,
            warnings: probe.warnings,
            note: "Cost limits (if any) are stored/reported but NOT enforced: ADIM has no reliable token/monetary accounting.",
          };
        }
        return {
          ok: true,
          scope: "project",
          project_id: projectId,
          config: ctx.store.getProjectBudgetDefault(projectId!),
          warnings: [],
          note: "This is the project default; per-incident overrides may exist — use op=get with an incident_id for the effective view.",
        };
      }

      if (!config || typeof config !== "object" || Object.keys(config).length === 0)
        throw validationError(`op=${op} requires a non-empty config patch`);

      if (op === "set_project_default") {
        const projectId = reqStr(args, "project_id");
        const merged = ctx.store.setBudgetConfig({
          scope: "project",
          project_id: projectId,
          incident_id: null,
          config,
          actor,
          rationale,
        });
        return { ok: true, scope: "project", project_id: projectId, config: merged, warnings: [], timeline_recorded: false };
      }
      if (op === "set_incident_override") {
        const incidentId = reqStr(args, "incident_id");
        const inc = ctx.store.getIncidentOrFail(incidentId);
        const merged = ctx.store.setBudgetConfig({
          scope: "incident",
          project_id: inc.project_id,
          incident_id: incidentId,
          config,
          actor,
          rationale,
        });
        return { ok: true, scope: "incident", incident_id: incidentId, config: merged, warnings: [], timeline_recorded: true };
      }
      if (op === "clear_incident_override") {
        const incidentId = reqStr(args, "incident_id");
        ctx.store.getIncidentOrFail(incidentId);
        ctx.store.clearIncidentBudgetOverride(incidentId, actor, rationale);
        const inc = ctx.store.getIncidentOrFail(incidentId);
        return {
          ok: true,
          scope: "incident",
          incident_id: incidentId,
          config: ctx.store.resolveBudgetConfig(inc.project_id, incidentId),
          warnings: [],
          timeline_recorded: true,
        };
      }
      throw validationError(`unknown op: ${op}`);
    },
  },
];
