import type { Tool, ToolContext } from "../context.ts";
import { str, objSchema, arr, optStr, optBool, reqStr, optArr } from "../context.ts";
import { validationError, notFound } from "../../errors.ts";
import { isOneOf } from "../../vocab.ts";
import { buildFingerprintValues } from "../../retrieval/fingerprint.ts";
import { listTimeline } from "../../memory/audit.ts";
import type { Incident } from "../../types.ts";

const REPRO_STATUSES = ["reproduced", "intermittent", "not_reproduced", "unknown"] as const;
const INCIDENT_UPDATE_STATES = ["open", "investigating", "blocked", "resolved", "closed_unresolved", "reopened"] as const;

function incidentSummary(i: Incident) {
  return {
    incident_id: i.incident_id,
    project_id: i.project_id,
    title: i.title,
    status: i.status,
    severity: i.severity,
    reproduction_status: i.reproduction_status,
    first_observed_at: i.first_observed_at,
    resolved_at: i.resolved_at,
    resolution_experiment_id: i.resolution_experiment_id,
  };
}

const projectProp = {
  type: "object",
  description: "Project identity. Prefer repository_uri or canonical_root so similar names do not collide.",
  properties: {
    project_id: str("Stable project id when known"),
    display_name: str("Human-readable project name"),
    canonical_root: str("Normalized workspace path or URI"),
    repository_uri: str("Repository remote reference"),
    default_branch: str("Primary development branch"),
  },
  required: ["display_name"],
  additionalProperties: false,
};

const environmentProp = {
  type: "object",
  description: "Optional environment snapshot. Never include secrets or raw env vars.",
  properties: {
    os_name: str("OS name"), os_version: str("OS version"), architecture: str("CPU architecture"),
    runtime_versions: { type: "object", additionalProperties: true },
    dependency_versions: { type: "object", additionalProperties: true },
    tool_versions: { type: "object", additionalProperties: true },
    git_commit: str("Commit hash"), git_branch: str("Branch name"),
    working_tree_state: str("clean/dirty note"),
    configuration_fingerprint: str("Hash of relevant non-secret config"),
    capture_method: str("How captured"),
  },
  additionalProperties: false,
};

