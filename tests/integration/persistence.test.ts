import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tempDbPath, openStore, closeStore } from "./helpers.ts";
import { buildFingerprintValues } from "../../src/retrieval/fingerprint.ts";
import { searchHistory } from "../../src/retrieval/search.ts";
import type { Store } from "../../src/memory/store.ts";

const paths: string[] = [];
function fresh(): string {
  const p = tempDbPath();
  paths.push(p);
  return p;
}
afterAll(() => {
  for (const p of paths) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(p + suffix, { force: true }); } catch { /* ignore */ }
    }
  }
});

function seed(store: Store, opts: { fingerprintRaw?: string; project?: { display_name: string; repository_uri?: string; project_id?: string } } = {}) {
  const fps = opts.fingerprintRaw ? buildFingerprintValues(opts.fingerprintRaw) : [];
  return store.createIncident({
    project: opts.project ?? { display_name: "App", repository_uri: "file:///app" },
    title: "parser crash",
    initial_symptom: "TypeError reading id",
    fingerprints: fps,
    reproduction_status: "reproduced",
    acceptance_criteria: "malformed input returns 400, no crash",
    actor: "agent",
  }).incident;
}

test("persistence survives a store close/reopen (restart durability)", () => {
  const db = fresh();
  let id = "";
  {
    const store = openStore(db);
    const inc = seed(store, { fingerprintRaw: "TypeError: reading 'id' at parse (C:\\x\\p.js:10:1)" });
    id = inc.incident_id;
    const strat = store.createExperiment({ incident_id: id, node_kind: "strategy", title: "Guard input", proposed_change: "add null check", expected_observation: "no crash", actor: "agent" });
    store.createExperiment({ incident_id: id, node_kind: "experiment", title: "Validate schema", parent_experiment_id: strat.experiment.experiment_id, proposed_change: "zod schema", expected_observation: "400", actor: "agent" });
    closeStore(store);
  }
  // Reopen = simulated restart
  const store2 = openStore(db);
  const inc = store2.getIncidentOrFail(id);
  const experiments = store2.allExperiments(id);
  expect(experiments.length).toBe(2);
  expect(experiments.some((e) => e.display_label === "A1")).toBe(true);
  closeStore(store2);
});

test("nested variations A1 -> A1A -> A1AA with failed outcomes preserved", () => {
  const store = openStore(fresh());
  const inc = seed(store);
  const a1 = store.createExperiment({ incident_id: inc.incident_id, node_kind: "strategy", title: "Strategy A", proposed_change: "approach A", expected_observation: "x", actor: "agent" }).experiment;
  const a1a = store.createExperiment({ incident_id: inc.incident_id, node_kind: "experiment", title: "Attempt A1", parent_experiment_id: a1.experiment_id, proposed_change: "attempt one", expected_observation: "x", actor: "agent" }).experiment;
  const a1aa = store.createExperiment({ incident_id: inc.incident_id, node_kind: "variant", title: "Attempt A1A", parent_experiment_id: a1a.experiment_id, reason_for_difference: "changed assumption X", proposed_change: "attempt one variant", expected_observation: "x", actor: "agent" }).experiment;
  const a1ab = store.createExperiment({ incident_id: inc.incident_id, node_kind: "variant", title: "Attempt A1B", parent_experiment_id: a1a.experiment_id, reason_for_difference: "changed assumption Y", proposed_change: "attempt one alt", expected_observation: "x", actor: "agent" }).experiment;

  expect([a1.display_label, a1a.display_label, a1aa.display_label, a1ab.display_label]).toEqual(["A", "A1", "A1A", "A1B"]);

  // Fail A1A; creating A1B must not overwrite A1A's outcome.
  store.recordEvidence({ project_id: inc.project_id, incident_id: inc.incident_id, experiment_id: a1aa.experiment_id, evidence_type: "stderr", content: "still failed", capture_source: "agent" });
  store.updateExperiment(a1aa.experiment_id, { execution_status: "completed", outcome_status: "failed", actual_observation: "failed", actor: "agent" });

  const reloaded = store.allExperiments(inc.incident_id);
  const aa = reloaded.find((e) => e.experiment_id === a1aa.experiment_id)!;
  expect(aa.outcome_status).toBe("failed");
  expect(reloaded.length).toBe(4);
  closeStore(store);
});

test("command success is NOT a verified fix; verified only via validation criteria", () => {
  const store = openStore(fresh());
  const inc = seed(store);
  const a1 = store.createExperiment({ incident_id: inc.incident_id, node_kind: "experiment", title: "Add guard", proposed_change: "null check", expected_observation: "no crash", actor: "agent" }).experiment;

  // A command completes fine but the bug remains -> outcome failed, not verified.
  store.recordEvidence({ project_id: inc.project_id, incident_id: inc.incident_id, experiment_id: a1.experiment_id, evidence_type: "stderr", content: "exit code 0 but crash persists", capture_source: "agent" });
  store.updateExperiment(a1.experiment_id, { execution_status: "completed", outcome_status: "failed", actual_observation: "crash persists despite exit 0", actor: "agent" });
  expect(store.getIncidentOrFail(inc.incident_id).status).toBe("open");

  // Validation with a FAILED criterion cannot be verified.
  const failing = store.recordValidation({
    incident_id: inc.incident_id, experiment_id: a1.experiment_id,
    validation_plan: "malformed input returns 400",
    criteria_results: [{ criteria: "returns 400", status: "failed" }],
    execution_result: "passed", evidence_ids: [], verified_by: "agent",
  });
  expect(failing.decision).toBe("unverified");

  // Validation with all passed -> verified, and only this flips outcome to verified.
  const passing = store.recordValidation({
    incident_id: inc.incident_id, experiment_id: a1.experiment_id,
    validation_plan: "malformed input returns 400",
    criteria_results: [{ criteria: "returns 400", status: "passed" }, { criteria: "no crash", status: "passed" }],
    execution_result: "passed", evidence_ids: [], verified_by: "agent",
  });
  expect(passing.decision).toBe("verified");
  expect(store.getExperiment(a1.experiment_id)!.outcome_status).toBe("verified");
  expect(store.getVerificationForIncident(inc.incident_id).length).toBe(1);
  closeStore(store);
});

