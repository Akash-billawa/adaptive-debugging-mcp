/**
 * Backup, restore, integrity verification, and retention management.
 *
 * Provides safe operational maintenance for the SQLite investigation store:
 * - Atomic point-in-time backup via VACUUM INTO
 * - Cryptographic checksumming (SHA-256) and manifest generation
 * - Integrity verification via PRAGMA integrity_check and schema inspection
 * - Safe restoration with pre-restore safety snapshots and WAL reset
 * - Retention policy enforcement for transient observations and evidence
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync, renameSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { resolveDbPath, openDatabase, runMigrations } from "./db.ts";
import { readSchemaVersion } from "./schema.ts";

export interface BackupCounts {
  incidents: number;
  experiments: number;
  evidence: number;
  timeline_events: number;
  plugin_observations: number;
}

export interface BackupManifest {
  backup_file: string;
  created_at: string;
  sha256: string;
  file_size_bytes: number;
  schema_version: number;
  counts: BackupCounts;
  original_db_path: string;
}

export interface BackupResult {
  ok: boolean;
  backup_path: string;
  manifest_path: string;
  sha256: string;
  file_size_bytes: number;
  schema_version: number;
  counts: BackupCounts;
}

export interface VerifyResult {
  ok: boolean;
  valid: boolean;
  backup_path: string;
  schema_version: number;
  sha256: string;
  manifest_found: boolean;
  manifest_matched: boolean | null;
  counts: BackupCounts;
  integrity_output: string;
}

export interface RestoreResult {
  ok: boolean;
  restored_from: string;
  target_db_path: string;
  safety_snapshot_path: string | null;
  schema_version: number;
  counts: BackupCounts;
}

export interface RetentionResult {
  ok: boolean;
  dry_run: boolean;
  cutoff_date: string;
  pruned_counts: {
    plugin_observations: number;
    transient_evidence: number;
  };
  details: string;
}

function computeSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function readCounts(db: Database): BackupCounts {
  const getCount = (table: string): number => {
    try {
      const row = db.query(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number } | null;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  };

  return {
    incidents: getCount("incidents"),
    experiments: getCount("experiments"),
    evidence: getCount("evidence"),
    timeline_events: getCount("timeline_events"),
    plugin_observations: getCount("plugin_observations"),
  };
}

/**
 * Create an atomic point-in-time snapshot backup using SQLite's VACUUM INTO.
 * Safe to execute against an active WAL database without interrupting readers.
 */
