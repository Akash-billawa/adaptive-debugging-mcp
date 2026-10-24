import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { applySchema, readSchemaVersion, SCHEMA_VERSION } from "./schema.ts";

/** Data directory used when no explicit DB path is provided. */
export function resolveDataDir(): string {
  if (process.env.ADAPTIVE_DEBUG_DATA_DIR) return process.env.ADAPTIVE_DEBUG_DATA_DIR;
  if (process.platform === "win32" && process.env.APPDATA)
    return join(process.env.APPDATA!, "adaptive-debugging-mcp");
  return join(homedir(), ".local", "share", "adaptive-debugging-mcp");
}

/** Resolve the SQLite database file path. Priority: explicit arg > env var > default. */
export function resolveDbPath(explicit?: string): string {
  const p =
    explicit ||
    process.env.ADAPTIVE_DEBUG_DB_PATH ||
    join(resolveDataDir(), "debug-memory.db");
  return resolve(p);
}

interface Migration {
  version: number;
  up: (db: Database) => void;
}

/**
 * Ordered, repeatable migrations. v1 creates the full idempotent schema; v2 adds
 * plugin observations. Each runs in its own transaction and the database-level
 * schema version is advanced only on success.
 */
const MIGRATIONS: Migration[] = [
  { version: 1, up: (db) => applySchema(db) },
  {
    version: 2,
    up: (db) => {
      db.run(`CREATE TABLE IF NOT EXISTS plugin_observations (
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
      )`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_plugin_obs_session ON plugin_observations(session_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_plugin_obs_incident ON plugin_observations(incident_id)`);
    },
  },
  {
    version: 3,
    up: (db) => {
      // Exploration budgets: project defaults + per-incident overrides (additive).
      db.run(`CREATE TABLE IF NOT EXISTS budgets (
        budget_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        project_id TEXT,
        incident_id TEXT,
        config TEXT NOT NULL,
        actor TEXT NOT NULL,
        rationale TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      db.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_scope ON budgets(scope, IFNULL(project_id,''), IFNULL(incident_id,''))`,
      );
    },
  },
  {
    version: 4,
    up: (db) => {
      // Dense vector similarity for hybrid retrieval (v4).
      db.run(`CREATE TABLE IF NOT EXISTS embeddings (
        embedding_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        source_text_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      db.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_entity ON embeddings(entity_type, entity_id, model_name)`,
      );
      db.run(`CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model_name)`);
    },
  },
];

/** Apply any pending migrations. */
export function runMigrations(db: Database): void {
  // Ensure the meta table exists so we can read the current version.
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const current = readSchemaVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const stamp = db.query("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)");
    const tx = db.transaction(() => {
      m.up(db);
      stamp.run(String(m.version));
    });
    tx();
  }
}

export interface OpenResult {
  db: Database;
  path: string;
}

/** Open (creating if needed) the database, set PRAGMAs, and migrate to current. */
export function openDatabase(explicitPath?: string): OpenResult {
  // Support ":memory:" for tests and ephemeral use.
  if (explicitPath === ":memory:") {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db);
    return { db, path: ":memory:" };
  }
  const path = resolveDbPath(explicitPath);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  runMigrations(db);
  return { db, path };
}
