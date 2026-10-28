/**
 * Hardening regression tests (v0.2.1):
 *  1. Verified outcomes are immutable to ordinary updates (CONFLICT, machine-readable).
 *  2. Only a validation run can set 'verified'; a failing re-validation regresses a
 *     verified fix auditably (verified -> failed + timeline event); validation
 *     history stays append-only.
 *  3. Incident resolution derives resolution_experiment_id from the qualifying
 *     validation record (store-level enforcement, transactional), and invalid
 *     resolution attempts preserve the incident state exactly.
 *
 * All fixtures run on isolated :memory: databases. The production memory DB is
 * never touched, and the resolved production incident is never mutated.
 */
import { test, expect } from "bun:test";
import { openStore, closeStore } from "./helpers.ts";
import type { Store } from "../../src/memory/store.ts";
import { McpError } from "../../src/errors.ts";
import { listTimeline } from "../../src/memory/audit.ts";
import { buildCatalog } from "../../src/server/catalog.ts";

function seed(s?: Store, title = "hardening case") {
  const store = s ?? openStore(":memory:");
  const inc = store.createIncident({
    project: { display_name: "Hardening", project_id: "prj_h" },
    title,
    initial_symptom: "symptom",
    actor: "agent",
  }).incident;
  const exp = store.createExperiment({
    incident_id: inc.incident_id,
    node_kind: "experiment",
    title: "the fix attempt",
    expected_observation: "o",
    risk_level: "low",
    actor: "agent",
  }).experiment;
  return { s: store, inc, exp };
}
function verify(s: Store, incId: string, expId: string) {
  const inc = s.getIncidentOrFail(incId);
  const ev = s.recordEvidence({
    project_id: inc.project_id,
    incident_id: incId,
    experiment_id: expId,
    evidence_type: "stdout",
    content: "repro passes cleanly",
    capture_source: "agent",
  });
  return s.recordValidation({
    incident_id: incId,
    experiment_id: expId,
    validation_plan: "original acceptance criteria",
    criteria_results: [{ criteria: "repro passes", status: "passed" }],
    execution_result: "passed",
    evidence_ids: [ev.evidence.evidence_id],
    verified_by: "agent",
  });
}
async function callTool(s: Store, name: string, args: Record<string, unknown>) {
  const catalog = buildCatalog({ store: s, dbPath: ":memory:", log: () => {} });
  try {
    const res = await catalog.call(name, args);
    return { isError: false, structured: res.structuredContent as any };
  } catch (e: any) {
    return { isError: true, category: (e?.category ?? "INTERNAL_ERROR") as string, structured: { ok: false, error: { category: e?.category, message: e?.message, details: e?.details } } };
  }
}

// --- Phase 2: verified-outcome integrity ------------------------------------------

test("verified outcome is immutable to ordinary updates (every downgrade target rejected)", () => {
  const { s, inc, exp } = seed();
  verify(s, inc.incident_id, exp.experiment_id);
  expect(s.getExperiment(exp.experiment_id)!.outcome_status).toBe("verified");
  const timelineBefore = listTimeline(s.db, inc.incident_id).length;
  for (const target of ["candidate", "partial", "pending", "failed", "inconclusive", "blocked", "superseded", "not_applicable"]) {
    let err: McpError | null = null;
    try {
      s.updateExperiment(exp.experiment_id, { outcome_status: target, actual_observation: "try downgrade", interpretation: "should not pass", actor: "agent" });
    } catch (e) { err = e as McpError; }
    expect(err?.category).toBe("CONFLICT");
    expect((err as McpError)!.details).toMatchObject({ from: "verified", to: target });
    expect(((err as McpError)!.details as any).hint).toContain("failing re-validation");
    expect(s.getExperiment(exp.experiment_id)!.outcome_status).toBe("verified"); // unchanged
  }
  // No timeline writes leaked from the rejected updates
  expect(listTimeline(s.db, inc.incident_id).length).toBe(timelineBefore);
  closeStore(s);
});

test("ordinary updates cannot SET verified either (store-level mirror of the tool rule)", () => {
  const { s, exp } = seed();
  let err: McpError | null = null;
  try {
    s.updateExperiment(exp.experiment_id, { outcome_status: "verified", actual_observation: "looks fixed", actor: "agent" });
  } catch (e) { err = e as McpError; }
  expect(err?.category).toBe("CONFLICT");
  expect(((err as McpError)!.details as any).hint).toContain("debug_validation_record");
  expect(s.getExperiment(exp.experiment_id)!.outcome_status).toBe("pending");
  closeStore(s);
});

