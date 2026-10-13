/**
 * Exploration budgets (engine, pure logic over store data).
 *
 * Budgets bound the investigation loop without hard-coding solution space:
 * they limit *tracked experiments within configured dimensions*, never the
 * conceivable solutions. Interrupted/unrecorded actions are never treated as
 * completed failures elsewhere; for budget usage every recorded experiment node
 * counts as spent exploration (documented interpretation).
 *
 * Cost limits: ADIM has no reliable token/monetary accounting, so `cost_limit`
 * is accepted, stored, and surfaced in reports, but NOT enforced. No figures are
 * invented (see Risks doc addendum).
 */
import type { Experiment, Incident } from "../types.ts";

export interface BudgetConfig {
  max_experiments_per_family: number;
  max_variants_per_parent: number;
  max_total_experiments: number;
  max_refinement_depth: number;
  max_duration_hours: number | null;
  max_risk_without_approval: "low" | "medium" | "high" | "unknown";
  cost_limit: { metric: string; limit: number } | null;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  max_experiments_per_family: 3,
  max_variants_per_parent: 3,
  max_total_experiments: 25,
  max_refinement_depth: 3,
  max_duration_hours: null,
  max_risk_without_approval: "medium",
  cost_limit: null,
};

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, unknown: 3 };

/** Merge a partial patch over a base config (missing keys keep base values). */
export function mergeBudgetConfig(base: BudgetConfig, patch: Partial<BudgetConfig> | null | undefined): BudgetConfig {
  if (!patch) return { ...base };
  const merged: BudgetConfig = {
    max_experiments_per_family: patch.max_experiments_per_family ?? base.max_experiments_per_family,
    max_variants_per_parent: patch.max_variants_per_parent ?? base.max_variants_per_parent,
    max_total_experiments: patch.max_total_experiments ?? base.max_total_experiments,
    max_refinement_depth: patch.max_refinement_depth ?? base.max_refinement_depth,
    max_duration_hours: patch.max_duration_hours !== undefined ? patch.max_duration_hours : base.max_duration_hours,
    max_risk_without_approval: patch.max_risk_without_approval ?? base.max_risk_without_approval,
    cost_limit: patch.cost_limit !== undefined ? patch.cost_limit : base.cost_limit,
  };
  return merged;
}

/** Validate a partial config; returns an error message or null. */
export function validateBudgetConfigPatch(patch: Partial<BudgetConfig>): string | null {
  const intFields: Array<[keyof BudgetConfig, number]> = [
    ["max_experiments_per_family", 1],
    ["max_variants_per_parent", 1],
    ["max_total_experiments", 1],
    ["max_refinement_depth", 1],
  ];
  for (const [key, min] of intFields) {
    const v = patch[key] as unknown;
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < min || v > 10000))
      return `${String(key)} must be an integer between ${min} and 10000`;
  }
  const d = patch.max_duration_hours;
  if (d !== undefined && d !== null && (typeof d !== "number" || d < 0)) return "max_duration_hours must be a non-negative number or null";
  const r = patch.max_risk_without_approval;
  if (r !== undefined && !["low", "medium", "high", "unknown"].includes(r)) return "invalid max_risk_without_approval";
  const c = patch.cost_limit;
  if (c !== undefined && c !== null && (typeof c !== "object" || typeof c.metric !== "string" || typeof c.limit !== "number"))
    return "cost_limit must be {metric, limit} or null";
  return null;
}

// --- Usage ------------------------------------------------------------------

/** Topmost ancestor of an experiment (family root: a strategy node or root experiment). */
export function familyRootOf(exp: Experiment, byId: Map<string, Experiment>): Experiment | null {
  let cursor = exp;
  const seen = new Set<string>();
  while (cursor.parent_experiment_id) {
    if (seen.has(cursor.experiment_id)) return cursor; // defensive; store guards cycles
    seen.add(cursor.experiment_id);
    const parent = byId.get(cursor.parent_experiment_id);
    if (!parent) return cursor;
    cursor = parent;
  }
  return cursor;
}

