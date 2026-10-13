/**
 * A reusable test corpus: multiple projects, exact-duplicate and similar-but-
 * distinct errors, nested trees with mixed outcomes, and evidence fixtures
 * containing secrets. Used by search-quality tests.
 */
import type { Store } from "../../src/memory/store.ts";
import { buildFingerprintValues, normalizeMessage, stackSignature } from "../../src/retrieval/fingerprint.ts";

export interface Corpus {
  projectA: string; // inc of "auth token expired" for project A
  projectADuplicate: string; // exact same fingerprint, recorded again
  projectASimilar: string; // similar text, DIFFERENT cause/fingerprint
  projectB: string; // another project's incident (should be isolated)
  verifiedIncident: string;
}

const rawAuthError = "Error: auth token expired (status 401) at login (C:\\srv\\auth.js:88:13) req 99887766 at 2026-10-12T09:00:00Z";
const authFingerprints = buildFingerprintValues(rawAuthError);

const rawDistinctError = "Error: connection timeout after 30000ms to db 10.0.0.7:5432";
const distinctFingerprints = buildFingerprintValues(rawDistinctError);

// Exported so search tests can compute the exact fingerprint value used above.
export const AUTH_RAW_ERROR = rawAuthError;
export const AUTH_NORMALIZED = normalizeMessage(rawAuthError);
export const AUTH_STACK_SIGNATURE = stackSignature(rawAuthError);

export function seedCorpus(store: Store): Corpus {
  // Project A — recurring "token expired"
  const a = store.createIncident({
    project: { display_name: "ProjectA", repository_uri: "file:///a", project_id: "prj_a" },
    title: "users logged out: auth token expired",
    initial_symptom: "Error: auth token expired (status 401)",
    fingerprints: authFingerprints,
    reproduction_status: "reproduced",
    acceptance_criteria: "valid session stays authenticated for 30 minutes",
    actor: "agent",
  }).incident;

  // Strategy + failed attempts + one verified
  const strat = store.createExperiment({ incident_id: a.incident_id, node_kind: "strategy", title: "Token refresh logic", proposed_change: "extend refresh window", expected_observation: "sessions persist", actor: "agent" }).experiment;
  const f1 = store.createExperiment({ incident_id: a.incident_id, node_kind: "experiment", title: "Increase token TTL to 1h", parent_experiment_id: strat.experiment_id, proposed_change: "set TTL=3600", expected_observation: "fewer 401s", risk_level: "medium", actor: "agent" }).experiment;
  store.recordEvidence({ project_id: a.project_id, incident_id: a.incident_id, experiment_id: f1.experiment_id, evidence_type: "test_result", content: "still 401 after TTL change, api_key=sk-liveKEYsecret0123456789xyz", capture_source: "agent" });
  store.updateExperiment(f1.experiment_id, { execution_status: "completed", outcome_status: "failed", actual_observation: "401 persists", actor: "agent" });
  const f2 = store.createExperiment({ incident_id: a.incident_id, node_kind: "variant", title: "Refresh window before TTL expiry", parent_experiment_id: f1.experiment_id, reason_for_difference: "rotate token proactively instead of reacting to 401", proposed_change: "prefetch new token", expected_observation: "no 401s", risk_level: "medium", actor: "agent" }).experiment;

  // Duplicate incident of A (same fingerprint) — should be found by fingerprint, not merged
  const aDup = store.createIncident({
    project: { display_name: "ProjectA", repository_uri: "file:///a", project_id: "prj_a" },
    title: "auth failures recurring",
    initial_symptom: "Error: auth token expired (status 401)",
    fingerprints: authFingerprints,
    reproduction_status: "reproduced",
    actor: "agent",
  }).incident;

  // Similar text, different cause (must not be treated as proven same root cause)
  const aSimilar = store.createIncident({
    project: { display_name: "ProjectA", repository_uri: "file:///a", project_id: "prj_a" },
    title: "auth error after dependency upgrade",
    initial_symptom: "Error: auth library rejected token signature",
    fingerprints: buildFingerprintValues("auth library rejected token signature"),
    reproduction_status: "intermittent",
    actor: "agent",
  }).incident;

  // Project B — isolated
  const b = store.createIncident({
    project: { display_name: "ProjectB", repository_uri: "file:///b", project_id: "prj_b" },
    title: "db connection timeout",
    initial_symptom: "Error: connection timeout after 30000ms to db",
    fingerprints: distinctFingerprints,
    reproduction_status: "reproduced",
    actor: "agent",
  }).incident;

  // A verified incident to confirm verified results surface
  const v = store.createIncident({
    project: { display_name: "ProjectA", repository_uri: "file:///a", project_id: "prj_a" },
    title: "config reload fixed via restart",
    initial_symptom: "config not reloaded after edit",
    reproduction_status: "reproduced",
    actor: "agent",
  }).incident;
  const vExp = store.createExperiment({ incident_id: v.incident_id, node_kind: "experiment", title: "Restart worker to reload config", proposed_change: "pm2 restart worker", expected_observation: "config live", risk_level: "low", actor: "agent" }).experiment;
  store.recordValidation({ incident_id: v.incident_id, experiment_id: vExp.experiment_id, validation_plan: "edit config -> observe live behavior", criteria_results: [{ criteria: "config live", status: "passed" }], execution_result: "passed", evidence_ids: [], verified_by: "agent" });

  void distinctFingerprints; void aSimilar;
  return { projectA: a.incident_id, projectADuplicate: aDup.incident_id, projectASimilar: aSimilar.incident_id, projectB: b.incident_id, verifiedIncident: v.incident_id };
}
