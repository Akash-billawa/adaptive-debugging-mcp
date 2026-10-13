import type { Database } from "bun:sqlite";

/** FTS5 index maintenance. Indexes are managed manually alongside writes. */

export function indexIncident(
  db: Database,
  incidentId: string,
  projectId: string,
  title: string,
  symptom: string,
  body: string,
): void {
  db.query("DELETE FROM incident_fts WHERE incident_id = ?").run(incidentId);
  db.query(
    "INSERT INTO incident_fts(incident_id, project_id, title, symptom, body) VALUES(?,?,?,?,?)",
  ).run(incidentId, projectId, title, symptom, body);
}

export function indexExperiment(
  db: Database,
  experimentId: string,
  incidentId: string,
  title: string,
  body: string,
): void {
  db.query("DELETE FROM experiment_fts WHERE experiment_id = ?").run(experimentId);
  db.query(
    "INSERT INTO experiment_fts(experiment_id, incident_id, title, body) VALUES(?,?,?,?)",
  ).run(experimentId, incidentId, title, body);
}

export function indexEvidence(
  db: Database,
  evidenceId: string,
  incidentId: string | null,
  experimentId: string | null,
  type: string,
  body: string,
): void {
  db.query("DELETE FROM evidence_fts WHERE evidence_id = ?").run(evidenceId);
  db.query(
    "INSERT INTO evidence_fts(evidence_id, incident_id, experiment_id, type, body) VALUES(?,?,?,?,?)",
  ).run(evidenceId, incidentId, experimentId, type, body);
}

export function removeIncidentIndex(db: Database, incidentId: string): void {
  db.query("DELETE FROM incident_fts WHERE incident_id = ?").run(incidentId);
}

export function removeExperimentIndex(db: Database, experimentId: string): void {
  db.query("DELETE FROM experiment_fts WHERE experiment_id = ?").run(experimentId);
}

export function removeEvidenceIndex(db: Database, evidenceId: string): void {
  db.query("DELETE FROM evidence_fts WHERE evidence_id = ?").run(evidenceId);
}
