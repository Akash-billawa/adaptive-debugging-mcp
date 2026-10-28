import type { Store } from "../memory/store.ts";
import type { Incident, Experiment } from "../types.ts";
import { ids, contentHash } from "../memory/ids.ts";
import { defaultVectorizer, cosineSimilarity, type EmbeddingProvider } from "./vector.ts";

export interface SemanticHit {
  entity_type: "incident" | "experiment" | "evidence";
  entity_id: string;
  similarity: number;
  model_name: string;
}

export interface SyncEmbeddingsResult {
  indexed_incidents: number;
  indexed_experiments: number;
  total_embeddings: number;
  model_name: string;
  dimension: number;
}

/**
 * Indexes a single incident embedding into the embeddings table.
 */
export function indexIncidentEmbedding(
  store: Store,
  incident: Incident,
  vectorizer: EmbeddingProvider = defaultVectorizer,
): string {
  const text = `${incident.title} ${incident.initial_symptom} ${incident.acceptance_criteria ?? ""}`.trim();
  const vector = vectorizer.embed(text);
  const textHash = contentHash(text);
  const embId = ids.embedding();
  const now = new Date().toISOString();

  store.db
    .query(
      `INSERT INTO embeddings
       (embedding_id, entity_type, entity_id, model_name, dimension, vector_json, source_text_hash, created_at)
       VALUES (?, 'incident', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id, model_name) DO UPDATE SET
         vector_json = excluded.vector_json,
         source_text_hash = excluded.source_text_hash,
         created_at = excluded.created_at`,
    )
    .run(
      embId,
      incident.incident_id,
      vectorizer.modelName,
      vectorizer.dimension,
      JSON.stringify(vector),
      textHash,
      now,
    );

  return embId;
}

/**
 * Indexes a single experiment embedding into the embeddings table.
 */
export function indexExperimentEmbedding(
  store: Store,
  exp: Experiment,
  vectorizer: EmbeddingProvider = defaultVectorizer,
): string {
  const text = `${exp.title} ${exp.proposed_change ?? ""} ${exp.actual_observation ?? ""}`.trim();
  const vector = vectorizer.embed(text);
  const textHash = contentHash(text);
  const embId = ids.embedding();
  const now = new Date().toISOString();

  store.db
    .query(
      `INSERT INTO embeddings
       (embedding_id, entity_type, entity_id, model_name, dimension, vector_json, source_text_hash, created_at)
       VALUES (?, 'experiment', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id, model_name) DO UPDATE SET
         vector_json = excluded.vector_json,
         source_text_hash = excluded.source_text_hash,
         created_at = excluded.created_at`,
    )
    .run(
      embId,
      exp.experiment_id,
      vectorizer.modelName,
      vectorizer.dimension,
      JSON.stringify(vector),
      textHash,
      now,
    );

  return embId;
}

/**
 * Synchronizes and generates embeddings for all unindexed incidents and experiments.
 */
export function syncAllEmbeddings(
  store: Store,
  vectorizer: EmbeddingProvider = defaultVectorizer,
): SyncEmbeddingsResult {
  let indexedIncidents = 0;
  let indexedExperiments = 0;

  // Unindexed incidents
  const unindexedIncidents = store.db
    .query(
      `SELECT * FROM incidents WHERE incident_id NOT IN (
         SELECT entity_id FROM embeddings WHERE entity_type = 'incident' AND model_name = ?
       )`,
    )
    .all(vectorizer.modelName) as Incident[];

  // Unindexed experiments
  const unindexedExperiments = store.db
    .query(
      `SELECT * FROM experiments WHERE experiment_id NOT IN (
         SELECT entity_id FROM embeddings WHERE entity_type = 'experiment' AND model_name = ?
       )`,
    )
    .all(vectorizer.modelName) as Experiment[];

  const runTx = store.db.transaction(() => {
    for (const inc of unindexedIncidents) {
      indexIncidentEmbedding(store, inc, vectorizer);
      indexedIncidents++;
    }
    for (const exp of unindexedExperiments) {
      indexExperimentEmbedding(store, exp, vectorizer);
      indexedExperiments++;
    }
  });
  runTx();

  const totalRow = store.db
    .query("SELECT COUNT(*) as total FROM embeddings WHERE model_name = ?")
    .get(vectorizer.modelName) as { total: number } | null;

  return {
    indexed_incidents: indexedIncidents,
    indexed_experiments: indexedExperiments,
    total_embeddings: totalRow?.total ?? 0,
    model_name: vectorizer.modelName,
    dimension: vectorizer.dimension,
  };
}

/**
 * Performs semantic similarity search against indexed embeddings.
 */
export function searchSemantic(
  store: Store,
  query: string,
  options?: {
    minSimilarity?: number;
    limit?: number;
    vectorizer?: EmbeddingProvider;
    entityType?: "incident" | "experiment";
    projectId?: string | null;
  },
): SemanticHit[] {
  const vectorizer = options?.vectorizer ?? defaultVectorizer;
  const minSim = options?.minSimilarity ?? 0.35;
  const limit = Math.max(1, Math.min(100, options?.limit ?? 20));

  const queryVector = vectorizer.embed(query);

  let sql = "SELECT e.entity_type, e.entity_id, e.vector_json FROM embeddings e";
  const params: any[] = [vectorizer.modelName];
  const where: string[] = ["e.model_name = ?"];

  if (options?.projectId) {
    sql += ` LEFT JOIN incidents i ON (e.entity_type = 'incident' AND i.incident_id = e.entity_id)
             LEFT JOIN experiments exp ON (e.entity_type = 'experiment' AND exp.experiment_id = e.entity_id)
             LEFT JOIN incidents i2 ON (e.entity_type = 'experiment' AND i2.incident_id = exp.incident_id)`;
    where.push("(i.project_id = ? OR i2.project_id = ?)");
    params.push(options.projectId, options.projectId);
  }

  if (options?.entityType) {
    where.push("e.entity_type = ?");
    params.push(options.entityType);
  }

  sql += ` WHERE ${where.join(" AND ")}`;

  const rows = store.db.query(sql).all(...params) as {
    entity_type: "incident" | "experiment" | "evidence";
    entity_id: string;
    vector_json: string;
  }[];

  const hits: SemanticHit[] = [];

  for (const row of rows) {
    try {
      const docVector = JSON.parse(row.vector_json) as number[];
      const sim = cosineSimilarity(queryVector, docVector);
      if (sim >= minSim) {
        hits.push({
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          similarity: sim,
          model_name: vectorizer.modelName,
        });
      }
    } catch {
      // Ignore corrupted vector row
    }
  }

  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, limit);
}