export const caseTools: Tool[] = [
  {
    def: {
      name: "debug_case_start",
      description:
        "Create (or re-open) a debugging incident and record the original failure baseline. " +
        "Does NOT run the reproduction command. Checks for related prior incidents but never auto-merges.",
      inputSchema: objSchema(
        "Start a debugging incident",
        {
          project: projectProp,
          title: str("Concise incident summary"),
          initial_symptom: str("Original user/system-visible failure"),
          error_text: str("Raw error text used to derive fingerprints (stored verbatim as evidence elsewhere)"),
          reproduction_status: str("Reproduction status", { enum: REPRO_STATUSES }),
          severity: str("Optional severity"),
          acceptance_criteria: str("Explicit condition that must hold for the fix to count as resolved"),
          environment: environmentProp,
          provided_fingerprints: arr("Explicit fingerprints", objSchema("fp", {
            fingerprint_type: str("e.g. normalized_message | stack_signature"),
            fingerprint_value: str("Normalized or signature value"),
          })),
          first_observed_at: str("Earliest known occurrence (ISO)"),
          actor: str("Who supplied this record", { enum: ["user", "agent", "plugin", "external_tool", "import"], default: "agent" }),
          session_id: str("OpenCode session id if known"),
          idempotency_key: str("Retry-safe key"),
        },
        ["project", "title", "initial_symptom"],
      ),
    },
    async handle(ctx, args) {
      const project = args.project as Record<string, unknown>;
      if (!project || typeof project !== "object") throw validationError("project is required");
      const title = reqStr(args, "title");
      const initial_symptom = reqStr(args, "initial_symptom");
      const actor = optStr(args, "actor") ?? "agent";
      const reproduction_status = optStr(args, "reproduction_status");
      if (reproduction_status && !isOneOf(REPRO_STATUSES, reproduction_status))
        throw validationError(`invalid reproduction_status: ${reproduction_status}`);

      const fingerprints = buildFingerprintValues(optStr(args, "error_text") ?? "");
      for (const fp of optArr(args, "provided_fingerprints")) {
        const f = fp as Record<string, unknown>;
        if (typeof f.fingerprint_type === "string" && typeof f.fingerprint_value === "string")
          fingerprints.push({ fingerprint_type: f.fingerprint_type, fingerprint_value: f.fingerprint_value, normalization_version: "explicit" });
      }

      const { incident, project: proj, related } = ctx.store.createIncident({
        project: {
          project_id: optStr(args, "project_id") ?? (project.project_id as string | undefined),
          display_name: (project.display_name as string) ?? (project.repository_uri as string) ?? "unknown",
          repository_uri: project.repository_uri as string | undefined,
          canonical_root: project.canonical_root as string | undefined,
          default_branch: project.default_branch as string | undefined,
        },
        title,
        initial_symptom,
        first_observed_at: optStr(args, "first_observed_at"),
        reproduction_status: reproduction_status as any,
        severity: optStr(args, "severity"),
        acceptance_criteria: optStr(args, "acceptance_criteria"),
        environment: (args.environment as any) ?? null,
        fingerprints,
        actor,
        idempotency_key: optStr(args, "idempotency_key"),
      });

      const warnings: string[] = [];
      if (related.length > 0) warnings.push("related_incidents_found");
      if (!args.environment) warnings.push("environment_not_captured");

      return {
        ok: true,
        created: true,
        ...incidentSummary(incident),
        acceptance_criteria: incident.acceptance_criteria,
        related_case_suggestions: related.map((r) => ({ incident_id: r.incident_id, title: r.title, status: r.status })),
        note: "Reproduction command content is stored as data only; it was not executed.",
        warnings,
      };
    },
  },

  {
    def: {
      name: "debug_case_read",
      description:
        "Read an incident's authoritative summary and selected sections. Read-only. " +
        "Distinguishes verified facts from AI interpretations and does not silently summarize away contradictions.",
      inputSchema: objSchema(
        "Read an incident",
        {
          incident_id: str("Incident id"),
          sections: arr("Sections to include", str("hypotheses|strategies|attempts|validations|research|timeline|environment"), { default: ["attempts", "hypotheses"] }),
          max_attempts: { type: "number", description: "Max attempts returned", default: 50 },
          include_evidence_refs: { type: "boolean", description: "Include evidence ids", default: true },
          include_evidence_content: { type: "boolean", description: "Include stored, redacted evidence content", default: false },
        },
        ["incident_id"],
      ),
    },
    handle(ctx, args) {
      const id = reqStr(args, "incident_id");
      const inc = ctx.store.getIncidentOrFail(id);
      const rawSections = optArr(args, "sections");
      const sections = rawSections.length > 0
        ? new Set(rawSections.map((s) => String(s)))
        : new Set(["attempts", "hypotheses"]);

      let maxAttempts = 50;
      if (args.max_attempts !== undefined) {
        const parsed = Number(args.max_attempts);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw validationError("max_attempts must be a valid positive integer");
        }
        maxAttempts = Math.max(1, Math.min(200, Math.floor(parsed)));
      }
      const includeEvidence = optBool(args, "include_evidence_refs", true);
      const includeEvidenceContent = optBool(args, "include_evidence_content", false);

      const out: Record<string, unknown> = {
        ok: true,
        incident: { ...incidentSummary(inc), initial_symptom: inc.initial_symptom, acceptance_criteria: inc.acceptance_criteria, summary_current: inc.summary_current, updated_at: inc.updated_at },
      };

      const attempts = ctx.store.allExperiments(id);
      out.attempts_summary = {
        total: attempts.length,
        by_outcome: countBy(attempts.map((a) => a.outcome_status)),
        by_execution: countBy(attempts.map((a) => a.execution_status)),
        unresolved: attempts.filter((a) => a.outcome_status === "pending" || a.outcome_status === "inconclusive").length,
      };

      if (sections.has("attempts")) {
        out.attempts = attempts.slice(0, maxAttempts).map((a) => ({
          experiment_id: a.experiment_id,
          label: a.display_label,
          node_kind: a.node_kind,
          title: a.title,
          parent_experiment_id: a.parent_experiment_id,
          hypothesis_id: a.hypothesis_id,
          risk_level: a.risk_level,
          execution_status: a.execution_status,
          outcome_status: a.outcome_status,
          observed: a.actual_observation ?? null, // raw observation
          interpretation: a.interpretation ?? null, // AI interpretation, kept distinct
          evidence_refs: includeEvidence ? ctx.store.listEvidence({ experiment_id: a.experiment_id }).map((e) => e.evidence_id) : undefined,
          evidence: includeEvidenceContent
            ? ctx.store.listEvidence({ experiment_id: a.experiment_id }).map((e) => {
                const c = ctx.store.getEvidenceContent(e.evidence_id);
                return {
                  evidence_id: e.evidence_id,
                  evidence_type: e.evidence_type,
                  redaction_status: e.redaction_status,
                  truncated: c?.truncated ?? false,
                  content: c?.content ?? "",
                  interpretation: e.interpretation,
                };
              })
            : undefined,
        }));
      }
      if (sections.has("hypotheses")) out.hypotheses = ctx.store.listHypotheses(id);
      if (sections.has("strategies")) out.strategies = ctx.store.listStrategies(id);
      if (sections.has("validations")) out.validations = ctx.store.listValidations(id);
      if (sections.has("research")) out.research = ctx.store.listResearch(id);
      if (sections.has("timeline")) out.timeline = listTimeline(ctx.store.db, id).slice(-200);
      if (sections.has("environment")) {
        const envs = ctx.store.db.query("SELECT * FROM environments WHERE experiment_id IN (SELECT experiment_id FROM experiments WHERE incident_id = ?) OR (experiment_id IS NULL AND project_id = ?) ORDER BY captured_at DESC LIMIT 5").all(id, inc.project_id);
        out.environment = envs;
      }

      const warnings: string[] = [];
      if (attempts.length > maxAttempts) warnings.push("attempts_truncated");
      return { ...out, warnings };
    },
  },

  {
    def: {
      name: "debug_case_status_update",
      description:
        "Update an incident's lifecycle state after reviewing evidence. Requires a rationale, enforces valid " +
        "transitions, and requires a qualifying verified validation before 'resolved'.",
      inputSchema: objSchema(
        "Update incident status",
        {
          incident_id: str("Incident id"),
          status: str("Target state", { enum: INCIDENT_UPDATE_STATES }),
          rationale: str("Reason for the state change"),
          verification_id: str("Required when status='resolved'"),
          blocked_reason: str("What is required to resume, when status='blocked'"),
          untested_directions: arr("High-value untested possibilities", str("direction")),
          next_review: str("Condition for next review"),
          actor: str("Actor", { enum: ["user", "agent", "plugin", "external_tool", "import"], default: "agent" }),
        },
        ["incident_id", "status", "rationale"],
      ),
    },
    handle(ctx, args) {
      const id = reqStr(args, "incident_id");
      const status = reqStr(args, "status");
      const rationale = reqStr(args, "rationale");
      const actor = optStr(args, "actor") ?? "agent";
      if (!isOneOf(INCIDENT_UPDATE_STATES, status)) throw validationError(`invalid status: ${status}`);

      const verification_id = optStr(args, "verification_id");
      if (status === "resolved") {
        if (!verification_id) throw validationError("status='resolved' requires verification_id of a qualified validation run");
        const val = ctx.store.listValidations(id).find((v) => v.validation_run_id === verification_id);
        if (!val) throw notFound(`validation run not found for incident: ${verification_id}`);
        if (val.resolution_decision !== "verified")
          throw validationError("referenced validation run did not reach a verified decision");
      }

      const updated = ctx.store.updateIncidentStatus(id, status, rationale, actor, {
        verification_id,
        blocked_reason: optStr(args, "blocked_reason"),
        untested: optArr(args, "untested_directions").map(String),
        next_review: optStr(args, "next_review"),
      });
      return {
        ok: true,
        incident_id: id,
        status: updated.status,
        resolved_at: updated.resolved_at,
        required_follow_up: status === "blocked" ? optStr(args, "blocked_reason") ?? null : null,
        warnings: [],
      };
    },
  },
];

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
