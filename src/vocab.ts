/**
 * Controlled vocabularies.
 *
 * Lifecycle logic must never branch on arbitrary free-text statuses. These
 * values are canonical; explanatory notes may accompany them but are stored
 * separately (e.g. reason fields). Derived display labels (such as "A1A") are
 * presentation-only and never identity.
 */

// --- Incident lifecycle ---------------------------------------------------
export const INCIDENT_STATUS = [
  "open",
  "investigating",
  "blocked",
  "resolved", // convenience alias for resolved_verified
  "closed_unresolved",
  "reopened",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUS)[number];

export const TERMINAL_INCIDENT_STATUSES = new Set<IncidentStatus>(["resolved", "closed_unresolved"]);
export const VALID_INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  open: ["investigating", "blocked", "closed_unresolved", "reopened"],
  investigating: ["blocked", "resolved", "closed_unresolved", "reopened", "investigating"],
  blocked: ["investigating", "closed_unresolved", "reopened"],
  resolved: ["reopened", "closed_unresolved"],
  closed_unresolved: ["reopened", "investigating"],
  reopened: ["investigating", "blocked", "closed_unresolved", "resolved"],
};

// --- Hypothesis lifecycle -------------------------------------------------
export const HYPOTHESIS_STATUS = [
  "proposed",
  "supported",
  "weakened",
  "rejected",
  "unresolved",
  "reopened",
] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUS)[number];

// --- Strategy lifecycle ---------------------------------------------------
export const STRATEGY_STATUS = [
  "planned",
  "active",
  "exhausted_for_now",
  "promising",
  "abandoned",
  "completed",
] as const;
export type StrategyStatus = (typeof STRATEGY_STATUS)[number];

// --- Reproduction status --------------------------------------------------
export const REPRODUCTION_STATUS = [
  "reproduced",
  "intermittent",
  "not_reproduced",
  "unknown",
] as const;
export type ReproductionStatus = (typeof REPRODUCTION_STATUS)[number];

// --- Experiment execution status -----------------------------------------
// Did the intended action actually run as planned?
export const EXECUTION_STATUS = [
  "not_started",
  "running",
  "completed",
  "interrupted",
  "failed_to_execute",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUS)[number];

// --- Experiment outcome status -------------------------------------------
// What did the executed experiment prove about the bug?
export const OUTCOME_STATUS = [
  "pending",
  "failed",
  "inconclusive",
  "partial",
  "blocked",
  "candidate",
  "verified",
  "superseded",
  "not_applicable",
] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUS)[number];

// Only these terminal outcomes require an evidence-backed justification to set.
export const TERMINAL_OUTCOMES = new Set<OutcomeStatus>([
  "failed",
  "inconclusive",
  "partial",
  "blocked",
  "candidate",
  "verified",
  "not_applicable",
  "superseded",
]);

// --- Node kinds in the experiment tree ------------------------------------
export const NODE_KIND = ["strategy", "experiment", "variant"] as const;
export type NodeKind = (typeof NODE_KIND)[number];

// --- Validation run result ------------------------------------------------
export const VALIDATION_RESULT = ["passed", "failed", "interrupted", "inconclusive"] as const;
export type ValidationResult = (typeof VALIDATION_RESULT)[number];

// --- Relationship types (general link records) ----------------------------
export const RELATIONSHIP_TYPES = [
  "similar_to",
  "derived_from",
  "contradicts",
  "supports",
  "depends_on",
  "supersedes",
  "reproduces",
  "resolved_by",
  "same_signature_as",
  "revisits_with_changed_environment",
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

// --- Evidence types -------------------------------------------------------
export const EVIDENCE_TYPES = [
  "stdout",
  "stderr",
  "log",
  "stack_trace",
  "test_result",
  "diff",
  "config_snapshot",
  "api_response",
  "research_excerpt",
  "screenshot_ref",
  "metric",
  "environment_observation",
  "user_observation",
  "source_reference",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

// --- Redaction status -----------------------------------------------------
export const REDACTION_STATUS = [
  "not_checked",
  "redacted",
  "no_secret_detected",
  "quarantined",
] as const;
export type RedactionStatus = (typeof REDACTION_STATUS)[number];

// --- Capture provenance / completeness ------------------------------------
export const CAPTURE_SOURCE = [
  "user",
  "agent",
  "plugin",
  "external_tool",
  "import",
  "server",
] as const;
export type CaptureSource = (typeof CAPTURE_SOURCE)[number];

export function isOneOf<T extends readonly string[]>(list: T, value: unknown): value is T[number] {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}