test("non-outcome updates on a verified experiment remain allowed", () => {
  const { s, inc, exp } = seed();
  verify(s, inc.incident_id, exp.experiment_id);
  const r = s.updateExperiment(exp.experiment_id, { interpretation: "additional context after verification", actor: "agent" });
  expect(r.experiment.outcome_status).toBe("verified");
  const tl = listTimeline(s.db, inc.incident_id);
  expect(tl.some((e) => e.event_type === "experiment.updated")).toBe(true);
  closeStore(s);
});

test("downgrade rejection surfaces through the MCP tool as a machine-readable error", async () => {
  const { s, inc, exp } = seed();
  verify(s, inc.incident_id, exp.experiment_id);
  const res = await callTool(s, "debug_attempt_update", { attempt_id: exp.experiment_id, outcome_status: "candidate", actual_observation: "x", actor: "agent" });
  expect(res.isError).toBe(true);
  expect(res.category).toBe("CONFLICT");
  expect((res.structured.error.details as any).hint).toContain("failing re-validation");
  expect(s.getExperiment(exp.experiment_id)!.outcome_status).toBe("verified");
  closeStore(s);
});

test("failing re-validation auditably regresses a verified experiment (verified -> failed)", () => {
  const { s, inc, exp } = seed();
  const first = verify(s, inc.incident_id, exp.experiment_id);
  const regressed = s.recordValidation({
    incident_id: inc.incident_id,
    experiment_id: exp.experiment_id,
    validation_plan: "regression check after recurrence report",
    criteria_results: [{ criteria: "repro passes", status: "failed" }],
    execution_result: "failed",
    evidence_ids: [],
    verified_by: "agent",
  });
  expect(regressed.decision).toBe("unverified");
  expect(s.getExperiment(exp.experiment_id)!.outcome_status).toBe("failed");
  const tl = listTimeline(s.db, inc.incident_id);
  const regressedEvent = tl.find((e) => e.event_type === "experiment.outcome.regressed");
  expect(regressedEvent).toBeDefined();
  expect(regressedEvent!.summary).toContain("verified -> failed");
  // Append-only: BOTH validation records survive
  const validations = s.listValidations(inc.incident_id);
  expect(validations.length).toBe(2);
  expect(validations.some((v) => v.validation_run_id === first.validation.validation_run_id && v.resolution_decision === "verified")).toBe(true);
  expect(validations.some((v) => v.validation_run_id === regressed.validation.validation_run_id && v.resolution_decision === "unverified")).toBe(true);
  closeStore(s);
});

test("inconclusive re-validation records doubt without downgrading the verified outcome", () => {
  const { s, inc, exp } = seed();
  verify(s, inc.incident_id, exp.experiment_id);
  const recheck = s.recordValidation({
    incident_id: inc.incident_id,
    experiment_id: exp.experiment_id,
    validation_plan: "spot check",
    criteria_results: [{ criteria: "repro passes", status: "not_evaluable", note: "environment unavailable" }],
    execution_result: "inconclusive",
    evidence_ids: [],
    verified_by: "agent",
  });
  expect(recheck.decision).toBe("unverified");
  expect(s.getExperiment(exp.experiment_id)!.outcome_status).toBe("verified"); // doubt on file, no silent downgrade
  expect(listTimeline(s.db, inc.incident_id).some((e) => e.event_type === "experiment.outcome.regressed")).toBe(false);
  closeStore(s);
});

test("a regressed experiment can be re-verified by a later passing validation", () => {
  const { s, inc, exp } = seed();
  verify(s, inc.incident_id, exp.experiment_id);
  s.recordValidation({ incident_id: inc.incident_id, experiment_id: exp.experiment_id, validation_plan: "p", criteria_results: [{ criteria: "repro", status: "failed" }], execution_result: "failed", evidence_ids: [], verified_by: "agent" });
  expect(s.getExperiment(exp.experiment_id)!.outcome_status).toBe("failed");
  const again = verify(s, inc.incident_id, exp.experiment_id);
  expect(again.decision).toBe("verified");
  expect(s.getExperiment(exp.experiment_id)!.outcome_status).toBe("verified");
  expect(s.listValidations(inc.incident_id).length).toBe(3); // full history retained
  closeStore(s);
});

