import { test, expect } from "bun:test";
import { openStore, closeStore } from "./helpers.ts";
import { buildCatalog } from "../../src/server/catalog.ts";
import { McpError } from "../../src/errors.ts";
import type { Store } from "../../src/memory/store.ts";

function setup() {
  const store = openStore(":memory:");
  const catalog = buildCatalog({ store, dbPath: ":memory:", log: () => {} });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await catalog.call(name, args);
    return res.structuredContent as any;
  };
  return { store, call };
}

test("recordValidation with empty criteria_results: [] yields unverified and cannot resolve", async () => {
  const { store } = setup();
  const inc = store.createIncident({
    project: { display_name: "VGApp", project_id: "prj_vg" },
    title: "bug", initial_symptom: "sym", actor: "agent",
  }).incident;
  const exp = store.createExperiment({
    incident_id: inc.incident_id, node_kind: "experiment", title: "fix", proposed_change: "c", expected_observation: "o", actor: "agent",
  }).experiment;
  const ev = store.recordEvidence({
    project_id: inc.project_id, incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    evidence_type: "stdout", content: "ok", capture_source: "agent",
  });

  const val = store.recordValidation({
    incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    validation_plan: "plan", criteria_results: [],
    execution_result: "passed", evidence_ids: [ev.evidence.evidence_id], verified_by: "agent",
  });

  expect(val.decision).toBe("unverified");
  expect(store.getExperiment(exp.experiment_id)!.outcome_status).not.toBe("verified");

  store.updateIncidentStatus(inc.incident_id, "investigating", "inv", "agent");
  expect(() =>
    store.updateIncidentStatus(inc.incident_id, "resolved", "res", "agent", {
      verification_id: val.validation.validation_run_id,
    })
  ).toThrow();

  closeStore(store);
});

test("recordValidation with execution_result: 'failed' yields unverified even if criteria pass", async () => {
  const { store } = setup();
  const inc = store.createIncident({
    project: { display_name: "VGApp", project_id: "prj_vg" },
    title: "bug", initial_symptom: "sym", actor: "agent",
  }).incident;
  const exp = store.createExperiment({
    incident_id: inc.incident_id, node_kind: "experiment", title: "fix", proposed_change: "c", expected_observation: "o", actor: "agent",
  }).experiment;
  const ev = store.recordEvidence({
    project_id: inc.project_id, incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    evidence_type: "stdout", content: "ok", capture_source: "agent",
  });

  const val = store.recordValidation({
    incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    validation_plan: "plan",
    criteria_results: [{ criteria: "no crash", status: "passed" }],
    execution_result: "failed", evidence_ids: [ev.evidence.evidence_id], verified_by: "agent",
  });

  expect(val.decision).toBe("unverified");
  expect(store.getExperiment(exp.experiment_id)!.outcome_status).not.toBe("verified");

  store.updateIncidentStatus(inc.incident_id, "investigating", "inv", "agent");
  expect(() =>
    store.updateIncidentStatus(inc.incident_id, "resolved", "res", "agent", {
      verification_id: val.validation.validation_run_id,
    })
  ).toThrow();

  closeStore(store);
});

test("recordValidation with skipped or not_evaluable criteria yields unverified", async () => {
  const { store } = setup();
  const inc = store.createIncident({
    project: { display_name: "VGApp", project_id: "prj_vg" },
    title: "bug", initial_symptom: "sym", actor: "agent",
  }).incident;
  const exp = store.createExperiment({
    incident_id: inc.incident_id, node_kind: "experiment", title: "fix", proposed_change: "c", expected_observation: "o", actor: "agent",
  }).experiment;
  const ev = store.recordEvidence({
    project_id: inc.project_id, incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    evidence_type: "stdout", content: "ok", capture_source: "agent",
  });

  // Criteria marked 'skipped'
  const valSkipped = store.recordValidation({
    incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    validation_plan: "plan",
    criteria_results: [{ criteria: "criteria 1", status: "skipped" }],
    execution_result: "passed", evidence_ids: [ev.evidence.evidence_id], verified_by: "agent",
  });
  expect(valSkipped.decision).toBe("unverified");

  // Criteria marked 'not_evaluable'
  const valNotEvaluable = store.recordValidation({
    incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    validation_plan: "plan",
    criteria_results: [
      { criteria: "criteria 1", status: "passed" },
      { criteria: "criteria 2", status: "not_evaluable" },
    ],
    execution_result: "passed", evidence_ids: [ev.evidence.evidence_id], verified_by: "agent",
  });
  expect(valNotEvaluable.decision).toBe("unverified");

  closeStore(store);
});