export function createBackup(options: {
  dbPath?: string;
  outPath?: string;
  backupDir?: string;
}): BackupResult {
  const sourceDbPath = resolveDbPath(options.dbPath);
  if (!existsSync(sourceDbPath)) {
    throw new Error(`Source database does not exist: ${sourceDbPath}`);
  }

  // Determine destination path
  let targetPath = options.outPath;
  if (!targetPath) {
    const dir = options.backupDir || join(dirname(sourceDbPath), "backups");
    mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    targetPath = join(dir, `debug-memory-${timestamp}.bak.db`);
  } else {
    targetPath = resolve(targetPath);
    mkdirSync(dirname(targetPath), { recursive: true });
  }

  if (resolve(targetPath) === resolve(sourceDbPath)) {
    throw new Error(`Cannot backup database to itself: outPath matches sourceDbPath (${targetPath})`);
  }

  if (existsSync(targetPath)) {
    rmSync(targetPath, { force: true });
  }

  // Checkpoint WAL on the active database first
  const activeDb = new Database(sourceDbPath);
  try {
    activeDb.run("PRAGMA wal_checkpoint(TRUNCATE)");
    // VACUUM INTO writes a clean, single-file database snapshot
    const escaped = targetPath.replace(/'/g, "''");
    activeDb.run(`VACUUM INTO '${escaped}'`);
  } finally {
    activeDb.close();
  }

  // Verify the backup file
  const backupDb = new Database(targetPath, { readonly: true });
  let schemaVer = 0;
  let counts: BackupCounts;
  try {
    const integrity = backupDb.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
    if (!integrity || integrity.integrity_check !== "ok") {
      throw new Error(`Backup file failed integrity check: ${JSON.stringify(integrity)}`);
    }
    schemaVer = readSchemaVersion(backupDb);
    counts = readCounts(backupDb);
  } finally {
    backupDb.close();
  }

  const sha = computeSha256(targetPath);
  const size = statSync(targetPath).size;

  const manifest: BackupManifest = {
    backup_file: basename(targetPath),
    created_at: new Date().toISOString(),
    sha256: sha,
    file_size_bytes: size,
    schema_version: schemaVer,
    counts,
    original_db_path: sourceDbPath,
  };

  const manifestPath = `${targetPath}.manifest.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return {
    ok: true,
    backup_path: targetPath,
    manifest_path: manifestPath,
    sha256: sha,
    file_size_bytes: size,
    schema_version: schemaVer,
    counts,
  };
}

/**
 * Verify a backup file's SQLite integrity, schema version, and SHA-256 against its manifest.
 */
export function verifyBackup(backupPath: string): VerifyResult {
  const p = resolve(backupPath);
  if (!existsSync(p)) {
    throw new Error(`Backup file does not exist: ${p}`);
  }

  let integrityOutput = "unknown";
  let schemaVer = 0;
  let counts: BackupCounts = { incidents: 0, experiments: 0, evidence: 0, timeline_events: 0, plugin_observations: 0 };
  let db: Database | null = null;
  try {
    db = new Database(p, { readonly: true });
    const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check?: string; [key: string]: unknown };
    integrityOutput = String(Object.values(integrity ?? {})[0] ?? "failed");
    if (integrityOutput !== "ok") {
      return {
        ok: false,
        valid: false,
        backup_path: p,
        schema_version: 0,
        sha256: "",
        manifest_found: false,
        manifest_matched: false,
        counts,
        integrity_output: integrityOutput,
      };
    }
    schemaVer = readSchemaVersion(db);
    counts = readCounts(db);
  } catch (err: any) {
    return {
      ok: false,
      valid: false,
      backup_path: p,
      schema_version: 0,
      sha256: "",
      manifest_found: false,
      manifest_matched: false,
      counts,
      integrity_output: err?.message ?? "corrupted database file",
    };
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }

  const actualSha = computeSha256(p);
  const manifestPath = `${p}.manifest.json`;
  let manifestFound = false;
  let manifestMatched: boolean | null = null;

  if (existsSync(manifestPath)) {
    manifestFound = true;
    try {
      const manifest: BackupManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifestMatched = manifest.sha256 === actualSha;
    } catch {
      manifestMatched = false;
    }
  }

  return {
    ok: integrityOutput === "ok" && (manifestMatched === null || manifestMatched === true),
    valid: integrityOutput === "ok",
    backup_path: p,
    schema_version: schemaVer,
    sha256: actualSha,
    manifest_found: manifestFound,
    manifest_matched: manifestMatched,
    counts,
    integrity_output: integrityOutput,
  };
}

/**
 * Restore database from a verified backup file.
 * Creates an automatic safety snapshot of the active target DB before overwriting.
 */
export function restoreBackup(options: {
  backupPath: string;
  targetDbPath?: string;
  createSafetySnapshot?: boolean;
}): RestoreResult {
  const backupPath = resolve(options.backupPath);
  const verify = verifyBackup(backupPath);
  if (!verify.ok) {
    if (verify.manifest_matched === false) {
      throw new Error(`Cannot restore backup with mismatched manifest SHA-256 (${backupPath})`);
    }
    throw new Error(`Cannot restore invalid backup (${backupPath}): integrity check = ${verify.integrity_output}`);
  }

  const targetPath = resolveDbPath(options.targetDbPath);
  let safetyPath: string | null = null;

  // If target database exists, make safety snapshot using VACUUM INTO after acquiring exclusive lock
  if (existsSync(targetPath)) {
    const checkDb = new Database(targetPath);
    try {
      checkDb.run("PRAGMA busy_timeout = 2000;");
      try {
        checkDb.run("BEGIN EXCLUSIVE;");
        checkDb.run("ROLLBACK;");
      } catch (err: any) {
        throw new Error(
          `Cannot restore into target database (${targetPath}): database is active or locked by another process: ${err?.message ?? String(err)}`,
        );
      }

      // Checkpoint WAL so any pending updates are incorporated
      try {
        checkDb.run("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        /* best effort */
      }

      if (options.createSafetySnapshot !== false) {
        safetyPath = `${targetPath}.pre-restore-${Date.now()}.bak`;
        if (existsSync(safetyPath)) rmSync(safetyPath, { force: true });
        const escaped = safetyPath.replace(/'/g, "''");
        checkDb.run(`VACUUM INTO '${escaped}'`);
      }
    } finally {
      try {
        checkDb.close();
      } catch {}
    }
  }

  // Restore via a temporary file and atomic swap
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempRestorePath = `${targetPath}.restore-${Date.now()}.tmp`;
  try {
    copyFileSync(backupPath, tempRestorePath);

    // Verify temp file before replacing target
    const tempCheck = new Database(tempRestorePath, { readonly: true });
    try {
      const integrity = tempCheck.query("PRAGMA integrity_check").get() as { integrity_check?: string; [key: string]: unknown };
      const output = String(Object.values(integrity ?? {})[0] ?? "failed");
      if (output !== "ok") {
        throw new Error(`Restored database copy failed integrity check: ${output}`);
      }
    } finally {
      tempCheck.close();
    }

    // Clean old WAL and SHM files
    if (existsSync(targetPath)) {
      for (const ext of ["-wal", "-shm"]) {
        try {
          rmSync(targetPath + ext, { force: true });
        } catch {
          /* ignore */
        }
      }
    }

    try {
      renameSync(tempRestorePath, targetPath);
    } catch {
      copyFileSync(tempRestorePath, targetPath);
      rmSync(tempRestorePath, { force: true });
    }
  } finally {
    if (existsSync(tempRestorePath)) {
      try {
        rmSync(tempRestorePath, { force: true });
      } catch {}
    }
  }

  // Open restored database, verify integrity, run migrations if newer schema needed
  const { db } = openDatabase(targetPath);
  let finalCounts: BackupCounts;
  let schemaVer = 0;
  try {
    runMigrations(db);
    schemaVer = readSchemaVersion(db);
    finalCounts = readCounts(db);
  } finally {
    db.close();
  }

  return {
    ok: true,
    restored_from: backupPath,
    target_db_path: targetPath,
    safety_snapshot_path: safetyPath,
    schema_version: schemaVer,
    counts: finalCounts,
  };
}

/**
 * Apply retention policies to prune transient plugin observations and evidence.
 * Supports dry-run inspection to forecast deletions before committing.
 */
export function applyRetention(options: {
  dbPath?: string;
  olderThanDays?: number;
  pruneTransientObservations?: boolean;
  pruneTransientEvidence?: boolean;
  dryRun?: boolean;
}): RetentionResult {
  const dbPath = resolveDbPath(options.dbPath);
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const days = Math.max(1, options.olderThanDays ?? 30);
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const dryRun = options.dryRun ?? false;
  const pruneObs = options.pruneTransientObservations !== false;
  const pruneEv = options.pruneTransientEvidence !== false;

  const db = new Database(dbPath);
  let obsCount = 0;
  let evCount = 0;

  try {
    if (pruneObs) {
      const q = db.query(
        "SELECT COUNT(*) as c FROM plugin_observations WHERE captured_at < ? AND (incident_id IS NULL OR incident_id = '')",
      ).get(cutoffDate) as { c: number } | null;
      obsCount = q?.c ?? 0;
    }

    if (pruneEv) {
      const q = db.query(
        "SELECT COUNT(*) as c FROM evidence WHERE created_at < ? AND retention_class = 'transient'",
      ).get(cutoffDate) as { c: number } | null;
      evCount = q?.c ?? 0;
    }

    if (!dryRun && (obsCount > 0 || evCount > 0)) {
      db.transaction(() => {
        if (pruneObs && obsCount > 0) {
          db.run(
            "DELETE FROM plugin_observations WHERE captured_at < ? AND (incident_id IS NULL OR incident_id = '')",
            [cutoffDate],
          );
        }
        if (pruneEv && evCount > 0) {
          // Remove from evidence_content, evidence_fts and evidence
          db.run(
            `DELETE FROM evidence_content WHERE evidence_id IN (
              SELECT evidence_id FROM evidence WHERE created_at < ? AND retention_class = 'transient'
            )`,
            [cutoffDate],
          );
          db.run(
            `DELETE FROM evidence_fts WHERE evidence_id IN (
              SELECT evidence_id FROM evidence WHERE created_at < ? AND retention_class = 'transient'
            )`,
            [cutoffDate],
          );
          db.run(
            "DELETE FROM evidence WHERE created_at < ? AND retention_class = 'transient'",
            [cutoffDate],
          );
        }
      })();
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    }
  } finally {
    db.close();
  }

  const details = dryRun
    ? `[Dry Run] Found ${obsCount} unlinked plugin observations and ${evCount} transient evidence records older than ${days} days (${cutoffDate}). None deleted.`
    : `Pruned ${obsCount} unlinked plugin observations and ${evCount} transient evidence records older than ${days} days (${cutoffDate}).`;

  return {
    ok: true,
    dry_run: dryRun,
    cutoff_date: cutoffDate,
    pruned_counts: {
      plugin_observations: obsCount,
      transient_evidence: evCount,
    },
    details,
  };
}