test("secrets are redacted before storage and not findable via search", () => {
  const store = openStore(fresh());
  const inc = seed(store, { fingerprintRaw: "TypeError: reading 'id' at parse line 10" });
  const a1 = store.createExperiment({ incident_id: inc.incident_id, node_kind: "experiment", title: "Debug auth", proposed_change: "inspect token", expected_observation: "see token", actor: "agent" }).experiment;
  store.recordEvidence({
    project_id: inc.project_id, incident_id: inc.incident_id, experiment_id: a1.experiment_id,
    evidence_type: "stdout",
    content: "authorizing with token=sk-abcdEFGHsecretvalue1234567890 and AKIAIOSFODNN7EXAMPLE",
    capture_source: "agent", interpretation: "shows a live key",
  });
  const ev = store.listEvidence({ experiment_id: a1.experiment_id })[0];
  const content = store.getEvidenceContent(ev.evidence_id)!.content;
  expect(content).not.toContain("sk-abcdEFGHsecretvalue1234567890");
  expect(content).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(ev.redaction_status).toBe("redacted");

  // Searching for the secret value must not return the incident.
  const res = searchHistory(store, { query: "sk-abcdEFGHsecretvalue1234567890", project_id: inc.project_id, limit: 5 });
  const ids = res.results.map((r) => r.incident.incident_id);
  expect(ids).not.toContain(inc.incident_id);
  closeStore(store);
});

test("project isolation: cross-project search is opt-in only", () => {
  const store = openStore(fresh());
  const inc = seed(store, { project: { display_name: "ProjectA", repository_uri: "file:///a", project_id: "prj_a" } });
  seed(store, { project: { display_name: "ProjectB", repository_uri: "file:///b", project_id: "prj_b" } });

  // Search scoped to prj_b should not surface project A's incident.
  const scoped = searchHistory(store, { query: "TypeError reading id", project_id: "prj_b", limit: 10 });
  const ids = scoped.results.map((r) => r.incident.incident_id);
  expect(ids).not.toContain(inc.incident_id);

  // Opt-in cross-project search can surface both.
  const cross = searchHistory(store, { query: "TypeError reading id", project_id: "prj_b", include_cross_project: true, limit: 10 });
  expect(cross.results.length).toBeGreaterThanOrEqual(2);
  closeStore(store);
});

test("duplicate/equivalent attempts are flagged", () => {
  const store = openStore(fresh());
  const inc = seed(store);
  const a1 = store.createExperiment({ incident_id: inc.incident_id, node_kind: "experiment", title: "Guard input", proposed_change: "add null check to parse", expected_observation: "no crash", actor: "agent" });
  expect(a1.duplicateWarnings.length).toBe(0);
  const dupe = store.createExperiment({ incident_id: inc.incident_id, node_kind: "experiment", title: "Guard input", proposed_change: "add null check to parse", expected_observation: "no crash", actor: "agent" });
  expect(dupe.duplicateWarnings.length).toBeGreaterThan(0);
  expect(dupe.duplicateWarnings[0].match).toBe("exact_action");
  closeStore(store);
});

test("invalid parents and cross-incident attachment are rejected", () => {
  const store = openStore(fresh());
  const incA = seed(store);
  seed(store, { fingerprintRaw: "other failure signature" });

  // Unknown parent id -> NOT_FOUND
  expect(() =>
    store.createExperiment({ incident_id: incA.incident_id, node_kind: "variant", title: "x", parent_experiment_id: "exp_missing", reason_for_difference: "reason", proposed_change: "y", expected_observation: "z", actor: "agent" }),
  ).toThrow();

  const a1 = store.createExperiment({ incident_id: incA.incident_id, node_kind: "experiment", title: "A1", proposed_change: "p", expected_observation: "o", actor: "agent" }).experiment;

  // Parent from a different incident -> VALIDATION_ERROR
  const cross = seed(store, { fingerprintRaw: "third failure sig" });
  expect(() =>
    store.createExperiment({ incident_id: cross.incident_id, node_kind: "experiment", title: "child", parent_experiment_id: a1.experiment_id, proposed_change: "p", expected_observation: "o", actor: "agent" }),
  ).toThrow();

  // Variant without a reason_for_difference -> VALIDATION_ERROR
  expect(() =>
    store.createExperiment({ incident_id: incA.incident_id, node_kind: "variant", title: "bad variant", parent_experiment_id: a1.experiment_id, proposed_change: "p", expected_observation: "o", actor: "agent" }),
  ).toThrow();

  closeStore(store);
});
