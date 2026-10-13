import { openDatabase } from "../../src/memory/db.ts";
import { Store } from "../../src/memory/store.ts";
import { buildFingerprintValues } from "../../src/retrieval/fingerprint.ts";
import { searchHistory } from "../../src/retrieval/search.ts";

const { db, path } = openDatabase(":memory:");
const s = new Store(db);
const fps = buildFingerprintValues("TypeError: Cannot read properties of undefined (reading 'foo') at parse (C:\\app\\src\\x.js:10:5)");

const { incident, related } = s.createIncident({
  project: { display_name: "Demo", repository_uri: "file:///demo" },
  title: "crash on parse",
  initial_symptom: "TypeError reading foo",
  fingerprints: fps,
  reproduction_status: "reproduced",
  actor: "agent",
});
console.log("incident", incident.incident_id, "related", related.length);

const a1 = s.createExperiment({ incident_id: incident.incident_id, node_kind: "strategy", title: "Guard the parser input", proposed_change: "add null check in parse()", expected_observation: "no crash", actor: "agent" });
const a2 = s.createExperiment({ incident_id: incident.incident_id, node_kind: "experiment", title: "Validate payload schema", parent_experiment_id: a1.experiment.experiment_id, proposed_change: "add zod schema validation", expected_observation: "400 instead of crash", actor: "agent" });
const a2a = s.createExperiment({ incident_id: incident.incident_id, node_kind: "variant", title: "Validate with stricter types", parent_experiment_id: a2.experiment.experiment_id, reason_for_difference: "schema now rejects unknown keys", proposed_change: "strict schema", expected_observation: "usable error", actor: "agent" });
console.log("labels", a1.experiment.display_label, a2.experiment.display_label, a2a.experiment.display_label);

s.recordEvidence({ project_id: incident.project_id, incident_id: incident.incident_id, experiment_id: a2.experiment.experiment_id, evidence_type: "stderr", content: "TypeError secret=sk-abcdEFGH12345678abcdEFGH reading foo line 10", capture_source: "agent", interpretation: "crash persists at line 10" });
const upd = s.updateExperiment(a2.experiment.experiment_id, { execution_status: "completed", outcome_status: "failed", actual_observation: "still crashed", actor: "agent" });
console.log("outcome", upd.experiment.outcome_status);

const ev = s.listEvidence({ experiment_id: a2.experiment.experiment_id });
console.log("evidence redaction", ev[0].redaction_status, "content:", s.getEvidenceContent(ev[0].evidence_id)?.content.slice(0, 70));

const val = s.recordValidation({ incident_id: incident.incident_id, experiment_id: a2a.experiment.experiment_id, validation_plan: "repro input must not crash", criteria_results: [{ criteria: "no crash", status: "passed" }], execution_result: "passed", evidence_ids: [], verified_by: "agent" });
console.log("validation decision", val.decision, "experiment outcome", s.getExperiment(a2a.experiment.experiment_id)?.outcome_status);

const res = searchHistory(s, { query: "crash parse undefined reading", project_id: incident.project_id, limit: 5 });
console.log("search complete", res.complete, "hits", res.results.length, res.results[0]?.matched_via);

const tree = s.buildTree(incident.incident_id, null, 5);
console.log("tree roots", tree.nodes.length, "total", tree.total);
console.log("path", path || "memory");
