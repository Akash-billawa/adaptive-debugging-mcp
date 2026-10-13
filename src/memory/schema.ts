import type { Database } from "bun:sqlite";

/**
 * SQLite schema for the Adaptive Debugging MCP.
 *
 * Design: local-first relational model with stable IDs and explicit parent-child
 * experiment relationships. Append-only history. Large artifacts are referenced
 * by `storage_reference`, not stored inline. FTS5 provides full-text retrieval;
 * semantic search is deliberately deferred.
 */

export const SCHEMA_VERSION = 3;

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS projects (
     project_id TEXT PRIMARY KEY,
     display_name TEXT NOT NULL,
     canonical_root TEXT,
     repository_uri TEXT,
     default_branch TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     archived_at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS incidents (
     incident_id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     title TEXT NOT NULL,
     initial_symptom TEXT NOT NULL,
     first_observed_at TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     status TEXT NOT NULL,
     severity TEXT,
     reproduction_status TEXT NOT NULL,
     resolution_experiment_id TEXT,
     resolved_at TEXT,
     summary_current TEXT,
     acceptance_criteria TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_incidents_project ON incidents(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status)`,

  `CREATE TABLE IF NOT EXISTS fingerprints (
     fingerprint_id TEXT PRIMARY KEY,
     incident_id TEXT NOT NULL,
     fingerprint_type TEXT NOT NULL,
     fingerprint_value TEXT NOT NULL,
     normalization_version TEXT NOT NULL,
     source_evidence_id TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_fp_value ON fingerprints(fingerprint_value)`,
  `CREATE INDEX IF NOT EXISTS idx_fp_incident ON fingerprints(incident_id)`,

  `CREATE TABLE IF NOT EXISTS environments (
     environment_id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     experiment_id TEXT,
     os_name TEXT,
     os_version TEXT,
     architecture TEXT,
     runtime_versions TEXT,
     dependency_versions TEXT,
     tool_versions TEXT,
     git_commit TEXT,
     git_branch TEXT,
     working_tree_state TEXT,
     configuration_fingerprint TEXT,
     capture_method TEXT NOT NULL,
     captured_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_env_project ON environments(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_env_experiment ON environments(experiment_id)`,

  `CREATE TABLE IF NOT EXISTS hypotheses (
     hypothesis_id TEXT PRIMARY KEY,
     incident_id TEXT NOT NULL,
     parent_hypothesis_id TEXT,
     statement TEXT NOT NULL,
     rationale TEXT NOT NULL,
     status TEXT NOT NULL,
     confidence_note TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_hyp_incident ON hypotheses(incident_id)`,

  `CREATE TABLE IF NOT EXISTS strategies (
     strategy_id TEXT PRIMARY KEY,
     incident_id TEXT NOT NULL,
     hypothesis_id TEXT,
     parent_strategy_id TEXT,
     title TEXT NOT NULL,
     description TEXT NOT NULL,
     reason_for_selection TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_incident ON strategies(incident_id)`,

  `CREATE TABLE IF NOT EXISTS experiments (
     experiment_id TEXT PRIMARY KEY,
     incident_id TEXT NOT NULL,
     strategy_id TEXT,
     hypothesis_id TEXT,
     parent_experiment_id TEXT,
     inspired_by_experiment_id TEXT,
     display_label TEXT,
     node_kind TEXT NOT NULL,
     title TEXT NOT NULL,
     proposed_change TEXT,
     reason_for_difference TEXT,
     expected_observation TEXT,
     preconditions TEXT,
     environment_id TEXT,
     risk_level TEXT NOT NULL DEFAULT 'unknown',
     estimated_cost TEXT,
     execution_status TEXT NOT NULL DEFAULT 'not_started',
     outcome_status TEXT NOT NULL DEFAULT 'pending',
     actual_observation TEXT,
     interpretation TEXT,
     failure_reason TEXT,
     environment_delta TEXT,
     display_order INTEGER NOT NULL DEFAULT 0,
     started_at TEXT,
     completed_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     approval_record_id TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_exp_incident ON experiments(incident_id)`,
  `CREATE INDEX IF NOT EXISTS idx_exp_parent ON experiments(parent_experiment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_exp_strategy ON experiments(strategy_id)`,
  `CREATE INDEX IF NOT EXISTS idx_exp_outcome ON experiments(outcome_status)`,

  `CREATE TABLE IF NOT EXISTS evidence (
     evidence_id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     incident_id TEXT,
     experiment_id TEXT,
     hypothesis_id TEXT,
     validation_run_id TEXT,
     evidence_type TEXT NOT NULL,
     storage_reference TEXT NOT NULL,
     content_hash TEXT,
     content_size_bytes INTEGER,
     redaction_status TEXT NOT NULL,
     capture_source TEXT NOT NULL,
     capture_complete INTEGER NOT NULL DEFAULT 0,
     interpretation TEXT,
     retention_class TEXT NOT NULL DEFAULT 'standard',
     captured_at TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ev_incident ON evidence(incident_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ev_experiment ON evidence(experiment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ev_redaction ON evidence(redaction_status)`,

  // Redacted, size-bounded evidence payload kept out of the indexed evidence row.
  `CREATE TABLE IF NOT EXISTS evidence_content (
     evidence_id TEXT PRIMARY KEY,
     content TEXT NOT NULL,
     truncated INTEGER NOT NULL DEFAULT 0,
     original_size_bytes INTEGER
   )`,

  `CREATE TABLE IF NOT EXISTS research_references (
     research_reference_id TEXT PRIMARY KEY,
     incident_id TEXT NOT NULL,
     experiment_id TEXT,
     hypothesis_id TEXT,
     source_uri TEXT,
     source_title TEXT,
     source_type TEXT NOT NULL,
     accessed_at TEXT NOT NULL,
     relevant_summary TEXT NOT NULL,
     reliability_note TEXT,
     claim_supported_or_challenged TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_res_incident ON research_references(incident_id)`,

  `CREATE TABLE IF NOT EXISTS validation_runs (
     validation_run_id TEXT PRIMARY KEY,
     incident_id TEXT NOT NULL,
     experiment_id TEXT NOT NULL,
     validation_plan TEXT NOT NULL,
     criteria_results TEXT NOT NULL,
     execution_result TEXT NOT NULL,
     evidence_ids TEXT NOT NULL DEFAULT '[]',
     validated_environment_id TEXT,
     verified_by TEXT NOT NULL,
     validated_at TEXT NOT NULL,
     limitations TEXT,
     reproduced_before INTEGER,
     resolution_decision TEXT NOT NULL DEFAULT 'unverified',
     decision_rationale TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_val_incident ON validation_runs(incident_id)`,
  `CREATE INDEX IF NOT EXISTS idx_val_experiment ON validation_runs(experiment_id)`,

  `CREATE TABLE IF NOT EXISTS timeline_events (
     event_id TEXT PRIMARY KEY,
     incident_id TEXT NOT NULL,
     event_type TEXT NOT NULL,
     actor TEXT NOT NULL,
     related_entity_type TEXT,
     related_entity_id TEXT,
     summary TEXT NOT NULL,
     details TEXT,
     evidence_refs TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tl_incident ON timeline_events(incident_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS entity_links (
     link_id TEXT PRIMARY KEY,
     source_type TEXT NOT NULL,
     source_id TEXT NOT NULL,
     target_type TEXT NOT NULL,
     target_id TEXT NOT NULL,
     relationship_type TEXT NOT NULL,
     rationale TEXT,
     actor TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_link_src ON entity_links(source_type, source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_link_tgt ON entity_links(target_type, target_id)`,

  `CREATE TABLE IF NOT EXISTS idempotency_keys (
     idem_key TEXT PRIMARY KEY,
     tool TEXT NOT NULL,
     result_ref TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,

  // --- Exploration budgets (v3) ---
  // Effective-config rows: 'project' defaults and 'incident' overrides.
  // Additive only; existing records are never touched by this table.
  `CREATE TABLE IF NOT EXISTS budgets (
     budget_id TEXT PRIMARY KEY,
     scope TEXT NOT NULL,
     project_id TEXT,
     incident_id TEXT,
     config TEXT NOT NULL,
     actor TEXT NOT NULL,
     rationale TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_scope
     ON budgets(scope, IFNULL(project_id,''), IFNULL(incident_id,''))`,

  // --- Plugin observations (v2) ---
  // Unassociated events captured by the OpenCode plugin. incident/experiment may
  // be NULL when the observation could not be correlated; never guess.
  `CREATE TABLE IF NOT EXISTS plugin_observations (
     observation_id TEXT PRIMARY KEY,
     event_key TEXT UNIQUE,
     kind TEXT NOT NULL,
     session_id TEXT,
     tool TEXT,
     args_summary TEXT,
     output_summary TEXT,
     status TEXT,
     incident_id TEXT,
     experiment_id TEXT,
     capture_complete INTEGER NOT NULL DEFAULT 0,
     redaction_status TEXT NOT NULL DEFAULT 'not_checked',
     captured_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_plugin_obs_session ON plugin_observations(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_plugin_obs_incident ON plugin_observations(incident_id)`,

  // --- Full-text search indexes (managed manually) ---
  `CREATE VIRTUAL TABLE IF NOT EXISTS incident_fts USING fts5(
     incident_id UNINDEXED,
     project_id UNINDEXED,
     title,
     symptom,
     body,
     tokenize = 'porter unicode61'
   )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS experiment_fts USING fts5(
     experiment_id UNINDEXED,
     incident_id UNINDEXED,
     title,
     body,
     tokenize = 'porter unicode61'
   )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
     evidence_id UNINDEXED,
     incident_id UNINDEXED,
     experiment_id UNINDEXED,
     type UNINDEXED,
     body,
     tokenize = 'porter unicode61'
   )`,
];

/** Create the full schema (idempotent) and stamp the schema version.
 * The caller is responsible for setting PRAGMAs before invoking this. */
export function applySchema(db: Database): void {
  for (const stmt of DDL) db.run(stmt);
  db.query("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(
    String(SCHEMA_VERSION),
  );
}

/** Read the stored schema version, or 0 when absent. */
export function readSchemaVersion(db: Database): number {
  try {
    const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | null;
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}
