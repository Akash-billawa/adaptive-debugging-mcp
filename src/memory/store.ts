import type { Database } from "bun:sqlite";
import { now, truncate } from "../util.ts";
import { ids, deriveLabel, contentHash } from "./ids.ts";
import * as fts from "./fts.ts";
import { appendTimelineEvent, createLink } from "./audit.ts";
import { redactWithStatus } from "../security/redaction.ts";
import { detectDuplicateWarnings, type DuplicateWarning } from "../retrieval/duplicates.ts";
import { validationError, notFound, conflict, McpError, ErrorCategory } from "../errors.ts";
import {
  DEFAULT_BUDGET_CONFIG,
  mergeBudgetConfig,
  validateBudgetConfigPatch,
  computeBudgetUsage,
  evaluateNewExperimentBudget,
  familyRootOf,
  variantDepthOf,
  type BudgetConfig,
} from "../engine/budgets.ts";
import {
  isOneOf,
  INCIDENT_STATUS,
  VALID_INCIDENT_TRANSITIONS,
  HYPOTHESIS_STATUS,
  STRATEGY_STATUS,
  EXECUTION_STATUS,
  OUTCOME_STATUS,
  NODE_KIND,
  EVIDENCE_TYPES,
  VALIDATION_RESULT,
} from "../vocab.ts";
import type {
  Project,
  Incident,
  Fingerprint,
  EnvironmentSnapshot,
  Hypothesis,
  Strategy,
  Experiment,
  Evidence,
  ResearchReference,
  ValidationRun,
} from "../types.ts";

export const MAX_EVIDENCE_BYTES = 64 * 1024; // bound raw evidence payloads
const MAX_TREE_DEPTH_GUARD = 64;

export interface ProjectInput {
  project_id?: string;
  display_name: string;
  canonical_root?: string | null;
  repository_uri?: string | null;
  default_branch?: string | null;
}

export interface CreateIncidentInput {
  project: ProjectInput;
  title: string;
  initial_symptom: string;
  first_observed_at?: string;
  reproduction_status?: string;
  severity?: string | null;
  acceptance_criteria?: string | null;
  environment?: Partial<EnvironmentSnapshot> | null;
  fingerprints?: { fingerprint_type: string; fingerprint_value: string; normalization_version?: string }[];
  actor: string;
  session_id?: string | null;
  idempotency_key?: string | null;
}

export interface CreateExperimentInput {
  incident_id: string;
  node_kind: string;
  title: string;
  parent_experiment_id?: string | null;
  strategy_id?: string | null;
  hypothesis_id?: string | null;
  inspired_by_experiment_id?: string | null;
  proposed_change?: string | null;
  reason_for_difference?: string | null;
  expected_observation?: string | null;
  preconditions?: string | null;
  risk_level?: string;
  estimated_cost?: string | null;
  actor: string;
  idempotency_key?: string | null;
}

export interface CreateExperimentResult {
  experiment: Experiment;
  duplicateWarnings: DuplicateWarning[];
  budgetWarnings: string[];
}

export interface UpdateExperimentInput {
  execution_status?: string;
  outcome_status?: string;
  actual_observation?: string | null;
  interpretation?: string | null;
  failure_reason?: string | null;
  environment_delta?: string | null;
  environment_id?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  approval_record_id?: string | null;
  actor: string;
}

/**
 * Repository/Store: the single authoritative persistence interface shared by the
 * MCP server and (optionally) the plugin. Every multi-write operation runs in a
 * transaction so history is never left half-committed.
 */
export class Store {
  constructor(public db: Database) {}

  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- Idempotency ---------------------------------------------------------
  checkIdem(key: string): string | null {
    const row = this.db
      .query("SELECT result_ref FROM idempotency_keys WHERE idem_key = ?")
      .get(key) as { result_ref: string } | null;
    return row ? row.result_ref : null;
  }
  putIdem(key: string, tool: string, ref: string): void {
    this.db
      .query("INSERT OR REPLACE INTO idempotency_keys(idem_key, tool, result_ref, created_at) VALUES(?,?,?,?)")
      .run(key, tool, ref, now());
  }

  // --- Projects ------------------------------------------------------------
  ensureProject(input: ProjectInput): Project {
    return this.tx(() => this.ensureProjectNoTx(input));
  }