test("recordValidation with empty evidence_ids: [] yields unverified and cannot resolve", async () => {
  const { store } = setup();
  const inc = store.createIncident({
    project: { display_name: "VGApp", project_id: "prj_vg" },
    title: "bug", initial_symptom: "sym", actor: "agent",
  }).incident;
  const exp = store.createExperiment({
    incident_id: inc.incident_id, node_kind: "experiment", title: "fix", proposed_change: "c", expected_observation: "o", actor: "agent",
  }).experiment;

  const val = store.recordValidation({
    incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    validation_plan: "plan",
    criteria_results: [{ criteria: "criteria 1", status: "passed" }],
    execution_result: "passed", evidence_ids: [], verified_by: "agent",
  });

  expect(val.decision).toBe("unverified");
  expect(store.getExperiment(exp.experiment_id)!.outcome_status).not.toBe("verified");

  store.updateIncidentStatus(inc.incident_id, "investigating", "inv", "agent");
  expect(() =>
    store.updateIncidentStatus(inc.incident_id, "resolved", "res", "agent", {
      verification_id: val.validation.validation_run_id,
    })
  ).toThrow();

  closeStore(store);
});

test("recordValidation with nonexistent or cross-incident evidence ID throws error", async () => {
  const { store } = setup();
  const incA = store.createIncident({
    project: { display_name: "VGApp", project_id: "prj_vg" },
    title: "bug A", initial_symptom: "sym A", actor: "agent",
  }).incident;
  const incB = store.createIncident({
    project: { display_name: "VGApp", project_id: "prj_vg" },
    title: "bug B", initial_symptom: "sym B", actor: "agent",
  }).incident;
  const expA = store.createExperiment({
    incident_id: incA.incident_id, node_kind: "experiment", title: "fix A", proposed_change: "c", expected_observation: "o", actor: "agent",
  }).experiment;
  const evB = store.recordEvidence({
    project_id: incB.project_id, incident_id: incB.incident_id, experiment_id: null,
    evidence_type: "stdout", content: "ok B", capture_source: "agent",
  });

  // Nonexistent evidence ID
  expect(() =>
    store.recordValidation({
      incident_id: incA.incident_id, experiment_id: expA.experiment_id,
      validation_plan: "plan",
      criteria_results: [{ criteria: "c", status: "passed" }],
      execution_result: "passed", evidence_ids: ["evi_does_not_exist"], verified_by: "agent",
    })
  ).toThrow(/evidence not found/);

  // Cross-incident evidence ID
  expect(() =>
    store.recordValidation({
      incident_id: incA.incident_id, experiment_id: expA.experiment_id,
      validation_plan: "plan",
      criteria_results: [{ criteria: "c", status: "passed" }],
      execution_result: "passed", evidence_ids: [evB.evidence.evidence_id], verified_by: "agent",
    })
  ).toThrow(/belongs to a different incident/);

  closeStore(store);
});

test("passed execution + passing criteria + valid evidence verifies experiment and permits resolution", async () => {
  const { store, call } = setup();
  const inc = (await call("debug_case_start", {
    project: { display_name: "VGApp", repository_uri: "git@example.com:o/a.git" },
    title: "bug", initial_symptom: "symptom",
  })).incident_id;

  const exp = (await call("debug_attempt_create", {
    incident_id: inc, node_kind: "experiment", title: "fix", expected_observation: "clean",
  })).experiment_id;

  const ev = (await call("debug_evidence_record", {
    project_id: "prj_vg", incident_id: inc, experiment_id: exp, evidence_type: "stdout",
    content: "clean run observed", capture_source: "agent",
  })).evidence_id;

  const val = await call("debug_validation_record", {
    incident_id: inc, experiment_id: exp, validation_plan: "run test", execution_result: "passed",
    criteria_results: [{ criteria: "runs cleanly", status: "passed" }], evidence_ids: [ev],
  });

  expect(val.decision).toBe("verified");
  expect(val.verified).toBe(true);

  // Experiment is verified in DB
  expect(store.getExperiment(exp)!.outcome_status).toBe("verified");

  // Incident can transition to resolved
  await call("debug_case_status_update", { incident_id: inc, status: "investigating", rationale: "inv", actor: "agent" });
  const resolved = await call("debug_case_status_update", {
    incident_id: inc, status: "resolved", verification_id: val.validation_id, rationale: "verified fix",
  });
  expect(resolved.status).toBe("resolved");

  const incDb = store.getIncidentOrFail(inc);
  expect(incDb.status).toBe("resolved");
  expect(incDb.resolved_at).toBeTruthy();
  expect(incDb.resolution_experiment_id).toBe(exp);

  closeStore(store);
});