// --- Phase 3: resolution traceability -----------------------------------------------

test("resolving an incident derives resolution_experiment_id from the qualifying validation", () => {
  const { s, inc, exp } = seed();
  const val = verify(s, inc.incident_id, exp.experiment_id);
  s.updateIncidentStatus(inc.incident_id, "investigating", "fix validated", "agent");
  const resolved = s.updateIncidentStatus(inc.incident_id, "resolved", "criteria verified", "agent", { verification_id: val.validation.validation_run_id });
  expect(resolved.status).toBe("resolved");
  expect(resolved.resolution_experiment_id).toBe(exp.experiment_id); // derived, not caller-supplied
  expect(resolved.resolved_at).toBeTruthy();
  const ev = listTimeline(s.db, inc.incident_id).find((e) => e.event_type === "incident.status.resolved");
  expect(JSON.parse(ev!.details as string).resolution_experiment_id).toBe(exp.experiment_id);
  closeStore(s);
});

test("invalid resolution attempts are rejected and preserve the incident state", () => {
  const { s, inc, exp } = seed();
  verify(s, inc.incident_id, exp.experiment_id);
  s.updateIncidentStatus(inc.incident_id, "investigating", "heading to resolution attempts", "agent");

  // a) no verification id (direct store call — store-level enforcement)
  expect(() => s.updateIncidentStatus(inc.incident_id, "resolved", "no id", "agent")).toThrow(/qualifying validation/);
  // b) verification id belonging to a DIFFERENT incident
  const other = seed(s, "second case");
  const otherVal = verify(s, other.inc.incident_id, other.exp.experiment_id);
  expect(() => s.updateIncidentStatus(inc.incident_id, "resolved", "wrong incident", "agent", { verification_id: otherVal.validation.validation_run_id })).toThrow(/not found for this incident/);
  // c) unverified validation
  const unverified = s.recordValidation({ incident_id: inc.incident_id, experiment_id: exp.experiment_id, validation_plan: "p", criteria_results: [{ criteria: "repro", status: "failed" }], execution_result: "failed", evidence_ids: [], verified_by: "agent" });
  expect(() => s.updateIncidentStatus(inc.incident_id, "resolved", "unverified", "agent", { verification_id: unverified.validation.validation_run_id })).toThrow(/did not reach a verified decision/);

  // State preserved exactly: still investigating, no resolution stamp, no resolved timeline event
  const after = s.getIncidentOrFail(inc.incident_id);
  expect(after.status).toBe("investigating");
  expect(after.resolution_experiment_id).toBeNull();
  expect(after.resolved_at).toBeNull();
  expect(listTimeline(s.db, inc.incident_id).some((e) => e.event_type === "incident.status.resolved")).toBe(false);
  closeStore(s);
});

test("invalid resolution through the MCP tool is a machine-readable error", async () => {
  const { s, inc } = seed();
  const res = await callTool(s, "debug_case_status_update", { incident_id: inc.incident_id, status: "resolved", verification_id: "val_nonexistent", rationale: "should fail", actor: "agent" });
  expect(res.isError).toBe(true);
  expect(s.getIncidentOrFail(inc.incident_id).status).not.toBe("resolved");
  closeStore(s);
});

test("promotion path intact end-to-end: pending -> candidate -> validated verified -> traceable resolution", async () => {
  const { s, inc, exp } = seed();
  // pending -> candidate via ordinary update (allowed)
  s.updateExperiment(exp.experiment_id, { execution_status: "completed", outcome_status: "candidate", actual_observation: "looks promising", actor: "agent" });
  // candidate -> verified only via validation
  const val = verify(s, inc.incident_id, exp.experiment_id);
  expect(val.decision).toBe("verified");
  // resolve through the tool end-to-end
  await callTool(s, "debug_case_status_update", { incident_id: inc.incident_id, status: "investigating", rationale: "validating candidate", actor: "agent" });
  const res = await callTool(s, "debug_case_status_update", { incident_id: inc.incident_id, status: "resolved", verification_id: val.validation.validation_run_id, rationale: "verified", actor: "user" });
  expect(res.isError).toBe(false);
  const finalInc = s.getIncidentOrFail(inc.incident_id);
  expect(finalInc.status).toBe("resolved");
  expect(finalInc.resolution_experiment_id).toBe(exp.experiment_id);
  closeStore(s);
});