/** Consecutive variant-ancestor chain length ending at this experiment (its refinement depth). */
export function variantDepthOf(exp: Experiment, byId: Map<string, Experiment>): number {
  let depth = 0;
  let cursor: Experiment | undefined = exp;
  const seen = new Set<string>();
  while (cursor && cursor.node_kind === "variant") {
    depth++;
    if (seen.has(cursor.experiment_id)) break;
    seen.add(cursor.experiment_id);
    cursor = cursor.parent_experiment_id ? byId.get(cursor.parent_experiment_id) : undefined;
  }
  return depth;
}

export interface FamilyUsage {
  root_id: string;
  root_label: string | null;
  root_kind: string;
  attempts: number; // non-strategy members
}

export interface BudgetUsage {
  total_experiments: number;
  families: FamilyUsage[];
  variants_per_parent: Record<string, number>;
  duration_hours: number | null;
}

export function computeBudgetUsage(experiments: Experiment[], incident: Incident, nowMs = Date.now()): BudgetUsage {
  const byId = new Map(experiments.map((e) => [e.experiment_id, e]));
  const families = new Map<string, FamilyUsage>();
  const variantsPerParent: Record<string, number> = {};
  let total = 0;
  for (const e of experiments) {
    if (e.node_kind === "strategy") continue; // strategy nodes group; they are not attempts
    total++;
    if (e.parent_experiment_id)
      variantsPerParent[e.parent_experiment_id] = (variantsPerParent[e.parent_experiment_id] ?? 0) + (e.node_kind === "variant" ? 1 : 0);
    const root = familyRootOf(e, byId);
    const key = root?.experiment_id ?? e.experiment_id;
    const fam = families.get(key) ?? {
      root_id: key,
      root_label: root?.display_label ?? e.display_label,
      root_kind: root?.node_kind ?? e.node_kind,
      attempts: 0,
    };
    fam.attempts++;
    families.set(key, fam);
  }
  const created = Date.parse(incident.created_at);
  const durationHours = Number.isFinite(created) ? (nowMs - created) / 3_600_000 : null;
  return { total_experiments: total, families: [...families.values()], variants_per_parent: variantsPerParent, duration_hours: durationHours };
}

// --- Enforcement ------------------------------------------------------------

export interface BudgetViolation {
  limit_name: string;
  limit: number | string;
  current: number | string;
  message: string;
}

export interface BudgetEvaluation {
  blocked: BudgetViolation | null;
  warnings: string[];
}

/**
 * Evaluate whether a NEW experiment/variant node may be recorded under the
 * effective config. Returns the first hard violation (enforced) plus near-limit
 * warnings. Budgets never limit the conceivable solution space — only tracked
 * experiments within these dimensions.
 */