test("updateIncidentStatus to resolved rejects if experiment was regressed", async () => {
  const { store } = setup();
  const inc = store.createIncident({
    project: { display_name: "VGApp", project_id: "prj_vg" },
    title: "bug", initial_symptom: "sym", actor: "agent",
  }).incident;
  const exp = store.createExperiment({
    incident_id: inc.incident_id, node_kind: "experiment", title: "fix", proposed_change: "c", expected_observation: "o", actor: "agent",
  }).experiment;
  const ev1 = store.recordEvidence({
    project_id: inc.project_id, incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    evidence_type: "stdout", content: "passed", capture_source: "agent",
  });

  // Initial validation succeeds
  const val1 = store.recordValidation({
    incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    validation_plan: "plan 1", criteria_results: [{ criteria: "c", status: "passed" }],
    execution_result: "passed", evidence_ids: [ev1.evidence.evidence_id], verified_by: "agent",
  });
  expect(val1.decision).toBe("verified");
  expect(store.getExperiment(exp.experiment_id)!.outcome_status).toBe("verified");

  // Later re-validation fails -> regresses experiment to failed
  const ev2 = store.recordEvidence({
    project_id: inc.project_id, incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    evidence_type: "stderr", content: "crashed", capture_source: "agent",
  });
  const val2 = store.recordValidation({
    incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    validation_plan: "plan 2", criteria_results: [{ criteria: "c", status: "failed" }],
    execution_result: "failed", evidence_ids: [ev2.evidence.evidence_id], verified_by: "agent",
  });
  expect(val2.decision).toBe("unverified");
  expect(store.getExperiment(exp.experiment_id)!.outcome_status).toBe("failed");

  // Attempting to resolve using val1's ID must fail because experiment is no longer verified
  store.updateIncidentStatus(inc.incident_id, "investigating", "inv", "agent");
  expect(() =>
    store.updateIncidentStatus(inc.incident_id, "resolved", "res", "agent", {
      verification_id: val1.validation.validation_run_id,
    })
  ).toThrow(/does not have verified outcome status/);

  closeStore(store);
});

test("transitioning status away from resolved clears resolved_at and resolution_experiment_id", async () => {
  const { store } = setup();
  const inc = store.createIncident({
    project: { display_name: "VGApp", project_id: "prj_vg" },
    title: "bug", initial_symptom: "sym", actor: "agent",
  }).incident;
  const exp = store.createExperiment({
    incident_id: inc.incident_id, node_kind: "experiment", title: "fix", proposed_change: "c", expected_observation: "o", actor: "agent",
  }).experiment;
  const ev = store.recordEvidence({
    project_id: inc.project_id, incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    evidence_type: "stdout", content: "passed", capture_source: "agent",
  });

  const val = store.recordValidation({
    incident_id: inc.incident_id, experiment_id: exp.experiment_id,
    validation_plan: "plan", criteria_results: [{ criteria: "c", status: "passed" }],
    execution_result: "passed", evidence_ids: [ev.evidence.evidence_id], verified_by: "agent",
  });

  store.updateIncidentStatus(inc.incident_id, "investigating", "inv", "agent");
  const resolved = store.updateIncidentStatus(inc.incident_id, "resolved", "res", "agent", {
    verification_id: val.validation.validation_run_id,
  });
  expect(resolved.status).toBe("resolved");
  expect(resolved.resolved_at).toBeTruthy();
  expect(resolved.resolution_experiment_id).toBe(exp.experiment_id);

  // Transition away from resolved (reopened)
  const reopened = store.updateIncidentStatus(inc.incident_id, "reopened", "reoccurred in staging", "agent");
  expect(reopened.status).toBe("reopened");
  expect(reopened.resolved_at).toBeNull();
  expect(reopened.resolution_experiment_id).toBeNull();

  // Read back from DB to confirm persisted columns are cleared
  const incDb = store.getIncidentOrFail(inc.incident_id);
  expect(incDb.status).toBe("reopened");
  expect(incDb.resolved_at).toBeNull();
  expect(incDb.resolution_experiment_id).toBeNull();

  closeStore(store);
});
