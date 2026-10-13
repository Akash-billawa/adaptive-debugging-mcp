import type {
  CaptureSource,
  ExecutionStatus,
  EvidenceType,
  HypothesisStatus,
  IncidentStatus,
  NodeKind,
  OutcomeStatus,
  RedactionStatus,
  RelationshipType,
  ReproductionStatus,
  StrategyStatus,
  ValidationResult,
} from "./vocab.ts";

// Re-export vocab unions for convenience.
export type {
  CaptureSource,
  ExecutionStatus,
  EvidenceType,
  HypothesisStatus,
  IncidentStatus,
  NodeKind,
  OutcomeStatus,
  RedactionStatus,
  RelationshipType,
  ReproductionStatus,
  StrategyStatus,
  ValidationResult,
};

export interface Project {
  project_id: string;
  display_name: string;
  canonical_root: string | null;
  repository_uri: string | null;
  default_branch: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface Incident {
  incident_id: string;
  project_id: string;
  title: string;
  initial_symptom: string;
  first_observed_at: string;
  created_at: string;
  updated_at: string;
  status: IncidentStatus;
  severity: string | null;
  reproduction_status: ReproductionStatus;
  resolution_experiment_id: string | null;
  resolved_at: string | null;
  summary_current: string | null;
  acceptance_criteria: string | null;
}

export interface Fingerprint {
  fingerprint_id: string;
  incident_id: string;
  fingerprint_type: string;
  fingerprint_value: string;
  normalization_version: string;
  source_evidence_id: string | null;
  created_at: string;
}

export interface EnvironmentSnapshot {
  environment_id: string;
  project_id: string;
  experiment_id: string | null;
  os_name: string | null;
  os_version: string | null;
  architecture: string | null;
  runtime_versions: string | null; // JSON
  dependency_versions: string | null; // JSON
  tool_versions: string | null; // JSON
  git_commit: string | null;
  git_branch: string | null;
  working_tree_state: string | null;
  configuration_fingerprint: string | null;
  capture_method: string;
  captured_at: string;
}

export interface Hypothesis {
  hypothesis_id: string;
  incident_id: string;
  parent_hypothesis_id: string | null;
  statement: string;
  rationale: string;
  status: HypothesisStatus;
  confidence_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Strategy {
  strategy_id: string;
  incident_id: string;
  hypothesis_id: string | null;
  parent_strategy_id: string | null;
  title: string;
  description: string;
  reason_for_selection: string;
  status: StrategyStatus;
  created_at: string;
  updated_at: string;
}

export interface Experiment {
  experiment_id: string;
  incident_id: string;
  strategy_id: string | null;
  hypothesis_id: string | null;
  parent_experiment_id: string | null;
  inspired_by_experiment_id: string | null;
  display_label: string | null;
  node_kind: NodeKind;
  title: string;
  proposed_change: string | null;
  reason_for_difference: string | null;
  expected_observation: string | null;
  preconditions: string | null;
  environment_id: string | null;
  risk_level: string;
  estimated_cost: string | null;
  execution_status: ExecutionStatus;
  outcome_status: OutcomeStatus;
  actual_observation: string | null;
  interpretation: string | null;
  failure_reason: string | null;
  environment_delta: string | null;
  display_order: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: CaptureSource;
  approval_record_id: string | null;
}

export interface Evidence {
  evidence_id: string;
  project_id: string;
  incident_id: string | null;
  experiment_id: string | null;
  hypothesis_id: string | null;
  validation_run_id: string | null;
  evidence_type: EvidenceType;
  storage_reference: string;
  content_hash: string | null;
  content_size_bytes: number | null;
  redaction_status: RedactionStatus;
  capture_source: CaptureSource;
  capture_complete: number; // 1 complete, 0 partial/unavailable
  interpretation: string | null; // agent-authored, separate from raw
  retention_class: string;
  captured_at: string;
  created_at: string;
}

export interface ResearchReference {
  research_reference_id: string;
  incident_id: string;
  experiment_id: string | null;
  hypothesis_id: string | null;
  source_uri: string | null;
  source_title: string | null;
  source_type: string;
  accessed_at: string;
  relevant_summary: string;
  reliability_note: string | null;
  claim_supported_or_challenged: string;
  created_at: string;
}

export interface ValidationRun {
  validation_run_id: string;
  incident_id: string;
  experiment_id: string;
  validation_plan: string;
  criteria_results: string; // JSON array of {criteria, status, note}
  execution_result: ValidationResult;
  evidence_ids: string; // JSON array
  validated_environment_id: string | null;
  verified_by: CaptureSource;
  validated_at: string;
  limitations: string | null;
  reproduced_before: number | null; // 1/0/null
  resolution_decision: string; // verified | unverified | rejected
  decision_rationale: string | null;
  created_at: string;
}

export interface TimelineEvent {
  event_id: string;
  incident_id: string;
  event_type: string;
  actor: CaptureSource;
  related_entity_type: string | null;
  related_entity_id: string | null;
  summary: string;
  details: string | null; // JSON
  evidence_refs: string | null; // JSON array
  created_at: string;
}

export interface EntityLink {
  link_id: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  relationship_type: RelationshipType;
  rationale: string | null;
  actor: CaptureSource;
  created_at: string;
}

export interface FtsRow {
  rowid: number;
}