export function evaluateNewExperimentBudget(
  config: BudgetConfig,
  usage: BudgetUsage,
  newNode: {
    node_kind: string;
    parent_experiment_id: string | null;
    parent_family_root_id: string | null;
    new_variant_depth: number; // depth the NEW node would have (0 if not a variant)
    risk_level: string;
  },
): BudgetEvaluation {
  const warnings: string[] = [];
  if (newNode.node_kind === "strategy") return { blocked: null, warnings }; // strategies do not consume attempt budgets

  // Total experiments per investigation
  const total = usage.total_experiments;
  if (total >= config.max_total_experiments) {
    return {
      blocked: {
        limit_name: "max_total_experiments",
        limit: config.max_total_experiments,
        current: total,
        message: `Investigation budget reached: ${total} recorded experiments (limit ${config.max_total_experiments}). Raise the per-incident budget with debug_budget_manage (recorded) or stop with a handoff report via debug_next_experiment_prepare.`,
      },
      warnings,
    };
  }
  if (total >= 1 && config.max_total_experiments - total <= Math.max(1, Math.round(config.max_total_experiments * 0.25)))
    warnings.push(`approaching total experiment budget: ${total}/${config.max_total_experiments}`);

  // Per-family attempts
  if (newNode.parent_family_root_id) {
    const fam = usage.families.find((f) => f.root_id === newNode.parent_family_root_id);
    const famCount = fam?.attempts ?? 0;
    if (famCount >= config.max_experiments_per_family) {
      return {
        blocked: {
          limit_name: "max_experiments_per_family",
          limit: config.max_experiments_per_family,
          current: famCount,
          message: `Strategy-family budget reached: family ${fam?.root_label ?? newNode.parent_family_root_id} has ${famCount} attempts (limit ${config.max_experiments_per_family}). Raise the budget (debug_budget_manage), refine within an existing attempt, or open a new strategy family.`,
        },
        warnings,
      };
    }
    if (famCount >= 1 && config.max_experiments_per_family - famCount <= Math.max(1, Math.round(config.max_experiments_per_family * 0.25)))
      warnings.push(`approaching family budget: ${famCount}/${config.max_experiments_per_family} attempts in family ${fam?.root_label ?? ""}`);
  }

  // Variants per parent
  if (newNode.node_kind === "variant" && newNode.parent_experiment_id) {
    const v = usage.variants_per_parent[newNode.parent_experiment_id] ?? 0;
    if (v >= config.max_variants_per_parent) {
      return {
        blocked: {
          limit_name: "max_variants_per_parent",
          limit: config.max_variants_per_parent,
          current: v,
          message: `Variant budget reached: parent attempt already has ${v} variants (limit ${config.max_variants_per_parent}). Raise the budget or refine a different attempt.`,
        },
        warnings,
      };
    }
    if (v >= 1 && config.max_variants_per_parent - v <= Math.max(1, Math.round(config.max_variants_per_parent * 0.25)))
      warnings.push(`approaching variant budget: ${v}/${config.max_variants_per_parent} variants under this parent`);
    if (newNode.new_variant_depth > config.max_refinement_depth) {
      return {
        blocked: {
          limit_name: "max_refinement_depth",
          limit: config.max_refinement_depth,
          current: newNode.new_variant_depth,
          message: `Refinement depth budget reached: this variant would nest ${newNode.new_variant_depth} levels deep (limit ${config.max_refinement_depth}). Raise the budget or step back to a coarser variation.`,
        },
        warnings,
      };
    }
    if (newNode.new_variant_depth === config.max_refinement_depth)
      warnings.push(`this variant sits at the maximum refinement depth (${config.max_refinement_depth})`);
  }

  // Wall-clock duration
  if (config.max_duration_hours !== null && usage.duration_hours !== null && usage.duration_hours > config.max_duration_hours) {
    return {
      blocked: {
        limit_name: "max_duration_hours",
        limit: config.max_duration_hours,
        current: Number(usage.duration_hours.toFixed(2)),
        message: `Investigation duration budget reached: ${usage.duration_hours.toFixed(2)}h elapsed (limit ${config.max_duration_hours}h). Raise the budget or produce a handoff report.`,
      },
      warnings,
    };
  }
  if (config.max_duration_hours !== null && usage.duration_hours !== null && usage.duration_hours >= config.max_duration_hours * 0.75)
    warnings.push(`approaching duration budget: ${usage.duration_hours.toFixed(2)}h/${config.max_duration_hours}h`);

  // Risk ceiling — advisory: approvals are enforced by the host permission layer, not the memory server
  const risk = newNode.risk_level || "unknown";
  if ((RISK_ORDER[risk] ?? 3) > (RISK_ORDER[config.max_risk_without_approval] ?? 3)) {
    warnings.push(
      `risk level '${risk}' exceeds the configured ceiling '${config.max_risk_without_approval}': obtain explicit approval before executing (approvals live in the host permission layer)`,
    );
  }

  return { blocked: null, warnings };
}