  // No-transaction variant for composition inside other transactions.
  private ensureProjectNoTx(input: ProjectInput): Project {
    if (input.project_id) {
      const existing = this.getProject(input.project_id);
      if (existing) return existing;
    }
    if (!input.project_id && (input.repository_uri || input.canonical_root)) {
      const found = this.db
        .query("SELECT * FROM projects WHERE repository_uri = ? OR canonical_root = ? LIMIT 1")
        .get(input.repository_uri ?? null, input.canonical_root ?? null) as unknown as Project | null;
      if (found) return found;
    }
    const p: Project = {
      project_id: input.project_id ?? ids.project(),
      display_name: input.display_name,
      canonical_root: input.canonical_root ?? null,
      repository_uri: input.repository_uri ?? null,
      default_branch: input.default_branch ?? null,
      created_at: now(),
      updated_at: now(),
      archived_at: null,
    };
    this.db
      .query(
        `INSERT INTO projects (project_id, display_name, canonical_root, repository_uri, default_branch, created_at, updated_at, archived_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.project_id, p.display_name, p.canonical_root, p.repository_uri,
        p.default_branch, p.created_at, p.updated_at, p.archived_at,
      );
    return p;
  }

  getProject(id: string): Project | null {
    return this.db.query("SELECT * FROM projects WHERE project_id = ?").get(id) as unknown as Project | null;
  }

  // --- Incidents -----------------------------------------------------------
  createIncident(input: CreateIncidentInput): { incident: Incident; project: Project; related: Incident[] } {
    if (input.idempotency_key) {
      const ref = this.checkIdem(input.idempotency_key);
      if (ref) {
        const incident = this.getIncident(ref);
        if (incident) return { incident, project: this.getProjectSafe(incident.project_id), related: [] };
      }
    }
    if (!input.title || !input.initial_symptom) {
      throw validationError("title and initial_symptom are required");
    }
    if (input.reproduction_status && !REPRO_SET.has(input.reproduction_status)) {
      throw validationError(`invalid reproduction_status: ${input.reproduction_status}`);
    }
    const related = this.findRelatedIncidents(input.project, input.fingerprints ?? [], input.initial_symptom);

    const { incident, project } = this.tx(() => {
      const project = this.ensureProjectNoTx(input.project);
      const t = now();
      const incidentId = ids.incident();
      const incident: Incident = {
        incident_id: incidentId,
        project_id: project.project_id,
        title: input.title,
        initial_symptom: input.initial_symptom,
        first_observed_at: input.first_observed_at ?? t,
        created_at: t,
        updated_at: t,
        status: "open",
        severity: input.severity ?? null,
        reproduction_status: (input.reproduction_status ?? "unknown") as Incident["reproduction_status"],
        resolution_experiment_id: null,
        resolved_at: null,
        summary_current: null,
        acceptance_criteria: input.acceptance_criteria ?? null,
      };
      this.db
        .query(
          `INSERT INTO incidents
           (incident_id, project_id, title, initial_symptom, first_observed_at, created_at, updated_at, status, severity, reproduction_status, resolution_experiment_id, resolved_at, summary_current, acceptance_criteria)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          incident.incident_id,
          incident.project_id,
          incident.title,
          incident.initial_symptom,
          incident.first_observed_at,
          incident.created_at,
          incident.updated_at,
          incident.status,
          incident.severity,
          incident.reproduction_status,
          incident.resolution_experiment_id,
          incident.resolved_at,
          incident.summary_current,
          incident.acceptance_criteria,
        );

      for (const fp of input.fingerprints ?? []) {
        this.db
          .query(
            `INSERT INTO fingerprints (fingerprint_id, incident_id, fingerprint_type, fingerprint_value, normalization_version, source_evidence_id, created_at)
             VALUES(?,?,?,?,?,?,?)`,
          )
          .run(ids.fingerprint(), incidentId, fp.fingerprint_type, fp.fingerprint_value, fp.normalization_version ?? "v1", null, now());
      }

      if (input.environment) {
        this.insertEnvironmentIncident(incidentId, project.project_id, input.environment, input.actor);
      }

      fts.indexIncident(this.db, incidentId, project.project_id, incident.title, incident.initial_symptom,
        `${incident.initial_symptom} ${incident.acceptance_criteria ?? ""}`);

      appendTimelineEvent(this.db, {
        incident_id: incidentId,
        event_type: "incident.opened",
        actor: (input.actor as any) ?? "agent",
        summary: `Incident opened: ${incident.title}`,
        details: { project_id: project.project_id, reproduction_status: incident.reproduction_status },
      });

      // Record the effective exploration budget with the investigation (audit rule).
      const budget = this.resolveBudgetConfigNoTx(project.project_id, incidentId);
      appendTimelineEvent(this.db, {
        incident_id: incidentId,
        event_type: "budget.snapshot",
        actor: (input.actor as any) ?? "agent",
        summary: "Effective exploration budget recorded with the investigation",
        details: { budget },
      });

      if (input.idempotency_key) this.putIdem(input.idempotency_key, "debug_case_start", incidentId);
      return { incident, project };
    });

    return { incident, project, related };
  }

  private getProjectSafe(id: string): Project {
    const p = this.getProject(id);
    if (!p) throw notFound(`project not found: ${id}`);
    return p;
  }

  getIncident(id: string): Incident | null {
    return this.db.query("SELECT * FROM incidents WHERE incident_id = ?").get(id) as unknown as Incident | null;
  }

  getIncidentOrFail(id: string): Incident {
    const inc = this.getIncident(id);
    if (!inc) throw notFound(`incident not found: ${id}`);
    return inc;
  }

  listIncidents(projectId?: string, limit = 50): Incident[] {
    if (projectId)
      return this.db
        .query("SELECT * FROM incidents WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?")
        .all(projectId, limit) as unknown as Incident[];
    return this.db
      .query("SELECT * FROM incidents ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as unknown as Incident[];
  }

  updateIncidentStatus(
    id: string,
    status: string,
    rationale: string,
    actor: string,
    opts: { verification_id?: string | null; blocked_reason?: string | null; untested?: string[]; next_review?: string | null } = {},
  ): Incident {
    if (!isOneOf(INCIDENT_STATUS, status)) throw validationError(`invalid incident status: ${status}`);
    return this.tx(() => {
      const inc = this.getIncidentOrFail(id);
      const allowed = VALID_INCIDENT_TRANSITIONS[inc.status] ?? [];
      if (!allowed.includes(status as any))
        throw conflict(`invalid incident transition ${inc.status} -> ${status}`);
      if (status === "resolved" && !opts.verification_id)
        throw validationError("resolved_verified requires a qualifying validation record id");
      if (!rationale) throw validationError("rationale is required for status change");
      const t = now();
      this.db
        .query("UPDATE incidents SET status = ?, updated_at = ?, summary_current = COALESCE(summary_current, ?) WHERE incident_id = ?")
        .run(status, t, status === "resolved" ? `Resolved: ${rationale}` : null, id);
      if (status === "resolved") {
        this.db.query("UPDATE incidents SET resolved_at = ? WHERE incident_id = ?").run(t, id);
      }
      appendTimelineEvent(this.db, {
        incident_id: id,
        event_type: `incident.status.${status}`,
        actor: actor as any,
        summary: `Status ${inc.status} -> ${status}: ${rationale}`,
        details: { verification_id: opts.verification_id ?? null, blocked_reason: opts.blocked_reason ?? null, untested: opts.untested ?? [], next_review: opts.next_review ?? null },
      });
      return this.getIncidentOrFail(id);
    });
  }

  /** Candidate related incidents for dedup suggestions (never auto-merged). */
  findRelatedIncidents(project: ProjectInput, fingerprints: { fingerprint_value: string }[], symptom: string): Incident[] {
    const results: Incident[] = [];
    const seen = new Set<string>();
    for (const fp of fingerprints) {
      const rows = this.db
        .query(
          `SELECT i.* FROM incidents i JOIN fingerprints f ON f.incident_id = i.incident_id WHERE f.fingerprint_value = ? LIMIT 5`,
        )
        .all(fp.fingerprint_value) as unknown as Incident[];
      for (const r of rows) if (!seen.has(r.incident_id)) { seen.add(r.incident_id); results.push(r); }
    }
    // Project-scoped approximate match on symptom title terms.
    void project;
    void symptom;
    return results;
  }

  // --- Environment ---------------------------------------------------------
  private insertEnvironmentIncident(
    incidentId: string | null,
    projectId: string,
    env: Partial<EnvironmentSnapshot>,
    actor: string,
    experimentId: string | null = null,
  ): string {
    const e: EnvironmentSnapshot = {
      environment_id: ids.environment(),
      project_id: projectId,
      experiment_id: experimentId,
      os_name: env.os_name ?? null,
      os_version: env.os_version ?? null,
      architecture: env.architecture ?? null,
      runtime_versions: env.runtime_versions ? JSON.stringify(env.runtime_versions) : null,
      dependency_versions: env.dependency_versions ? JSON.stringify(env.dependency_versions) : null,
      tool_versions: env.tool_versions ? JSON.stringify(env.tool_versions) : null,
      git_commit: env.git_commit ?? null,
      git_branch: env.git_branch ?? null,
      working_tree_state: env.working_tree_state ?? null,
      configuration_fingerprint: env.configuration_fingerprint ?? null,
      capture_method: env.capture_method ?? `provided_by_${actor}`,
      captured_at: env.captured_at ?? now(),
    };
    this.db
      .query(
        `INSERT INTO environments
         (environment_id, project_id, experiment_id, os_name, os_version, architecture, runtime_versions, dependency_versions, tool_versions, git_commit, git_branch, working_tree_state, configuration_fingerprint, capture_method, captured_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.environment_id, e.project_id, e.experiment_id, e.os_name, e.os_version, e.architecture,
        e.runtime_versions, e.dependency_versions, e.tool_versions, e.git_commit, e.git_branch,
        e.working_tree_state, e.configuration_fingerprint, e.capture_method, e.captured_at,
      );
    void incidentId;
    return e.environment_id;
  }

  captureEnvironment(incidentId: string | null, projectId: string, env: Partial<EnvironmentSnapshot>, actor: string, experimentId: string | null = null): string {
    return this.tx(() => this.insertEnvironmentIncident(incidentId, projectId, env, actor, experimentId));
  }

  getEnvironment(id: string): EnvironmentSnapshot | null {
    return this.db.query("SELECT * FROM environments WHERE environment_id = ?").get(id) as unknown as EnvironmentSnapshot | null;
  }

  // --- Hypotheses ----------------------------------------------------------
  createHypothesis(input: {
    incident_id: string;
    statement: string;
    rationale: string;
    parent_hypothesis_id?: string | null;
    confidence_note?: string | null;
    actor: string;
  }): Hypothesis {
    this.getIncidentOrFail(input.incident_id);
    return this.tx(() => {
      const t = now();
      const hypId = ids.hypothesis();
      this.db
        .query(
          `INSERT INTO hypotheses (hypothesis_id, incident_id, parent_hypothesis_id, statement, rationale, status, confidence_note, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(hypId, input.incident_id, input.parent_hypothesis_id ?? null, input.statement, input.rationale, "proposed", input.confidence_note ?? null, t, t);
      appendTimelineEvent(this.db, {
        incident_id: input.incident_id,
        event_type: "hypothesis.created",
        actor: input.actor as any,
        related_entity_type: "hypothesis",
        related_entity_id: hypId,
        summary: `Hypothesis proposed: ${input.statement}`,
      });
      return this.getHypothesis(hypId)!;
    });
  }

  getHypothesis(id: string): Hypothesis | null {
    return this.db.query("SELECT * FROM hypotheses WHERE hypothesis_id = ?").get(id) as unknown as Hypothesis | null;
  }

  listHypotheses(incidentId: string): Hypothesis[] {
    return this.db.query("SELECT * FROM hypotheses WHERE incident_id = ? ORDER BY created_at ASC").all(incidentId) as unknown as Hypothesis[];
  }

  /** Most recent timeline event id referencing an entity (for audit_refs in responses). */
  lastEventIdFor(entityId: string): string | null {
    const row = this.db
      .query("SELECT event_id FROM timeline_events WHERE related_entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(entityId) as { event_id: string } | null;
    return row ? row.event_id : null;
  }

  updateHypothesisStatus(id: string, status: string, rationale: string, actor: string): Hypothesis {
    if (!isOneOf(HYPOTHESIS_STATUS, status)) throw validationError(`invalid hypothesis status: ${status}`);
    return this.tx(() => {
      const hyp = this.getHypothesis(id);
      if (!hyp) throw notFound(`hypothesis not found: ${id}`);
      this.db.query("UPDATE hypotheses SET status = ?, updated_at = ?, confidence_note = COALESCE(?, confidence_note) WHERE hypothesis_id = ?").run(status, now(), rationale, id);
      appendTimelineEvent(this.db, {
        incident_id: hyp.incident_id,
        event_type: `hypothesis.${status}`,
        actor: actor as any,
        related_entity_type: "hypothesis",
        related_entity_id: id,
        summary: `Hypothesis ${hyp.status} -> ${status}: ${rationale}`,
      });
      return this.getHypothesis(id)!;
    });
  }

  // --- Strategies ----------------------------------------------------------
  createStrategy(input: {
    incident_id: string;
    title: string;
    description: string;
    reason_for_selection: string;
    hypothesis_id?: string | null;
    parent_strategy_id?: string | null;
    actor: string;
  }): Strategy {
    this.getIncidentOrFail(input.incident_id);
    return this.tx(() => {
      const t = now();
      const id = ids.strategy();
      this.db
        .query(
          `INSERT INTO strategies (strategy_id, incident_id, hypothesis_id, parent_strategy_id, title, description, reason_for_selection, status, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, input.incident_id, input.hypothesis_id ?? null, input.parent_strategy_id ?? null, input.title, input.description, input.reason_for_selection, "active", t, t);
      appendTimelineEvent(this.db, {
        incident_id: input.incident_id,
        event_type: "strategy.created",
        actor: input.actor as any,
        related_entity_type: "strategy",
        related_entity_id: id,
        summary: `Strategy created: ${input.title}`,
      });
      return this.getStrategy(id)!;
    });
  }

  getStrategy(id: string): Strategy | null {
    return this.db.query("SELECT * FROM strategies WHERE strategy_id = ?").get(id) as unknown as Strategy | null;
  }

  listStrategies(incidentId: string): Strategy[] {
    return this.db.query("SELECT * FROM strategies WHERE incident_id = ? ORDER BY created_at ASC").all(incidentId) as unknown as Strategy[];
  }

  // --- Experiments (tree) --------------------------------------------------
  getExperiment(id: string): Experiment | null {
    return this.db.query("SELECT * FROM experiments WHERE experiment_id = ?").get(id) as unknown as Experiment | null;
  }

  private ancestorDepth(experimentId: string | null): number {
    let depth = 0;
    let cursor = experimentId;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) throw conflict("cycle detected in experiment ancestry");
      seen.add(cursor);
      const parent = this.db
        .query("SELECT parent_experiment_id FROM experiments WHERE experiment_id = ?")
        .get(cursor) as { parent_experiment_id: string | null } | null;
      cursor = parent?.parent_experiment_id ?? null;
      depth++;
      if (depth > MAX_TREE_DEPTH_GUARD) throw validationError("experiment tree exceeds max supported depth");
    }
    return depth;
  }

  createExperiment(input: CreateExperimentInput): CreateExperimentResult {
    if (input.idempotency_key) {
      const ref = this.checkIdem(input.idempotency_key);
      if (ref) {
        const exp = this.getExperiment(ref);
        if (exp) return { experiment: exp, duplicateWarnings: [], budgetWarnings: [] };
      }
    }
    if (!isOneOf(NODE_KIND, input.node_kind)) throw validationError(`invalid node_kind: ${input.node_kind}`);
    this.getIncidentOrFail(input.incident_id);
    if (input.node_kind === "variant" && !input.parent_experiment_id)
      throw validationError("a variant node requires parent_experiment_id");
    if (input.node_kind === "variant" && !input.reason_for_difference)
      throw validationError("a variant node requires reason_for_difference (what changed and why)");

    let budgetWarnings: string[] = [];
    const result = this.tx(() => {
      let parentLabel: string | null = null;
      let depth = 0;
      if (input.parent_experiment_id) {
        const parent = this.getExperiment(input.parent_experiment_id);
        if (!parent) throw notFound(`parent experiment not found: ${input.parent_experiment_id}`);
        if (parent.incident_id !== input.incident_id)
          throw validationError("parent experiment belongs to a different incident");
        parentLabel = parent.display_label;
        // ancestorDepth(parent) counts nodes from parent up to root inclusive,
        // which equals the NEW node's depth (root = 0).
        depth = this.ancestorDepth(input.parent_experiment_id);
      }
      const siblingCount = (
        this.db
          .query("SELECT COUNT(*) AS c FROM experiments WHERE incident_id = ? AND IFNULL(parent_experiment_id,'') = IFNULL(?,'')")
          .get(input.incident_id, input.parent_experiment_id ?? null) as { c: number }
      ).c;
      const label = deriveLabel(parentLabel, siblingCount, depth);

      // Exploration budgets: enforced hard limits + near-limit warnings (engine/budgets.ts).
      const incidentForBudget = this.getIncidentOrFail(input.incident_id);
      const budgetConfig = this.resolveBudgetConfigNoTx(incidentForBudget.project_id, incidentForBudget.incident_id);
      const existingNodes = this.allExperiments(input.incident_id);
      const byId = new Map(existingNodes.map((e) => [e.experiment_id, e]));
      let parentFamilyRootId: string | null = null;
      let newVariantDepth = 0;
      if (input.parent_experiment_id) {
        const parentNode = byId.get(input.parent_experiment_id);
        if (parentNode) {
          const rootExp = familyRootOf(parentNode, byId);
          parentFamilyRootId = (rootExp ?? parentNode).experiment_id;
          newVariantDepth = input.node_kind === "variant" ? variantDepthOf(parentNode, byId) + 1 : 0;
        }
      }
      const usage = computeBudgetUsage(existingNodes, incidentForBudget);
      const budgetEval = evaluateNewExperimentBudget(budgetConfig, usage, {
        node_kind: input.node_kind,
        parent_experiment_id: input.parent_experiment_id ?? null,
        parent_family_root_id: parentFamilyRootId,
        new_variant_depth: newVariantDepth,
        risk_level: input.risk_level ?? "unknown",
      });
      if (budgetEval.blocked)
        throw new McpError(ErrorCategory.LIMIT_EXCEEDED, budgetEval.blocked.message, {
          limit_name: budgetEval.blocked.limit_name,
          limit: budgetEval.blocked.limit,
          current: budgetEval.blocked.current,
        });
      budgetWarnings = budgetEval.warnings;

      const t = now();
      const id = ids.experiment();
      const exp: Experiment = {
        experiment_id: id,
        incident_id: input.incident_id,
        strategy_id: input.strategy_id ?? null,
        hypothesis_id: input.hypothesis_id ?? null,
        parent_experiment_id: input.parent_experiment_id ?? null,
        inspired_by_experiment_id: input.inspired_by_experiment_id ?? null,
        display_label: label,
        node_kind: input.node_kind as Experiment["node_kind"],
        title: input.title,
        proposed_change: input.proposed_change ?? null,
        reason_for_difference: input.reason_for_difference ?? null,
        expected_observation: input.expected_observation ?? null,
        preconditions: input.preconditions ?? null,
        environment_id: null,
        risk_level: input.risk_level ?? "unknown",
        estimated_cost: input.estimated_cost ?? null,
        execution_status: "not_started",
        outcome_status: "pending",
        actual_observation: null,
        interpretation: null,
        failure_reason: null,
        environment_delta: null,
        display_order: siblingCount,
        started_at: null,
        completed_at: null,
        created_at: t,
        updated_at: t,
        created_by: (input.actor as any) ?? "agent",
        approval_record_id: null,
      };
      this.db
        .query(
          `INSERT INTO experiments
           (experiment_id, incident_id, strategy_id, hypothesis_id, parent_experiment_id, inspired_by_experiment_id, display_label, node_kind, title, proposed_change, reason_for_difference, expected_observation, preconditions, environment_id, risk_level, estimated_cost, execution_status, outcome_status, actual_observation, interpretation, failure_reason, environment_delta, display_order, started_at, completed_at, created_at, updated_at, created_by, approval_record_id)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          exp.experiment_id, exp.incident_id, exp.strategy_id, exp.hypothesis_id, exp.parent_experiment_id,
          exp.inspired_by_experiment_id, exp.display_label, exp.node_kind, exp.title, exp.proposed_change,
          exp.reason_for_difference, exp.expected_observation, exp.preconditions, exp.environment_id, exp.risk_level,
          exp.estimated_cost, exp.execution_status, exp.outcome_status, exp.actual_observation, exp.interpretation,
          exp.failure_reason, exp.environment_delta, exp.display_order, exp.started_at, exp.completed_at,
          exp.created_at, exp.updated_at, exp.created_by, exp.approval_record_id,
        );
      fts.indexExperiment(this.db, id, exp.incident_id, exp.title,
        [exp.proposed_change, exp.expected_observation, exp.reason_for_difference].filter(Boolean).join(" "));
      appendTimelineEvent(this.db, {
        incident_id: exp.incident_id,
        event_type: "experiment.created",
        actor: exp.created_by,
        related_entity_type: "experiment",
        related_entity_id: id,
        summary: `${input.node_kind} ${label} created: ${exp.title}`,
        details: { parent: input.parent_experiment_id ?? null, reason_for_difference: exp.reason_for_difference },
      });
      if (input.idempotency_key) this.putIdem(input.idempotency_key, "debug_attempt_create", id);
      return { experiment: exp };
    });

    const duplicateWarnings = this.duplicateWarnings(result.experiment);
    return { experiment: result.experiment, duplicateWarnings, budgetWarnings };
  }

  updateExperiment(id: string, input: UpdateExperimentInput): { experiment: Experiment; previous: Experiment } {
    if (input.execution_status && !isOneOf(EXECUTION_STATUS, input.execution_status))
      throw validationError(`invalid execution_status: ${input.execution_status}`);
    if (input.outcome_status && !isOneOf(OUTCOME_STATUS, input.outcome_status))
      throw validationError(`invalid outcome_status: ${input.outcome_status}`);
    return this.tx(() => {
      const prev = this.getExperiment(id);
      if (!prev) throw notFound(`experiment not found: ${id}`);
      // Any non-pending outcome is a claim and must be justified by observation/
      // interpretation/failure_reason OR attached evidence. Records the reason;
      // does not fabricate outcomes.
      if (input.outcome_status && input.outcome_status !== "pending") {
        const hasJustification =
          input.actual_observation || input.interpretation || input.failure_reason;
        const evCount = (
          this.db.query("SELECT COUNT(*) AS c FROM evidence WHERE experiment_id = ?").get(id) as { c: number }
        ).c;
        if (!hasJustification && evCount === 0)
          throw validationError(
            "setting a non-pending outcome requires actual_observation, interpretation, failure_reason, or attached evidence",
          );
      }

      const fields: string[] = [];
      const values: (string | number | null)[] = [];
      const set = (col: string, val: string | number | null) => { fields.push(`${col} = ?`); values.push(val); };
      if (input.execution_status !== undefined) set("execution_status", input.execution_status);
      if (input.outcome_status !== undefined) set("outcome_status", input.outcome_status);
      if (input.actual_observation !== undefined) set("actual_observation", input.actual_observation);
      if (input.interpretation !== undefined) set("interpretation", input.interpretation);
      if (input.failure_reason !== undefined) set("failure_reason", input.failure_reason);
      if (input.environment_delta !== undefined) set("environment_delta", input.environment_delta);
      if (input.environment_id !== undefined) set("environment_id", input.environment_id);
      if (input.started_at !== undefined) set("started_at", input.started_at);
      if (input.completed_at !== undefined) set("completed_at", input.completed_at);
      if (input.approval_record_id !== undefined) set("approval_record_id", input.approval_record_id);
      set("updated_at", now());
      values.push(id);
      this.db.query(`UPDATE experiments SET ${fields.join(", ")} WHERE experiment_id = ?`).run(...values as any);

      const updated = this.getExperiment(id)!;
      fts.indexExperiment(this.db, id, updated.incident_id, updated.title,
        [updated.proposed_change, updated.expected_observation, updated.actual_observation, updated.interpretation].filter(Boolean).join(" "));

      appendTimelineEvent(this.db, {
        incident_id: updated.incident_id,
        event_type: `experiment.${input.outcome_status ? `outcome.${input.outcome_status}` : "updated"}`,
        actor: input.actor as any,
        related_entity_type: "experiment",
        related_entity_id: id,
        summary: `Experiment ${updated.display_label ?? id}: exec ${prev.execution_status}->${updated.execution_status}, outcome ${prev.outcome_status}->${updated.outcome_status}`,
        details: { before: { execution: prev.execution_status, outcome: prev.outcome_status }, after: { execution: updated.execution_status, outcome: updated.outcome_status } },
      });
      return { experiment: updated, previous: prev };
    });
  }

  listChildren(parentId: string | null, incidentId: string): Experiment[] {
    if (parentId === null) {
      return this.db
        .query("SELECT * FROM experiments WHERE incident_id = ? AND parent_experiment_id IS NULL ORDER BY display_order ASC")
        .all(incidentId) as unknown as Experiment[];
    }
    return this.db
      .query("SELECT * FROM experiments WHERE incident_id = ? AND parent_experiment_id = ? ORDER BY display_order ASC")
      .all(incidentId, parentId) as unknown as Experiment[];
  }

  allExperiments(incidentId: string): Experiment[] {
    return this.db
      .query("SELECT * FROM experiments WHERE incident_id = ? ORDER BY display_order, created_at ASC")
      .all(incidentId) as unknown as Experiment[];
  }

  /** Build a nested tree of an incident (or subtree). */
  buildTree(incidentId: string, rootId: string | null, maxDepth: number): { nodes: TreeNode[]; total: number } {
    const all = this.allExperiments(incidentId);
    const byId = new Map(all.map((e) => [e.experiment_id, e]));
    const childrenOf = new Map<string | null, Experiment[]>();
    for (const e of all) {
      const key = e.parent_experiment_id ?? null;
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key)!.push(e);
    }
    const toNode = (e: Experiment, depth: number): TreeNode => {
      const kids = (childrenOf.get(e.experiment_id) ?? []).map((c) => toNode(c, depth + 1));
      return {
        experiment_id: e.experiment_id,
        label: e.display_label,
        node_kind: e.node_kind,
        title: e.title,
        hypothesis_id: e.hypothesis_id,
        strategy_id: e.strategy_id,
        execution_status: e.execution_status,
        outcome_status: e.outcome_status,
        depth,
        children: kids,
        truncated: depth >= maxDepth && (childrenOf.get(e.experiment_id) ?? []).length > 0,
      };
    };
    let roots: Experiment[];
    if (rootId) {
      const r = byId.get(rootId);
      if (!r) throw notFound(`root experiment not found: ${rootId}`);
      roots = [r];
    } else {
      roots = childrenOf.get(null) ?? [];
    }
    return { nodes: roots.map((r) => toNode(r, 0)), total: all.length };
  }

  duplicateWarnings(candidate: Experiment): DuplicateWarning[] {
    return detectDuplicateWarnings(this, candidate);
  }

  // --- Evidence ------------------------------------------------------------
  recordEvidence(input: {
    project_id: string;
    incident_id?: string | null;
    experiment_id?: string | null;
    hypothesis_id?: string | null;
    validation_run_id?: string | null;
    evidence_type: string;
    content: string;
    capture_source: string;
    interpretation?: string | null;
    captured_at?: string | null;
    retention_class?: string;
    idempotency_key?: string | null;
  }): { evidence: Evidence; warnings: string[] } {
    if (!isOneOf(EVIDENCE_TYPES, input.evidence_type)) throw validationError(`invalid evidence_type: ${input.evidence_type}`);
    return this.tx(() => {
      if (input.idempotency_key) {
        const ref = this.checkIdem(input.idempotency_key);
        if (ref) {
          const existing = this.getEvidence(ref);
          if (existing) return { evidence: existing, warnings: [] };
        }
      }
      const id = ids.evidence();
      const { text: redacted, status } = redactWithStatus(input.content ?? "");
      const { text: bounded, truncated } = truncate(redacted, MAX_EVIDENCE_BYTES);
      const originalSize = Buffer.byteLength(input.content ?? "", "utf8");
      const warnings: string[] = [];
      if (status === "redacted") warnings.push("secrets_redacted_before_storage");
      if (truncated) warnings.push("content_truncated_to_size_limit");

      const evidence: Evidence = {
        evidence_id: id,
        project_id: input.project_id,
        incident_id: input.incident_id ?? null,
        experiment_id: input.experiment_id ?? null,
        hypothesis_id: input.hypothesis_id ?? null,
        validation_run_id: input.validation_run_id ?? null,
        evidence_type: input.evidence_type as Evidence["evidence_type"],
        storage_reference: `inline:${id}`,
        content_hash: contentHash(redacted),
        content_size_bytes: originalSize,
        redaction_status: status,
        capture_source: (input.capture_source as any) ?? "agent",
        capture_complete: truncated ? 0 : 1,
        interpretation: input.interpretation ? redactWithStatus(input.interpretation).text : null,
        retention_class: input.retention_class ?? "standard",
        captured_at: input.captured_at ?? now(),
        created_at: now(),
      };
      this.db
        .query(
          `INSERT INTO evidence
           (evidence_id, project_id, incident_id, experiment_id, hypothesis_id, validation_run_id, evidence_type, storage_reference, content_hash, content_size_bytes, redaction_status, capture_source, capture_complete, interpretation, retention_class, captured_at, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          evidence.evidence_id, evidence.project_id, evidence.incident_id, evidence.experiment_id,
          evidence.hypothesis_id, evidence.validation_run_id, evidence.evidence_type, evidence.storage_reference,
          evidence.content_hash, evidence.content_size_bytes, evidence.redaction_status, evidence.capture_source,
          evidence.capture_complete ? 1 : 0, evidence.interpretation, evidence.retention_class, evidence.captured_at, evidence.created_at,
        );
      this.db
        .query("INSERT INTO evidence_content(evidence_id, content, truncated, original_size_bytes) VALUES(?,?,?,?)")
        .run(id, bounded, truncated ? 1 : 0, originalSize);

      const incId = input.incident_id ?? (input.experiment_id ? this.getExperiment(input.experiment_id)?.incident_id ?? null : null);
      if (incId) {
        fts.indexEvidence(this.db, id, incId, input.experiment_id ?? null, input.evidence_type, `${evidence.interpretation ?? ""} ${bounded}`);
        appendTimelineEvent(this.db, {
          incident_id: incId,
          event_type: "evidence.recorded",
          actor: evidence.capture_source,
          related_entity_type: "evidence",
          related_entity_id: id,
          summary: `Evidence recorded (${input.evidence_type})`,
          evidence_refs: [id],
          details: { warnings },
        });
      }
      if (input.idempotency_key) this.putIdem(input.idempotency_key, "debug_evidence_record", id);
      return { evidence, warnings };
    });
  }

  getEvidence(id: string): Evidence | null {
    return this.db.query("SELECT * FROM evidence WHERE evidence_id = ?").get(id) as unknown as Evidence | null;
  }

  getEvidenceContent(id: string): { content: string; truncated: boolean } | null {
    const row = this.db.query("SELECT content, truncated FROM evidence_content WHERE evidence_id = ?").get(id) as
      | { content: string; truncated: number }
      | null;
    return row ? { content: row.content, truncated: !!row.truncated } : null;
  }

  listEvidence(filter: { incident_id?: string; experiment_id?: string }): Evidence[] {
    if (filter.experiment_id)
      return this.db.query("SELECT * FROM evidence WHERE experiment_id = ? ORDER BY created_at ASC").all(filter.experiment_id) as unknown as Evidence[];
    if (filter.incident_id)
      return this.db.query("SELECT * FROM evidence WHERE incident_id = ? ORDER BY created_at ASC").all(filter.incident_id) as unknown as Evidence[];
    return [] as Evidence[];
  }

  // --- Research references -------------------------------------------------
  recordResearch(input: {
    incident_id: string;
    source_type: string;
    relevant_summary: string;
    claim_supported_or_challenged: string;
    experiment_id?: string | null;
    hypothesis_id?: string | null;
    source_uri?: string | null;
    source_title?: string | null;
    reliability_note?: string | null;
    accessed_at?: string | null;
    actor: string;
  }): ResearchReference {
    this.getIncidentOrFail(input.incident_id);
    return this.tx(() => {
      const ref: ResearchReference = {
        research_reference_id: ids.research(),
        incident_id: input.incident_id,
        experiment_id: input.experiment_id ?? null,
        hypothesis_id: input.hypothesis_id ?? null,
        source_uri: input.source_uri ?? null,
        source_title: input.source_title ?? null,
        source_type: input.source_type,
        accessed_at: input.accessed_at ?? now(),
        relevant_summary: input.relevant_summary,
        reliability_note: input.reliability_note ?? null,
        claim_supported_or_challenged: input.claim_supported_or_challenged,
        created_at: now(),
      };
      this.db
        .query(
          `INSERT INTO research_references
           (research_reference_id, incident_id, experiment_id, hypothesis_id, source_uri, source_title, source_type, accessed_at, relevant_summary, reliability_note, claim_supported_or_challenged, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          ref.research_reference_id, ref.incident_id, ref.experiment_id, ref.hypothesis_id, ref.source_uri,
          ref.source_title, ref.source_type, ref.accessed_at, ref.relevant_summary, ref.reliability_note,
          ref.claim_supported_or_challenged, ref.created_at,
        );
      appendTimelineEvent(this.db, {
        incident_id: ref.incident_id,
        event_type: "research.recorded",
        actor: input.actor as any,
        related_entity_type: "research_reference",
        related_entity_id: ref.research_reference_id,
        summary: `Research (${ref.source_type}): ${ref.claim_supported_or_challenged}`,
      });
      return ref;
    });
  }

  listResearch(incidentId: string): ResearchReference[] {
    return this.db.query("SELECT * FROM research_references WHERE incident_id = ? ORDER BY created_at ASC").all(incidentId) as unknown as ResearchReference[];
  }

  // --- Validation ----------------------------------------------------------
  recordValidation(input: {
    incident_id: string;
    experiment_id: string;
    validation_plan: string;
    criteria_results: { criteria: string; status: string; note?: string }[];
    execution_result: string;
    evidence_ids: string[];
    verified_by: string;
    validated_environment_id?: string | null;
    limitations?: string | null;
    reproduced_before?: number | null;
  }): { validation: ValidationRun; decision: string } {
    if (!isOneOf(VALIDATION_RESULT, input.execution_result)) throw validationError(`invalid execution_result: ${input.execution_result}`);
    return this.tx(() => {
      const inc = this.getIncidentOrFail(input.incident_id);
      const exp = this.getExperiment(input.experiment_id);
      if (!exp) throw notFound(`experiment not found: ${input.experiment_id}`);
      if (exp.incident_id !== input.incident_id) throw validationError("experiment belongs to a different incident");

      const hasFailed = input.criteria_results.some((c) => c.status === "failed");
      const decision =
        input.execution_result === "passed" && !hasFailed ? "verified" : "unverified";

      const validation: ValidationRun = {
        validation_run_id: ids.validation(),
        incident_id: input.incident_id,
        experiment_id: input.experiment_id,
        validation_plan: input.validation_plan,
        criteria_results: JSON.stringify(input.criteria_results),
        execution_result: input.execution_result as ValidationRun["execution_result"],
        evidence_ids: JSON.stringify(input.evidence_ids ?? []),
        validated_environment_id: input.validated_environment_id ?? null,
        verified_by: (input.verified_by as any) ?? "agent",
        validated_at: now(),
        limitations: input.limitations ?? null,
        reproduced_before: input.reproduced_before ?? null,
        resolution_decision: decision,
        decision_rationale:
          decision === "verified"
            ? "All required acceptance criteria passed with recorded evidence."
            : hasFailed
              ? "One or more acceptance criteria failed; resolution not verified."
              : "Validation did not pass all criteria under the required conditions.",
        created_at: now(),
      };
      this.db
        .query(
          `INSERT INTO validation_runs
           (validation_run_id, incident_id, experiment_id, validation_plan, criteria_results, execution_result, evidence_ids, validated_environment_id, verified_by, validated_at, limitations, reproduced_before, resolution_decision, decision_rationale, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          validation.validation_run_id, validation.incident_id, validation.experiment_id, validation.validation_plan,
          validation.criteria_results, validation.execution_result, validation.evidence_ids, validation.validated_environment_id,
          validation.verified_by, validation.validated_at, validation.limitations, validation.reproduced_before,
          validation.resolution_decision, validation.decision_rationale, validation.created_at,
        );

      // A verified validation is the ONLY path that marks an experiment's outcome as verified.
      if (decision === "verified") {
        this.db.query("UPDATE experiments SET outcome_status = 'verified', execution_status = 'completed', updated_at = ? WHERE experiment_id = ?").run(now(), input.experiment_id);
      }

      appendTimelineEvent(this.db, {
        incident_id: input.incident_id,
        event_type: decision === "verified" ? "validation.verified" : "validation.unverified",
        actor: validation.verified_by,
        related_entity_type: "validation_run",
        related_entity_id: validation.validation_run_id,
        summary: `Validation ${decision} for ${exp.display_label ?? input.experiment_id}: ${validation.decision_rationale}`,
        evidence_refs: input.evidence_ids ?? [],
        details: { experiment_id: input.experiment_id, decision },
      });
      void inc;
      return { validation, decision };
    });
  }

  listValidations(incidentId: string): ValidationRun[] {
    return this.db.query("SELECT * FROM validation_runs WHERE incident_id = ? ORDER BY validated_at ASC").all(incidentId) as unknown as ValidationRun[];
  }

  getVerificationForIncident(incidentId: string): ValidationRun[] {
    return this.listValidations(incidentId).filter((v) => v.resolution_decision === "verified");
  }

  // --- Plugin observations ---------------------------------------------------
  // Unassociated events captured by the OpenCode plugin. incident_id is NULL when
  // correlation is unknown — never guessed. Deduplicated by event_key.

  recordObservation(input: {
    event_key: string;
    kind: string;
    session_id?: string | null;
    tool?: string | null;
    args_summary?: string | null;
    output_summary?: string | null;
    status?: string | null;
    incident_id?: string | null;
    experiment_id?: string | null;
    capture_complete?: boolean;
  }): { observation_id: string; duplicate: boolean } {
    return this.tx(() => {
      const existing = this.db
        .query("SELECT observation_id FROM plugin_observations WHERE event_key = ?")
        .get(input.event_key) as { observation_id: string } | null;
      if (existing) return { observation_id: existing.observation_id, duplicate: true };

      const args = input.args_summary ? redactWithStatus(input.args_summary) : null;
      const out = input.output_summary ? redactWithStatus(input.output_summary) : null;
      const redaction =
        args?.status === "redacted" || out?.status === "redacted" ? "redacted" : "no_secret_detected";

      const id = ids.approval().replace(/^apr_/, "obs_");
      this.db
        .query(
          `INSERT INTO plugin_observations
           (observation_id, event_key, kind, session_id, tool, args_summary, output_summary, status, incident_id, experiment_id, capture_complete, redaction_status, captured_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id, input.event_key, input.kind, input.session_id ?? null, input.tool ?? null,
          args ? truncate(args.text, 4096).text : null,
          out ? truncate(out.text, 4096).text : null,
          input.status ?? null, input.incident_id ?? null, input.experiment_id ?? null,
          input.capture_complete === false ? 0 : 1, redaction, now(),
        );
      return { observation_id: id, duplicate: false };
    });
  }

  associateObservation(observationId: string, incidentId: string, experimentId?: string | null): void {
    this.db
      .query("UPDATE plugin_observations SET incident_id = ?, experiment_id = ? WHERE observation_id = ?")
      .run(incidentId, experimentId ?? null, observationId);
  }

  listObservations(filter: { incident_id?: string; session_id?: string; limit?: number }): Array<{
    observation_id: string; event_key: string; kind: string; session_id: string | null; tool: string | null;
    args_summary: string | null; output_summary: string | null; status: string | null;
    incident_id: string | null; experiment_id: string | null; capture_complete: number; captured_at: string;
  }> {
    const limit = Math.max(1, Math.min(500, filter.limit ?? 50));
    if (filter.incident_id)
      return this.db.query("SELECT * FROM plugin_observations WHERE incident_id = ? ORDER BY captured_at DESC LIMIT ?").all(filter.incident_id, limit) as any;
    if (filter.session_id)
      return this.db.query("SELECT * FROM plugin_observations WHERE session_id = ? ORDER BY captured_at DESC LIMIT ?").all(filter.session_id, limit) as any;
    return this.db.query("SELECT * FROM plugin_observations ORDER BY captured_at DESC LIMIT ?").all(limit) as any;
  }

  // --- Exploration budgets ---------------------------------------------------
  private getBudgetRow(scope: "project" | "incident", projectId: string | null, incidentId: string | null): BudgetConfig | null {
    const row = this.db
      .query(
        "SELECT config FROM budgets WHERE scope = ? AND IFNULL(project_id,'') = IFNULL(?,'') AND IFNULL(incident_id,'') = IFNULL(?,'') LIMIT 1",
      )
      .get(scope, projectId, incidentId) as { config: string } | null;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.config) as Partial<BudgetConfig>;
      return { ...DEFAULT_BUDGET_CONFIG, ...parsed };
    } catch {
      return null;
    }
  }

  /** Effective config: incident override > project default > built-in defaults. */
  resolveBudgetConfigNoTx(projectId: string, incidentId: string): BudgetConfig {
    return (
      this.getBudgetRow("incident", projectId, incidentId) ??
      this.getBudgetRow("project", projectId, null) ??
      { ...DEFAULT_BUDGET_CONFIG }
    );
  }

  resolveBudgetConfig(projectId: string, incidentId: string): BudgetConfig {
    return this.resolveBudgetConfigNoTx(projectId, incidentId);
  }

  /** Project-level default (no incident override applied). */
  getProjectBudgetDefault(projectId: string): BudgetConfig {
    return this.getBudgetRow("project", projectId, null) ?? { ...DEFAULT_BUDGET_CONFIG };
  }

  /**
   * Upsert a budget config. Layered merge: project defaults merge over the
   * built-in defaults; incident overrides merge over the project default.
   * Incident-scoped changes are recorded in the audit timeline; project-level
   * changes update the row only (the timeline is incident-scoped by design).
   */
  setBudgetConfig(input: {
    scope: "project" | "incident";
    project_id: string | null;
    incident_id: string | null;
    config: Partial<BudgetConfig>;
    actor: string;
    rationale?: string | null;
  }): BudgetConfig {
    const err = validateBudgetConfigPatch(input.config);
    if (err) throw validationError(err);
    return this.tx(() => {
      const base =
        input.scope === "incident"
          ? this.getBudgetRow("project", input.project_id, null) ?? { ...DEFAULT_BUDGET_CONFIG }
          : { ...DEFAULT_BUDGET_CONFIG };
      const merged = mergeBudgetConfig(base, input.config);
      const t = now();
      this.db
        .query(
          `INSERT OR REPLACE INTO budgets
           (budget_id, scope, project_id, incident_id, config, actor, rationale, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          `bgt_${input.scope}_${input.incident_id ?? input.project_id ?? "default"}`,
          input.scope,
          input.project_id,
          input.incident_id,
          JSON.stringify(merged),
          input.actor,
          input.rationale ?? null,
          t,
          t,
        );
      if (input.scope === "incident" && input.incident_id) {
        appendTimelineEvent(this.db, {
          incident_id: input.incident_id,
          event_type: "budget.updated",
          actor: input.actor as any,
          summary: `Exploration budget updated${input.rationale ? `: ${input.rationale}` : ""}`,
          details: { config: merged, rationale: input.rationale ?? null },
        });
      }
      return merged;
    });
  }

  clearIncidentBudgetOverride(incidentId: string, actor: string, rationale?: string | null): void {
    this.tx(() => {
      this.db.query("DELETE FROM budgets WHERE scope = 'incident' AND IFNULL(incident_id,'') = ?").run(incidentId);
      appendTimelineEvent(this.db, {
        incident_id: incidentId,
        event_type: "budget.override_cleared",
        actor: actor as any,
        summary: `Per-incident budget override cleared${rationale ? `: ${rationale}` : ""}; the project/default budget applies again.`,
      });
    });
  }

  // --- Links ---------------------------------------------------------------
  link(input: {
    source_type: string;
    source_id: string;
    target_type: string;
    target_id: string;
    relationship_type: string;
    rationale?: string | null;
    actor: string;
  }) {
    return this.tx(() =>
      createLink(this.db, {
        source_type: input.source_type,
        source_id: input.source_id,
        target_type: input.target_type,
        target_id: input.target_id,
        relationship_type: input.relationship_type as any,
        rationale: input.rationale ?? null,
        actor: input.actor as any,
      }),
    );
  }
}

const REPRO_SET = new Set(["reproduced", "intermittent", "not_reproduced", "unknown"]);

export interface TreeNode {
  experiment_id: string;
  label: string | null;
  node_kind: string;
  title: string;
  hypothesis_id: string | null;
  strategy_id: string | null;
  execution_status: string;
  outcome_status: string;
  depth: number;
  children: TreeNode[];
  truncated: boolean;
}
